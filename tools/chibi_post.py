#!/usr/bin/env python3
"""Chibi renders (tools/blender/chibi.py) -> 64px character atlases.

build <id...|all> [--raw DIR]   <raw>/<id>/frames.npz -> <raw>/<id>/atlas.png (8 idle + 8 walk columns, rows
                                down/left/right/up) and review.png (old sheet vs new, 4x)
install <id...|all> [--raw DIR] copy the reviewed atlas to public/assets/characters/<id>.png

Pixel steps: 4x mode downsample -> inner lines where another part sits in front -> face decals from the projected
anchors (eyes, blink, mouth, blush) -> sel-out outer outline -> soles on the sheet baseline.
Numbers and pixel templates live in assets_src/chibi/style.json; palettes in assets_src/chibi/cast.json.
"""

from __future__ import annotations

import argparse
import colorsys
import json
import pathlib
import shutil

import numpy as np
from assetlib import (
    ROOT,
    content_json,
    hex_rgb,
    load_json,
    load_src,
    save_png,
    to_image,
)

STYLE = load_json(ROOT / "assets_src/chibi/style.json")
_CAST_DOC = load_json(ROOT / "assets_src/chibi/cast.json")
CAST = {
    c["id"]: {**c, "colors": {**_CAST_DOC["defaults"]["colors"], **c["colors"]}}
    for c in _CAST_DOC["characters"]
}
DIRS = ("down", "left", "right", "up")
N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))


def _shift(a: np.ndarray, dy: int, dx: int, fill: float = 0) -> np.ndarray:
    out = np.full_like(a, fill)
    h, w = a.shape[:2]
    ys, yd = (
        (slice(0, h - dy), slice(dy, h))
        if dy >= 0
        else (slice(-dy, h), slice(0, h + dy))
    )
    xs, xd = (
        (slice(0, w - dx), slice(dx, w))
        if dx >= 0
        else (slice(-dx, w), slice(0, w + dx))
    )
    out[yd, xd] = a[ys, xs]
    return out


def downsample(
    col: np.ndarray, dat: np.ndarray, s: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per s x s block: opaque when most samples are, colour = most frequent opaque colour, part/depth from it."""
    h = col.shape[0] // s

    def blocks(a: np.ndarray) -> np.ndarray:
        return (
            a.reshape(h, s, h, s, -1).transpose(0, 2, 1, 3, 4).reshape(h, h, s * s, -1)
        )

    cb, db = blocks(col), blocks(dat)
    op = cb[..., 3] > 127
    code = (
        (cb[..., 0].astype(np.int64) << 16)
        | (cb[..., 1].astype(np.int64) << 8)
        | cb[..., 2]
    )
    code = np.where(op, code, -1)
    cnt = ((code[..., :, None] == code[..., None, :]) & op[..., None, :]).sum(-1)
    j = np.where(op, cnt, -1).argmax(-1)[..., None]
    alpha = op.sum(-1) * 2 >= s * s - 2
    rgb = np.take_along_axis(cb[..., :3], j[..., None], axis=2)[:, :, 0]
    pid = np.take_along_axis(db[..., 0], j, axis=2)[..., 0].astype(np.int32)
    depth = np.take_along_axis(db[..., 1], j, axis=2)[..., 0]
    rgba = np.zeros((h, h, 4), np.uint8)
    rgba[..., :3] = rgb
    rgba[..., 3] = np.where(alpha, 255, 0)
    pid[~alpha] = 0
    return rgba, pid, depth


_TONE: dict[tuple, tuple[int, int, int]] = {}


def darker(rgb, spec: dict) -> tuple[int, int, int]:
    key = (
        tuple(int(x) for x in rgb),
        spec["darken"],
        spec.get("hueTarget"),
        spec.get("hueShift", 0),
    )
    if key in _TONE:
        return _TONE[key]
    h, s, v = colorsys.rgb_to_hsv(*(c / 255 for c in key[0]))
    if "hueTarget" in spec:
        dh = ((spec["hueTarget"] - h + 0.5) % 1.0) - 0.5
        h = (h + dh * spec["hueShift"]) % 1.0
    s = min(1.0, s * 1.1 + 0.08)
    v *= spec["darken"]
    out = tuple(round(c * 255) for c in colorsys.hsv_to_rgb(h, s, v))
    _TONE[key] = out  # type: ignore[assignment]
    return out  # type: ignore[return-value]


def inner_lines(rgba, pid, depth, kinds: dict[int, str], cfg: dict) -> np.ndarray:
    out = rgba.copy()
    skip = {tuple(sorted(p)) for p in cfg["skipKinds"]}
    h, w = pid.shape
    for y in range(h):
        for x in range(w):
            p = pid[y, x]
            if not p:
                continue
            for dy, dx in N4:
                yy, xx = y + dy, x + dx
                if not (0 <= yy < h and 0 <= xx < w):
                    continue
                q = pid[yy, xx]
                if not q or q == p or tuple(sorted((kinds[p], kinds[q]))) in skip:
                    continue
                if depth[yy, xx] < depth[y, x] - cfg["depthGap"]:
                    out[y, x, :3] = darker(
                        rgba[y, x, :3],
                        {"darken": cfg["darken"], "hueTarget": 0.72, "hueShift": 0.08},
                    )
                    break
    return out


def outline(rgba: np.ndarray, depth: np.ndarray, cfg: dict) -> np.ndarray:
    out = rgba.copy()
    op = rgba[..., 3] > 0
    h, w = op.shape
    for y in range(h):
        for x in range(w):
            if op[y, x]:
                continue
            best = None
            for dy, dx in N4:
                yy, xx = y + dy, x + dx
                if (
                    0 <= yy < h
                    and 0 <= xx < w
                    and op[yy, xx]
                    and (best is None or depth[yy, xx] < depth[best])
                ):
                    best = (yy, xx)
            if best is not None:
                out[y, x, :3] = darker(rgba[best][:3], cfg)
                out[y, x, 3] = 255
    return out


def _stamp(
    img, pid, head_ids, rows, keys, colors, cx: float, cy: float, mirror=False
) -> None:
    th, tw = len(rows), len(rows[0])
    x0, y0 = round(cx - tw / 2), round(cy - th / 2)
    for r, line in enumerate(rows):
        for c, ch in enumerate(line[::-1] if mirror else line):
            if ch == ".":
                continue
            y, x = y0 + r, x0 + c
            if (
                0 <= y < img.shape[0]
                and 0 <= x < img.shape[1]
                and pid[y, x] in head_ids
            ):
                img[y, x, :3] = colors[keys[ch]]
                img[y, x, 3] = 255


def face(
    img, pid, head_ids, meta_frame, view: str, ch: dict, blink: bool, cell: int, dy: int
) -> None:
    if view == "up":
        return
    pal = {k: hex_rgb(v) for k, v in {**STYLE["faceColors"], **ch["colors"]}.items()}
    pal.update(
        {v: hex_rgb(v) for v in STYLE["eyes"]["keys"].values() if v.startswith("#")}
    )
    anchors = meta_frame["anchors"]
    vis = {k: a for k, a in anchors.items() if a[2] >= STYLE["face"]["minFacing"]}
    eye = STYLE["eyes"]["front" if view == "down" else "side"]
    rows = eye["closed"] if blink else eye["rows"]
    mirror = view == "left"
    for name in ("eyeL", "eyeR"):
        if name in vis:
            x, y, _ = vis[name]
            _stamp(
                img,
                pid,
                head_ids,
                rows,
                STYLE["eyes"]["keys"],
                pal,
                x * cell,
                y * cell + dy,
                mirror,
            )
    if ch.get("glasses"):
        g = STYLE["glasses"]["front" if view == "down" else "side"]
        for name in ("eyeL", "eyeR"):
            if name in vis:
                x, y, _ = vis[name]
                _stamp(img, pid, head_ids, g, STYLE["glasses"]["keys"], pal, x * cell, y * cell + dy, mirror)
    if ch.get("blush", False):
        for name in ("blushL", "blushR"):
            if name in vis:
                x, y, _ = vis[name]
                _stamp(
                    img,
                    pid,
                    head_ids,
                    STYLE["blush"]["rows"],
                    STYLE["blush"]["keys"],
                    pal,
                    x * cell,
                    y * cell + dy,
                    mirror,
                )
    if "mouth" in vis:
        x, y, _ = vis["mouth"]
        shape = ch.get("mouth", "smile") if view == "down" else "side"
        _stamp(
            img,
            pid,
            head_ids,
            STYLE["mouths"][shape],
            STYLE["mouths"]["keys"],
            pal,
            x * cell,
            y * cell + dy,
            mirror,
        )


def build(cid: str, raw: pathlib.Path) -> None:
    post = STYLE["post"]
    cell, s, sole = post["cell"], post["scale"], post["soleRow"]
    d = raw / cid
    z = np.load(d / "frames.npz")
    meta = json.loads((d / "frames.json").read_text())
    kinds = {p["index"]: p["kind"] for p in meta["parts"]}
    head_ids = {p["index"] for p in meta["parts"] if p["kind"] == "face"}
    ch = CAST[cid]
    frames = meta["frames"]
    small = [downsample(z["colour"][i], z["data"][i], s) for i in range(len(frames))]
    n_idle, n_walk = STYLE["frames"]["idle"], STYLE["frames"]["walk"]
    atlas = np.zeros((cell * 4, cell * (n_idle + n_walk), 4), np.uint8)
    shifts = []
    for i, f in enumerate(frames):
        rgba, pid, depth = small[i]
        # every frame stands on the baseline: the planted foot carries the weight, so the stride bob stays physical
        rows_op = np.nonzero(rgba[..., 3].any(axis=1))[0]
        dy = sole - 1 - int(rows_op.max())
        shifts.append(dy)
        rgba, pid, depth = (
            _shift(rgba, dy, 0),
            _shift(pid, dy, 0),
            _shift(depth, dy, 0, 1.0),
        )
        img = inner_lines(rgba, pid, depth, kinds, post["innerLine"])
        blink = (
            f["kind"] in post["blinkFrames"]
            and f["k"] in post["blinkFrames"][f["kind"]]
        )
        face(img, pid, head_ids, f, f["view"], ch, blink, cell, dy)
        img = outline(img, depth, post["outline"])
        col = f["k"] + (n_idle if f["kind"] == "walk" else 0)
        row = DIRS.index(f["view"])
        atlas[row * cell : (row + 1) * cell, col * cell : (col + 1) * cell] = img
    save_png(to_image(atlas.astype(np.float32)), d / "atlas.png")
    review(cid, atlas, d / "review.png")
    print(json.dumps({"id": cid, "atlas": str(d / "atlas.png"), "dy": [min(shifts), max(shifts)]}))


def review(cid: str, atlas: np.ndarray, path: pathlib.Path) -> None:
    rv = STYLE["post"]["review"]
    k, cell = rv["scale"], STYLE["post"]["cell"]
    old_path = ROOT / "public/assets/characters" / f"{cid}.png"
    old = (
        load_src(old_path)
        if old_path.exists()
        else np.zeros((cell * 4, cell, 4), np.float32)
    )
    old_col = old[:, :cell]
    pick = [0, 2, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15]
    new = np.concatenate(
        [atlas[:, c * cell : (c + 1) * cell].astype(np.float32) for c in pick], axis=1
    )
    gap = np.zeros((cell * 4, 8, 4), np.float32)
    sheet = np.concatenate([old_col, gap, new], axis=1)
    sheet = np.repeat(np.repeat(sheet, k, axis=0), k, axis=1)
    bg = np.empty_like(sheet)
    bg[..., :3] = hex_rgb(rv["background"])
    bg[..., 3] = 255
    a = sheet[..., 3:4] / 255.0
    bg[..., :3] = sheet[..., :3] * a + bg[..., :3] * (1 - a)
    save_png(to_image(bg), path)


def install(cid: str, raw: pathlib.Path) -> None:
    dst = ROOT / "public/assets/characters" / f"{cid}.png"
    shutil.copyfile(raw / cid / "atlas.png", dst)
    print(json.dumps({"installed": str(dst)}))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("build", "install"))
    ap.add_argument("ids", nargs="+")
    ap.add_argument("--raw", default=str(ROOT / STYLE["outDir"]))
    a = ap.parse_args()
    ids = list(CAST) if a.ids == ["all"] else a.ids
    known = {c["id"] for c in content_json("content/characters.json")}
    for cid in ids:
        if cid not in known:
            raise SystemExit(f"{cid} is not in content/characters.json")
        (build if a.cmd == "build" else install)(cid, pathlib.Path(a.raw))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
