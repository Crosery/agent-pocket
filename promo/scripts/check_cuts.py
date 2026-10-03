"""Double-exposure check at every hard cut of the exported MP4, plus a contact sheet of the frames around each cut.

uv run --with numpy --with pillow python scripts/check_cuts.py [out/agent-pocket-promo.mp4] [out/cuts_sheet.png]

Cuts come from data/sfx_events.json (`cuts`: plate boundaries + scene-internal cuts, written by
`bun scripts/render.ts sfx`). A frame next to a cut is flagged as a double exposure when it is explained by a
blend of the frames either side of it (0.1 < alpha < 0.9) much better than by either of them alone.
"""

import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FFMPEG = "/opt/homebrew/bin/ffmpeg"
src = os.path.join(
    ROOT, sys.argv[1] if len(sys.argv) > 1 else "out/agent-pocket-promo.mp4"
)
dst = os.path.join(ROOT, sys.argv[2] if len(sys.argv) > 2 else "out/cuts_sheet.png")
ev = json.loads(open(os.path.join(ROOT, "data/sfx_events.json")).read())  # noqa: SIM115
style = json.loads(open(os.path.join(ROOT, "data/style.json")).read())  # noqa: SIM115
FPS, W, H = 60, 320, 180
cuts = [c for c in ev["cuts"] if 0 < c < ev["duration"] - 1e-3]

raw = subprocess.run(
    [
        FFMPEG,
        "-v",
        "error",
        "-i",
        src,
        "-vf",
        f"scale={W}:{H}:flags=area,format=rgb24",
        "-f",
        "rawvideo",
        "-",
    ],
    capture_output=True,
    check=True,
).stdout
frames = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3).astype(np.float32)
print(f"{len(frames)} frames decoded, {len(cuts)} cuts")


def blend_test(a, x, b):
    """Best alpha with x ~ alpha*a + (1-alpha)*b, and residuals of the blend vs the nearer pure neighbour."""
    d = (a - b).ravel()
    den = float(d @ d)
    if den < 1e-6:
        return 0.0, 0.0, 0.0
    al = float(np.clip(((x - b).ravel() @ d) / den, 0, 1))
    rb = float(np.abs(x - (al * a + (1 - al) * b)).mean())
    rp = float(min(np.abs(x - a).mean(), np.abs(x - b).mean()))
    return al, rb, rp


flags = []
rows = []
for c in cuts:
    k = int(np.floor(c * FPS + 1e-6))  # last frame whose time is before the cut
    idx = [i for i in range(k - 1, k + 3) if 1 <= i < len(frames) - 1]
    for i in idx:
        if i < 2 or i + 2 >= len(frames):
            continue
        al, rb, rp = blend_test(frames[i - 1], frames[i], frames[i + 1])
        # a cut is a discontinuity: the jump across frame i dwarfs the motion inside either shot (smooth motion
        # also makes a frame look like the average of its neighbours, so this is what separates the two)
        jump = float(np.abs(frames[i + 1] - frames[i - 1]).mean())
        motion = max(
            float(np.abs(frames[i - 1] - frames[i - 2]).mean()),
            float(np.abs(frames[i + 2] - frames[i + 1]).mean()),
        )
        if os.environ.get("CUTS_DEBUG"):
            print(
                f"  cut {c:.3f} f{i} alpha {al:.2f} rb {rb:.1f} rp {rp:.1f} jump {jump:.1f} motion {motion:.1f}"
            )
        if 0.1 < al < 0.9 and rp > 4 and rb < 0.6 * rp and jump > 3 * motion:
            flags.append((c, i, al, rb, rp))
    rows.append((c, idx))

for c, i, al, rb, rp in flags:
    print(
        f"DOUBLE EXPOSURE? cut {c:.3f}s frame {i} ({i / FPS:.3f}s) alpha {al:.2f} blend-residual {rb:.1f} vs pure {rp:.1f}"
    )
print(f"{len(flags)} suspect frames")

hexrgb = lambda h: tuple(int(h[i : i + 2], 16) for i in (1, 3, 5))
ink, gold = hexrgb(style["palette"]["ink"]), hexrgb(style["palette"]["goldHi"])
font = ImageFont.truetype(os.path.join(ROOT, "public/fonts/IBMPlexMono-Medium.ttf"), 12)
pad, cols = 4, 4
sheet = Image.new("RGB", (cols * (W + pad) + pad, len(rows) * (H + pad) + pad), ink)
for r, (c, idx) in enumerate(rows):
    for j, i in enumerate(idx[:cols]):
        im = Image.fromarray(frames[i].astype(np.uint8))
        d = ImageDraw.Draw(im)
        lab = f"cut {c:.2f} | f{i} {i / FPS:.3f}s"
        d.rectangle([2, 2, 6 + d.textlength(lab, font=font), 17], fill=ink)
        d.text((4, 3), lab, font=font, fill=gold)
        sheet.paste(im, (pad + j * (W + pad), pad + r * (H + pad)))
sheet.save(dst)
print(dst, sheet.size)
