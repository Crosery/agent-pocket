"""Music analysis -> data/audio.json  (beat grid, downbeats, sections, envelopes, onsets)

  * constant-tempo grid fitted to percussive + mix onset envelopes (Music3 renders at one tempo),
    each beat then snapped to a strong percussive attack within +-SNAP s when there is one
    (residuals median-smoothed, so the grid stays regular where the music is soft),
  * downbeats = every 4th beat from data/music.json grid.firstDownbeatBeat (read off the
    arrangement: the bass enters, the breakdown starts and the final chord lands on those beats),
  * sections from data/music.json (in bars),
  * 100 fps normalised envelopes (rms / low / mid / high / perc / harm),
  * onsets: kick (<150 Hz attacks), hit (broadband percussive), note (harmonic attacks).

Run from promo/:  uv run --with librosa --with soundfile --with scipy --with matplotlib python analysis/analyze.py [--plot]
"""

# pyright: reportMissingImports=false
import json
import sys
from pathlib import Path

import librosa
import numpy as np
from scipy.ndimage import median_filter
from scipy.signal import find_peaks

ROOT = Path(__file__).resolve().parent.parent
SR = 22050
FPS = 100
SNAP = 0.035


def norm01(x, pct=99.0):
    return np.clip(x / (np.percentile(x, pct) + 1e-12), 0, 1)


def env(x, hop):
    r = librosa.feature.rms(y=x, frame_length=2048, hop_length=hop)[0]
    return r


def main():
    cfg = json.loads((ROOT / "data/music.json").read_text())
    y, _ = librosa.load(ROOT / cfg["output"], sr=SR, mono=True)
    dur = len(y) / SR
    H, P = librosa.effects.hpss(y)

    # ---- grid
    hop = 128
    ofps = SR / hop
    op = librosa.onset.onset_strength(y=P, sr=SR, hop_length=hop)
    om = librosa.onset.onset_strength(y=y, sr=SR, hop_length=hop)
    o = op / np.percentile(op, 99) + om / np.percentile(om, 99)

    def score(per, off):
        ts = off + per * np.arange(int(dur / per) + 1)
        idx = np.round(ts * ofps).astype(int)
        idx = idx[(idx > 2) & (idx < len(o) - 2)]
        return np.maximum.reduce([o[idx - 1], o[idx], o[idx + 1]]).mean()

    lo, hi = cfg["grid"]["bpmSearch"]
    best = (0.0, 0.0, 0.0)
    for bpm in np.arange(lo, hi, 0.05):
        per = 60 / bpm
        for off in np.arange(0, per, 0.004):
            s = score(per, off)
            if s > best[0]:
                best = (s, bpm, off)
    for bpm in np.arange(best[1] - 0.05, best[1] + 0.05, 0.002):
        per = 60 / bpm
        for off in np.arange(best[2] - 0.006, best[2] + 0.006, 0.0005):
            s = score(per, off)
            if s > best[0]:
                best = (s, bpm, off)
    _, bpm, off = best
    per = 60 / bpm
    grid = off + per * np.arange(int((dur - off) / per) + 1)

    # snap each beat to the strongest percussive attack within +-SNAP (if clearly above the local floor)
    pk, _ = find_peaks(op, height=np.percentile(op, 80), distance=int(0.05 * ofps))
    pkt = pk / ofps
    res = np.zeros(len(grid))
    for i, g in enumerate(grid):
        m = np.abs(pkt - g) < SNAP
        if m.any():
            j = np.argmax(np.where(m, op[pk], -1))
            res[i] = pkt[j] - g
    res = median_filter(res, size=5, mode="nearest")
    beats = grid + res

    k0 = cfg["grid"]["firstDownbeatBeat"]
    bpb = cfg["grid"]["beatsPerBar"]
    downbeats = beats[k0::bpb]

    def bar_time(b):
        if b < 0:
            return 0.0 if b == -1 else float(downbeats[0] + b * per * bpb)
        return (
            float(downbeats[b])
            if b < len(downbeats)
            else float(downbeats[-1] + (b - len(downbeats) + 1) * per * bpb)
        )

    secs = cfg["sections"]
    sections = []
    for i, s in enumerate(secs):
        a = bar_time(s["bar"])
        b = bar_time(secs[i + 1]["bar"]) if i + 1 < len(secs) else dur
        sections.append(
            {
                "name": s["name"],
                "bar": s["bar"],
                "start": round(a, 4),
                "end": round(b, 4),
            }
        )

    # ---- envelopes (100 fps)
    ehop = SR // FPS
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=ehop))
    f = librosa.fft_frequencies(sr=SR, n_fft=2048)

    def band(a, b):
        return np.sqrt((S[(f >= a) & (f < b)] ** 2).mean(0))

    feats = {
        "rms": norm01(env(y, ehop)),
        "low": norm01(band(20, 150)),
        "mid": norm01(band(150, 2500)),
        "high": norm01(band(4000, 11000)),
        "perc": norm01(env(P, ehop)),
        "harm": norm01(env(H, ehop)),
    }
    nfr = int(np.ceil(dur * FPS))
    features = {
        k: [round(float(v), 4) for v in np.interp(np.arange(nfr), np.arange(len(a)), a)]
        for k, a in feats.items()
    }

    # ---- onsets
    def onsets(sig, fmin=None, fmax=None, delta=0.08, wait=0.08):
        s = sig
        if fmin or fmax:
            Sx = np.abs(librosa.stft(sig, n_fft=1024, hop_length=hop))
            ff = librosa.fft_frequencies(sr=SR, n_fft=1024)
            msk = np.ones_like(ff, bool)
            if fmin:
                msk &= ff >= fmin
            if fmax:
                msk &= ff < fmax
            ev = librosa.onset.onset_strength(
                S=librosa.amplitude_to_db(Sx[msk]), sr=SR, hop_length=hop
            )
        else:
            ev = librosa.onset.onset_strength(y=s, sr=SR, hop_length=hop)
        fr = librosa.onset.onset_detect(
            onset_envelope=ev,
            sr=SR,
            hop_length=hop,
            delta=delta,
            wait=int(wait * ofps),
            backtrack=False,
        )
        st = ev[fr]
        st = (
            np.clip(
                (st - np.percentile(st, 5))
                / (np.percentile(st, 95) - np.percentile(st, 5) + 1e-9)
                * 0.8
                + 0.2,
                0,
                1,
            )
            if len(st)
            else st
        )
        return [[round(float(t), 4), round(float(v), 3)] for t, v in zip(fr / ofps, st)]

    out = {
        "_doc": "Generated by analysis/analyze.py from audio/trailer.wav. Do not edit by hand.",
        "audio": "audio/trailer.wav",
        "duration": round(dur, 4),
        "bpm": round(float(bpm), 3),
        "fps": FPS,
        "beats": [round(float(b), 4) for b in beats],
        "downbeats": [round(float(b), 4) for b in downbeats],
        "sections": sections,
        "features": features,
        "onsets": {
            "kick": onsets(P, None, 150, 0.12, 0.15),
            "hit": onsets(P, None, None, 0.1, 0.1),
            "note": onsets(H, 300, 5000, 0.12, 0.09),
        },
    }
    (ROOT / "data/audio.json").write_text(json.dumps(out, separators=(",", ":")))
    print(
        f"bpm {bpm:.3f}  offset {off:.4f}  beats {len(beats)}  downbeats {len(downbeats)}  max snap {np.abs(res).max() * 1000:.1f} ms"
    )
    for s in sections:
        print(
            f"  {s['name']:10s} bar {s['bar']:3d}  {s['start']:7.3f} -> {s['end']:7.3f}"
        )
    print("  onsets:", {k: len(v) for k, v in out["onsets"].items()})

    if "--plot" in sys.argv:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        M = librosa.power_to_db(
            librosa.feature.melspectrogram(y=y, sr=SR, n_mels=96, hop_length=256),
            ref=np.max,
        )
        _fig, ax = plt.subplots(1, 1, figsize=(26, 5))
        ax.imshow(
            M,
            origin="lower",
            aspect="auto",
            extent=(0.0, dur, 0.0, 96.0),
            cmap="magma",
            vmin=-70,
            vmax=0,
        )
        for b in beats:
            ax.axvline(b, color="w", lw=0.3, alpha=0.5)
        for d in downbeats:
            ax.axvline(d, color="c", lw=1.0)
        for s in sections:
            ax.text(s["start"] + 0.1, 90, s["name"], color="y", fontsize=10)
        ax.set_xticks(np.arange(0, dur, 2))
        plt.tight_layout()
        plt.savefig(ROOT / "audio/analysis.png", dpi=55)
        print("plot -> audio/analysis.png")


if __name__ == "__main__":
    main()
