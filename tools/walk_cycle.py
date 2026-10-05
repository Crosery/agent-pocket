#!/usr/bin/env python3
"""Deterministic 4-frame walk cycle built from one drawn pose per sheet row.

AI walk sheets draw (nearly) the same pose in every cell of a row, so playing them back reads as sliding.
Each row is rebuilt from its most typical drawn frame (medoid) by moving only leg pixels:

  frame 0, 2  legs together (frame 0 doubles as the idle pose), body `bob` px higher than on contact
  frame 1, 3  contact: front/back rows raise one foot by `lift` px (left foot, then right foot);
              side rows show the drawn stride

- front/back rows: leg band = bottom `legFrac` of the figure, split at the band's own pixel mass snapped to the
  gap between the feet; a foot the drawn pose left in the air is first put back on the ground (`maxPlant`); when one
  half still does not reach the ground (legs drawn crossed or hidden) the contact frames only get the bob
- side rows: the drawn stride is the contact frame; the passing frame shears both legs toward each other
  (`tuck` of the foot distance, 0 at the crotch growing to full at the feet), darker (far) leg drawn first.
  Strides drawn without a gap between the legs only get the bob
- pixels are only moved or duplicated, never resampled, so frames stay on the sheet palette; every frame keeps
  its lowest pixel on the drawn baseline

Parameters: assets_src/pipeline.json `sheet.walkCycle`. Rows/frames: content/config.json `sprites`.
Usage: python3 tools/walk_cycle.py sheet.png out.png   (preview on a sheet processed with `enabled: false`)
"""

from __future__ import annotations

import argparse
import itertools
import json
import sys

import numpy as np
from assetlib import content_json, load_src, pipeline_cfg, save_png, to_image

FRAMES = 4


def _opaque(f: np.ndarray) -> np.ndarray:
    return f[..., 3] >= 127.5


def _extent(op: np.ndarray) -> tuple[int, int]:
    ys = np.nonzero(op.any(axis=1))[0]
    return int(ys.min()), int(ys.max())


def _medoid(cells: list[np.ndarray]) -> int:
    ops = [_opaque(c) for c in cells]
    cost = [
        sum(
            float(np.abs(a - b).mean()) + float((oa != ob).mean())
            for b, ob in zip(cells, ops, strict=True)
        )
        for a, oa in zip(cells, ops, strict=True)
    ]
    return int(np.argmin(cost))


def _blit(dst: np.ndarray, src: np.ndarray, mask: np.ndarray, dy: int = 0) -> None:
    """Copies src pixels where mask is set into dst, moved down by dy rows (clipped)."""
    ys, xs = np.nonzero(mask)
    ty = ys + dy
    ok = (ty >= 0) & (ty < dst.shape[0])
    dst[ty[ok], xs[ok]] = src[ys[ok], xs[ok]]


def _ground(f: np.ndarray, foot: int) -> np.ndarray:
    """Moves the whole frame vertically so its lowest opaque row is `foot`."""
    op = _opaque(f)
    d = foot - _extent(op)[1]
    if d == 0:
        return f
    out = np.zeros_like(f)
    _blit(out, f, op, d)
    return out


def _raise_body(f: np.ndarray, out: np.ndarray, hip: int, bob: int) -> None:
    """Draws the body (rows above `hip`) `bob` px up over `out`; the legs' top row is stretched into the gap."""
    leg_top = _opaque(out[hip])
    for b in range(1, bob + 1):
        out[hip - b, leg_top] = out[hip, leg_top]
    body = _opaque(f)
    body[hip:] = False
    _blit(out, f, body, -bob)


# ---------------------------------------------------------------------------
# front / back rows
# ---------------------------------------------------------------------------


def _front_split(op: np.ndarray, hip: int, foot: int, cfg: dict) -> int:
    """Column where the right half starts.

    Centred on the legs' pixel mass (runs narrower than `minRun` px, e.g. canes, are ignored), then moved within
    `splitSearch` px to the strongest step of the band's bottom profile (>= `minRise` px) that leaves at least
    `minRun` leg columns on each side: the gap or notch between the feet, or the edge of a foot the drawn pose holds
    in the air. Legs drawn as one block split at the centre.
    """
    band = op[hip : foot + 1]
    n, min_run = band.shape[0], cfg["minRun"]
    thick = np.zeros_like(band)
    for y, row in enumerate(band):
        xs = np.nonzero(row)[0]
        for run in np.split(xs, np.nonzero(np.diff(xs) > 1)[0] + 1):
            if len(run) >= min_run:
                thick[y, run] = True
    cx = float(np.median(np.nonzero(thick if thick.any() else band)[1])) + 0.5
    has = band.any(axis=0)
    # rows between a column's lowest pixel and the baseline (empty columns count as fully raised)
    rise = np.where(has, np.argmax(band[::-1], axis=0), n)
    cols = np.nonzero(has)[0]
    best, best_key = round(cx), None
    for b in range(
        max(1, round(cx) - cfg["splitSearch"]),
        min(op.shape[1], round(cx) + cfg["splitSearch"] + 1),
    ):
        jump = abs(int(rise[b]) - int(rise[b - 1]))
        if (
            jump < cfg["minRise"]
            or (cols < b).sum() < min_run
            or (cols >= b).sum() < min_run
        ):
            continue
        key = (jump, -abs(b - cx))
        if best_key is None or key > best_key:
            best, best_key = b, key
    return best


def _plant(
    f: np.ndarray, hip: int, foot: int, split: int, max_plant: int
) -> np.ndarray:
    """Puts a raised foot back on the baseline by stretching that half of the leg band down."""
    out = f.copy()
    op = _opaque(f)
    for xs in (slice(0, split), slice(split, f.shape[1])):
        rows = np.nonzero(op[hip : foot + 1, xs].any(axis=1))[0]
        if not len(rows):
            continue
        d = min(foot - (hip + int(rows.max())), max_plant)
        if d <= 0:
            continue
        part = f[hip : foot + 1, xs].copy()
        out[hip : foot + 1, xs] = 0
        out[hip + d : foot + 1, xs] = part[: foot + 1 - hip - d]
        out[hip : hip + d, xs] = part[0]
    return out


def plant_idle(f: np.ndarray, cfg: dict) -> np.ndarray:
    """Plant only the lowest leg band; long hair, sleeves and skirts above it are not moved."""
    op = _opaque(f)
    top, foot = _extent(op)
    h = foot - top + 1
    legs = min(max(cfg["minLegRows"], round(cfg["legFrac"] * h)), h // 2)
    hip = foot - legs + 1
    split = _front_split(op, hip, foot, cfg)
    return _plant(f, hip, foot, split, min(legs - 1, cfg["maxPlant"] + cfg["lift"]))


def _front_step(
    f: np.ndarray, hip: int, split: int, lift_left: bool, bob: int, lift: int
) -> np.ndarray:
    op = _opaque(f)
    legs = op.copy()
    legs[:hip] = False
    side = np.zeros_like(op)
    side[:, :split] = True
    lifted = legs & (side if lift_left else ~side)
    out = np.zeros_like(f)
    _blit(out, f, legs & ~lifted)
    _blit(out, f, lifted, -lift)
    body = op.copy()
    body[hip:] = False
    _blit(out, f, body, bob)  # contact: the body drops onto the legs
    return out


def front_row(cells: list[np.ndarray], cfg: dict) -> tuple[list[np.ndarray], dict]:
    i = _medoid(cells)
    base = cells[i]
    op = _opaque(base)
    top, foot = _extent(op)
    h = foot - top + 1
    legs = min(max(cfg["minLegRows"], round(cfg["legFrac"] * h)), h // 2)
    hip = foot - legs + 1
    split = _front_split(op, hip, foot, cfg)
    stand = _ground(_plant(base, hip, foot, split, cfg["maxPlant"]), foot)
    sop = _opaque(stand)
    # both halves must stand on the baseline, else lifting the other one would drop the whole figure (a limp):
    # legs drawn crossed or hidden only get the bob
    two_feet = all(sop[foot, xs].any() for xs in (slice(0, split), slice(split, None)))
    lift = cfg["lift"] if two_feet else 0
    contact = [
        _ground(_front_step(stand, hip, split, lift_left, cfg["bob"], lift), foot)
        for lift_left in (True, False)
    ]
    return [stand, contact[0], stand, contact[1]], {
        "base": i,
        "legRows": legs,
        "split": split,
        "twoFeet": two_feet,
    }


# ---------------------------------------------------------------------------
# side rows
# ---------------------------------------------------------------------------


def _gaps(row: np.ndarray) -> list[tuple[int, int]]:
    """Transparent runs [a, b) with opaque pixels on both sides."""
    xs = np.nonzero(row)[0]
    return [(int(a) + 1, int(b)) for a, b in itertools.pairwise(xs) if b - a > 1]


def _stride_gap(
    op: np.ndarray, foot: int, max_rows: int, start_rows: int
) -> tuple[int, dict[int, float]] | None:
    """Crotch row and the per-row centre of the gap between the two legs, tracked up from the feet.

    The gap must open within the bottom `start_rows` rows (the back foot may be lifted off the ground)."""
    centres: dict[int, float] = {}
    prev: tuple[int, int] | None = None
    for y in range(foot, foot - max_rows, -1):
        gaps = _gaps(op[y])
        if prev is None:
            if not gaps:
                if foot - y + 1 >= start_rows:
                    return None
                continue
            prev = max(gaps, key=lambda g: g[1] - g[0])
        else:
            p0, p1 = prev
            near = [g for g in gaps if g[0] <= p1 and g[1] >= p0]
            if not near:
                return y + 1, centres
            prev = min(near, key=lambda g: abs((g[0] + g[1]) - (p0 + p1)))
        centres[y] = (prev[0] + prev[1]) / 2
    return foot - max_rows + 1, centres


def _side_pass(
    f: np.ndarray, hip: int, foot: int, centres: dict[int, float], cfg: dict
) -> np.ndarray:
    op = _opaque(f)
    known = sorted(centres)
    split = {
        y: centres[min(known, key=lambda k: abs(k - y))] for y in range(hip, foot + 1)
    }
    xs = np.arange(f.shape[1])
    legs = {
        side: [(y, xs[op[y] & ((xs < split[y]) == side)]) for y in range(hip, foot + 1)]
        for side in (True, False)
    }
    # each leg's foot: its own lowest footRows rows (a lifted back foot still counts)
    feet = {
        side: [
            x
            for _, row in [r for r in rows if len(r[1])][-cfg["footRows"] :]
            for x in row
        ]
        for side, rows in legs.items()
    }
    shift = (
        cfg["tuck"] * (np.mean(feet[False]) - np.mean(feet[True])) / 2
        if feet[True] and feet[False]
        else 0.0
    )
    pieces: dict[bool, list[tuple[int, int, int]]] = {True: [], False: []}
    for y in range(hip, foot + 1):
        s = round(shift * (y - hip + 1) / (foot - hip + 1))
        for x in np.nonzero(op[y])[0]:
            left = bool(x < split[y])
            pieces[left].append((y, int(x), int(x) + s if left else int(x) - s))
    luma = {
        k: float(np.mean([f[y, x, :3] @ (0.299, 0.587, 0.114) for y, x, _ in v]))
        if v
        else 0.0
        for k, v in pieces.items()
    }
    out = np.zeros_like(f)
    for k in sorted(pieces, key=lambda k: luma[k]):
        for y, x, nx in pieces[k]:
            if 0 <= nx < f.shape[1]:
                out[y, nx] = f[y, x]
    _raise_body(f, out, hip, min(cfg["bob"], _extent(op)[0]))
    return out


def _row_centre(op: np.ndarray, y: int) -> float:
    return float(np.nonzero(op[y])[0].mean())


def side_row(cells: list[np.ndarray], cfg: dict) -> tuple[list[np.ndarray], dict]:
    i = _medoid(cells)
    stride = cells[i]
    op = _opaque(stride)
    top, foot = _extent(op)
    h = foot - top + 1
    found = _stride_gap(
        op,
        foot,
        max(cfg["minLegRows"], round(cfg["maxLegFrac"] * h)),
        cfg["strideStartRows"],
    )
    if found:
        hip, centres = found
    else:  # legs drawn without a gap: nothing to close, the passing frame only bobs
        hip, centres = (
            foot - min(max(cfg["minLegRows"], round(cfg["legFrac"] * h)), h // 2) + 1,
            {foot: _row_centre(op, foot)},
        )
    passing = _side_pass(
        stride, hip, foot, centres, cfg if found else {**cfg, "tuck": 0}
    )
    return [passing, stride, passing, stride], {
        "base": i,
        "legRows": foot - hip + 1,
        "stride": bool(found),
    }


# ---------------------------------------------------------------------------


def walk_cycle(
    frames: list[list[np.ndarray]], side_rows: set[int], cfg: dict
) -> tuple[list[list[np.ndarray]], list[dict]]:
    """Rebuilds every row of a rows x 4 grid of float RGBA cells (binary alpha). Returns (rows, per-row report)."""
    out, report = [], []
    for r, cells in enumerate(frames):
        if len(cells) != FRAMES:
            raise ValueError(
                f"walk cycle needs {FRAMES} frames per row, got {len(cells)}"
            )
        row, rep = side_row(cells, cfg) if r in side_rows else front_row(cells, cfg)
        out.append(row)
        report.append(rep)
    return out, report


def side_row_indices() -> set[int]:
    rows = content_json("content/config.json")["sprites"]["sheetRows"]
    return {rows["left"], rows["right"]}


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("src")
    ap.add_argument("dst")
    a = ap.parse_args()
    cell = content_json("content/config.json")["sprites"]["sheetCell"]
    sheet = load_src(a.src)
    if sheet.shape[2] != 4:
        print(f"{a.src}: no alpha channel", file=sys.stderr)
        return 1
    grid = [
        [
            sheet[r * cell : (r + 1) * cell, c * cell : (c + 1) * cell]
            for c in range(sheet.shape[1] // cell)
        ]
        for r in range(sheet.shape[0] // cell)
    ]
    rows, rep = walk_cycle(
        grid, side_row_indices(), pipeline_cfg()["sheet"]["walkCycle"]
    )
    out = np.zeros_like(sheet)
    for r, row in enumerate(rows):
        for c, f in enumerate(row):
            out[r * cell : (r + 1) * cell, c * cell : (c + 1) * cell] = f
    save_png(to_image(out), a.dst)
    print(json.dumps(rep))
    return 0


if __name__ == "__main__":
    sys.exit(main())
