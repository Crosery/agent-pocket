"""Contact sheet of the exported MP4: N frames evenly spread (or at given times), labelled with their time.

uv run --with pillow python scripts/contact_sheet.py [out/agent-pocket-promo.mp4] [out/contact_sheet.png] [--n 30] [--cols 5] [--times 1.2,3.4]
"""

import json
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FFMPEG = "/opt/homebrew/bin/ffmpeg"
args = [a for a in sys.argv[1:]]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
pos = [
    a
    for i, a in enumerate(args)
    if not a.startswith("--") and (i == 0 or not args[i - 1].startswith("--"))
]
src = os.path.join(ROOT, pos[0] if pos else "out/agent-pocket-promo.mp4")
dst = os.path.join(ROOT, pos[1] if len(pos) > 1 else "out/contact_sheet.png")
dur = float(
    subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            src,
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
)
n, cols, w = int(opt("--n", "30")), int(opt("--cols", "5")), int(opt("--w", "384"))
times = [float(x) for x in opt("--times", "").split(",") if x] or [
    dur * (i + 0.5) / n for i in range(n)
]
with open(os.path.join(ROOT, "data/style.json")) as fh:
    pal = json.load(fh)["palette"]
hexrgb = lambda h: tuple(int(h[i : i + 2], 16) for i in (1, 3, 5))
ink, gold = hexrgb(pal["ink"]), hexrgb(pal["goldHi"])
font = ImageFont.truetype(os.path.join(ROOT, "public/fonts/IBMPlexMono-Medium.ttf"), 13)
tiles = []
with tempfile.TemporaryDirectory() as tmp:
    for i, t in enumerate(times):
        f = os.path.join(tmp, f"{i:03d}.png")
        frame = int(t * 60)
        subprocess.run(
            [
                FFMPEG,
                "-v",
                "error",
                "-y",
                "-i",
                src,
                "-vf",
                f"select=eq(n\\,{frame}),scale={w}:-1:flags=area,format=rgb24",
                "-frames:v",
                "1",
                "-update",
                "1",
                f,
            ],
            check=True,
        )
        im = Image.open(f).convert("RGB")
        d = ImageDraw.Draw(im)
        lab = f"{t:.2f}s"
        d.rectangle([3, 3, 9 + d.textlength(lab, font=font), 20], fill=ink)
        d.text((6, 4), lab, font=font, fill=gold)
        tiles.append(im)
h, pad = tiles[0].size[1], 4
rows = (len(tiles) + cols - 1) // cols
sheet = Image.new("RGB", (cols * (w + pad) + pad, rows * (h + pad) + pad), ink)
for i, im in enumerate(tiles):
    sheet.paste(im, (pad + (i % cols) * (w + pad), pad + (i // cols) * (h + pad)))
sheet.save(dst)
print(dst, sheet.size, len(tiles), "frames")
