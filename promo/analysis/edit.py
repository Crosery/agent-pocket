"""Render the promo soundtrack (audio/trailer.wav) from data/music.json.

  raw Music3 take -> resample -> fades -> synthetic reverb tail -> loudness normalisation (ffmpeg loudnorm, 2 pass)

Run from promo/:  uv run --with librosa --with soundfile --with scipy python analysis/edit.py
"""

# pyright: reportMissingImports=false
import json
import subprocess
import sys
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy.signal import fftconvolve

ROOT = Path(__file__).resolve().parent.parent
FFMPEG = "/opt/homebrew/bin/ffmpeg"


def main():
    cfg = json.loads((ROOT / "data/music.json").read_text())
    sr = cfg["sampleRate"]
    y, _ = librosa.load(ROOT / cfg["source"], sr=sr, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    n = y.shape[1]

    fi = int(cfg["fadeInSec"] * sr)
    y[:, :fi] *= np.linspace(0, 1, fi)[None, :]

    # reverb tail: the last seconds convolved with a decaying stereo noise IR, appended past the end
    tail = cfg["tail"]
    tn = int(tail["seconds"] * sr)
    rng = np.random.default_rng(7)
    ir_len = int(tail["rt60"] * sr)
    decay = np.exp(-6.9 * np.arange(ir_len) / ir_len)  # -60 dB over rt60
    ir = rng.standard_normal((2, ir_len)) * decay[None, :]
    ir /= np.sqrt((ir**2).sum(axis=1, keepdims=True))
    seg = y[:, int(tail["fromSec"] * sr) :]
    wet = np.stack([fftconvolve(seg[c], ir[c]) for c in range(2)])
    out = np.zeros((2, n + tn), dtype=np.float32)
    out[:, :n] = y
    start = int(tail["fromSec"] * sr)
    wl = min(wet.shape[1], out.shape[1] - start)
    # wet only fades in after the dry fade-out begins, so the body is untouched
    fo0 = int(cfg["fadeOutStartSec"] * sr)
    wmix = np.zeros(wl)
    k0 = max(0, fo0 - start)
    wmix[k0:] = np.linspace(0, 1, wl - k0) ** 0.5 * tail["wet"]
    out[:, start : start + wl] += wet[:, :wl] * wmix[None, :]
    fo = int(cfg["fadeOutSec"] * sr)
    ramp = np.ones(out.shape[1])
    ramp[fo0 : fo0 + fo] = np.linspace(1, 0, fo) ** 2
    ramp[fo0 + fo :] = 0
    dry = np.zeros_like(out)
    dry[:, :n] = y * ramp[None, :n]
    out[:, :n] = dry[:, :n] + (out[:, :n] - y)  # dry fades, wet stays
    # final gentle fade of the whole thing over the last 0.6 s
    e = int(0.6 * sr)
    out[:, -e:] *= np.linspace(1, 0, e)[None, :] ** 2

    tmp = ROOT / "audio/.trailer_pre.wav"
    sf.write(tmp, out.T, sr, subtype="FLOAT")
    L = cfg["loudness"]
    p1 = subprocess.run(  # noqa: PLW1510
        [
            FFMPEG,
            "-hide_banner",
            "-i",
            str(tmp),
            "-af",
            f"loudnorm=I={L['integratedLufs']}:TP={L['truePeakDb']}:LRA={L['lra']}:print_format=json",
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
        f"loudnorm=I={L['integratedLufs']}:TP={L['truePeakDb']}:LRA={L['lra']}:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
        f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
    )
    outp = ROOT / cfg["output"]
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
    info = sf.info(outp)
    print(
        f"wrote {outp} {info.duration:.3f}s {info.samplerate}Hz  (input I={m['input_i']} LUFS, TP={m['input_tp']})"
    )


if __name__ == "__main__":
    sys.exit(main())
