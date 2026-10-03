"""Procedural nature & furniture prop toolkit (Blender 5.2, background).

Everything here is *mechanism*: pixel-art texture generators, low-poly shape builders, material/mesh assembly,
glTF export, GLB inspection and the preview contact sheet. All look/size/colour data comes from
tools/blender/nature_spec.json (style) and content/props.json (footprint/height); nothing prop-specific lives here.

Coordinates are Blender's: X right, Y back (front = -Y = glTF +Z), Z up. 1 unit = 1 tile.
"""

from __future__ import annotations

import importlib
import importlib.util
import itertools
import json
import math
import struct
import zlib
from pathlib import Path
from typing import Any

import numpy as np

# bpy is optional so texture generation also runs under plain python3 for quick iteration.
bpy: Any = importlib.import_module("bpy") if importlib.util.find_spec("bpy") else None


# =====================================================================================================
# Pixel-art textures (numpy, row 0 = top of the image)
# =====================================================================================================

_BAYER4 = (
    np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], np.float32)
    + 0.5
) / 16 - 0.5


def hex_rgb(h: str) -> np.ndarray:
    h = h.lstrip("#")
    return np.array([int(h[i : i + 2], 16) for i in (0, 2, 4)], np.float32)


def _pal(spec: dict, key: str = "palette") -> np.ndarray:
    return np.stack([hex_rgb(c) for c in spec[key]])


def _size(spec: dict) -> tuple[int, int]:
    s = spec.get("size", 32)
    return (s, s) if isinstance(s, int) else (int(s[0]), int(s[1]))  # (w, h)


def value_noise(rng, h: int, w: int, cell) -> np.ndarray:
    """Tileable smooth value noise in [0,1]; cell = px size (int or [cy, cx])."""
    cy, cx = (cell, cell) if isinstance(cell, (int, float)) else cell
    gy, gx = max(1, round(h / max(cy, 1))), max(1, round(w / max(cx, 1)))
    g = rng.random((gy, gx)).astype(np.float32)
    ys = (np.arange(h) + 0.5) / h * gy - 0.5
    xs = (np.arange(w) + 0.5) / w * gx - 0.5
    y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
    fy, fx = ys - y0, xs - x0
    fy, fx = (fy * fy * (3 - 2 * fy))[:, None], (fx * fx * (3 - 2 * fx))[None, :]
    a = g[np.ix_(y0 % gy, x0 % gx)]
    b = g[np.ix_(y0 % gy, (x0 + 1) % gx)]
    c = g[np.ix_((y0 + 1) % gy, x0 % gx)]
    d = g[np.ix_((y0 + 1) % gy, (x0 + 1) % gx)]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(rng, h: int, w: int, cells, weights) -> np.ndarray:
    v = np.zeros((h, w), np.float32)
    for c, wt in zip(cells, weights):
        v = v + wt * value_noise(rng, h, w, c)
    lo, hi = float(v.min()), float(v.max())
    return (v - lo) / (hi - lo + 1e-6)


def quantize(v: np.ndarray, n: int, dither: float) -> np.ndarray:
    h, w = v.shape
    b = np.tile(_BAYER4, (h // 4 + 1, w // 4 + 1))[:h, :w]
    return np.clip(np.floor(np.clip(v, 0, 1) * n + b * dither), 0, n - 1).astype(int)


def _grid(h: int, w: int):
    return np.mgrid[0:h, 0:w]


def _wrap_delta(a: np.ndarray, c: float, period: int) -> np.ndarray:
    d = (a - c) % period
    return np.where(d > period / 2, d - period, d)


def _noise_idx(spec, rng, h, w, n, lo=0):
    v = fbm(rng, h, w, spec.get("cells", [8, 4]), spec.get("weights", [0.7, 0.3]))
    return quantize(v, n - lo, spec.get("dither", 0.6)) + lo


def _voronoi(rng, h, w, count):
    pts = rng.random((count, 2)) * [h, w]
    Y, X = _grid(h, w)
    d = np.stack(
        [np.hypot(_wrap_delta(Y, py, h), _wrap_delta(X, px, w)) for py, px in pts]
    )
    order = np.argsort(d, axis=0)
    d_sorted = np.take_along_axis(d, order[:2], axis=0)
    return order[0], d_sorted[0], d_sorted[1], pts


def gen_noise(spec, rng, w, h):
    P = _pal(spec)
    return P[_noise_idx(spec, rng, h, w, len(P))]


def gen_bark(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    v = fbm(rng, h, w, [[max(h // 2, 1), 2], [max(h // 4, 1), 1]], [0.6, 0.4])
    idx = quantize(v, n - 1, spec.get("dither", 0.5)) + 1
    for _ in range(int(w * spec.get("cracks", 0.3))):
        x = int(rng.integers(w))
        y0 = int(rng.integers(h))
        for k in range(int(rng.integers(max(2, h // 4), max(3, int(h * 0.7))))):
            if rng.random() < 0.15:
                x = (x + int(rng.choice([-1, 1]))) % w
            idx[(y0 + k) % h, x] = 0
    ring = spec.get("rings")
    if ring:
        Y, _ = _grid(h, w)
        idx = np.where(Y % ring == 0, 0, idx)
        idx = np.where(Y % ring == 1, np.minimum(idx + 1, n - 1), idx)
    return P[idx]


def gen_planks(spec, rng, w, h):
    vertical = spec.get("vertical", False)
    if vertical:
        w, h = h, w
    P = _pal(spec)
    n = len(P)
    ph = int(spec.get("plank", 8))
    grain = fbm(rng, h, w, [[1, max(w // 2, 1)], [2, max(w // 4, 1)]], [0.6, 0.4])
    idx = np.zeros((h, w), int)
    tones = spec.get("tones", list(range(1, n)))
    amp = spec.get("grain", 2.0)
    for top in range(0, h, ph):
        tone = int(rng.choice(tones))
        rows = slice(top, min(top + ph, h))
        idx[rows] = np.clip(
            tone + np.round((grain[rows] - 0.5) * amp).astype(int), 1, n - 1
        )
        if rng.random() < spec.get("joints", 0.6):
            x = int(rng.integers(w))
            idx[rows, x] = 0
        idx[min(top + ph, h) - 1] = 0
        if spec.get("highlight", True) and top < h:
            idx[top] = np.minimum(idx[top] + 1, n - 1)
    for _ in range(int(spec.get("knots", 1))):
        y, x = int(rng.integers(h)), int(rng.integers(w))
        idx[y, x] = 0
        idx[y, (x + 1) % w] = 0
    Y, X = _grid(h, w)
    fr = int(spec.get("frame", 0))
    if spec.get("brace"):
        diag = np.abs(X - (h - 1 - Y) * (w - 1) / max(h - 1, 1))
        idx = np.where(diag < fr * 0.75, n - 2, np.where(diag < fr * 0.75 + 1, 0, idx))
    if fr:
        edge = np.minimum(np.minimum(X, Y), np.minimum(w - 1 - X, h - 1 - Y))
        idx = np.where(edge < fr, np.where(edge == 0, 0, n - 2), idx)
        idx = np.where(edge == fr, 0, idx)
    rgb = P[idx]
    return rgb.transpose(1, 0, 2) if vertical else rgb


def gen_leaves(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    idx = _noise_idx(spec, rng, h, w, 2)
    Y, X = _grid(h, w)
    rmin, rmax = spec.get("blob", [2.0, 3.5])
    count = int(h * w * spec.get("density", 0.9) / (rmax * rmax))
    for _ in range(count):
        cy, cx, r = (
            rng.random() * h,
            rng.random() * w,
            rmin + rng.random() * (rmax - rmin),
        )
        dy, dx = _wrap_delta(Y, cy, h), _wrap_delta(X, cx, w)
        inside = dy * dy + dx * dx <= r * r
        lit = (dx + dy) < -r * 0.35
        shade = (dx + dy) > r * 0.6
        idx = np.where(inside, np.where(lit, 3, np.where(shade, 1, 2)), idx)
    if n > 4:
        sp = rng.random((h, w)) < spec.get("sparkle", 0.03)
        idx = np.where(sp & (idx >= 2), 4, idx)
    return P[np.clip(idx, 0, n - 1)]


def gen_needles(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    idx = _noise_idx(spec, rng, h, w, 2)
    for _ in range(int(h * w * spec.get("density", 0.12))):
        y, x = int(rng.integers(h)), int(rng.integers(w))
        dx = int(rng.choice([-1, 1]))
        c = int(rng.choice(list(range(2, n)), p=None))
        for k in range(int(rng.integers(2, 5))):
            idx[(y + k) % h, (x + dx * k) % w] = c
    return P[idx]


def gen_blossom(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    idx = _noise_idx(spec, rng, h, w, max(2, n - 3))
    for _ in range(int(h * w * spec.get("density", 0.06))):
        y, x = int(rng.integers(h)), int(rng.integers(w))
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            idx[(y + dy) % h, (x + dx) % w] = n - 2
        idx[y, x] = n - 1
        if rng.random() < 0.5:
            idx[(y + 1) % h, (x + 1) % w] = max(0, n - 3)
    return P[idx]


def gen_stone(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    cell, d1, d2, pts = _voronoi(rng, h, w, int(spec.get("cells", 6)))
    tones = rng.integers(1, max(2, n - 1), size=len(pts))
    noise = fbm(rng, h, w, [4, 2], [0.6, 0.4])
    idx = np.clip(
        tones[cell] + np.round((noise - 0.5) * spec.get("noise", 2)).astype(int),
        1,
        n - 1,
    )
    Y, X = _grid(h, w)
    py, px = pts[cell, 0], pts[cell, 1]
    lit = (_wrap_delta(Y, py, h) + _wrap_delta(X, px, w)) < -d2 * 0.4
    idx = np.where(lit, np.minimum(idx + 1, n - 1), idx)
    idx = np.where((d2 - d1) < spec.get("edge", 1.0), 0, idx)
    return P[idx]


def gen_metal(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    nx, ny = spec.get("panels", [1, 1])
    pw, ph = max(4, w // nx), max(4, h // ny)
    brushed = fbm(rng, h, w, [[1, max(w // 2, 1)], [1, max(w // 8, 1)]], [0.5, 0.5])
    mid = int(spec.get("base", n // 2))
    idx = np.clip(
        mid + np.round((brushed - 0.5) * spec.get("brush", 1.5)).astype(int), 1, n - 2
    )
    Y, X = _grid(h, w)
    ly, lx = Y % ph, X % pw
    idx = np.where((ly == 0) | (lx == 0), n - 1, idx)
    idx = np.where((ly == ph - 1) | (lx == pw - 1), 0, idx)
    if spec.get("rivets", True):
        for ry in (2, ph - 3):
            for rx in (2, pw - 3):
                riv = (ly == ry) & (lx == rx)
                idx = np.where(riv, n - 1, idx)
                idx = np.where((ly == ry + 1) & (lx == rx), 1, idx)
    return P[idx]


def gen_fabric(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    c = int(spec.get("weave", 1))
    Y, X = _grid(h, w)
    a, b = spec.get("weaveIdx", [1, 2])
    idx = np.where(((Y // c + X // c) % 2) == 0, a, b)
    noise = rng.random((h, w)) < spec.get("fleck", 0.05)
    idx = np.where(noise, 0, idx)
    for start, width, col in spec.get("stripes", []):
        band = ((X if spec.get("vertical") else Y) - start) % h
        idx = (
            np.where(band < width, col, idx)
            if spec.get("repeat", False)
            else np.where(
                ((X if spec.get("vertical") else Y) >= start)
                & ((X if spec.get("vertical") else Y) < start + width),
                col,
                idx,
            )
        )
    return P[np.clip(idx, 0, n - 1)]


def gen_screen(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    idx = np.zeros((h, w), int)
    bz = int(spec.get("bezel", 1))
    if bz:
        idx[:bz], idx[-bz:], idx[:, :bz], idx[:, -bz:] = 1, 1, 1, 1
    text = list(range(2, n))
    y = bz + 1
    hb = spec.get("header", 2)
    if hb:
        idx[y : y + hb, bz + 1 : w - bz - 1] = text[0]
        y += hb + 2
    while y < h - bz - 1:
        x = bz + 1 + int(rng.integers(0, 3))
        end = w - bz - 1 - int(rng.integers(0, w // 3))
        while x < end:
            ln = int(rng.integers(2, 6))
            idx[y, x : min(x + ln, end)] = int(rng.choice(text))
            x += ln + int(rng.integers(1, 3))
        y += int(spec.get("lineStep", 3))
    rgb = P[idx]
    Y, _ = _grid(h, w)
    return rgb * np.where(Y % 2 == 1, 1 - spec.get("scanline", 0.2), 1.0)[..., None]


def gen_leds(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    u = int(spec.get("unit", 4))
    idx = np.zeros((h, w), int)
    Y, X = _grid(h, w)
    idx = np.where(Y % u == 0, 1, idx)
    vent = (X > w // 2) & (X % 2 == 0) & (Y % u == u // 2)
    idx = np.where(vent, 1, idx)
    leds = list(range(2, n))
    for top in range(0, h, u):
        for x in range(2, max(3, w // 2), 2):
            if rng.random() < spec.get("on", 0.6):
                idx[min(top + u // 2, h - 1), x] = int(rng.choice(leds))
    return P[idx]


def gen_books(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    idx = np.zeros((h, w), int)
    colors = list(range(1, n - 1))
    gap = int(spec.get("gap", 3))
    x = 0
    while x < w:
        bw = int(rng.integers(spec.get("minW", 2), spec.get("maxW", 4) + 1))
        g = int(rng.integers(0, gap + 1))
        idx[g:, x : x + bw] = int(rng.choice(colors))
        for band in spec.get("bands", [0.2, 0.8]):
            yy = g + int((h - g) * band)
            if yy < h and bw > 1:
                idx[yy, x : x + bw - 1] = n - 1
        idx[:, min(x + bw - 1, w - 1)] = np.where(
            idx[:, min(x + bw - 1, w - 1)] > 0, 0, 0
        )
        x += bw
    return P[idx]


def gen_goods(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    idx = np.zeros((h, w), int)
    x = 1
    while x < w - 1:
        bw = int(rng.integers(spec.get("minW", 3), spec.get("maxW", 6) + 1))
        bh = int(
            h * (spec.get("minH", 0.5) + rng.random() * (1 - spec.get("minH", 0.5)))
        )
        col = int(rng.integers(1, n - 1))
        x1 = min(x + bw, w - 1)
        idx[h - bh :, x:x1] = col
        idx[h - bh + bh // 2, x:x1] = n - 1
        x = x1 + int(rng.integers(0, 2))
    return P[idx]


def gen_rug(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    Y, X = _grid(h, w)
    d = np.minimum(np.minimum(X, Y), np.minimum(w - 1 - X, h - 1 - Y))
    idx = np.full((h, w), int(spec.get("field", 1)))
    acc = 0
    for px, col in spec.get("bands", []):
        idx = np.where((d >= acc) & (d < acc + px), col, idx)
        acc += px
    cx, cy = (w - 1) / 2, (h - 1) / 2
    dia = np.abs(X - cx) / max(cx - acc, 1) + np.abs(Y - cy) / max(cy - acc, 1)
    for lim, col in spec.get("diamond", []):
        idx = np.where((d >= acc) & (dia < lim), col, idx)
    fleck = rng.random((h, w)) < spec.get("fleck", 0.04)
    idx = np.where(fleck & (d >= acc), np.clip(idx - 1, 0, n - 1), idx)
    return P[idx]


def gen_arena(spec, rng, w, h):
    P = _pal(spec)
    Y, X = _grid(h, w)
    sw = int(spec.get("stripe", 4))
    idx = np.where((Y // sw) % 2 == 0, 0, 1)
    m = int(spec.get("inset", 2))
    line = int(spec.get("line", 2))
    border = (
        ((X == m) | (X == w - 1 - m) | (Y == m) | (Y == h - 1 - m))
        & (X >= m)
        & (X <= w - 1 - m)
        & (Y >= m)
        & (Y <= h - 1 - m)
    )
    cy, cx = (h - 1) / 2, (w - 1) / 2
    r = spec.get("circle", 0.22) * min(w, h)
    dist = np.hypot(X - cx, Y - cy)
    ring = np.abs(dist - r) < 0.6
    mid = (np.abs(Y - cy) < 0.6) & (X >= m) & (X <= w - 1 - m)
    bw, bh = int(spec.get("boxW", 0.4) * w) // 2, int(spec.get("boxH", 0.12) * h)
    box_x = np.abs(X - cx) <= bw
    boxes = (box_x & ((Y == m + bh) | (Y == h - 1 - m - bh))) | (
        (np.abs(np.abs(X - cx) - bw) < 0.6)
        & (((Y >= m) & (Y <= m + bh)) | ((Y <= h - 1 - m) & (Y >= h - 1 - m - bh)))
    )
    idx = np.where(border | ring | mid | boxes, line, idx)
    idx = np.where(dist < r * spec.get("dot", 0.35), int(spec.get("accent", 3)), idx)
    return P[idx]


def gen_stairs(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    steps = int(spec.get("steps", 4))
    sh = max(2, h // steps)
    Y, X = _grid(h, w)
    k = np.minimum(Y // sh, steps - 1)
    idx = np.round(k / max(steps - 1, 1) * (n - 3)).astype(int) + 1
    idx = np.where(Y % sh == sh - 1, np.minimum(idx + 1, n - 1), idx)
    idx = np.where(Y < sh, 0, idx)
    edge = int(spec.get("wall", 2))
    idx = np.where((X < edge) | (X >= w - edge), np.maximum(idx - 1, 0), idx)
    return P[idx]


def gen_lava(spec, rng, w, h):
    P = _pal(spec)
    H = _pal(spec, "hot")
    n = len(P)
    cell, d1, d2, _ = _voronoi(rng, h, w, int(spec.get("cells", 6)))
    noise = fbm(rng, h, w, [4, 2], [0.6, 0.4])
    tones = rng.integers(0, n, size=int(cell.max()) + 1)
    rgb = P[np.clip(tones[cell] + np.round((noise - 0.5) * 2).astype(int), 0, n - 1)]
    if spec.get("emitOnly"):
        rgb = np.zeros_like(rgb)
    gap = d2 - d1
    ew = spec.get("edge", 1.2)
    rgb = np.where((gap < ew * spec.get("halo", 2.2))[..., None], H[0], rgb)
    rgb = np.where((gap < ew)[..., None], H[min(1, len(H) - 1)], rgb)
    rgb = np.where((gap < ew * 0.45)[..., None], H[-1], rgb)
    return rgb


def gen_gradient(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    Y, X = _grid(h, w)
    t = (h - 1 - Y) / max(h - 1, 1)
    if spec.get("reverse"):
        t = 1 - t
    t = t + (fbm(rng, h, w, [4, 2], [0.6, 0.4]) - 0.5) * spec.get("noise", 0.25)
    fk = spec.get("facets", 0)
    if fk:
        t = t + np.where(
            (X // fk) % 2 == 0, spec.get("facetAmp", 0.12), -spec.get("facetAmp", 0.12)
        )
    idx = quantize(t, n, spec.get("dither", 0.8))
    sp = rng.random((h, w)) < spec.get("sparkle", 0.0)
    idx = np.where(sp, n - 1, idx)
    return P[idx]


def gen_stripes(spec, rng, w, h):
    P = _pal(spec)
    Y, X = _grid(h, w)
    axis = X if spec.get("vertical") else Y
    seq = []
    for col, px in spec["bands"]:
        seq += [col] * int(px)
    seq = np.array(seq)
    idx = seq[axis % len(seq)]
    fleck = rng.random((h, w)) < spec.get("fleck", 0.0)
    idx = np.where(fleck, np.maximum(idx - 1, 0), idx)
    return P[idx]


def gen_grid(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    c = int(spec.get("cell", 8))
    Y, X = _grid(h, w)
    ly, lx = Y % c, X % c
    idx = np.where((ly + lx) < c // 2, 2, 1)
    idx = np.where(ly == lx, n - 1, idx)
    idx = np.where((ly == 0) | (lx == 0), 0, idx)
    return P[idx]


def gen_blocks(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    bh, bw = int(spec.get("rowH", 8)), int(spec.get("blockW", 16))
    Y, X = _grid(h, w)
    row = Y // bh
    off = np.where(row % 2 == 1, bw // 2, 0)
    col = ((X + off) % w) // bw
    tones = rng.integers(1, n - 1, size=(h // bh + 1, w // bw + 2))
    noise = fbm(rng, h, w, [4, 2], [0.6, 0.4])
    idx = np.clip(tones[row, col] + np.round((noise - 0.5) * 2).astype(int), 1, n - 1)
    idx = np.where(Y % bh == 0, n - 1, idx)
    idx = np.where((Y % bh == bh - 1) | ((X + off) % bw == 0), 0, idx)
    return P[idx]


def gen_cactus(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    p = int(spec.get("rib", 4))
    _, X = _grid(h, w)
    phase = X % p
    ramp = np.array(spec.get("ribRamp", [0, 1, 2, 1]))
    idx = ramp[phase % len(ramp)]
    sp = (rng.random((h, w)) < spec.get("spines", 0.06)) & (
        phase == int(np.argmax(ramp))
    )
    idx = np.where(sp, n - 1, idx)
    return P[np.clip(idx, 0, n - 1)]


def gen_rings(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    Y, X = _grid(h, w)
    cx, cy = (
        (w - 1) / 2 + spec.get("offset", [0.5, -0.5])[0],
        (h - 1) / 2 + spec.get("offset", [0.5, -0.5])[1],
    )
    d = np.hypot(X - cx, Y - cy) + (rng.random((h, w)) - 0.5) * spec.get("wobble", 0.6)
    rw = spec.get("ringW", 2.0)
    idx = np.where((d // rw) % 2 == 0, 1, 2)
    idx = np.where(d < rw, n - 1, idx)
    R = min(w, h) / 2
    idx = np.where(d > R - spec.get("barkW", 1.5), 0, idx)
    return P[idx]


def gen_spots(spec, rng, w, h):
    P = _pal(spec)
    n = len(P)
    idx = _noise_idx(spec, rng, h, w, n - 1)
    Y, X = _grid(h, w)
    rmin, rmax = spec.get("spot", [1.2, 2.4])
    for _ in range(int(spec.get("count", 6))):
        cy, cx, r = (
            rng.random() * h,
            rng.random() * w,
            rmin + rng.random() * (rmax - rmin),
        )
        inside = _wrap_delta(Y, cy, h) ** 2 + _wrap_delta(X, cx, w) ** 2 <= r * r
        idx = np.where(inside, n - 1, idx)
    return P[idx]


GENERATORS = {
    "noise": gen_noise,
    "bark": gen_bark,
    "planks": gen_planks,
    "leaves": gen_leaves,
    "needles": gen_needles,
    "blossom": gen_blossom,
    "stone": gen_stone,
    "metal": gen_metal,
    "fabric": gen_fabric,
    "screen": gen_screen,
    "leds": gen_leds,
    "books": gen_books,
    "goods": gen_goods,
    "rug": gen_rug,
    "arena": gen_arena,
    "stairs": gen_stairs,
    "lava": gen_lava,
    "gradient": gen_gradient,
    "stripes": gen_stripes,
    "grid": gen_grid,
    "blocks": gen_blocks,
    "cactus": gen_cactus,
    "rings": gen_rings,
    "spots": gen_spots,
}


class TextureBank:
    """Generates (and caches) every texture key of the spec; atlases concatenate tiles horizontally."""

    def __init__(self, textures: dict):
        self.defs = textures
        self.cache: dict[str, np.ndarray] = {}

    def get(self, key: str) -> np.ndarray:
        if key not in self.cache:
            spec = self.defs[key]
            if spec["gen"] == "atlas":
                tiles = [self.get(t) for t in spec["tiles"]]
                hs = {t.shape[0] for t in tiles}
                if len(hs) != 1:
                    raise ValueError(
                        f"atlas {key}: tiles must share a height, got {sorted(hs)}"
                    )
                img = np.concatenate(tiles, axis=1)
            else:
                if spec["gen"] not in GENERATORS:
                    raise ValueError(
                        f"texture {key}: unknown generator {spec['gen']!r}"
                    )
                w, h = _size(spec)
                rng = np.random.default_rng(int(spec.get("seed", 1)))
                img = GENERATORS[spec["gen"]](spec, rng, w, h)
            self.cache[key] = np.clip(np.round(img), 0, 255).astype(np.uint8)
        return self.cache[key]

    def tiles(self, key: str) -> int:
        spec = self.defs[key]
        return len(spec["tiles"]) if spec["gen"] == "atlas" else 1


def write_png(path: Path, img: np.ndarray) -> None:
    img = np.ascontiguousarray(img.astype(np.uint8))
    h, w, c = img.shape
    color_type = {3: 2, 4: 6}[c]
    raw = b"".join(b"\x00" + img[y].tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


# =====================================================================================================
# Geometry: shapes produce local-space parts; parts are transformed, replicated and UV-mapped
# =====================================================================================================


class Geo:
    """Polygon soup with optional native per-loop UVs (world units), per-face tile and UV-mode overrides."""

    def __init__(self, closed: bool = True):
        self.v: list[tuple[float, float, float]] = []
        self.f: list[list[int]] = []
        self.uv: list[list[tuple[float, float]] | None] = []
        self.tile: list[int | None] = []
        self.mode: list[str | None] = []
        self.closed = closed

    def vert(self, co) -> int:
        self.v.append((float(co[0]), float(co[1]), float(co[2])))
        return len(self.v) - 1

    def face(self, idx, uv=None, tile=None, mode=None) -> None:
        self.f.append(list(idx))
        self.uv.append(list(uv) if uv is not None else None)
        self.tile.append(tile)
        self.mode.append(mode)

    def extend(self, other: Geo) -> None:
        base = len(self.v)
        self.v += other.v
        self.f += [[i + base for i in f] for f in other.f]
        self.uv += other.uv
        self.tile += other.tile
        self.mode += other.mode
        self.closed = self.closed and other.closed


def _rot_matrix(deg) -> np.ndarray:
    rx, ry, rz = (math.radians(a) for a in deg)
    cx, sx, cy, sy, cz, sz = (
        math.cos(rx),
        math.sin(rx),
        math.cos(ry),
        math.sin(ry),
        math.cos(rz),
        math.sin(rz),
    )
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def _rng(p: dict, salt: int = 0):
    return np.random.default_rng(int(p.get("seed", 1)) * 7919 + salt)


def _lathe_geo(
    profile,
    sides: int,
    *,
    start_deg=0.0,
    cap_tile=None,
    jitter=0.0,
    rng=None,
    closed=True,
) -> Geo:
    """Revolve [[r, z], ...] around Z. r == 0 endpoints become apex vertices; other ends get n-gon caps."""
    g = Geo(closed=closed)
    rings = []
    vlen = [0.0]
    for (r0, z0), (r1, z1) in itertools.pairwise(profile):
        vlen.append(vlen[-1] + math.hypot(r1 - r0, z1 - z0))
    rmax = max(r for r, _ in profile) or 1.0
    circ = 2 * math.pi * rmax
    for r, z in profile:
        if r <= 1e-9:
            rings.append([g.vert((0, 0, z))] * (sides + 1))
            continue
        ring = []
        for j in range(sides):
            a = math.radians(start_deg) + 2 * math.pi * j / sides
            rr = r * (
                1 + (rng.uniform(-jitter, jitter) if rng is not None and jitter else 0)
            )
            ring.append(g.vert((rr * math.cos(a), rr * math.sin(a), z)))
        rings.append(ring + [ring[0]])
    for i in range(len(profile) - 1):
        lo, hi = rings[i], rings[i + 1]
        for j in range(sides):
            u0, u1 = circ * j / sides, circ * (j + 1) / sides
            quad = [
                (lo[j], (u0, vlen[i])),
                (lo[j + 1], (u1, vlen[i])),
                (hi[j + 1], (u1, vlen[i + 1])),
                (hi[j], (u0, vlen[i + 1])),
            ]
            seen, poly = set(), []
            for vi, uv in quad:
                if vi not in seen:
                    seen.add(vi)
                    poly.append((vi, uv))
            if len(poly) >= 3:
                g.face([p[0] for p in poly], [p[1] for p in poly])
    for end, order in ((0, -1), (len(profile) - 1, 1)):
        if profile[end][0] > 1e-9 and closed:
            ring = rings[end][:sides][::order]
            g.face(ring, [(g.v[i][0], g.v[i][1]) for i in ring], cap_tile, "face")
    return g


def _frames(pts: np.ndarray):
    tang = (
        np.gradient(pts, axis=0)
        if len(pts) > 2
        else np.repeat((pts[1] - pts[0])[None], len(pts), 0)
    )
    tang = tang / (np.linalg.norm(tang, axis=1, keepdims=True) + 1e-9)
    ref = np.array([0, 0, 1.0]) if abs(tang[0][2]) < 0.9 else np.array([1.0, 0, 0])
    n = np.cross(tang[0], ref)
    n /= np.linalg.norm(n)
    normals = [n]
    for i in range(1, len(pts)):
        n = normals[-1] - np.dot(normals[-1], tang[i]) * tang[i]
        n /= np.linalg.norm(n) + 1e-9
        normals.append(n)
    normals = np.array(normals)
    return tang, normals, np.cross(tang, normals)


def _catmull(pts: np.ndarray, seg: int) -> np.ndarray:
    if seg <= 1 or len(pts) < 3:
        return pts
    P = np.vstack([2 * pts[0] - pts[1], pts, 2 * pts[-1] - pts[-2]])
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(seg):
            t = k / seg
            out.append(
                0.5
                * (
                    (2 * p1)
                    + (-p0 + p2) * t
                    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                    + (-p0 + 3 * p1 - 3 * p2 + p3) * t**3
                )
            )
    out.append(pts[-1])
    return np.array(out)


def _tube_geo(
    path,
    radii,
    sides,
    *,
    segments=1,
    cap_start="none",
    cap_end="flat",
    cap_tile=None,
    jitter=0.0,
    rng=None,
) -> Geo:
    pts = _catmull(np.array(path, float), int(segments))
    seglen = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
    total = seglen[-1] or 1.0
    if len(radii) == len(path) and len(path) == len(pts):
        rs = np.array(radii, float)
    else:
        src_t = np.linspace(0, 1, len(radii))
        rs = np.interp(seglen / total, src_t, np.array(radii, float))
    tang, nor, bin_ = _frames(pts)
    g = Geo(closed=cap_start != "none" and cap_end != "none")
    circ = 2 * math.pi * float(rs.max())
    rings = []
    for i, p in enumerate(pts):
        ring = []
        for j in range(sides):
            a = 2 * math.pi * j / sides
            rr = rs[i] * (
                1 + (rng.uniform(-jitter, jitter) if rng is not None and jitter else 0)
            )
            ring.append(g.vert(p + rr * (math.cos(a) * nor[i] + math.sin(a) * bin_[i])))
        rings.append(ring + [ring[0]])
    for i in range(len(pts) - 1):
        lo, hi = rings[i], rings[i + 1]
        for j in range(sides):
            u0, u1 = circ * j / sides, circ * (j + 1) / sides
            g.face(
                [lo[j], lo[j + 1], hi[j + 1], hi[j]],
                [
                    (u0, seglen[i]),
                    (u1, seglen[i]),
                    (u1, seglen[i + 1]),
                    (u0, seglen[i + 1]),
                ],
            )
    end = rings[-1]
    if cap_end in ("point", "dome"):
        last = end
        if cap_end == "dome":
            mid = []
            for j in range(sides):
                a = 2 * math.pi * j / sides
                mid.append(
                    g.vert(
                        pts[-1]
                        + tang[-1] * rs[-1] * 0.55
                        + rs[-1]
                        * 0.75
                        * (math.cos(a) * nor[-1] + math.sin(a) * bin_[-1])
                    )
                )
            mid.append(mid[0])
            for j in range(sides):
                g.face(
                    [last[j], last[j + 1], mid[j + 1], mid[j]],
                    [
                        (circ * j / sides, total),
                        (circ * (j + 1) / sides, total),
                        (circ * (j + 1) / sides, total + rs[-1] * 0.6),
                        (circ * j / sides, total + rs[-1] * 0.6),
                    ],
                )
            last = mid
        apex = g.vert(
            pts[-1] + tang[-1] * rs[-1] * (0.85 if cap_end == "dome" else 2.2)
        )
        for j in range(sides):
            g.face(
                [last[j], last[j + 1], apex],
                [
                    (circ * j / sides, total),
                    (circ * (j + 1) / sides, total),
                    (circ * (j + 0.5) / sides, total + rs[-1]),
                ],
            )
    elif cap_end == "flat":
        g.face(
            end[:sides],
            [
                (
                    math.cos(2 * math.pi * j / sides) * rs[-1],
                    math.sin(2 * math.pi * j / sides) * rs[-1],
                )
                for j in range(sides)
            ],
            cap_tile,
            "face",
        )
    if cap_start == "flat":
        ring = rings[0][:sides][::-1]
        g.face(
            ring,
            [
                (
                    math.cos(-2 * math.pi * j / sides) * rs[0],
                    math.sin(-2 * math.pi * j / sides) * rs[0],
                )
                for j in range(sides)
            ],
            cap_tile,
            "face",
        )
    return g


def _ico_unit(detail: int):
    """Icosphere (detail 0 = 20 faces, each level x4) as (verts ndarray, faces list)."""
    t = (1 + 5**0.5) / 2
    v = [
        (-1, t, 0),
        (1, t, 0),
        (-1, -t, 0),
        (1, -t, 0),
        (0, -1, t),
        (0, 1, t),
        (0, -1, -t),
        (0, 1, -t),
        (t, 0, -1),
        (t, 0, 1),
        (-t, 0, -1),
        (-t, 0, 1),
    ]
    v = [np.array(p, float) / np.linalg.norm(p) for p in v]
    f = [
        (0, 11, 5),
        (0, 5, 1),
        (0, 1, 7),
        (0, 7, 10),
        (0, 10, 11),
        (1, 5, 9),
        (5, 11, 4),
        (11, 10, 2),
        (10, 7, 6),
        (7, 1, 8),
        (3, 9, 4),
        (3, 4, 2),
        (3, 2, 6),
        (3, 6, 8),
        (3, 8, 9),
        (4, 9, 5),
        (2, 4, 11),
        (6, 2, 10),
        (8, 6, 7),
        (9, 8, 1),
    ]
    for _ in range(detail):
        cache: dict = {}

        def mid(a, b, cache=cache):
            k = (min(a, b), max(a, b))
            if k not in cache:
                m = v[a] + v[b]
                v.append(m / np.linalg.norm(m))
                cache[k] = len(v) - 1
            return cache[k]

        nf = []
        for a, b, c in f:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            nf += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        f = nf
    return np.array(v), f


def _ico_geo(size, detail, jitter, rng, cut=None) -> Geo:
    v, f = _ico_unit(int(detail))
    if jitter:
        v = v * (1 + rng.uniform(-jitter, jitter, size=(len(v), 1)))
    v = v * np.array(size, float)
    if cut is not None:
        zc = cut * size[2]
        v[:, 2] = np.maximum(v[:, 2], zc) - zc
    g = Geo()
    for p in v:
        g.vert(p)
    for tri in f:
        g.face(tri)
    return g


# ---- shapes ------------------------------------------------------------------------------------------


def shape_box(p, rng) -> Geo:
    sx, sy, sz = p["size"]
    t = p.get("taper", 1.0)
    tx, ty = (t, t) if isinstance(t, (int, float)) else t
    sh = p.get("shear", [0, 0])
    g = Geo()
    for z, kx, ky, ox, oy in ((0, 1, 1, 0, 0), (sz, tx, ty, sh[0], sh[1])):
        for x, y in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            g.vert((x * sx / 2 * kx + ox, y * sy / 2 * ky + oy, z))
    for f in (
        (0, 3, 2, 1),
        (4, 5, 6, 7),
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (3, 0, 4, 7),
    ):
        g.face(f)
    return g


def shape_lathe(p, rng) -> Geo:
    return _lathe_geo(
        p["profile"],
        int(p.get("sides", 8)),
        start_deg=p.get("startDeg", 0),
        cap_tile=p.get("capTile"),
        jitter=p.get("jitter", 0),
        rng=rng,
        closed=p.get("closed", True),
    )


def shape_cyl(p, rng) -> Geo:
    r = p["r"]
    return _lathe_geo(
        [[r, 0], [p.get("rTop", r), p["h"]]],
        int(p.get("sides", 8)),
        start_deg=p.get("startDeg", 0),
        cap_tile=p.get("capTile"),
        jitter=p.get("jitter", 0),
        rng=rng,
    )


def shape_spike(p, rng) -> Geo:
    r, h, tip = p["r"], p["h"], p.get("tip", 0.3)
    return _lathe_geo(
        [[r, 0], [p.get("rTop", r), h * (1 - tip)], [0, h]],
        int(p.get("sides", 6)),
        start_deg=p.get("startDeg", 0),
        jitter=p.get("jitter", 0),
        rng=rng,
    )


def shape_ico(p, rng) -> Geo:
    size = p.get("size") or [p["r"]] * 3
    return _ico_geo(size, p.get("detail", 1), p.get("jitter", 0), rng, p.get("cut"))


def shape_cluster(p, rng) -> Geo:
    g = Geo()
    rmin, rmax = p["r"]
    squash = p.get("squash", 1.0)
    n = int(p["count"])
    ring = p.get("ring", 0.5)
    rj, zj = p.get("ringJitter", 0.2), p.get("zJitter", 0.1)
    blobs = []
    if p.get("centerR"):
        blobs.append(((0.0, 0.0, p.get("centerZ", 0.0)), p["centerR"]))
    for k in range(n):
        a = (
            math.radians(p.get("startDeg", 0))
            + 2 * math.pi * k / n
            + rng.uniform(-0.3, 0.3)
        )
        d = ring * (1 + rng.uniform(-rj, rj))
        blobs.append(
            (
                (d * math.cos(a), d * math.sin(a), rng.uniform(-zj, zj)),
                rmin + rng.random() * (rmax - rmin),
            )
        )
    for (cx, cy, cz), r in blobs:
        b = _ico_geo([r, r, r * squash], p.get("detail", 1), p.get("jitter", 0.1), rng)
        b.v = [(x + cx, y + cy, z + cz) for x, y, z in b.v]
        g.extend(b)
    return g


def shape_tube(p, rng) -> Geo:
    r = p["r"]
    radii = r if isinstance(r, list) else [r, r]
    return _tube_geo(
        p["path"],
        radii,
        int(p.get("sides", 6)),
        segments=p.get("segments", 1),
        cap_start=p.get("capStart", "none"),
        cap_end=p.get("capEnd", "flat"),
        cap_tile=p.get("capTile"),
        jitter=p.get("jitter", 0),
        rng=rng,
    )


def shape_cones(p, rng) -> Geo:
    """Stacked pine tiers: notched/drooping rims, concave underside.

    Optional cap {tile, frac, line}: the top of each tier down to a jittered snow line (fraction `line` of the
    mid->rim band) uses atlas tile `tile`; the drooping rim below stays on the base tile.
    """
    g = Geo()
    tiers, sides = int(p["tiers"]), int(p.get("sides", 8))
    z0, z1 = p["z"]
    r0, r1 = p["r"]
    th = p.get("tierH", 0.45 * (z1 - z0))
    notch, droop, jit = p.get("notch", 0.2), p.get("droop", 0.15), p.get("jitter", 0.06)
    cap = p.get("cap")
    capf = cap["frac"] if cap else p.get("midFrac", 0.5)
    cap_tile = cap["tile"] if cap else None
    line = cap.get("line") if cap else None
    for i in range(tiers):
        t = i / max(tiers - 1, 1)
        R = r0 + (r1 - r0) * t
        apex_z = z0 + (z1 - z0 - th) * t + th
        base_z = apex_z - th
        rot = rng.uniform(0, 2 * math.pi)
        apex = g.vert((0, 0, apex_z))
        mid, rim, snow = [], [], []
        for j in range(sides):
            a = rot + 2 * math.pi * j / sides
            ca, sa = math.cos(a), math.sin(a)
            k = 1 - notch if j % 2 else 1.0
            rr = R * k * (1 + rng.uniform(-jit, jit))
            zz = base_z - (droop * th if j % 2 == 0 else 0)
            rim.append((rr * ca, rr * sa, zz))
            mr = R * capf * (1 + rng.uniform(-jit, jit))
            mid.append((mr * ca, mr * sa, apex_z - th * capf))
            if line is not None:
                f = min(0.95, max(0.05, line + rng.uniform(-jit, jit) * 2))
                snow.append(tuple(np.array(mid[-1]) + (np.array(rim[-1]) - np.array(mid[-1])) * f))
        rim_i = [g.vert(c) for c in rim]
        mid_i = [g.vert(c) for c in mid]
        snow_i = [g.vert(c) for c in snow]
        under = g.vert((0, 0, base_z + th * p.get("under", 0.2)))
        circ = 2 * math.pi * R
        for j in range(sides):
            jn = (j + 1) % sides
            u0, u1 = circ * j / sides, circ * (j + 1) / sides
            g.face([mid_i[j], mid_i[jn], apex], [(u0, 0), (u1, 0), ((u0 + u1) / 2, th * capf)], cap_tile)
            if snow_i:
                g.face([snow_i[j], snow_i[jn], mid_i[jn], mid_i[j]], [(u0, -th / 2), (u1, -th / 2), (u1, 0), (u0, 0)], cap_tile)
                g.face([rim_i[j], rim_i[jn], snow_i[jn], snow_i[j]], [(u0, -th), (u1, -th), (u1, -th / 2), (u0, -th / 2)])
            else:
                g.face([rim_i[j], rim_i[jn], mid_i[jn], mid_i[j]], [(u0, -th), (u1, -th), (u1, 0), (u0, 0)])
            g.face([rim_i[jn], rim_i[j], under], [(u1, 0), (u0, 0), ((u0 + u1) / 2, R)])
    return g


def shape_fronds(p, rng) -> Geo:
    """Folded, serrated leaf strips radiating from origin; lift/droop shape the arc."""
    g = Geo(closed=False)
    ox, oy, oz = p.get("origin", [0, 0, 0])
    n, segs = int(p["count"]), int(p.get("segments", 5))
    L, W = p["length"], p["width"]
    lift, droop, fold = (
        math.radians(p.get("lift", 20)),
        p.get("droop", 0.6),
        p.get("fold", 0.25),
    )
    serr = p.get("serrate", 0.0)
    for k in range(n):
        a = (
            math.radians(p.get("startDeg", 0))
            + 2 * math.pi * k / n
            + rng.uniform(-1, 1) * math.radians(p.get("spreadJitter", 10))
        )
        Lk = L * (
            1 + rng.uniform(-p.get("lengthJitter", 0.1), p.get("lengthJitter", 0.1))
        )
        d = np.array([math.cos(a), math.sin(a), 0.0])
        side = np.array([-d[1], d[0], 0.0])
        rows = []
        for s in range(segs + 1):
            t = s / segs
            pos = (
                np.array([ox, oy, oz])
                + d * Lk * t * math.cos(lift)
                + np.array([0, 0, Lk * t * math.sin(lift) - droop * Lk * t * t])
            )
            if s == segs:
                rows.append([g.vert(pos)])
                continue
            w = (
                W
                * (0.35 + 0.65 * math.sin(math.pi * min(1.0, 0.25 + t * 0.9)))
                * (1 - t) ** 0.35
            )
            if serr and s % 2 == 1:
                w *= 1 - serr
            dz = np.array([0, 0, fold * w])
            rows.append(
                [
                    g.vert(pos + side * w / 2 - dz),
                    g.vert(pos),
                    g.vert(pos - side * w / 2 - dz),
                ]
            )
        for s in range(segs):
            v0, v1 = s * L / segs, (s + 1) * L / segs
            a_, b_ = rows[s], rows[s + 1]
            if len(b_) == 1:
                g.face([a_[0], a_[1], b_[0]], [(-W / 2, v0), (0, v0), (0, v1)])
                g.face([a_[1], a_[2], b_[0]], [(0, v0), (W / 2, v0), (0, v1)])
            else:
                g.face(
                    [a_[0], a_[1], b_[1], b_[0]],
                    [(-W / 2, v0), (0, v0), (0, v1), (-W / 2, v1)],
                )
                g.face(
                    [a_[1], a_[2], b_[2], b_[1]],
                    [(0, v0), (W / 2, v0), (W / 2, v1), (0, v1)],
                )
    return g


def shape_strands(p, rng) -> Geo:
    """Hanging crossed tapered strips (moss, vines) distributed in an annulus."""
    g = Geo(closed=False)
    rmin, rmax = p.get("ring", [0.2, 0.8])
    lmin, lmax = p["length"]
    w = p.get("width", 0.08)
    for k in range(int(p["count"])):
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(rmin, rmax)
        cx, cy, cz = (
            d * math.cos(a),
            d * math.sin(a),
            rng.uniform(-p.get("zJitter", 0.1), p.get("zJitter", 0.1)),
        )
        ln = rng.uniform(lmin, lmax)
        for ang in (a, a + math.pi / 2):
            sx, sy = math.cos(ang) * w / 2, math.sin(ang) * w / 2
            i0 = g.vert((cx - sx, cy - sy, cz))
            i1 = g.vert((cx + sx, cy + sy, cz))
            i2 = g.vert((cx, cy, cz - ln))
            g.face([i0, i2, i1], [(0, ln), (w / 2, 0), (w, ln)])
    return g


def shape_truss(p, rng) -> Geo:
    """Square lattice tower: four tapered legs, ring bars per level and alternating face diagonals."""
    g = Geo(closed=False)
    hb, ht, h, levels, bar = p["base"], p["top"], p["h"], int(p["levels"]), p["bar"]

    def corner(i, z):
        k = hb + (ht - hb) * z / h
        sx, sy = ((-1, -1), (1, -1), (1, 1), (-1, 1))[i % 4]
        return np.array([sx * k, sy * k, z])

    def bar_between(a, b, r):
        g.extend(_tube_geo([a, b], [r, r], 4, cap_end="none"))

    for i in range(4):
        bar_between(corner(i, 0), corner(i, h), bar)
    for lv in range(1, levels + 1):
        z, zp = h * lv / levels, h * (lv - 1) / levels
        for i in range(4):
            bar_between(corner(i, z), corner(i + 1, z), bar * 0.7)
            a, b = (
                (corner(i, zp), corner(i + 1, z))
                if lv % 2
                else (corner(i + 1, zp), corner(i, z))
            )
            bar_between(a, b, bar * 0.5)
    g.closed = False
    return g


def shape_plane(p, rng) -> Geo:
    sx, sy = p["size"]
    g = Geo(closed=False)
    ids = [
        g.vert((x * sx / 2, y * sy / 2, 0))
        for x, y in ((-1, -1), (1, -1), (1, 1), (-1, 1))
    ]
    g.face(ids)
    if p.get("both"):
        g.face(ids[::-1])
    return g


SHAPES = {
    "box": shape_box,
    "lathe": shape_lathe,
    "cyl": shape_cyl,
    "spike": shape_spike,
    "ico": shape_ico,
    "cluster": shape_cluster,
    "tube": shape_tube,
    "cones": shape_cones,
    "fronds": shape_fronds,
    "strands": shape_strands,
    "truss": shape_truss,
    "plane": shape_plane,
}

_DIRS = {
    "+x": (1, 0, 0),
    "-x": (-1, 0, 0),
    "+y": (0, 1, 0),
    "-y": (0, -1, 0),
    "+z": (0, 0, 1),
    "-z": (0, 0, -1),
}


def _face_normal(pts: np.ndarray) -> np.ndarray:
    n = np.zeros(3)
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        n += np.cross(a, b)
    ln = np.linalg.norm(n)
    return n / ln if ln > 1e-12 else np.array([0, 0, 1.0])


def _project_uv(pts: np.ndarray, n: np.ndarray):
    ax = int(np.argmax(np.abs(n)))
    s = 1.0 if n[ax] >= 0 else -1.0
    if ax == 2:
        return [(x, y * s) for x, y, _ in pts]
    if ax == 0:
        return [(y * s, z) for _, y, z in pts]
    return [(-x * s, z) for x, _, z in pts]


def _signed_volume(v: np.ndarray, faces) -> float:
    vol = 0.0
    for f in faces:
        for i in range(1, len(f) - 1):
            vol += float(np.dot(v[f[0]], np.cross(v[f[i]], v[f[i + 1]])))
    return vol / 6


class MatInfo:
    def __init__(self, tiles: int, tex_w: int, tex_h: int, tpu: float):
        self.tiles, self.tile_w, self.tex_h, self.tpu = (
            tiles,
            tex_w // tiles,
            tex_h,
            tpu,
        )
        self.tex_w = tex_w


def _to_tex_uv(a: np.ndarray, normalized: bool, tile: int, mi: MatInfo) -> np.ndarray:
    """World-unit UVs repeat at the texel density; normalized UVs span one tile. Atlas faces never wrap."""
    a = np.array(a, float)
    if not normalized:
        a = a * mi.tpu / np.array([mi.tile_w, mi.tex_h])
        if mi.tiles == 1:
            return a
        a = a - np.floor(a.min(0))
        a = a / np.maximum(a.max(0), 1.0)
    elif mi.tiles == 1:
        return a
    iu, iv = 0.5 / mi.tex_w, 0.5 / mi.tex_h
    a[:, 0] = tile / mi.tiles + iu + a[:, 0] * (1 / mi.tiles - 2 * iu)
    a[:, 1] = iv + a[:, 1] * (1 - 2 * iv)
    return a


def _normalize(a: np.ndarray, lo: np.ndarray, hi: np.ndarray) -> np.ndarray:
    return (a - lo) / np.where(hi - lo > 1e-9, hi - lo, 1)


def build_part(
    p: dict, mat_infos: dict[str, MatInfo]
) -> tuple[np.ndarray, list, list, list, str]:
    """Returns (verts, faces, loop_uvs, smooth, mat) for every copy of a part."""
    if p["shape"] not in SHAPES:
        raise ValueError(f"unknown shape {p['shape']!r}")
    if p["mat"] not in mat_infos:
        raise ValueError(
            f"part uses material {p['mat']!r} not declared in the prop materials"
        )
    rng = _rng(p)
    g = SHAPES[p["shape"]](p, rng)
    v = np.array(g.v, float) * np.array(p.get("scale", [1, 1, 1]), float)
    faces = [list(f) for f in g.f]
    if g.closed and faces and _signed_volume(v, faces) < 0:
        faces = [f[::-1] for f in faces]
        g.uv = [u[::-1] if u is not None else None for u in g.uv]
    mi = mat_infos[p["mat"]]
    mode = p.get("uv", "world")
    dir_tiles = [(np.array(_DIRS[k]), t) for k, t in p.get("dirTiles", {}).items()]
    dir_uv = p.get("dirUv")
    base_tile = int(p.get("tile", 0))
    raws, modes, tiles = [], [], []
    for fi, f in enumerate(faces):
        pts = v[f]
        n = _face_normal(pts)
        face_tile = g.tile[fi]
        tile: int = face_tile if face_tile is not None else base_tile
        fmode = g.mode[fi] or mode
        for d, t in dir_tiles:
            if float(np.dot(n, d)) > p.get("dirThreshold", 0.7):
                tile = t
                fmode = dir_uv or fmode
        native = g.uv[fi]
        raws.append(np.array(native if (native is not None and fmode != "project") else _project_uv(pts, n), float))
        modes.append(fmode)
        tiles.append(tile)
    fit_raw = [r for r, m in zip(raws, modes) if m == "fit"]
    fit_lo = np.min([r.min(0) for r in fit_raw], axis=0) if fit_raw else None
    fit_hi = np.max([r.max(0) for r in fit_raw], axis=0) if fit_raw else None
    uvs = []
    for raw, fmode, tile in zip(raws, modes, tiles):
        if fmode == "face":
            uvs.append(_to_tex_uv(_normalize(raw, raw.min(0), raw.max(0)), True, tile, mi))
        elif fmode == "fit" and fit_lo is not None and fit_hi is not None:
            uvs.append(_to_tex_uv(_normalize(raw, fit_lo, fit_hi), True, tile, mi))
        else:
            uvs.append(_to_tex_uv(raw, False, tile, mi))
    # transform & replicate
    R = _rot_matrix(p.get("rot", [0, 0, 0]))
    pos = np.array(p.get("pos", [0, 0, 0]), float)
    base = v @ R.T
    copies = []
    grid = p.get("grid")
    offsets = [np.zeros(3)]
    if grid:
        cnt = list(grid["count"]) + [1] * (3 - len(grid["count"]))
        step = list(grid["step"]) + [0] * (3 - len(grid["step"]))
        offsets = [
            np.array(
                [
                    (i - (cnt[0] - 1) / 2) * step[0],
                    (j - (cnt[1] - 1) / 2) * step[1],
                    k * step[2],
                ]
            )
            for i in range(cnt[0])
            for j in range(cnt[1])
            for k in range(cnt[2])
        ]
    radial = p.get("radial")
    rots = [None]
    if radial:
        rots = [
            radial.get("start", 0) + 360 * k / radial["count"]
            for k in range(radial["count"])
        ]
    vary = p.get("vary", {})
    vr = _rng(p, 101)
    for off in offsets:
        for rz in rots:
            vv = base
            if vary:
                s = vr.uniform(*vary.get("scale", [1, 1]))
                vv = (vv * s) @ _rot_matrix(
                    [0, 0, vr.uniform(-vary.get("rot", 0), vary.get("rot", 0))]
                ).T
            vv = vv + pos + off
            if rz is not None and radial:
                pv = np.array(radial.get("pivot", [0, 0, 0]), float)
                vv = (vv - pv) @ _rot_matrix([0, 0, rz]).T + pv
            copies.append((vv, False))
    if p.get("mirror") == "x":
        copies += [(c * np.array([-1, 1, 1]), True) for c, _ in list(copies)]
    out_v, out_f, out_uv = [], [], []
    count = 0
    for vv, flipped in copies:
        out_v.append(vv)
        for f, uv in zip(faces, uvs):
            if flipped:
                out_f.append([i + count for i in f[::-1]])
                out_uv.append(uv[::-1])
            else:
                out_f.append([i + count for i in f])
                out_uv.append(uv)
        count += len(vv)
    smooth = [bool(p.get("smooth", False))] * len(out_f)
    return np.vstack(out_v), out_f, out_uv, smooth, p["mat"]


def fit_vertices(
    v: np.ndarray, fit, footprint, height: float, margin: float, center: bool | None
) -> np.ndarray:
    """Scale/centre authored geometry so it matches PropDef footprint/height; ground at z = 0."""
    lo, hi = v.min(0), v.max(0)
    size = np.maximum(hi - lo, 1e-9)
    target = np.array([footprint[0] - 2 * margin, footprint[1] - 2 * margin, height])
    if fit == "height":
        s = np.full(3, height / size[2])
        axes = []
    elif fit == "none":
        s = np.ones(3)
        axes = []
    else:
        axes = ["x", "y", "z"] if fit == "box" else list(fit)
        s = np.ones(3)
        for ax in axes:
            i = "xyz".index(ax)
            s[i] = target[i] / size[i]
    v = v * s
    lo, hi = v.min(0), v.max(0)
    shift = np.zeros(3)
    do_center = center if center is not None else fit not in ("height", "none")
    for i in (0, 1):
        if do_center or "xyz"[i] in axes:
            shift[i] = -(lo[i] + hi[i]) / 2
    shift[2] = -lo[2]
    return v + shift


# =====================================================================================================
# Blender assembly
# =====================================================================================================


def purge_scene() -> None:
    for coll in (
        bpy.data.objects,
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.cameras,
        bpy.data.lights,
        bpy.data.curves,
        bpy.data.worlds,
        bpy.data.node_groups,
        bpy.data.textures,
    ):
        ids = list(coll)
        if ids:
            bpy.data.batch_remove(ids)


def make_image(name: str, rgb: np.ndarray):
    h, w, _ = rgb.shape
    img = bpy.data.images.new(name, w, h, alpha=False)
    px = np.ones((h, w, 4), np.float32)
    px[..., :3] = rgb.astype(np.float32) / 255.0
    img.pixels.foreach_set(np.flipud(px).ravel())
    img.file_format = "PNG"
    img.pack()
    return img


def _ensure_nodes(idblock) -> None:
    if getattr(idblock, "node_tree", None) is None:
        idblock.use_nodes = True


def make_material(name: str, mdef: dict, bank: TextureBank, images: dict):
    def image(key):
        if key not in images:
            images[key] = make_image(key, bank.get(key))
        return images[key]

    mat = bpy.data.materials.new(name)
    _ensure_nodes(mat)
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    ext = "EXTEND" if bank.tiles(mdef["tex"]) > 1 else "REPEAT"
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image(mdef["tex"])
    tex.interpolation = "Closest"
    tex.extension = ext
    tex.location = (-400, 200)
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = mdef.get("rough", 0.85)
    bsdf.inputs["Metallic"].default_value = mdef.get("metal", 0.0)
    emit = mdef.get("emit", 0.0)
    if emit > 0:
        etex = tex
        if mdef.get("emitTex"):
            etex = nt.nodes.new("ShaderNodeTexImage")
            etex.image = image(mdef["emitTex"])
            etex.interpolation = "Closest"
            etex.extension = ext
            etex.location = (-400, -150)
        nt.links.new(etex.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = emit
    mat.use_backface_culling = not mdef.get("doubleSided", False)
    return mat


def build_mesh_object(
    name: str, parts_out, mat_order: list[str], materials: dict, fit_args
):
    verts, faces, loop_uv, smooth, mat_idx = [], [], [], [], []
    offset = 0
    for v, f, uv, sm, mname in parts_out:
        verts.append(v)
        faces += [[i + offset for i in face] for face in f]
        loop_uv += uv
        smooth += sm
        mat_idx += [mat_order.index(mname)] * len(f)
        offset += len(v)
    V = fit_vertices(np.vstack(verts), *fit_args)
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(p) for p in V], [], faces)
    uvl = me.uv_layers.new(name="UVMap")
    uvl.data.foreach_set(
        "uv", np.concatenate([np.asarray(u, float) for u in loop_uv]).ravel()
    )
    me.polygons.foreach_set("material_index", mat_idx)
    me.polygons.foreach_set("use_smooth", smooth)
    for mname in mat_order:
        me.materials.append(materials[mname])
    me.validate(clean_customdata=False)
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj, V


def export_glb(obj, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    for o in bpy.context.scene.objects:
        o.select_set(o == obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_extras=False,
        export_vertex_color="NONE",
        export_skins=False,
        export_morph=False,
    )


def build_prop(
    key: str, pspec: dict, pdef: dict, spec: dict, bank: TextureBank, out_path: Path
) -> dict:
    purge_scene()
    defaults = spec["defaults"]
    images: dict = {}
    materials, infos = {}, {}
    for exp_name, mkey in pspec["materials"].items():
        mdef = spec["materials"][mkey]
        emissive = mdef.get("emit", 0) > 0
        if emissive != exp_name.startswith(defaults["emissivePrefix"]):
            raise ValueError(
                f"{key}: material {exp_name} emissive={emissive} must match the {defaults['emissivePrefix']} prefix rule"
            )
        materials[exp_name] = make_material(exp_name, mdef, bank, images)
        th, tw, _ = bank.get(mdef["tex"]).shape
        infos[exp_name] = MatInfo(
            bank.tiles(mdef["tex"]), tw, th, mdef.get("tpu", defaults["texelsPerUnit"])
        )
    parts_out = [build_part(p, infos) for p in pspec["parts"]]
    used = {po[4] for po in parts_out}
    mat_order = [m for m in pspec["materials"] if m in used]
    fit_args = (
        pspec.get("fit", defaults["fit"]),
        pdef["footprint"],
        pdef["height"],
        pspec.get("margin", defaults["margin"]),
        pspec.get("center"),
    )
    obj, V = build_mesh_object(key, parts_out, mat_order, materials, fit_args)
    # write to <key>.part.glb (ignored by tools/build_manifest.py) and swap in atomically
    tmp = out_path.with_name(out_path.stem + ".part" + out_path.suffix)
    export_glb(obj, tmp)
    flt = spec["export"]
    set_sampler_filters(tmp, flt["magFilter"], flt["minFilter"])
    tmp.replace(out_path)
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    return {
        "key": key,
        "tris": tris,
        "bbox": [V.min(0).round(3).tolist(), V.max(0).round(3).tolist()],
        "materials": mat_order,
    }


# =====================================================================================================
# GLB inspection (pure python) & preview contact sheet
# =====================================================================================================


def read_glb(path: Path) -> dict:
    data = path.read_bytes()
    magic, version, _ = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67 or version != 2:
        raise ValueError(f"{path.name}: not a glTF 2 binary")
    ln, _ = struct.unpack_from("<II", data, 12)
    return json.loads(data[20 : 20 + ln])


def patch_glb_json(path: Path, patch) -> None:
    """Rewrite the JSON chunk in place (binary chunk untouched); patch(gltf_dict) mutates the document."""
    data = path.read_bytes()
    ln, _ = struct.unpack_from("<II", data, 12)
    doc = json.loads(data[20 : 20 + ln])
    patch(doc)
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    rest = data[20 + ln :]
    body = struct.pack("<II", len(js), 0x4E4F534A) + js + rest
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body)


def set_sampler_filters(path: Path, mag: int, min_: int) -> None:
    def patch(doc):
        for s in doc.get("samplers", []):
            s["magFilter"], s["minFilter"] = mag, min_

    patch_glb_json(path, patch)


def inspect_glb(path: Path) -> dict:
    """Bounds (glTF Y-up, converted back to Blender axes), triangle count, materials and sampler filters."""
    g = read_glb(path)
    lo, hi, tris = np.full(3, np.inf), np.full(3, -np.inf), 0
    for mesh in g.get("meshes", []):
        for prim in mesh["primitives"]:
            acc = g["accessors"][prim["attributes"]["POSITION"]]
            lo, hi = np.minimum(lo, acc["min"]), np.maximum(hi, acc["max"])
            tris += (
                g["accessors"][prim["indices"]]["count"]
                if "indices" in prim
                else acc["count"]
            ) // 3
    # glTF (x, y, z) = Blender (x, z, -y)
    blo = np.array([lo[0], -hi[2], lo[1]])
    bhi = np.array([hi[0], -lo[2], hi[1]])
    mats = [m.get("name", "") for m in g.get("materials", [])]
    filters = sorted(
        {(s.get("magFilter"), s.get("minFilter")) for s in g.get("samplers", [])},
        key=str,
    )
    emissive = [
        m.get("name")
        for m in g.get("materials", [])
        if any(m.get("emissiveFactor", [0, 0, 0]))
    ]
    double = [m.get("name") for m in g.get("materials", []) if m.get("doubleSided")]
    return {
        "bytes": path.stat().st_size,
        "tris": int(tris),
        "min": blo.round(3).tolist(),
        "max": bhi.round(3).tolist(),
        "materials": mats,
        "samplers": [list(f) for f in filters],
        "emissive": emissive,
        "doubleSided": double,
        "images": len(g.get("images", [])),
    }


def _setup_world(prev: dict) -> None:
    scene = bpy.context.scene
    world = bpy.data.worlds.new("preview")
    scene.world = world
    _ensure_nodes(world)
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (*(hex_rgb(prev["ambient"]) / 255), 1)
    bg.inputs["Strength"].default_value = prev["ambientStrength"]
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = scene.render.resolution_y = prev["cell"]
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "Standard"
    try:
        scene.eevee.taa_render_samples = prev.get("samples", 16)
    except AttributeError:
        pass
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = prev["sunEnergy"]
    sun.color = tuple(hex_rgb(prev["sunColor"]) / 255)
    so = bpy.data.objects.new("sun", sun)
    so.rotation_euler = [math.radians(a) for a in prev["sunRotDeg"]]
    scene.collection.objects.link(so)


def render_preview(glb: Path, label: str, out_png: Path, prev: dict) -> None:
    purge_scene()
    bpy.ops.import_scene.gltf(filepath=str(glb))
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    pts = np.array(
        [tuple(o.matrix_world @ v.co) for o in meshes for v in o.data.vertices]
    )
    lo, hi = pts.min(0), pts.max(0)
    c = (lo + hi) / 2
    _setup_world(prev)
    az, el = math.radians(prev["azimuthDeg"]), math.radians(prev["elevationDeg"])
    fwd = -np.array(
        [math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)]
    )
    right = np.cross(fwd, [0, 0, 1.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    corners = (
        np.array(
            [
                [x, y, z]
                for x in (lo[0], hi[0])
                for y in (lo[1], hi[1])
                for z in (lo[2], hi[2])
            ]
        )
        - c
    )
    ext = max(np.ptp(corners @ right), np.ptp(corners @ up))
    cam = bpy.data.cameras.new("cam")
    cam.type = "ORTHO"
    cam.ortho_scale = ext * prev["frame"]
    cam.shift_y = prev["shiftY"]
    dist = float(np.linalg.norm(hi - lo)) * 3 + 5
    co = bpy.data.objects.new("cam", cam)
    co.location = tuple(c - fwd * dist)
    mathutils = importlib.import_module("mathutils")
    co.rotation_euler = mathutils.Vector(tuple(fwd)).to_track_quat("-Z", "Y").to_euler()
    cam.clip_end = dist * 3
    bpy.context.scene.collection.objects.link(co)
    bpy.context.scene.camera = co
    txt = bpy.data.curves.new("label", "FONT")
    txt.body = label
    txt.size = cam.ortho_scale * prev["labelSize"]
    txt.align_x = "CENTER"
    to = bpy.data.objects.new("label", txt)
    to.parent = co
    to.location = (0, cam.ortho_scale * (cam.shift_y + prev["labelY"]), -1.0)
    tm = bpy.data.materials.new("label")
    _ensure_nodes(tm)
    tb = next(n for n in tm.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    tb.inputs["Base Color"].default_value = (0, 0, 0, 1)
    tb.inputs["Emission Color"].default_value = (
        *(hex_rgb(prev["labelColor"]) / 255),
        1,
    )
    tb.inputs["Emission Strength"].default_value = 1.0
    txt.materials.append(tm)
    bpy.context.scene.collection.objects.link(to)
    bpy.context.scene.render.filepath = str(out_png)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.render.render(write_still=True)


def compose_sheet(pngs: list[Path], out: Path, prev: dict) -> None:
    cell, cols = prev["cell"], prev["cols"]
    rows = (len(pngs) + cols - 1) // cols
    bgc = hex_rgb(prev["background"])
    sheet = np.zeros((rows * cell, cols * cell, 3), np.float32)
    sheet[:] = bgc
    Y, X = np.mgrid[0:cell, 0:cell]
    checker = (((Y // 16) + (X // 16)) % 2 == 0)[..., None]
    for i, png in enumerate(pngs):
        r, cidx = divmod(i, cols)
        tile = np.empty((cell, cell, 3), np.float32)
        tile[:] = bgc
        tile = np.where(checker, tile * 1.08, tile)
        if png.exists():
            img = bpy.data.images.load(str(png))
            px = np.empty(img.size[0] * img.size[1] * 4, np.float32)
            img.pixels.foreach_get(px)
            px = np.flipud(px.reshape(img.size[1], img.size[0], 4))[:cell, :cell]
            a = px[..., 3:4]
            tile = tile * (1 - a) + np.clip(px[..., :3], 0, 1) * 255 * a
            bpy.data.images.remove(img)
        tile[0, :], tile[:, 0] = bgc * 0.6, bgc * 0.6
        sheet[r * cell : (r + 1) * cell, cidx * cell : (cidx + 1) * cell] = tile
    write_png(out, np.clip(sheet, 0, 255).astype(np.uint8))
