#!/usr/bin/env python3
"""4x4 walk sheet (AI render on magenta) -> sheetCell*frames square RGBA sheet.

- cells found from alpha projections (runs assigned to an even grid over the content extent, merged/split)
- ONE uniform scale for all frames: the tallest frame maps to the target height
- each frame: feet on the cell bottom (bottomMargin px), horizontally centred on the torso
- the left/right rows are checked (face-side heuristic + mirror similarity) and fixed by mirroring/swapping
- each row is rebuilt into a 4-frame walk cycle from its most typical drawn pose (walk_cycle.py); rows with an H3
  walk clip (walk_video.py, `--id` needed) take their cycle from the clip instead
- shared palette across the sheet, binary alpha, speck/pinhole/halo cleanup

Cell size, frame count and row order come from content/config.json `sprites`.
Usage: python3 tools/process_sheet.py raw.png out.png [--id ID] [--debug dir]
"""

from __future__ import annotations

import argparse
import colorsys
import json
import math
import sys

import numpy as np
from assetlib import (
    apply_palette,
    binarize_alpha,
    build_palette,
    chroma_key,
    clean_halo,
    content_json,
    estimate_key,
    fill_pinholes,
    hex_rgb,
    load_src,
    medoid_resample,
    pipeline_cfg,
    remove_specks,
    save_png,
    to_image,
)
from walk_cycle import walk_cycle
from walk_video import apply as apply_walk_video


class SheetError(Exception):
    pass


def runs_of(active: np.ndarray) -> list[list[int]]:
    runs, start = [], None
    for i, v in enumerate(active.tolist() + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append([start, i])
            start = None
    return runs


def split_bands(
    profile: np.ndarray, n: int, thr: float, snap: dict
) -> list[tuple[int, int]]:
    """Split a projection profile into n bands that follow an (approximately) even grid.

    Runs crossing an even-grid boundary (touching figures) are cut at the profile minimum within
    snap.search cells of it; every piece is then assigned to the slot holding its mass centre.
    """
    runs = runs_of(profile > thr)
    if not runs:
        raise SheetError("empty profile")
    lo, hi = runs[0][0], runs[-1][1]
    cell = (hi - lo) / n
    pieces: list[list[int]] = []
    for s, e in runs:
        cuts = []
        for k in range(1, n):
            b = lo + k * cell
            if s + snap["edge"] * cell < b < e - snap["edge"] * cell:
                a0, a1 = (
                    int(max(s + 1, b - snap["search"] * cell)),
                    int(min(e - 1, b + snap["search"] * cell)),
                )
                cuts.append(a0 + int(np.argmin(profile[a0:a1])))
        prev = s
        for c in cuts:
            pieces.append([prev, c])
            prev = c
        pieces.append([prev, e])
    slots: list[list[int] | None] = [None] * n
    for s, e in pieces:
        seg = profile[s:e]
        if seg.sum() <= 0:
            continue
        centre = s + float((np.arange(e - s) * seg).sum() / seg.sum())
        k = min(n - 1, max(0, int((centre - lo) / cell)))
        cur = slots[k]
        slots[k] = [s, e] if cur is None else [min(cur[0], s), max(cur[1], e)]
    if any(v is None for v in slots):
        raise SheetError(
            f"expected {n} bands, found {sum(v is not None for v in slots)}"
        )
    return [(v[0], v[1]) for v in slots if v is not None]


def detect_cells(
    alpha: np.ndarray, rows: int, cols: int, thr: float, snap: dict
) -> list[list[tuple[int, int, int, int]]]:
    """Return rows x cols tight bboxes (x0, y0, x1, y1) in source pixels."""
    mask = alpha >= 127.5
    row_bands = split_bands(mask.sum(axis=1).astype(np.float32), rows, thr, snap)
    grid = []
    for y0, y1 in row_bands:
        col_bands = split_bands(
            mask[y0:y1].sum(axis=0).astype(np.float32), cols, thr, snap
        )
        line = []
        for x0, x1 in col_bands:
            sub = mask[y0:y1, x0:x1]
            ys, xs = np.nonzero(sub)
            line.append(
                (
                    x0 + int(xs.min()),
                    y0 + int(ys.min()),
                    x0 + int(xs.max()) + 1,
                    y0 + int(ys.max()) + 1,
                )
            )
        grid.append(line)
    return grid


def torso_center(frame: np.ndarray, band: list[float]) -> float:
    op = frame[..., 3] >= 127.5
    ys, xs = np.nonzero(op)
    if len(xs) == 0:
        return frame.shape[1] / 2
    top, bottom = ys.min(), ys.max() + 1
    h = bottom - top
    sel = (ys >= top + band[0] * h) & (ys < top + band[1] * h)
    return float(np.median(xs[sel] if sel.any() else xs)) + 0.5


def facing_score(frame: np.ndarray, fcfg: dict) -> tuple[float, int]:
    """Skin-in-head-region horizontal offset: <0 face points left, >0 right. Returns (score, skin pixel count)."""
    op = frame[..., 3] >= 127.5
    ys, xs = np.nonzero(op)
    if len(xs) == 0:
        return 0.0, 0
    top, bottom = ys.min(), ys.max() + 1
    head = op & (
        np.arange(frame.shape[0])[:, None] < top + fcfg["headBand"] * (bottom - top)
    )
    hy, hx = np.nonzero(head)
    if len(hx) == 0:
        return 0.0, 0
    rgb = frame[hy, hx, :3] / 255.0
    hsv = np.array([colorsys.rgb_to_hsv(*p) for p in rgb])
    sk = fcfg["skin"]
    skin = (
        ((hsv[:, 0] <= sk["hueMax"]) | (hsv[:, 0] >= sk["hueWrapMin"]))
        & (hsv[:, 1] >= sk["satMin"])
        & (hsv[:, 1] <= sk["satMax"])
        & (hsv[:, 2] >= sk["valMin"])
    )
    if skin.sum() == 0:
        return 0.0, 0
    width = hx.max() - hx.min() + 1
    return float((hx[skin].mean() - (hx.min() + hx.max()) / 2) / width), int(skin.sum())


def row_facing(cells: list[np.ndarray], fcfg: dict) -> float:
    scores = [facing_score(c, fcfg) for c in cells]
    tot = sum(n for _, n in scores if n >= fcfg["minSkinPixels"])
    if tot == 0:
        return 0.0
    return sum(s * n for s, n in scores if n >= fcfg["minSkinPixels"]) / tot


def row_distance(a: list[np.ndarray], b: list[np.ndarray]) -> float:
    return float(np.mean([np.abs(x - y).mean() for x, y in zip(a, b, strict=True)]))


def fix_facing(cells: list[list[np.ndarray]], left: int, right: int, fcfg: dict) -> str:
    L, R = row_facing(cells[left], fcfg), row_facing(cells[right], fcfg)
    mirror = lambda row: [c[:, ::-1].copy() for c in row]
    same = row_distance(cells[left], cells[right]) < row_distance(
        cells[left], mirror(cells[right])
    )
    conf = fcfg["minScore"]
    if same:
        if L + R > conf:  # both rows face right
            cells[left] = mirror(cells[right])
            return f"both side rows faced right (L={L:.2f} R={R:.2f}); left row = mirrored right row"
        cells[right] = mirror(cells[left])
        return f"both side rows faced the same way (L={L:.2f} R={R:.2f}); right row = mirrored left row"
    if L > conf and R < -conf:
        cells[left], cells[right] = cells[right], cells[left]
        return f"side rows were swapped (L={L:.2f} R={R:.2f}); swapped"
    return f"ok (L={L:.2f} R={R:.2f})"


def process_sheet(
    src: str, dst: str, sheet_id: str = "", debug: str | None = None
) -> dict:
    cfg = pipeline_cfg()
    scfg = cfg["sheet"]
    sprites = content_json("content/config.json")["sprites"]
    cell, ncols = sprites["sheetCell"], sprites["sheetFrames"]
    order = sorted(sprites["sheetRows"].items(), key=lambda kv: kv[1])
    nrows = len(order)

    rgb = load_src(src)
    keyed = chroma_key(rgb, cfg["chroma"])
    boxes = detect_cells(
        keyed[..., 3], nrows, ncols, scfg["profileMinCount"], scfg["bandSnap"]
    )

    avail_h = cell - scfg["topMargin"] - scfg["bottomMargin"]
    avail_w = cell - 2 * scfg["sideMargin"]
    target_h = (
        avail_h * scfg["targetHeightFill"] * scfg["heightScale"].get(sheet_id, 1.0)
    )
    max_h = max(b[3] - b[1] for row in boxes for b in row)
    max_w = max(b[2] - b[0] for row in boxes for b in row)
    g = max(max_h / target_h, max_w / avail_w)

    key = tuple(
        estimate_key(
            rgb, hex_rgb(cfg["chroma"]["color"]), cfg["chroma"]["estimateMaxDist"]
        )
    )
    frames: list[list[np.ndarray]] = []
    warnings: list[str] = []
    for r, row in enumerate(boxes):
        out_row = []
        for c, (x0, y0, x1, y1) in enumerate(row):
            h = math.ceil((y1 - y0) / g)
            w = math.ceil((x1 - x0) / g)
            oy = y1 - h * g  # feet land exactly on a pixel boundary
            ox = (x0 + x1) / 2 - w * g / 2
            f = binarize_alpha(medoid_resample(keyed, g, g, ox, oy, w, h))
            f = remove_specks(f, scfg["minSpeck"], scfg["speckRatio"])
            f = fill_pinholes(f, scfg["pinhole"])
            f = clean_halo(f, key, cfg["chroma"]["haloMaxDist"])
            canvas = np.zeros((cell, cell, 4), np.float32)
            ys, xs = np.nonzero(f[..., 3] >= 127.5)
            if len(xs) == 0:
                raise SheetError(f"empty frame r{r} c{c}")
            f = f[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
            fh, fw = f.shape[:2]
            dx = round(cell / 2 - torso_center(f, scfg["torsoBand"]))
            dy = cell - scfg["bottomMargin"] - fh
            dx = min(max(dx, 0), cell - fw)
            if dy < 0:
                warnings.append(f"frame r{r} c{c} taller than cell, top clipped")
                f, dy = f[-dy:], 0
            canvas[dy : dy + f.shape[0], dx : dx + fw] = f
            out_row.append(canvas)
        frames.append(out_row)

    rows = sprites["sheetRows"]
    facing = fix_facing(frames, rows["left"], rows["right"], scfg["facing"])
    walk = None
    if scfg["walkCycle"]["enabled"]:
        frames, walk = walk_cycle(
            frames, {rows["left"], rows["right"]}, scfg["walkCycle"]
        )
    video = None
    if cfg["walkVideo"]["enabled"]:
        frames, video = apply_walk_video(sheet_id, frames, rows)
    ncols = len(frames[0])
    pal = build_palette([c for row in frames for c in row], scfg["palette"])
    sheet = np.zeros((cell * nrows, cell * ncols, 4), np.float32)
    for r, row in enumerate(frames):
        for c, f in enumerate(row):
            sheet[r * cell : (r + 1) * cell, c * cell : (c + 1) * cell] = apply_palette(
                f, pal
            )
    save_png(to_image(sheet), dst)
    if debug:
        dbg = keyed.copy()
        for row in boxes:
            for x0, y0, x1, y1 in row:
                dbg[y0:y1, [x0, x1 - 1]] = (0, 255, 0, 255)
                dbg[[y0, y1 - 1], x0:x1] = (0, 255, 0, 255)
        save_png(to_image(dbg), f"{debug}/{sheet_id or 'sheet'}_cells.png")
    return {
        "id": sheet_id,
        "grid": round(g, 3),
        "srcMaxFrame": [max_w, max_h],
        "facing": facing,
        "walk": walk,
        "walkVideo": video,
        "warnings": warnings,
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--id", default="")
    ap.add_argument("--debug", default=None)
    a = ap.parse_args()
    try:
        print(
            json.dumps(process_sheet(a.src, a.dst, a.id, a.debug), ensure_ascii=False)
        )
    except SheetError as e:
        print(f"FAILED {a.src}: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
