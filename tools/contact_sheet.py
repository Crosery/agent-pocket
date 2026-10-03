#!/usr/bin/env python3
"""Contact sheets for visual QA of processed assets (labels = file stems).

Transparent assets are drawn over a checkerboard; textures can be shown as repeat*repeat tiled previews.

Usage:
  python3 tools/contact_sheet.py public/assets/characters --out /tmp/chars.png [--scale 2] [--cols 6]
  python3 tools/contact_sheet.py public/assets/textures/terrain --tile 4 --scale 3 --out /tmp/terrain.png
  python3 tools/contact_sheet.py assets_src/raw/character --thumb 256 --out /tmp/raw_chars.png
  (--glob '*_tuft.png' / --exclude '*_tuft.png' filter the files)
"""

from __future__ import annotations

import argparse
import fnmatch
import pathlib
import sys

import numpy as np
from assetlib import checkerboard, composite
from PIL import Image, ImageDraw

LABEL_H = 14


def load_cell(path: pathlib.Path, scale: int, tile: int, thumb: int) -> Image.Image:
    im = Image.open(path).convert("RGBA")
    if tile > 1:
        a = np.tile(np.asarray(im), (tile, tile, 1))
        im = Image.fromarray(a, "RGBA")
    if thumb:
        im.thumbnail((thumb, thumb), Image.Resampling.LANCZOS)
    elif scale > 1:
        im = im.resize((im.width * scale, im.height * scale), Image.Resampling.NEAREST)
    arr = np.asarray(im, np.float32)
    bg = checkerboard(im.width, im.height, max(4, scale * 4))
    return Image.fromarray(composite(arr, bg).astype(np.uint8), "RGB")


def build(
    files: list[pathlib.Path], cols: int, scale: int, tile: int, thumb: int
) -> Image.Image:
    cells = [(f.stem, load_cell(f, scale, tile, thumb)) for f in files]
    cw = max(c.width for _, c in cells)
    ch = max(c.height for _, c in cells) + LABEL_H
    cols = max(1, min(cols, len(cells)))
    rows = (len(cells) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (cw + 4) + 4, rows * (ch + 4) + 4), (32, 32, 40))
    draw = ImageDraw.Draw(sheet)
    for i, (name, im) in enumerate(cells):
        x, y = 4 + (i % cols) * (cw + 4), 4 + (i // cols) * (ch + 4)
        sheet.paste(im, (x, y))
        draw.text((x + 2, y + ch - LABEL_H + 1), name, fill=(235, 235, 235))
    return sheet


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--cols", type=int, default=6)
    ap.add_argument("--scale", type=int, default=1)
    ap.add_argument(
        "--tile", type=int, default=1, help="repeat each image tile*tile (seam check)"
    )
    ap.add_argument(
        "--thumb", type=int, default=0, help="fit each image into thumb*thumb (smooth)"
    )
    ap.add_argument("--glob", default="*.png")
    ap.add_argument("--exclude", default="")
    a = ap.parse_args()
    files = sorted(
        f
        for d in a.dirs
        for f in pathlib.Path(d).glob("*.png")
        if fnmatch.fnmatch(f.name, a.glob)
        and not (a.exclude and fnmatch.fnmatch(f.name, a.exclude))
        and not f.name.endswith(".part.png")
    )
    if not files:
        print("no images found", file=sys.stderr)
        return 1
    build(files, a.cols, a.scale, a.tile, a.thumb).save(a.out)
    print(f"{len(files)} image(s) -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
