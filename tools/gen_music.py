#!/usr/bin/env python3
"""BGM pipeline: structured captions -> local music model (WAV) -> seamless loop + loudness -> MP3.

Every piece of data lives in JSON: track ids come from content/audio.json (bgm[].id); captions,
durations, generation/loop/loudness/encode parameters and paths come from
assets_src/music/captions.json. This file holds logic only.

Usage:
  python3 tools/gen_music.py validate
  python3 tools/gen_music.py caption <id>
  python3 tools/gen_music.py generate [ids...] [--force]
  python3 tools/gen_music.py process  [ids...]
  python3 tools/gen_music.py docs
  python3 tools/gen_music.py all      [ids...] [--force]
"""

import argparse
import datetime
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CAPTIONS = ROOT / "assets_src" / "music" / "captions.json"
# Section labels the Music3 studio splits a caption on (protocol of the model endpoint, not game data).
API_HEADINGS = ("Global Metadata", "Vocal Details", "Arrangement")
PLACEHOLDER = re.compile(r"\{([A-Za-z_][\w.]*)\}")
DOCS_BEGIN = "<!-- tracks:begin -->"
DOCS_END = "<!-- tracks:end -->"
# Parameter ranges accepted by ffmpeg's loudnorm filter.
LOUDNORM_I_RANGE = (-70.0, -5.0)
LOUDNORM_LRA_MAX = 50.0

_log_lock = threading.Lock()


def rel(path):
    path = Path(path)
    return path.relative_to(ROOT) if path.is_relative_to(ROOT) else path


def log(*parts):
    stamp = datetime.datetime.now().astimezone().strftime("%H:%M:%S")
    with _log_lock:
        print(f"[{stamp}]", *parts, flush=True)


# ---------------------------------------------------------------- config & captions


class Config:
    def __init__(self, path):
        self.file = Path(path)
        self.data = json.loads(self.file.read_text(encoding="utf8"))

    def __getitem__(self, key):
        return self.data[key]

    def path(self, key):
        return ROOT / self.data["paths"][key]

    def bgm_ids(self):
        audio = json.loads(self.path("audioContent").read_text(encoding="utf8"))
        return [entry["id"] for entry in audio["bgm"]]

    def bgm_names(self):
        audio = json.loads(self.path("audioContent").read_text(encoding="utf8"))
        return {entry["id"]: entry.get("nameZh", "") for entry in audio["bgm"]}

    def track(self, tid):
        tracks = self.data["tracks"]
        if tid not in tracks:
            raise KeyError(f'no caption entry for track "{tid}" in {rel(self.file)}')
        return tracks[tid]

    def category(self, tid):
        return self.data["categories"][self.track(tid)["category"]]

    def duration(self, tid):
        return float(
            self.track(tid).get(
                "durationSeconds", self.category(tid)["durationSeconds"]
            )
        )


def _lookup(ctx, dotted):
    value = ctx
    for part in dotted.split("."):
        if not isinstance(value, dict) or part not in value:
            raise KeyError(dotted)
        value = value[part]
    if isinstance(value, (dict, list)):
        raise KeyError(dotted)
    return str(value)


def render(template, ctx, where):
    def sub(match):
        try:
            return _lookup(ctx, match.group(1))
        except KeyError:
            raise ValueError(
                f"{where}: unresolved placeholder {{{match.group(1)}}}"
            ) from None

    return PLACEHOLDER.sub(sub, template).strip()


def compose_caption(cfg, tid):
    tpl = cfg["template"]
    ctx = {**cfg.category(tid), **cfg.track(tid), "id": tid, "style": cfg["style"]}
    ctx["sections"] = "\n".join(
        render(tpl["section"], {**ctx, **section}, f"{tid}.sections[{i}]")
        for i, section in enumerate(cfg.track(tid)["sections"])
    )
    lines = [render(tpl["description"], ctx, f"{tid}.description")]
    for block in tpl["blocks"]:
        lines.append(f"### {block['heading']}")
        lines.extend(
            render(line, ctx, f"{tid}.{block['heading']}") for line in block["lines"]
        )
    return "\n".join(lines)


def validate(cfg):
    errors, warnings = [], []
    ids = cfg.bgm_ids()
    gen, cats = cfg["generation"], cfg["categories"]
    for block in cfg["template"]["blocks"]:
        if block["heading"] not in API_HEADINGS:
            errors.append(
                f'template heading "{block["heading"]}" is not one of {API_HEADINGS}'
            )
    for name, cat in cats.items():
        loop = cat["loop"]
        if not 0 < loop["minKeepRatio"] <= 1:
            errors.append(f"category {name}: loop.minKeepRatio must be in (0, 1]")
        lo, hi = cat["durationRange"]
        if not lo <= cat["durationSeconds"] <= hi:
            errors.append(f"category {name}: durationSeconds outside durationRange")
    for tid in ids:
        if tid not in cfg["tracks"]:
            errors.append(f"{tid}: listed in content/audio.json bgm but has no caption")
            continue
        track = cfg.track(tid)
        if track.get("category") not in cats:
            errors.append(f'{tid}: unknown category "{track.get("category")}"')
            continue
        duration = cfg.duration(tid)
        lo, hi = cfg.category(tid)["durationRange"]
        if not lo <= duration <= hi:
            errors.append(
                f"{tid}: duration {duration}s outside category range [{lo}, {hi}]"
            )
        if not gen["minDurationSeconds"] <= duration <= gen["maxDurationSeconds"]:
            errors.append(f"{tid}: duration {duration}s outside model limits")
        if not track.get("sections"):
            errors.append(f"{tid}: needs at least one arrangement section")
        try:
            compose_caption(cfg, tid)
        except ValueError as error:
            errors.append(str(error))
    for tid in cfg["tracks"]:
        if tid not in ids:
            warnings.append(
                f"{tid}: caption exists but track is not in content/audio.json bgm (ignored)"
            )
    return errors, warnings


# ---------------------------------------------------------------- generation


def _crosery_ct():
    exe = shutil.which("crosery-ct")
    if not exe:
        raise SystemExit("crosery-ct not found on PATH")
    return exe


def generate_one(cfg, tid, exe):
    gen = cfg["generation"]
    raw_dir = cfg.path("rawDir")
    wav, pending, meta_path = (
        raw_dir / f"{tid}.wav",
        raw_dir / f"{tid}.pending",
        raw_dir / f"{tid}.json",
    )
    work = raw_dir / ".work" / tid
    caption = compose_caption(cfg, tid)
    duration = cfg.duration(tid)
    track = cfg.track(tid)
    args = {
        "caption": caption,
        "instrumental": True,
        "duration_seconds": duration,
        "output_name": f"{tid}.wav",
        "steps": gen["steps"],
        "guidance": gen["guidance"],
        "timeout_seconds": gen["timeoutSeconds"],
    }
    if track.get("seed") is not None:
        args["seed"] = track["seed"]
    attempts = 1 + int(gen["retries"])
    for attempt in range(1, attempts + 1):
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True, exist_ok=True)
        pending.write_text(
            json.dumps(
                {
                    "pid": os.getpid(),
                    "attempt": attempt,
                    "startedAt": datetime.datetime.now().astimezone().isoformat(),
                }
            )
        )
        if attempt > 1:
            time.sleep(float(gen["retryDelaySeconds"]))
        log(f"{tid}: generating {duration:.0f}s (attempt {attempt}/{attempts})")
        proc = subprocess.run(
            [
                exe,
                "call",
                gen["tool"],
                "--json-args",
                json.dumps(args),
                "--out-dir",
                str(work),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        pending.unlink(missing_ok=True)
        if proc.returncode == 0:
            try:
                result = json.loads(proc.stdout)
                artifact = Path(result["artifact"]["absolute"])
            except (ValueError, KeyError, TypeError):
                log(f"{tid}: unparseable tool output: {proc.stdout[-500:]}")
                continue
            shutil.move(str(artifact), wav)
            shutil.rmtree(work, ignore_errors=True)
            meta_path.write_text(
                json.dumps(
                    {
                        "id": tid,
                        "durationSeconds": duration,
                        "seed": result.get("seed"),
                        "steps": gen["steps"],
                        "guidance": gen["guidance"],
                        "attempt": attempt,
                        "generatedAt": datetime.datetime.now()
                        .astimezone()
                        .isoformat(timespec="seconds"),
                        "captionSha256": hashlib.sha256(
                            caption.encode("utf8")
                        ).hexdigest(),
                        "caption": caption,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf8",
            )
            log(f"{tid}: done -> {rel(wav)} (seed {result.get('seed')})")
            return True
        log(
            f"{tid}: attempt {attempt} failed (exit {proc.returncode}): {proc.stderr.strip()[-600:]}"
        )
    shutil.rmtree(work, ignore_errors=True)
    return False


def generate(cfg, ids, force):
    raw_dir = cfg.path("rawDir")
    raw_dir.mkdir(parents=True, exist_ok=True)
    exe = _crosery_ct()
    todo = []
    for tid in ids:
        if (raw_dir / f"{tid}.pending").exists():
            log(
                f"{tid}: a job is already submitted (pending marker) - not resubmitting"
            )
            continue
        if (raw_dir / f"{tid}.wav").exists() and not force:
            log(f"{tid}: raw WAV exists - skip (use --force to regenerate)")
            continue
        todo.append(tid)
    if not todo:
        return []
    with ThreadPoolExecutor(max_workers=int(cfg["generation"]["concurrency"])) as pool:
        ok = list(pool.map(lambda tid: generate_one(cfg, tid, exe), todo))
    work_root = raw_dir / ".work"
    if work_root.exists() and not any(work_root.iterdir()):
        work_root.rmdir()
    return [tid for tid, good in zip(todo, ok) if not good]


# ---------------------------------------------------------------- audio helpers


def ffmpeg(args, stdin=None):
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-y", *args],
        input=stdin,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed: {proc.stderr.decode(errors='replace')[-1500:]}"
        )
    return proc


def decode(path, sr, channels):
    proc = ffmpeg(
        [
            "-i",
            str(path),
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-ac",
            str(channels),
            "-ar",
            str(sr),
            "pipe:1",
        ]
    )
    return np.frombuffer(proc.stdout, dtype=np.float32).reshape(-1, channels).copy()


def pcm_input(sr, channels):
    return ["-f", "f32le", "-ar", str(sr), "-ac", str(channels), "-i", "pipe:0"]


def loudnorm_json(stderr):
    text = stderr.decode(errors="replace")
    start = text.rfind("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise RuntimeError(f"loudnorm produced no stats: {text[-800:]}")
    return json.loads(text[start : end + 1])


def moving_average(values, width):
    width = max(1, int(width))
    if width == 1:
        return values
    kernel = np.ones(width) / width
    return np.convolve(values, kernel, mode="same")


def frame_rms_db(mono, frame):
    count = len(mono) // frame
    blocks = mono[: count * frame].reshape(count, frame)
    return 10 * np.log10(np.mean(blocks.astype(np.float64) ** 2, axis=1) + 1e-12)


# ---------------------------------------------------------------- loop construction


def trim_silence(x, sr, proc):
    mono = x.mean(axis=1)
    frame = max(1, round(sr * proc["silenceFrameMs"] / 1000))
    db = frame_rms_db(mono, frame)
    loud = np.nonzero(db > proc["silenceThresholdDb"])[0]
    if loud.size == 0:
        raise RuntimeError("audio is silent")
    pad = int(proc["silencePadSeconds"] * sr)
    start = max(0, loud[0] * frame - pad)
    end = min(len(x), (loud[-1] + 1) * frame + pad)
    return x[start:end], start / sr, (len(x) - end) / sr


def musical_end(x, sr, proc):
    """End of the last passage at playing level - excludes a final ring-out / decay tail."""
    hop = proc["analysis"]["hop"]
    db = frame_rms_db(x.mean(axis=1), hop)
    power = moving_average(10 ** (db / 10), proc["tailSmoothingSeconds"] * sr / hop)
    smooth = 10 * np.log10(power + 1e-12)
    floor = np.median(db) - proc["tailDropDb"]
    playing = np.nonzero(smooth >= floor)[0]
    return len(x) if playing.size == 0 else min(len(x), (playing[-1] + 1) * hop)


def features(mono, sr, analysis):
    n_fft, hop = analysis["fftSize"], analysis["hop"]
    frames = sliding_window_view(mono, n_fft)[::hop] * np.hanning(n_fft).astype(
        np.float32
    )
    mag = np.abs(np.fft.rfft(frames, axis=1)).astype(np.float32)
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    band = (freqs >= analysis["chromaMinHz"]) & (freqs <= analysis["chromaMaxHz"])
    pitch_class = (np.round(12 * np.log2(freqs[band] / 440.0) + 69).astype(int)) % 12
    onehot = np.zeros((band.sum(), 12), dtype=np.float32)
    onehot[np.arange(band.sum()), pitch_class] = 1
    chroma = np.log1p((mag[:, band] ** 2) @ onehot)
    chroma /= np.linalg.norm(chroma, axis=1, keepdims=True) + 1e-9
    logmag = np.log1p(analysis["onsetLogCompression"] * mag[:, band])
    flux = np.maximum(np.diff(logmag, axis=0, prepend=logmag[:1]), 0).sum(axis=1)
    onset = np.maximum(
        flux - moving_average(flux, analysis["onsetDetrendSeconds"] * sr / hop), 0
    )
    level = 10 * np.log10(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12)
    return chroma, onset.astype(np.float64), level


def diagonal_window_sums(matrix, width):
    """S[i, j] = sum_{k<width} matrix[i-1-k, j-1-k] for i, j >= width (window ending before i, j)."""
    rows, cols = matrix.shape
    acc = np.zeros((rows + 1, cols + 1))
    for i in range(rows):
        acc[i + 1, 1:] = matrix[i] + acc[i, :-1]
    out = np.full((rows + 1, cols + 1), np.nan)
    out[width:, width:] = acc[width:, width:] - acc[:-width, :-width]
    return out


def window_sums(values, width):
    acc = np.concatenate([[0.0], np.cumsum(values)])
    out = np.full(len(values) + 1, np.nan)
    out[width:] = acc[width:] - acc[:-width]
    return out


def window_match(chroma, onset, level, rows, cols, width):
    """For every pair of frame boundaries (rows.start + i, cols.start + j) compare the `width`-frame
    windows ending there: mean chroma cosine, onset Pearson r, absolute mean-level difference (dB).
    Index [i, j]; entries without a full window are NaN."""
    chroma_mean = diagonal_window_sums(chroma[rows] @ chroma[cols].T, width) / width
    a, b = onset[rows], onset[cols]
    ab = diagonal_window_sums(np.outer(a, b), width)
    sa, saa = window_sums(a, width), window_sums(a * a, width)
    sb, sbb = window_sums(b, width), window_sums(b * b, width)
    var_a = np.maximum(saa - sa * sa / width, 1e-9)
    var_b = np.maximum(sbb - sb * sb / width, 1e-9)
    onset_r = (ab - np.outer(sa, sb) / width) / np.sqrt(np.outer(var_a, var_b))
    la = window_sums(level[rows], width) / width
    lb = window_sums(level[cols], width) / width
    return chroma_mean, onset_r, np.abs(np.subtract.outer(la, lb))


def find_loop(x, end, sr, proc, loop):
    """Pick loop start S (near the top) and end E (near the musical end) so that the audio before E
    matches the audio before S (the crossfaded material) and the audio after E matches the audio after
    S (what the listener expects next): harmony (chroma), beat phase (onset correlation) and level,
    minus a penalty for discarded material."""
    analysis, weights = proc["analysis"], proc["score"]
    n_fft, hop = analysis["fftSize"], analysis["hop"]
    offset = n_fft // 2
    xfade = round(loop["crossfadeSeconds"] * sr)
    chroma, onset, level = features(x.mean(axis=1), sr, analysis)
    frames = len(onset)
    width = max(
        math.ceil(xfade / hop), math.ceil(loop["similarityWindowSeconds"] * sr / hop)
    )
    follow = max(2, math.ceil(loop["followWindowSeconds"] * sr / hop))
    s_lo = max(width, math.ceil((xfade - offset) / hop))
    s_hi = min(frames - follow, s_lo + int(loop["startSearchSeconds"] * sr / hop))
    e_hi = min(frames, (end - offset) // hop)
    e_lo = max(s_lo + width, e_hi - int(loop["endSearchSeconds"] * sr / hop))
    if s_hi <= s_lo or e_hi <= e_lo:
        raise RuntimeError("track too short for the configured loop search windows")

    s_frames, e_frames = np.arange(s_lo, s_hi + 1), np.arange(e_lo, e_hi + 1)
    back = window_match(
        chroma,
        onset,
        level,
        slice(s_lo - width, s_hi),
        slice(e_lo - width, e_hi),
        width,
    )
    back_grid = np.ix_(s_frames - (s_lo - width), e_frames - (e_lo - width))
    fwd_cols = slice(e_lo, min(frames, e_hi + follow))
    fwd = window_match(
        chroma, onset, level, slice(s_lo, s_hi + follow), fwd_cols, follow
    )
    fwd_e = e_frames + follow - e_lo
    fwd_ok = fwd_e < fwd[0].shape[1]
    fwd_grid = np.ix_(s_frames + follow - s_lo, np.minimum(fwd_e, fwd[0].shape[1] - 1))
    (cb, rb, lb), (cf, rf, lf) = (
        [m[back_grid] for m in back],
        [m[fwd_grid] for m in fwd],
    )
    follow_term = (
        weights["followChroma"] * cf
        + weights["followOnset"] * rf
        - weights["levelPerDb"] * lf
    )
    follow_term = np.where(fwd_ok[None, :], np.nan_to_num(follow_term, nan=0.0), 0.0)

    # Seams inside quiet passages (outro ring-out -> sparse intro) leave an audible hole in the loop.
    playing = float(np.median(level[:e_hi]))
    mean_level = window_sums(level, width) / width
    quiet_s = np.maximum(playing - mean_level[s_frames], 0)[:, None]
    quiet_e = np.maximum(playing - mean_level[e_frames], 0)[None, :]
    quiet = weights["quietPerDb"] * (quiet_s + quiet_e) / 2

    s_pos = (s_frames * hop + offset)[:, None]
    e_pos = (e_frames * hop + offset)[None, :]
    lost = (s_pos + (end - e_pos)) / end
    score = (
        weights["chroma"] * cb
        + weights["onset"] * rb
        - weights["levelPerDb"] * lb
        + follow_term
        - quiet
        - weights["lostFraction"] * lost
    )
    score[(e_pos - s_pos) < loop["minKeepRatio"] * end] = -np.inf
    score[~np.isfinite(score)] = -np.inf
    if not np.isfinite(score.max()):
        raise RuntimeError("no loop candidate satisfies minKeepRatio")
    i, j = np.unravel_index(np.argmax(score), score.shape)
    return (
        int(s_pos[i, 0]),
        int(e_pos[0, j]),
        {
            "score": float(score[i, j]),
            "chroma": float(cb[i, j]),
            "onsetR": float(rb[i, j]),
            "levelDiffDb": float(lb[i, j]),
            "followChroma": float(cf[i, j]),
            "followOnsetR": float(rf[i, j]),
            "followLevelDiffDb": float(lf[i, j]),
            "quietDb": float((quiet_s[i, 0] + quiet_e[0, j]) / 2),
        },
    )


def refine_end(x, start, end, xfade, sr, refine):
    """Sample-accurate rhythmic alignment: shift E so transients before E line up with those before S."""
    step = max(1, int(sr * refine["envelopeMs"] / 1000))
    mono = x.mean(axis=1)
    hp = np.abs(np.diff(mono, prepend=mono[:1]))
    count = len(hp) // step
    env = hp[: count * step].reshape(count, step).mean(axis=1)
    env = np.maximum(np.diff(env, prepend=env[:1]), 0)
    win = max(8, xfade // step)
    max_lag = int(refine["maxLagMs"] / refine["envelopeMs"])
    s_i, e_i = start // step, end // step
    ref = env[s_i - win : s_i]
    best_lag, best_r = 0, -np.inf
    for lag in range(-max_lag, max_lag + 1):
        lo, hi = e_i - win + lag, e_i + lag
        if lo < 0 or hi > len(env):
            continue
        r = np.corrcoef(ref, env[lo:hi])[0, 1]
        if np.isfinite(r) and r > best_r:
            best_lag, best_r = lag, r
    return (
        min(len(x), end + best_lag * step),
        float(best_r),
        best_lag * step / sr * 1000,
    )


def build_loop(x, start, end, xfade, curve):
    """Loop of length E-S: A[S:E-X] then A[E-X:E] fading out over A[S-X:S] fading in.
    The last sample therefore continues into A[S], the first sample of the file."""
    t = (np.arange(xfade) + 0.5) / xfade
    if curve == "equal_power":
        fade_in, fade_out = np.sin(t * np.pi / 2), np.cos(t * np.pi / 2)
    elif curve == "linear":
        fade_in, fade_out = t, 1 - t
    else:
        raise ValueError(f'unknown crossfadeCurve "{curve}"')
    tail = x[end - xfade : end] * fade_out[:, None]
    head = x[start - xfade : start] * fade_in[:, None]
    return np.concatenate([x[start : end - xfade], tail + head]).astype(np.float32)


def align_lag(reference, processed, sr, max_ms):
    """Lag (samples) of processed vs reference, measured on a 1 s window in the middle."""
    max_lag = int(sr * max_ms / 1000)
    mid = len(reference) // 2
    ref = reference[mid : mid + sr].mean(axis=1)
    best, best_r = 0, -np.inf
    for lag in range(-max_lag, max_lag + 1):
        seg = processed[mid + lag : mid + lag + sr].mean(axis=1)
        if len(seg) != len(ref):
            continue
        r = float(
            np.dot(ref, seg) / (np.linalg.norm(ref) * np.linalg.norm(seg) + 1e-12)
        )
        if r > best_r:
            best, best_r = lag, r
    return best


def measure_pcm(y, sr, channels, loud):
    base = (
        f"loudnorm=I={loud['integratedLufs']}:TP={loud['truePeakDb']}:LRA={loud['lra']}"
    )
    args = [
        *pcm_input(sr, channels),
        "-af",
        f"{base}:print_format=json",
        "-f",
        "null",
        "-",
    ]
    return loudnorm_json(ffmpeg(args, stdin=y.tobytes()).stderr)


def normalize_loudness(y, sr, channels, loud, measured, aim):
    """Second loudnorm pass (with first-pass stats) applied to a circularly padded copy so any dynamic
    gain state is identical on both sides of the loop seam, then cut back to the exact loop."""
    lra = loud["lra"]
    if loud.get("preserveDynamics"):
        lra = min(
            LOUDNORM_LRA_MAX,
            max(lra, float(measured["input_lra"]) + loud["lraMarginLu"]),
        )
    pad = min(len(y), int(loud["seamPadSeconds"] * sr))
    padded = np.concatenate([y[-pad:], y, y[:pad]])
    second = (
        f"loudnorm=I={aim}:TP={loud['truePeakDb']}:LRA={lra}"
        f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
        f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
        f":offset={measured['target_offset']}:linear=true:print_format=json"
    )
    args = [
        *pcm_input(sr, channels),
        "-af",
        second,
        "-ar",
        str(sr),
        "-f",
        "f32le",
        "pipe:1",
    ]
    out = ffmpeg(args, stdin=padded.tobytes())
    z = np.frombuffer(out.stdout, dtype=np.float32).reshape(-1, channels)
    lag = align_lag(padded, z, sr, loud["alignSearchMs"])
    cut = np.ascontiguousarray(z[pad + lag : pad + lag + len(y)])
    if len(cut) != len(y):
        raise RuntimeError("loudnorm output shorter than expected")
    return cut, loudnorm_json(out.stderr).get("normalization_type"), int(lag)


def normalize_and_encode(y, sr, channels, proc, mp3):
    """Loudnorm + MP3 encode. The codec low-pass and loudnorm's dynamic fallback both shift the measured
    result, so the target is re-aimed while the encoded file is off by more than aimToleranceLu - but a
    re-aim that would push linear (pure gain) normalisation into dynamic mode is not taken."""
    loud = proc["loudness"]
    target, ceiling = float(loud["integratedLufs"]), float(loud["truePeakDb"])
    measured = measure_pcm(y, sr, channels, loud)
    aim = target
    for attempt in range(int(loud["maxCorrections"]) + 1):
        cut, mode, lag = normalize_loudness(y, sr, channels, loud, measured, aim)
        encode_mp3(cut, sr, channels, mp3, proc["encode"])
        final = measure_file(mp3)
        if abs(final["lufs"] - target) <= loud["aimToleranceLu"]:
            break
        lo, hi = LOUDNORM_I_RANGE
        next_aim = min(hi, max(lo, aim + (target - final["lufs"])))
        stays_linear = (
            float(measured["input_tp"]) + next_aim - float(measured["input_i"])
            <= ceiling
        )
        if mode == "linear" and not stays_linear:
            break
        aim = next_aim
    return (
        final,
        len(cut),
        {
            "inputLufs": float(measured["input_i"]),
            "inputTruePeakDb": float(measured["input_tp"]),
            "inputLra": float(measured["input_lra"]),
            "mode": mode,
            "targetUsed": round(aim, 2),
            "corrections": attempt,
            "alignLagSamples": lag,
        },
    )


def seam_check(path, sr, channels, window_ms):
    """Level change across the loop seam vs. the level changes found everywhere else in the file
    (same window size): a seam percentile near the middle means the seam is as smooth as the music."""
    z = decode(path, sr, channels).mean(axis=1)
    n = max(1, int(sr * window_ms / 1000))
    levels = frame_rms_db(np.concatenate([z, z[:n]]), n)
    jumps = np.abs(np.diff(levels[:-1]))
    seam = abs(float(frame_rms_db(z[-n:], n)[0]) - float(frame_rms_db(z[:n], n)[0]))
    typical = float(np.median(np.abs(np.diff(z)))) + 1e-9
    return {
        "decodedSamples": len(z),
        "levelJumpDb": round(seam, 2),
        "levelJumpPercentile": round(float(np.mean(jumps < seam)) * 100, 1),
        "sampleJumpRatio": round(abs(float(z[-1]) - float(z[0])) / typical, 2),
    }


def encode_mp3(y, sr, channels, out_path, encode):
    ffmpeg(
        [
            *pcm_input(sr, channels),
            "-c:a",
            encode["codec"],
            "-b:a",
            f"{encode['bitrateKbps']}k",
            "-ar",
            str(sr),
            "-ac",
            str(channels),
            str(out_path),
        ],
        stdin=y.tobytes(),
    )


def probe(path):
    proc = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,bit_rate:stream=codec_name,sample_rate,channels",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    info = json.loads(proc.stdout)
    stream = info["streams"][0]
    return {
        "codec": stream["codec_name"],
        "sampleRate": int(stream["sample_rate"]),
        "channels": int(stream["channels"]),
        "bitRate": int(info["format"].get("bit_rate", 0)),
        "durationSeconds": float(info["format"]["duration"]),
    }


def measure_file(path):
    stats = loudnorm_json(
        ffmpeg(
            ["-i", str(path), "-af", "loudnorm=print_format=json", "-f", "null", "-"]
        ).stderr
    )
    return {
        "lufs": float(stats["input_i"]),
        "truePeakDb": float(stats["input_tp"]),
        "lra": float(stats["input_lra"]),
    }


def process_one(cfg, tid):
    proc = cfg["processing"]
    sr, channels = int(proc["sampleRate"]), int(proc["channels"])
    loop = cfg.category(tid)["loop"]
    wav = cfg.path("rawDir") / f"{tid}.wav"
    out_dir = cfg.path("outDir")
    out_dir.mkdir(parents=True, exist_ok=True)
    mp3 = out_dir / f"{tid}.mp3"

    x = decode(wav, sr, channels)
    raw_seconds = len(x) / sr
    x, head_trim, tail_trim = trim_silence(x, sr, proc)
    end = musical_end(x, sr, proc)
    xfade = round(loop["crossfadeSeconds"] * sr)
    start, stop, match = find_loop(x, end, sr, proc, loop)
    stop, align_r, shift_ms = refine_end(x, start, stop, xfade, sr, proc["refine"])
    # FFmpeg-based MP3 decoders (incl. Chrome) round the last frame up when it holds fewer than
    # minLastFrameSamples real samples, breaking sample-exact gapless length: nudge E back (< 1.1 ms).
    frame, min_last = (
        proc["encode"]["frameSamples"],
        proc["encode"]["minLastFrameSamples"],
    )
    residue = (stop - start) % frame
    if 0 < residue < min_last:
        stop -= residue
    y = build_loop(x, start, stop, xfade, proc["crossfadeCurve"])
    final, samples, loudness = normalize_and_encode(y, sr, channels, proc, mp3)

    info = probe(mp3)
    expected = samples / sr
    problems = []
    if info["codec"] != "mp3":
        problems.append(f"codec {info['codec']}")
    if info["sampleRate"] != sr:
        problems.append(f"sample rate {info['sampleRate']}")
    if info["channels"] != channels:
        problems.append(f"channels {info['channels']}")
    if (
        abs(info["bitRate"] / 1000 - proc["encode"]["bitrateKbps"])
        > proc["encode"]["bitrateToleranceKbps"]
    ):
        problems.append(f"bit rate {info['bitRate']}")
    if abs(info["durationSeconds"] - expected) > proc["verifyToleranceSeconds"]:
        problems.append(f"duration {info['durationSeconds']:.2f}s != {expected:.2f}s")
    if (
        abs(final["lufs"] - proc["loudness"]["integratedLufs"])
        > proc["loudness"]["toleranceLu"]
    ):
        problems.append(f"loudness {final['lufs']:.1f} LUFS")
    if final["truePeakDb"] > proc["loudness"]["maxEncodedTruePeakDb"]:
        problems.append(f"true peak {final['truePeakDb']:.1f} dBTP")
    seam = seam_check(mp3, sr, channels, proc["seamWindowMs"])
    seam["expectedSamples"] = samples
    if abs(seam["decodedSamples"] - samples) > proc["gaplessToleranceSamples"]:
        problems.append(
            f"decoded {seam['decodedSamples']} samples != {samples} (gapless info)"
        )
    entry = {
        "id": tid,
        "file": str(rel(mp3)),
        "rawSeconds": round(raw_seconds, 2),
        "trimmedHeadSeconds": round(head_trim, 3),
        "trimmedTailSeconds": round(tail_trim, 3),
        "decayCutSeconds": round((len(x) - end) / sr, 2),
        "loop": {
            "startSeconds": round(start / sr, 3),
            "endSeconds": round(stop / sr, 3),
            "crossfadeSeconds": loop["crossfadeSeconds"],
            "alignShiftMs": round(shift_ms, 1),
            "alignR": round(align_r, 3),
            **{k: round(v, 3) for k, v in match.items()},
        },
        "loudnorm": loudness,
        "seam": seam,
        "output": {
            **info,
            "durationSeconds": round(info["durationSeconds"], 3),
            "bytes": mp3.stat().st_size,
            **final,
        },
        "ok": not problems,
        "problems": problems,
    }
    log(
        f"{tid}: {raw_seconds:.1f}s raw -> loop {start / sr:.2f}-{stop / sr:.2f}s = {expected:.2f}s, "
        f"{final['lufs']:.1f} LUFS / TP {final['truePeakDb']:.1f} dB, loudnorm {loudness['mode']}"
        + (f"  PROBLEMS: {problems}" if problems else "")
    )
    return entry


def process(cfg, ids):
    report_path = cfg.path("report")
    report = (
        json.loads(report_path.read_text(encoding="utf8"))
        if report_path.exists()
        else {}
    )
    failed = []
    for tid in ids:
        if not (cfg.path("rawDir") / f"{tid}.wav").exists():
            log(f"{tid}: no raw WAV - skip processing")
            failed.append(tid)
            continue
        try:
            entry = process_one(cfg, tid)
        except (
            RuntimeError,
            ValueError,
            KeyError,
            OSError,
            subprocess.CalledProcessError,
        ) as error:
            log(f"{tid}: processing failed: {error}")
            failed.append(tid)
            continue
        meta = cfg.path("rawDir") / f"{tid}.json"
        if meta.exists():
            entry["seed"] = json.loads(meta.read_text(encoding="utf8")).get("seed")
        report[tid] = entry
        if not entry["ok"]:
            failed.append(tid)
        report_path.write_text(
            json.dumps(dict(sorted(report.items())), ensure_ascii=False, indent=2)
            + "\n",
            encoding="utf8",
        )
    return failed


# ---------------------------------------------------------------- docs & manifest


def write_docs(cfg):
    docs = cfg.path("docs")
    report_path = cfg.path("report")
    report = (
        json.loads(report_path.read_text(encoding="utf8"))
        if report_path.exists()
        else {}
    )
    names = cfg.bgm_names()
    rows = [
        "| id | 名称 | category | BPM | key | requested | loop (MP3) | LUFS | caption summary |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for tid in cfg.bgm_ids():
        track = cfg["tracks"].get(tid)
        if track is None:
            rows.append(
                f"| `{tid}` | {names.get(tid, '')} | - | - | - | - | missing caption | - | - |"
            )
            continue
        entry = report.get(tid)
        loop = f"{entry['output']['durationSeconds']:.1f} s" if entry else "not built"
        lufs = f"{entry['output']['lufs']:.1f}" if entry else "-"
        rows.append(
            f"| `{tid}` | {names.get(tid, '')} | {track['category']} | {track['bpm']} | "
            f"{track['key']} {track['scale']} | {cfg.duration(tid):.0f} s | {loop} | {lufs} | "
            f"{track['genre']} — {track['description']} |"
        )
    block = "\n".join([DOCS_BEGIN, *rows, DOCS_END])
    text = (
        docs.read_text(encoding="utf8")
        if docs.exists()
        else f"# Music\n\n{DOCS_BEGIN}\n{DOCS_END}\n"
    )
    if DOCS_BEGIN not in text or DOCS_END not in text:
        text = text.rstrip() + f"\n\n{DOCS_BEGIN}\n{DOCS_END}\n"
    head, rest = text.split(DOCS_BEGIN, 1)
    tail = rest.split(DOCS_END, 1)[1]
    docs.write_text(head + block + tail, encoding="utf8")
    log(f"docs: wrote track table to {rel(docs)}")


def build_manifest(cfg):
    tool = cfg.path("manifestTool")
    if tool.exists():
        subprocess.run([sys.executable, str(tool)], check=True, cwd=ROOT)
        log(f"manifest: ran {rel(tool)}")
    else:
        log(f"manifest: {rel(tool)} not present - skipped")


# ---------------------------------------------------------------- cli


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "command", choices=["validate", "caption", "generate", "process", "docs", "all"]
    )
    parser.add_argument(
        "ids", nargs="*", help="track ids (default: every bgm id in content/audio.json)"
    )
    parser.add_argument(
        "--force", action="store_true", help="regenerate even if the raw WAV exists"
    )
    parser.add_argument("--captions", default=str(DEFAULT_CAPTIONS))
    opts = parser.parse_args()
    cfg = Config(opts.captions)

    errors, warnings = validate(cfg)
    for warning in warnings:
        log("warning:", warning)
    if errors:
        for error in errors:
            log("error:", error)
        sys.exit(1)

    known = cfg.bgm_ids()
    unknown = [tid for tid in opts.ids if tid not in known]
    if unknown:
        sys.exit(f"unknown track ids (not in content/audio.json bgm): {unknown}")
    ids = opts.ids or known

    if opts.command == "validate":
        log(f"ok: {len(known)} tracks have valid captions")
    elif opts.command == "caption":
        for tid in ids:
            print(
                f"--- {tid} ({cfg.duration(tid):.0f}s)\n{compose_caption(cfg, tid)}\n"
            )
    elif opts.command == "generate":
        failed = generate(cfg, ids, opts.force)
        sys.exit(f"generation failed: {failed}" if failed else 0)
    elif opts.command == "process":
        failed = process(cfg, ids)
        build_manifest(cfg)
        sys.exit(f"processing failed: {failed}" if failed else 0)
    elif opts.command == "docs":
        write_docs(cfg)
    else:
        gen_failed = generate(cfg, ids, opts.force)
        proc_failed = process(cfg, [tid for tid in ids if tid not in gen_failed])
        write_docs(cfg)
        build_manifest(cfg)
        failed = sorted(set(gen_failed) | set(proc_failed))
        sys.exit(f"failed: {failed}" if failed else 0)


if __name__ == "__main__":
    main()
