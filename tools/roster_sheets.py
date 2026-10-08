#!/usr/bin/env python3
"""Numbered roster contact sheets (dex number + id under each sprite) for owner review.

Reads content/species.json for the dex order and public/assets/creatures/<id>.png for the art; writes
<out>-<n>.png sheets of cols x rows cells (docs/previews/creatures-*.png is the shipped set).

Usage:
  python3 tools/roster_sheets.py --out docs/previews/creatures            # every species, 8 x 6 per sheet
  python3 tools/roster_sheets.py --ids a,b,c --out output/18/new-creatures  # only these ids (dex order)
"""

from __future__ import annotations

import argparse
import pathlib
import sys

from assetlib import ROOT, content_json
from PIL import Image, ImageDraw, ImageFont

CELL_W, CELL_H, PAD, LABEL_Y = 136, 148, 4, 134
BG = (52, 56, 70)
TEXT = (235, 235, 235)


def sheet(rows: list[tuple[int, str]], cols: int, nrows: int) -> Image.Image:
    img = Image.new("RGBA", (cols * CELL_W, nrows * CELL_H), BG + (255,))
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default()
    for i, (dex, sid) in enumerate(rows):
        x, y = (i % cols) * CELL_W, (i // cols) * CELL_H
        art = ROOT / "public" / "assets" / "creatures" / f"{sid}.png"
        if art.is_file():
            sprite = Image.open(art).convert("RGBA")
            img.alpha_composite(sprite, (x + PAD, y + PAD))
        draw.text((x + 5, y + LABEL_Y), f"{dex} {sid}", fill=TEXT, font=font)
    return img


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--out",
        required=True,
        help="output path prefix; sheets are <out>-1.png, <out>-2.png ...",
    )
    ap.add_argument(
        "--ids", default="", help="comma list of species ids (default: every species)"
    )
    ap.add_argument("--cols", type=int, default=8)
    ap.add_argument("--rows", type=int, default=6)
    a = ap.parse_args()
    species = sorted(content_json("content/species.json"), key=lambda s: s["dexNo"])
    want = {x for x in a.ids.split(",") if x}
    rows = [(s["dexNo"], s["id"]) for s in species if not want or s["id"] in want]
    if not rows:
        print("no species selected", file=sys.stderr)
        return 1
    per = a.cols * a.rows
    for n, start in enumerate(range(0, len(rows), per), start=1):
        chunk = rows[start : start + per]
        out = pathlib.Path(f"{a.out}-{n}.png")
        out = out if out.is_absolute() else ROOT / out
        out.parent.mkdir(parents=True, exist_ok=True)
        sheet(chunk, a.cols, (len(chunk) + a.cols - 1) // a.cols).save(out)
        print(f"{len(chunk)} sprite(s) -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
