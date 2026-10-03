"""Mix the promo soundtrack: music + sound design -> audio/final.wav (the file the video is muxed with).

  audio/trailer.wav (music, from analysis/edit.py)
  + every event in data/sfx_events.json (exported from the scenes: `bun scripts/render.ts sfx`)
    rendered from the game's own chiptune SFX recipes (audio/game/sfx.json) or data/sfx.json `recipes`
  -> a short hall reverb on the SFX bus -> trimmed to the film -> picture-synced fade + held silence
  -> loudness normalisation (ffmpeg loudnorm, 2 pass) to data/sfx.json master.

The recipe synth is a numpy re-implementation of the format's semantics (pulse/square/triangle/sine/noise,
ADSR gate envelope, exponential pitch/filter sweeps, notes/step, repeat, vibrato, FM, bend): it reads the game's
recipe data, not its code.

Run from promo/:  uv run --with numpy --with soundfile --with scipy python analysis/mix.py
"""

# pyright: reportMissingImports=false
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import fftconvolve, resample_poly

ROOT = Path(__file__).resolve().parent.parent
FFMPEG = "/opt/homebrew/bin/ffmpeg"
HARMONICS = 48
DEFAULT_ENV = [0.003, 0.05, 0.7, 0.05]
DEFAULT_Q = 0.7
NOTE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def note_freq(name: str) -> float:
    m = re.fullmatch(r"([A-G])([#b]?)(-?\d+)", name)
    if not m:
        raise ValueError(f"bad note {name}")
    midi = (
        12 * (int(m.group(3)) + 1)
        + NOTE[m.group(1)]
        + (1 if m.group(2) == "#" else -1 if m.group(2) == "b" else 0)
    )
    return 440.0 * 2 ** ((midi - 69) / 12)


class Synth:
    def __init__(self, sr: int):
        self.sr = sr
        rng = np.random.default_rng(12345)
        self.noise = rng.uniform(-1, 1, sr * 3).astype(np.float64)

    # ---- oscillators (band-limited by additive synthesis, peak ~1 like WebAudio's normalised waves)
    def wave(
        self, kind: str, phase: np.ndarray, freq: np.ndarray, duty: float
    ) -> np.ndarray:
        nyq = self.sr / 2
        fmax = max(1.0, float(np.max(freq)))
        nmax = int(max(1, min(HARMONICS, nyq // fmax)))
        if kind == "sine":
            return np.sin(phase)
        if kind == "triangle":
            out = np.zeros_like(phase)
            for n in range(1, nmax + 1, 2):
                out += ((-1) ** ((n - 1) // 2)) * np.sin(n * phase) / (n * n)
            return out * (8 / np.pi**2)
        if kind in ("square", "pulse"):
            d = 0.5 if kind == "square" else min(0.95, max(0.05, duty))
            out = np.zeros_like(phase)
            for n in range(1, nmax + 1):
                out += np.sin(n * np.pi * d) / n * np.cos(n * (phase - np.pi * d))
            pk = np.max(np.abs(out)) or 1.0
            return out / pk
        raise ValueError(kind)

    def envelope(self, env, gate: float, n: int) -> np.ndarray:
        a, d, s, r = env
        A, D = max(1e-3, a), max(1e-3, d)
        R = max(0.004, r)
        t = np.arange(n) / self.sr
        e = np.zeros(n)
        # gate shorter than the attack/decay: the level reached at the gate is where the release starts
        if gate <= A:
            lvl = gate / A
            m = t < gate
            e[m] = t[m] / A
        else:
            m1 = t < A
            e[m1] = t[m1] / A
            if gate < A + D:
                lvl = 1 + (s - 1) * ((gate - A) / D)
                m2 = (t >= A) & (t < gate)
                e[m2] = 1 + (s - 1) * ((t[m2] - A) / D)
            else:
                lvl = s
                m2 = (t >= A) & (t < A + D)
                e[m2] = 1 + (s - 1) * ((t[m2] - A) / D)
                e[(t >= A + D) & (t < gate)] = s
        mr = (t >= gate) & (t < gate + R)
        e[mr] = lvl * np.exp(-(t[mr] - gate) / (R / 4))
        return e

    def biquad(
        self, x: np.ndarray, ftype: str, f0: float, f1, q: float, dur: float
    ) -> np.ndarray:
        sr, n = self.sr, len(x)
        y = np.zeros(n)
        x1 = x2 = y1 = y2 = 0.0
        B = 32
        for i0 in range(0, n, B):
            tt = i0 / sr
            f = f0 if f1 is None else f0 * (f1 / f0) ** min(1.0, tt / max(1e-3, dur))
            f = min(sr / 2 - 1, max(10.0, f))
            w = 2 * np.pi * f / sr
            alpha = np.sin(w) / (2 * q)
            cw = np.cos(w)
            if ftype == "lowpass":
                b0, b1, b2 = (1 - cw) / 2, 1 - cw, (1 - cw) / 2
            elif ftype == "highpass":
                b0, b1, b2 = (1 + cw) / 2, -(1 + cw), (1 + cw) / 2
            elif ftype == "bandpass":  # constant 0 dB peak gain (WebAudio)
                b0, b1, b2 = alpha, 0.0, -alpha
            else:
                raise ValueError(ftype)
            a0, a1, a2 = 1 + alpha, -2 * cw, 1 - alpha
            b0, b1, b2, a1, a2 = b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0
            for i in range(i0, min(n, i0 + B)):
                xi = x[i]
                yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
                x2, x1, y2, y1 = x1, xi, y1, yi
                y[i] = yi
        return y

    def voice(
        self, L: dict, f: float, gate: float, gain: float, pitch: float
    ) -> np.ndarray:
        env = L.get("env", DEFAULT_ENV)
        R = max(0.004, env[3])
        n = int((gate + R) * self.sr) + 1
        t = np.arange(n) / self.sr
        if L["wave"] == "noise":
            k = (
                int(
                    abs(hash((L.get("dur"), L.get("gain"), f)))
                    % (len(self.noise) - n - 1)
                )
                if len(self.noise) > n + 1
                else 0
            )
            x = self.noise[k : k + n].copy()
        else:
            fr = np.full(n, f)
            if L.get("bend"):
                pts = L["bend"]
                xs = np.linspace(0, gate, len(pts))
                fr = f * 2 ** (np.interp(t, xs, pts) / 12)
            elif L.get("to") is not None:
                f1 = L["to"] * pitch
                fr = f * (f1 / f) ** np.clip(t / max(1e-3, gate), 0, 1)
            if L.get("vibrato"):
                v = L["vibrato"]
                ramp = np.clip(t / 0.08, 0, 1)
                fr = fr * 2 ** (
                    v["depth"] * ramp * np.sin(2 * np.pi * v["rate"] * t) / 12
                )
            if L.get("fm"):
                fm = L["fm"]
                dev = fm["index"] * f * (0.1 + 0.9 * np.exp(-t / max(1e-3, gate / 3)))
                fr = fr + dev * np.sin(2 * np.pi * f * fm["ratio"] * t)
            phase = 2 * np.pi * np.cumsum(fr) / self.sr
            x = self.wave(L["wave"], phase, fr, L.get("duty", 0.5))
        if L.get("filter"):
            F = L["filter"]
            fp = 1 if L["wave"] == "noise" else pitch
            x = self.biquad(
                x,
                F["type"],
                F["freq"] * fp,
                None if F.get("to") is None else F["to"] * fp,
                F.get("q", DEFAULT_Q),
                gate,
            )
        return x * self.envelope(env, gate, n) * gain * L.get("gain", 1.0)

    def recipe(self, R: dict, pitch: float = 1.0) -> np.ndarray:
        parts = []
        for L in R["layers"]:
            reps = max(1, L.get("repeat", {}).get("count", 1))
            every = L.get("repeat", {}).get("every", 0)
            base = (
                L["freq"]
                if "freq" in L
                else note_freq(L["note"])
                if "note" in L
                else 440.0
            ) * pitch
            for r in range(reps):
                t0 = L.get("at", 0) + r * every
                if L.get("notes"):
                    step = L.get("step", L["dur"])
                    for i, nn in enumerate(L["notes"]):
                        f = (
                            base * 2 ** (nn / 12)
                            if isinstance(nn, (int, float))
                            else note_freq(nn) * pitch
                        )
                        parts.append(
                            (t0 + i * step, self.voice(L, f, L["dur"], 1.0, pitch))
                        )
                else:
                    parts.append((t0, self.voice(L, base, L["dur"], 1.0, pitch)))
        n = max(int(t * self.sr) + len(x) for t, x in parts)
        out = np.zeros(n)
        for t, x in parts:
            i = int(t * self.sr)
            out[i : i + len(x)] += x
        return out * R.get("gain", 1.0)


def hall_ir(sr: int, rt60: float, predelay: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(rt60 * sr)
    decay = np.exp(-6.9 * np.arange(n) / n)
    ir = rng.standard_normal((2, n)) * decay[None, :]
    ir /= np.sqrt((ir**2).sum(axis=1, keepdims=True))
    pad = np.zeros((2, int(predelay * sr)))
    return np.concatenate([pad, ir], axis=1)


def main():
    S = json.loads((ROOT / "data/sfx.json").read_text())
    EV = json.loads((ROOT / "data/sfx_events.json").read_text())
    MU = json.loads((ROOT / "data/music.json").read_text())
    sr = S["sampleRate"]
    recipes = {
        **json.loads((ROOT / S["recipesFrom"]).read_text())["sfx"],
        **S["recipes"],
    }
    syn = Synth(sr)

    music, msr = sf.read(ROOT / MU["output"], always_2d=True)
    music = music.T.astype(np.float64)
    if msr != sr:
        music = resample_poly(music, sr, msr, axis=1)
    dur = float(EV["duration"])
    n = round(dur * sr)
    out = np.zeros((2, n))
    out[:, : min(n, music.shape[1])] = music[:, :n]
    # ducking: the music dips under chosen events (data/sfx.json duck), a short attack/hold/release in dB
    duck_db = np.zeros(n)
    for D_ in S.get("duck", []):
        a, h, r = (int(D_[k] * sr) for k in ("attackSec", "holdSec", "releaseSec"))
        shape = np.concatenate([np.linspace(0, 1, max(1, a)), np.ones(h), np.linspace(1, 0, max(1, r))]) * D_["db"]
        for e in EV["events"]:
            if e["id"] not in D_["ids"] or ("plates" in D_ and e.get("plate") not in D_["plates"]):
                continue
            i0 = max(0, round(e["t"] * sr) - a)
            j0 = min(n, i0 + len(shape))
            duck_db[i0:j0] = np.minimum(duck_db[i0:j0], shape[: j0 - i0])
    out *= (10 ** (duck_db / 20))[None, :]

    bus = np.zeros((2, n + sr * 3))
    cache: dict = {}
    missing = set()
    for e in EV["events"]:
        layers = S["sounds"].get(e["id"])
        if not layers:
            missing.add(e["id"])
            continue
        for L in layers:
            p = L.get("pitch", 1.0) * e.get("pitch", 1.0)
            key = (L["recipe"], round(p, 5))
            if key not in cache:
                x = syn.recipe(recipes[L["recipe"]], p)
                cache[key] = x / (np.max(np.abs(x)) or 1.0)
            x = cache[key] * 10 ** (L["db"] / 20) * 10 ** (e.get("gain", 0) / 20)
            i = round(e["t"] * sr)
            j = min(bus.shape[1], i + len(x))
            bus[:, i:j] += x[: j - i][None, :]
    if missing:
        print("no sound for:", ", ".join(sorted(missing)))
    rv = S["reverb"]
    ir = hall_ir(sr, rv["rt60"], rv["predelaySec"], rv["seed"])
    wet = np.stack([fftconvolve(bus[c], ir[c])[: bus.shape[1]] for c in range(2)])
    sfx = bus + wet * rv["wet"]
    out += sfx[:, :n]

    # picture-synced ending: the fade ends where the picture reaches black, then silence
    M = S["master"]
    f1 = n - int(M["blackSec"] * sr)
    f0 = f1 - int(M["fadeOutSec"] * sr)
    ramp = np.ones(n)
    ramp[f0:f1] = np.linspace(1, 0, f1 - f0) ** 2
    ramp[f1:] = 0
    out *= ramp[None, :]

    tmp = ROOT / "audio/.final_pre.wav"
    sf.write(tmp, out.T, sr, subtype="FLOAT")
    lo = f"loudnorm=I={M['integratedLufs']}:TP={M['truePeakDb']}:LRA={M['lra']}"
    p1 = subprocess.run(  # noqa: PLW1510 (loudnorm prints its measurement on stderr; a failure surfaces as a JSON parse error)
        [
            FFMPEG,
            "-hide_banner",
            "-i",
            str(tmp),
            "-af",
            lo + ":print_format=json",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
    )
    js = p1.stderr[p1.stderr.rfind("{") : p1.stderr.rfind("}") + 1]
    m = json.loads(js)
    af = (
        f"{lo}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
        f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
    )
    outp = ROOT / MU["mix"]["output"]
    subprocess.run(
        [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(tmp),
            "-af",
            af,
            "-ar",
            str(sr),
            "-c:a",
            "pcm_s24le",
            str(outp),
        ],
        check=True,
    )
    tmp.unlink()
    y, _ = sf.read(outp, always_2d=True)
    y = y[:n]
    # loudnorm resamples internally and may add a few samples: pin the length to the film
    if len(y) != n:
        z = np.zeros((n, 2))
        z[: min(n, len(y))] = y[:n]
        sf.write(outp, z, sr, subtype="PCM_24")
    print(
        f"wrote {outp}  {n / sr:.3f}s  events {len(EV['events'])}  sounds {len(cache)}  (pre: I={m['input_i']} LUFS TP={m['input_tp']})"
    )


if __name__ == "__main__":
    sys.exit(main())
