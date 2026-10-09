#!/usr/bin/env python3
"""2D pixel-puppet motion for the drawn character sheets: 4-frame walk sheet -> 8 idle + 8 walk atlas.

The look stays the original 2D drawing: pixels are only moved or duplicated, never resampled or redrawn.

Rig per frame: head / body / legs bands (neck = narrowest row inside `bands.neckBand`, legs = bottom `bands.legFrac`),
arms = body pixels outside the legs' columns below `arms.topFrac`, legs split at their middle column. Pieces not
connected to the figure (a hovering drone) move rigidly with the body.
  idle  the stand pose (front / back: both feet planted first; side: the drawn stride with both legs sheared under
        the hips, so neither foot is lifted) breathing: the body sinks 1 px over `idle.body`, the
        head follows `idle.headLag` frames later
  walk  front / back: from the planted stand pose, one foot lifted per step (`walk.front`), the arms counter-swinging
        `arms.swing` px; side: the drawn strides (`walk.sidePoses`). Each pose is shown twice, first with the head
        still at the previous pose's height (at most 1 px off the body), then settled
A band moved down covers the band below; a band moved up leaves a seam row that is filled by stretching the row
under it, only where the drawing had pixels and both neighbours are opaque. Every frame keeps a foot on the baseline.

Parameters: assets_src/sprite2d.json. Layout: content/config.json `sprites`.
Usage: python3 tools/sprite2d.py build <id ...|all>
       python3 tools/sprite2d.py review <id ...|all>   (4x sheet + idle/walk GIFs per id in review.dir)
"""

from __future__ import annotations

import argparse
import sys

import numpy as np
from assetlib import ROOT, content_json, hex_rgb, load_json, save_png
from PIL import Image

CFG = load_json(ROOT / "assets_src/sprite2d.json")
SPRITES = content_json("content/config.json")["sprites"]
CELL = SPRITES["sheetCell"]
ROWS = sorted(SPRITES["sheetRows"].values())


def _opaque(f: np.ndarray) -> np.ndarray:
    return f[..., 3] > 0


def _top(f: np.ndarray) -> int:
    return int(np.nonzero(_opaque(f).any(axis=1))[0].min())


def rig(f: np.ndarray) -> dict:
    """Bands of one frame: neck / arm / hip rows and the legs' column extent (split at legMid into left / right)."""
    b = CFG["bands"]
    op = _opaque(f)
    ys = np.nonzero(op.any(axis=1))[0]
    top, bot = int(ys.min()), int(ys.max())
    h = bot - top + 1
    lo, hi = top + round(b["neckBand"][0] * h), top + round(b["neckBand"][1] * h)
    neck = lo + int(np.argmin(op.sum(axis=1)[lo : hi + 1]))
    hip = max(bot + 1 - max(b["minLegRows"], round(b["legFrac"] * h)), neck + 1)
    xs = np.nonzero(op[hip])[0]
    leg_l, leg_r = int(xs.min()), int(xs.max())
    arm_top = neck + round(CFG["arms"]["topFrac"] * (hip - neck))
    return {"neck": neck, "hip": hip, "armTop": arm_top, "legL": leg_l, "legR": leg_r, "legMid": (leg_l + leg_r + 1) // 2}


def _label8(op: np.ndarray) -> tuple[np.ndarray, list[int]]:
    """8-connected labelling: (labels, -1 = background; size per label)."""
    h, w = op.shape
    lab = np.full((h, w), -1, np.int32)
    sizes: list[int] = []
    for y0, x0 in zip(*np.nonzero(op), strict=True):
        if lab[y0, x0] >= 0:
            continue
        n, todo = len(sizes), [(y0, x0)]
        lab[y0, x0] = n
        for y, x in todo:
            for ny in range(max(y - 1, 0), min(y + 2, h)):
                for nx in range(max(x - 1, 0), min(x + 2, w)):
                    if op[ny, nx] and lab[ny, nx] < 0:
                        lab[ny, nx] = n
                        todo.append((ny, nx))
        sizes.append(len(todo))
    return lab, sizes


def _floating(op: np.ndarray) -> np.ndarray:
    """Pixels not 8-connected to the largest piece (a hovering drone, a loose ribbon): they move rigidly."""
    lab, sizes = _label8(op)
    return op & (lab != int(np.argmax(sizes)))


def _blit(dst: np.ndarray, src: np.ndarray, mask: np.ndarray, dy: int) -> None:
    ys, xs = np.nonzero(mask)
    ty = ys + dy
    ok = (ty >= 0) & (ty < dst.shape[0])
    dst[ty[ok], xs[ok]] = src[ys[ok], xs[ok]]


def pose(
    f: np.ndarray, d_head: int, d_body: int, d_arms: tuple[int, int] = (0, 0), d_legs: tuple[int, int] = (0, 0)
) -> np.ndarray:
    """Redraws f with the head band moved d_head px, the body band d_body px, the left / right arm (body pixels
    outside the legs' columns, below armTop) a further d_arms px and the left / right leg d_legs px (negative =
    foot lifted; the planted leg stays on the baseline)."""
    if d_head == 0 and d_body == 0 and d_arms == (0, 0) and d_legs == (0, 0):
        return f.copy()
    g = rig(f)
    whole = _opaque(f)
    loose = _floating(whole)
    op = whole & ~loose
    rows = np.arange(f.shape[0])[:, None]
    cols = np.arange(f.shape[1])[None, :]
    body = op & (rows >= g["neck"]) & (rows < g["hip"])
    lower = body & (rows >= g["armTop"])
    arm_l, arm_r = lower & (cols < g["legL"]), lower & (cols > g["legR"])
    out = np.zeros_like(f)
    legs = op & (rows >= g["hip"])
    _blit(out, f, legs & (cols < g["legMid"]), d_legs[0])
    _blit(out, f, legs & (cols >= g["legMid"]), d_legs[1])
    _blit(out, f, body & ~arm_l & ~arm_r, d_body)
    _blit(out, f, arm_l, d_body + d_arms[0])
    _blit(out, f, arm_r, d_body + d_arms[1])
    _blit(out, f, op & (rows < g["neck"]), d_head)
    _blit(out, f, loose, d_body)
    for seam in (g["neck"], g["armTop"], g["hip"]):
        for y in range(seam + 1, seam - 3, -1):
            if not 1 <= y < f.shape[0] - 1:
                continue
            fill = op[y] & ~_opaque(out[y]) & _opaque(out[y + 1]) & _opaque(out[y - 1])
            out[y, fill] = out[y + 1, fill]
    return out


def plant(f: np.ndarray) -> np.ndarray:
    """Front / back stand pose with both feet on the baseline: a leg half drawn in the air (left over from the
    sheet's own walk) is moved down onto it, up to walk.front.maxPlant px, its top stretched under the hem."""
    g = rig(f)
    op = _opaque(f)
    bot = int(np.nonzero(op.any(axis=1))[0].max())
    d = []
    for x0, x1 in ((g["legL"], g["legMid"]), (g["legMid"], g["legR"] + 1)):
        m = op[g["hip"] :, x0:x1]
        low = g["hip"] + int(np.nonzero(m.any(axis=1))[0].max()) if m.any() else bot
        d.append(min(bot - low, CFG["walk"]["front"]["maxPlant"]))
    return pose(f, 0, 0, (0, 0), (d[0], d[1]))


def idle_frames(stand: np.ndarray) -> list[np.ndarray]:
    i = CFG["idle"]
    body, lag = i["body"], i["headLag"]
    return [pose(stand, body[(k - lag) % len(body)], body[k]) for k in range(len(body))]


def stride_legs(f: np.ndarray, forward_left: bool) -> tuple[np.ndarray, np.ndarray] | None:
    """(forward leg, back leg) masks of a drawn side stride: the two pieces the legs split into below the crotch
    (the highest row from which down the leg region is still two pieces of at least side.minLegPx)."""
    sd = CFG["walk"]["side"]
    op = _opaque(f)
    top, bot = _top(f), _low(f)
    lo = bot - round(sd["maxLegFrac"] * (bot - top + 1))
    found = None
    for y0 in range(bot - 1, lo - 1, -1):
        lab, sizes = _label8(op[y0 : bot + 1])
        big = [i for i, n in enumerate(sizes) if n >= sd["minLegPx"]]
        if len(big) == 2:
            found = (y0, lab, big)
        elif found:
            break
    if not found:
        return _split_legs(f, forward_left)
    y0, lab, big = found
    legs = []
    for i in big:
        m = np.zeros_like(op)
        m[y0 : bot + 1] = lab == i
        legs.append(m)
    legs.sort(key=lambda m: float(np.nonzero(m)[1].mean()), reverse=not forward_left)
    return legs[0], legs[1]


def _split_legs(f: np.ndarray, forward_left: bool) -> tuple[np.ndarray, np.ndarray] | None:
    """Legs drawn touching: cut the legs band along the line from its top-row centre to the gap (or the middle)
    between the two lowest runs. None when the feet are not two runs either."""
    op = _opaque(f)
    hip, bot = rig(f)["hip"], _low(f)
    runs, foot_y = [], bot
    for y in range(bot, hip, -1):
        xs = np.nonzero(op[y])[0]
        breaks = np.nonzero(np.diff(xs) > 1)[0]
        if len(breaks) == 1:
            runs = [xs[breaks[0]], xs[breaks[0] + 1]]
            foot_y = y
            break
    if not runs:
        return None
    top_xs = np.nonzero(op[hip])[0]
    x_top, x_bot = (top_xs.min() + top_xs.max()) / 2, (runs[0] + runs[1]) / 2
    rows = np.arange(f.shape[0])[:, None]
    cols = np.arange(f.shape[1])[None, :]
    t = np.clip((rows - hip) / max(foot_y - hip, 1), 0, 1)
    left = cols < x_top + (x_bot - x_top) * t
    band = op & (rows >= hip)
    fwd, back = band & left, band & ~left
    return (fwd, back) if forward_left else (back, fwd)


def shade_far(f: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """The far limb a step darker and cooler (each pixel's own colour mixed toward side.farTint);
    near-black outline pixels stay."""
    sd = CFG["walk"]["side"]
    out = f.copy()
    m = mask & _opaque(f) & (f[..., :3].max(axis=2) >= sd["keepBelow"])
    tint = np.array(hex_rgb(sd["farTint"]), np.float32)
    mixed = f[m][:, :3].astype(np.float32) * sd["farShade"] + tint * (1 - sd["farShade"])
    out[m, :3] = np.rint(mixed).astype(np.uint8)
    return out


def side_strides(f: np.ndarray, row: str) -> tuple[np.ndarray, np.ndarray]:
    """The drawn stride twice: back leg far (shaded), then forward leg far, so the steps alternate legs."""
    legs = stride_legs(f, CFG["walk"]["side"]["forwardLeft"][row])
    if legs is None:
        return f.copy(), f.copy()
    fwd, back = legs
    return shade_far(f, back), shade_far(f, fwd)


def _common(f: np.ndarray, mask: np.ndarray) -> np.ndarray | None:
    """Most frequent colour (RGBA) under mask, or None."""
    px = f[mask]
    if not len(px):
        return None
    cols, counts = np.unique(px, axis=0, return_counts=True)
    return cols[int(np.argmax(counts))]


def side_stand(stride: np.ndarray, row: str) -> np.ndarray:
    """Side stand pose from the drawn stride (both feet on the ground): the legs band (from the hip row) cut in two
    along the crotch-to-feet line, each leg sheared (0 at the hip row, full at the foot) so its foot lands under the
    hips, `side.standGap` px ahead of / behind the hip centre; back leg drawn first. Rows never change, so both
    feet stay on the baseline. The stride itself when its legs cannot be split."""
    sd = CFG["walk"]["side"]
    forward_left = sd["forwardLeft"][row]
    legs = _split_legs(stride, forward_left)
    if legs is None:
        return stride.copy()
    fwd, back = legs
    y0 = int(np.nonzero((fwd | back).any(axis=1))[0].min())
    xs = np.nonzero(_opaque(stride)[y0 - 1])[0]
    hip_x = (xs.min() + xs.max()) / 2
    ahead = -1 if forward_left else 1
    out = stride.copy()
    out[fwd | back] = 0
    for leg, target in ((back, hip_x - ahead * sd["standGap"]), (fwd, hip_x + ahead * sd["standGap"])):
        ys, lx = np.nonzero(leg)
        yb = ys.max()
        foot_x = lx[ys >= yb - 1].mean()
        for y in range(y0, yb + 1):
            cols = lx[ys == y]
            tx = cols + round((target - foot_x) * (y - y0) / max(yb - y0, 1))
            ok = (tx >= 0) & (tx < out.shape[1])
            out[y, tx[ok]] = stride[y, cols[ok]]
    return out


def _low(f: np.ndarray) -> int:
    return int(np.nonzero(_opaque(f).any(axis=1))[0].max())


def walk_frames(cells: list[np.ndarray], row: str) -> list[np.ndarray]:
    """Side rows: the drawn stride twice with the near / far leg swapped, between the drawn passing poses (their bob
    is drawn in). Front / back rows: built from the planted
    stand pose, one foot lifted per step with the arms counter-swinging (walk.front); the lift shrinks until a foot
    is still on the baseline (legs drawn as one block under a skirt). Each pose is shown twice, the first time with
    the head still at the previous pose's height."""
    w = CFG["walk"]
    if row in w["sideRows"]:
        sd = w["side"]
        step_a, step_b = side_strides(cells[sd["stride"]], row)
        seq = [step_a, cells[sd["pass"][0]], step_b, cells[sd["pass"][1]]]
        out = []
        for k, cur in enumerate(seq):
            lag = max(-1, min(1, _top(seq[k - 1]) - _top(cur)))
            out += [pose(cur, lag, 0), cur.copy()]
        return out
    fr, swing = w["front"], CFG["arms"]["swing"][row]
    stand = plant(cells[0])
    ground = _low(stand)
    out = []
    for k, (body, foot) in enumerate(zip(fr["body"], fr["foot"], strict=True)):
        arms = (-foot * swing, foot * swing)
        prev = fr["body"][k - 1]
        pair: list[np.ndarray] = []
        for lift in range(fr["lift"], -1, -1):
            legs = (-lift if foot < 0 else 0, -lift if foot > 0 else 0)
            pair = [pose(stand, prev, body, arms, legs), pose(stand, body, body, arms, legs)]
            if all(_low(f) == ground for f in pair):
                break
        out += pair
    return out


def build_sheet(base: np.ndarray) -> np.ndarray:
    nb = base.shape[1] // CELL
    names = {v: k for k, v in SPRITES["sheetRows"].items()}
    rows = []
    for r in ROWS:
        cells = [base[r * CELL : (r + 1) * CELL, c * CELL : (c + 1) * CELL] for c in range(nb)]
        if names[r] in CFG["walk"]["sideRows"]:
            stand = side_stand(cells[CFG["walk"]["side"]["stride"]], names[r])
        else:
            stand = plant(cells[0])
        frames = idle_frames(stand) + walk_frames(cells, names[r])
        rows.append(np.concatenate(frames, axis=1))
    sheet = np.concatenate(rows, axis=0)
    want = SPRITES["sheetIdleFrames"] + SPRITES["sheetWalkFrames"]
    if sheet.shape[1] != want * CELL:
        raise ValueError(f"atlas has {sheet.shape[1] // CELL} columns, config wants {want}")
    return sheet


def _ids(args: list[str]) -> list[str]:
    if args == ["all"]:
        return sorted(p.stem for p in (ROOT / CFG["baseDir"]).glob("*.png"))
    return args


def _load(path) -> np.ndarray:
    return np.array(Image.open(path).convert("RGBA"))


def build(ids: list[str]) -> None:
    for i in ids:
        sheet = build_sheet(_load(ROOT / CFG["baseDir"] / f"{i}.png"))
        save_png(Image.fromarray(sheet, "RGBA"), ROOT / CFG["outDir"] / f"{i}.png")
        print(f"{i}: {sheet.shape[1]}x{sheet.shape[0]}")


def review(ids: list[str]) -> None:
    rv = CFG["review"]
    s, bg = rv["scale"], (*hex_rgb(rv["background"]), 255)
    out = ROOT / rv["dir"]
    n_idle = SPRITES["sheetIdleFrames"]
    for i in ids:
        sheet = build_sheet(_load(ROOT / CFG["baseDir"] / f"{i}.png"))
        img = Image.new("RGBA", (sheet.shape[1], sheet.shape[0]), bg)
        img.alpha_composite(Image.fromarray(sheet, "RGBA"))
        save_png(
            img.resize((img.width * s, img.height * s), Image.Resampling.NEAREST),
            out / f"{i}_sheet.png",
        )
        for name, c0, n in (
            ("idle", 0, n_idle),
            ("walk", n_idle, SPRITES["sheetWalkFrames"]),
        ):
            frames = []
            for k in range(n):
                strip = Image.new("RGBA", (CELL * len(ROWS), CELL), bg)
                for j, r in enumerate(ROWS):
                    cell = sheet[
                        r * CELL : (r + 1) * CELL, (c0 + k) * CELL : (c0 + k + 1) * CELL
                    ]
                    strip.alpha_composite(
                        Image.fromarray(np.ascontiguousarray(cell), "RGBA"),
                        (j * CELL, 0),
                    )
                frames.append(
                    strip.resize(
                        (strip.width * s, strip.height * s), Image.Resampling.NEAREST
                    ).convert("RGB")
                )
            out.mkdir(parents=True, exist_ok=True)
            frames[0].save(
                out / f"{i}_{name}.gif",
                save_all=True,
                append_images=frames[1:],
                duration=rv["gifMs"][name],
                loop=0,
            )
        print(f"{i}: {out}")


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("cmd", choices=["build", "review"])
    ap.add_argument("ids", nargs="+")
    a = ap.parse_args()
    (build if a.cmd == "build" else review)(_ids(a.ids))
    return 0


if __name__ == "__main__":
    sys.exit(main())
