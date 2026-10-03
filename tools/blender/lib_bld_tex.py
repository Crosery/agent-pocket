"""Procedural pixel-art textures (numpy only, no bpy).

Every pattern produces an (S, S) palette-index map, top row first, that tiles seamlessly; colours and
all shape parameters come from the texture spec in buildings_spec.json. Pattern ids are the
capability keys referenced by spec textures[*].pattern.
"""

import numpy as np


def hex_rgb(h):
    h = h.lstrip("#")
    return [int(h[i : i + 2], 16) for i in (0, 2, 4)]


class Pal:
    """Collects named colours into an index palette so patterns can paint by index."""

    def __init__(self):
        self.colors = []

    def add(self, hexcolor):
        rgb = hex_rgb(hexcolor)
        if rgb not in self.colors:
            self.colors.append(rgb)
        return self.colors.index(rgb)

    def many(self, hexes):
        return [self.add(h) for h in hexes]


def _rng(spec):
    return np.random.default_rng(int(spec["seed"]))


def _choose(rng, idxs, n=None, weights=None):
    p = None
    if weights:
        w = np.asarray(weights[: len(idxs)], dtype=float)
        p = w / w.sum()
    return rng.choice(idxs, size=n, p=p)


def _rows_sum(rng, total, sizes):
    """Random sequence of course heights from `sizes` summing exactly to `total`."""
    rows, acc = [], 0
    while acc < total:
        h = int(rng.choice(sizes))
        if total - acc - h < min(sizes) and total - acc != h:
            h = total - acc
        rows.append(h)
        acc += h
    return rows


# --------------------------------------------------------------------------- patterns


def p_noise(S, c, P, rng):
    base = P.add(c["base"])
    m = np.full((S, S), base, dtype=np.int32)
    for spot in c.get("spots", []):
        idx = P.add(spot["color"])
        k = int(spot.get("size", c["spotSize"]))
        n = int(spot["density"] * S * S / (k * k))
        ys, xs = rng.integers(0, S, n), rng.integers(0, S, n)
        for y, x in zip(ys, xs):
            for dy in range(k):
                for dx in range(k):
                    m[(y + dy) % S, (x + dx) % S] = idx
    return m


def p_brick(S, c, P, rng):
    bricks = P.many(c["bricks"])
    mortar, shade = P.add(c["mortar"]), P.add(c["shade"])
    hi = P.add(c["highlight"]) if "highlight" in c else None
    bw, bh = int(c["brickW"]), int(c["brickH"])
    m = np.full((S, S), mortar, dtype=np.int32)
    for r in range(S // bh):
        y0 = r * bh
        off = (bw // 2) * (r % 2)
        for b in range(S // bw + 1):
            x0 = b * bw + off
            col = int(_choose(rng, bricks, weights=c.get("weights")))
            for y in range(y0, y0 + bh - 1):
                for x in range(x0, x0 + bw - 1):
                    m[y % S, x % S] = col
            for x in range(x0, x0 + bw - 1):
                m[(y0 + bh - 2) % S, x % S] = shade
            if hi is not None:
                m[y0 % S, x0 % S] = hi
    return m


def p_stone(S, c, P, rng):
    stones = P.many(c["stones"])
    mortar, shade, hi = P.add(c["mortar"]), P.add(c["shade"]), P.add(c["highlight"])
    m = np.full((S, S), mortar, dtype=np.int32)
    y = 0
    for h in _rows_sum(rng, S, [int(v) for v in c["rowH"]]):
        x = int(rng.integers(0, S))
        end = x + S
        while x < end:
            w = int(rng.integers(int(c["wMin"]), int(c["wMax"]) + 1))
            w = min(w, end - x)
            col = int(_choose(rng, stones, weights=c.get("weights")))
            if w >= 2 and h >= 2:
                for yy in range(y, y + h - 1):
                    for xx in range(x, x + w - 1):
                        m[yy % S, xx % S] = col
                for xx in range(x, x + w - 1):
                    m[(y + h - 2) % S, xx % S] = shade
                for yy in range(y, y + h - 2):
                    m[yy % S, (x + w - 2) % S] = shade
                m[y % S, x % S] = hi
                if w > 3:
                    m[y % S, (x + 1) % S] = hi
            x += w
        y += h
    return m


def p_planks(S, c, P, rng):
    cols = P.many(c["planks"])
    seam, grain = P.add(c["seam"]), P.add(c["grain"])
    knot = P.add(c["knot"]) if "knot" in c else None
    pw = int(c["plankW"])
    m = np.zeros((S, S), dtype=np.int32)
    for i in range(S // pw):
        col = int(_choose(rng, cols))
        m[:, i * pw : (i + 1) * pw] = col
        m[:, i * pw] = seam
        joint = int(rng.integers(0, S))
        m[joint, i * pw : (i + 1) * pw] = seam
        for _ in range(int(c["grainLines"])):
            gx = i * pw + 1 + int(rng.integers(0, max(1, pw - 1)))
            gy, gl = int(rng.integers(0, S)), int(rng.integers(c["grainLen"][0], c["grainLen"][1] + 1))
            for yy in range(gy, gy + gl):
                if m[yy % S, gx % S] != seam:
                    m[yy % S, gx % S] = grain
        if knot is not None and rng.random() < float(c["knotChance"]):
            ky, kx = (
                int(rng.integers(0, S)),
                i * pw + 1 + int(rng.integers(0, max(1, pw - 2))),
            )
            m[ky % S, kx % S] = knot
    if c["dir"] == "h":
        m = m.T.copy()
    return m


def p_shingles(S, c, P, rng):
    cols = P.many(c["shingles"])
    edge, gap = P.add(c["edge"]), P.add(c["gap"])
    hi = P.add(c["highlight"]) if "highlight" in c else None
    rh, sw = int(c["rowH"]), int(c["shingleW"])
    m = np.zeros((S, S), dtype=np.int32)
    for r in range(S // rh):
        y0 = r * rh
        off = (sw // 2) * (r % 2)
        for b in range(S // sw + 1):
            x0 = b * sw + off
            col = int(_choose(rng, cols, weights=c.get("weights")))
            for y in range(y0, y0 + rh):
                for x in range(x0, x0 + sw):
                    m[y % S, x % S] = col
            for y in range(y0, y0 + rh):
                m[y % S, x0 % S] = gap
            if hi is not None:
                m[y0 % S, (x0 + 1) % S] = hi
        m[(y0 + rh - 1) % S, :] = edge
    return m


def p_tiles(S, c, P, rng):
    """Barrel roof tiles: columns with a light crown and dark troughs, row breaks with shadow."""
    light, mid, dark = P.add(c["light"]), P.add(c["mid"]), P.add(c["dark"])
    edge = P.add(c["edge"])
    tw, th = int(c["tileW"]), int(c["tileH"])
    m = np.zeros((S, S), dtype=np.int32)
    for x in range(S):
        t = x % tw
        m[:, x] = dark if t == 0 else (light if t == tw // 2 else mid)
    for r in range(S // th):
        y = r * th + th - 1
        m[y % S, :] = edge
        for x in range(0, S, tw):
            m[(y + 1) % S, (x + tw // 2) % S] = light
    if "accent" in c:
        acc = P.add(c["accent"])
        n = int(float(c["accentDensity"]) * S * S / tw)
        for _ in range(n):
            x, y = int(rng.integers(0, S)), int(rng.integers(0, S))
            if m[y, x] == mid:
                m[y, x] = acc
    return m


def p_metal(S, c, P, rng):
    base, seam = P.add(c["base"]), P.add(c["seam"])
    rivet, hi = P.add(c["rivet"]), P.add(c["highlight"])
    streak = P.add(c["streak"]) if "streak" in c else None
    pw, ph = int(c["panelW"]), int(c["panelH"])
    m = np.full((S, S), base, dtype=np.int32)
    if streak is not None:
        for _ in range(int(c["streaks"])):
            x, y, l = (
                int(rng.integers(0, S)),
                int(rng.integers(0, S)),
                int(rng.integers(c["streakLen"][0], c["streakLen"][1] + 1)),
            )
            for yy in range(y, y + l):
                m[yy % S, x] = streak
    for y in range(0, S, ph):
        m[y, :] = seam
        m[(y + 1) % S, :] = hi
    for x in range(0, S, pw):
        m[:, x] = seam
    if c["rivets"]:
        for y in range(0, S, ph):
            for x in range(0, S, pw):
                ri = int(c["rivetInset"])
                for dx, dy in ((ri, ri), (pw - ri, ri), (ri, ph - ri), (pw - ri, ph - ri)):
                    m[(y + dy) % S, (x + dx) % S] = rivet
    return m


def p_grate(S, c, P, rng):
    frame, slat, shadow = P.add(c["frame"]), P.add(c["slat"]), P.add(c["shadow"])
    sh, b = int(c["slatH"]), int(c["border"])
    m = np.full((S, S), frame, dtype=np.int32)
    for y in range(b, S - b):
        m[y, b : S - b] = slat if (y - b) % sh < sh - 1 else shadow
    return m


def p_circuit(S, c, P, rng):
    base, trace, node = P.add(c["base"]), P.add(c["trace"]), P.add(c["node"])
    grid = P.add(c["grid"]) if "grid" in c else None
    m = np.full((S, S), base, dtype=np.int32)
    if grid is not None:
        step = int(c["gridStep"])
        m[::step, :] = grid
        m[:, ::step] = grid
    for _ in range(int(c["traces"])):
        x, y = int(rng.integers(0, S)), int(rng.integers(0, S))
        for _seg in range(int(rng.integers(c["segs"][0], c["segs"][1] + 1))):
            dx, dy = [(1, 0), (-1, 0), (0, 1), (0, -1)][int(rng.integers(0, 4))]
            for _ in range(int(rng.integers(c["segLen"][0], c["segLen"][1] + 1))):
                m[y % S, x % S] = trace
                x, y = x + dx, y + dy
        m[y % S, x % S] = node
        m[(y + 1) % S, x % S] = node
    return m


def p_glass(S, c, P, rng):
    frame, mull = P.add(c["frame"]), P.add(c["mullion"])
    top, bot, glint = P.add(c["paneTop"]), P.add(c["paneBottom"]), P.add(c["glint"])
    b, cols, rows = int(c["border"]), int(c["cols"]), int(c["rows"])
    m = np.full((S, S), frame, dtype=np.int32)
    inner = S - 2 * b
    for y in range(b, S - b):
        m[y, b : S - b] = top if (y - b) < inner * float(c["split"]) else bot
    for i in range(1, cols):
        x = b + i * inner // cols
        m[b : S - b, x] = mull
    for j in range(1, rows):
        y = b + j * inner // rows
        m[y, b : S - b] = mull
    for k in range(int(c["glints"])):
        gi, (gsx, gsy) = int(c["glintInset"]), c["glintStep"]
        x0, y0 = b + gi + k * gsx, b + gi + k * gsy
        for t in range(int(c["glintLen"])):
            if (
                b <= y0 + t < S - b
                and b <= x0 + t < S - b
                and m[y0 + t, x0 + t] != mull
            ):
                m[y0 + t, x0 + t] = glint
    if "sill" in c:
        m[S - b :, :] = P.add(c["sill"])
    return m


def p_door(S, c, P, rng):
    m = p_planks(
        S,
        {
            "planks": c["planks"],
            "seam": c["seam"],
            "grain": c["grain"],
            "plankW": c["plankW"],
            "grainLines": c["grainLines"],
            "grainLen": c["grainLen"],
            "knotChance": 0,
            "dir": "v",
        },
        P,
        rng,
    )
    frame = P.add(c["frame"])
    b = int(c["border"])
    m[:b, :] = frame
    m[:, :b] = frame
    m[:, S - b :] = frame
    if "band" in c:
        band = P.add(c["band"])
        for fy in c["bands"]:
            y = int(S * fy)
            m[y : y + int(c["bandH"]), b : S - b] = band
    if "window" in c:
        win = P.add(c["window"])
        wy0, wy1 = int(S * c["windowY"][0]), int(S * c["windowY"][1])
        wx0, wx1 = int(S * c["windowX"][0]), int(S * c["windowX"][1])
        m[wy0:wy1, wx0:wx1] = win
        m[wy0:wy1, (wx0 + wx1) // 2] = frame
    handle = P.add(c["handle"])
    hy, hx = int(S * c["handleAt"][1]), int(S * c["handleAt"][0])
    k = int(c["handleSize"])
    m[hy : hy + k, hx : hx + k] = handle
    return m


def p_stripes(S, c, P, rng):
    cols = P.many(c["colors"])
    sw = int(c["stripeW"])
    m = np.zeros((S, S), dtype=np.int32)
    for x in range(S):
        m[:, x] = cols[(x // sw) % len(cols)]
    if "hem" in c:
        hem = P.add(c["hem"])
        hh = int(c["hemH"])
        m[S - hh :, :] = hem
    if "shade" in c:
        m[0, :] = P.add(c["shade"])
    if c["dir"] == "h":
        m = m.T.copy()
    return m


def _stamp_glyph(m, glyph_rows, color, x0, y0, scale):
    for gy, row in enumerate(glyph_rows):
        for gx, ch in enumerate(row):
            if ch != "." and ch != " ":
                col = color[ch] if isinstance(color, dict) else color
                m[
                    y0 + gy * scale : y0 + (gy + 1) * scale,
                    x0 + gx * scale : x0 + (gx + 1) * scale,
                ] = col


def p_sign(S, c, P, rng, glyphs):
    bg, border = P.add(c["bg"]), P.add(c["border"])
    b = int(c["borderW"])
    m = np.full((S, S), border, dtype=np.int32)
    m[b : S - b, b : S - b] = bg
    if "inner" in c:
        m[b, b : S - b] = P.add(c["inner"])
        m[b : S - b, b] = P.add(c["inner"])
    if "glyph" in c:
        rows = glyphs[c["glyph"]]
        gh, gw = len(rows), max(len(r) for r in rows)
        avail = S - 2 * b - 2 * int(c["pad"])
        scale = max(1, avail // max(gh, gw))
        gcol = c["glyphColors"] if "glyphColors" in c else {"#": c["glyphColor"]}
        color = {k: P.add(v) for k, v in gcol.items()}
        x0 = (S - gw * scale) // 2
        y0 = (S - gh * scale) // 2
        _stamp_glyph(m, rows, color, x0, y0, scale)
    return m


def p_marble(S, c, P, rng):
    base, vein, light = P.add(c["base"]), P.add(c["vein"]), P.add(c["light"])
    m = np.full((S, S), base, dtype=np.int32)
    n = int(c["lightDensity"] * S * S)
    m[rng.integers(0, S, n), rng.integers(0, S, n)] = light
    for _ in range(int(c["veins"])):
        x, y = int(rng.integers(0, S)), int(rng.integers(0, S))
        for _ in range(S):
            m[y % S, x % S] = vein
            x += 1
            y += int(rng.integers(-1, 2))
            if rng.random() < float(c["veinBreak"]):
                break
    if "joint" in c:
        j = P.add(c["joint"])
        step = int(c["jointStep"])
        m[::step, :] = j
        for r in range(0, S, step):
            off = (step // 2) * ((r // step) % 2)
            m[r : r + step, (off) % S] = j
    return m


def p_rock(S, c, P, rng):
    """Tileable Voronoi cells shaded from a dark→light ramp with crack edges."""
    shades = P.many(c["shades"])
    crack = P.add(c["crack"])
    n = int(c["cells"])
    pts = rng.random((n, 2)) * S
    shade_of = rng.integers(0, len(shades), n)
    ys, xs = np.mgrid[0:S, 0:S]
    best = np.full((S, S), 1e9)
    second = np.full((S, S), 1e9)
    owner = np.zeros((S, S), dtype=np.int32)
    for i, (px, py) in enumerate(pts):
        dx = np.abs(xs - px)
        dy = np.abs(ys - py)
        dx = np.minimum(dx, S - dx)
        dy = np.minimum(dy, S - dy)
        d = np.sqrt(dx * dx + dy * dy)
        closer = d < best
        second = np.where(closer, best, np.minimum(second, d))
        owner = np.where(closer, i, owner)
        best = np.where(closer, d, best)
    m = np.asarray(shades)[shade_of[owner]]
    m = np.where(second - best < float(c["crackW"]), crack, m)
    if "highlight" in c:
        hi = P.add(c["highlight"])
        top_edge = (np.roll(m, 1, axis=0) == crack) & (m != crack)
        m = np.where(top_edge, hi, m)
    return m.astype(np.int32)


def p_water(S, c, P, rng):
    base, wave, light = P.add(c["base"]), P.add(c["wave"]), P.add(c["light"])
    m = np.full((S, S), base, dtype=np.int32)
    for _ in range(int(c["waves"])):
        x, y, l = (
            int(rng.integers(0, S)),
            int(rng.integers(0, S)),
            int(rng.integers(c["waveLen"][0], c["waveLen"][1] + 1)),
        )
        for t in range(l):
            m[y, (x + t) % S] = wave
        m[(y - 1) % S, (x + l // 2) % S] = light
    return m


def p_fan(S, c, P, rng):
    bg, ring, blade, hub = (
        P.add(c["bg"]),
        P.add(c["ring"]),
        P.add(c["blade"]),
        P.add(c["hub"]),
    )
    ys, xs = np.mgrid[0:S, 0:S] + 0.5
    cx = cy = S / 2
    r = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2) / (S / 2)
    ang = np.arctan2(ys - cy, xs - cx)
    m = np.full((S, S), bg, dtype=np.int32)
    nb = int(c["blades"])
    r0, r1 = (float(v) for v in c["ringR"])
    on_blade = (
        np.mod(ang * nb / (2 * np.pi), 1.0) < float(c["bladeFill"])
    ) & (r < r0)
    m = np.where(on_blade, blade, m)
    m = np.where((r > r0) & (r < r1), ring, m)
    m = np.where(r < float(c["hubR"]), hub, m)
    return m.astype(np.int32)


def p_trim(S, c, P, rng):
    """Horizontal moulding bands (top highlight, body, bottom shadow) with optional studs."""
    bands = c["bands"]
    m = np.zeros((S, S), dtype=np.int32)
    total = sum(int(b["h"]) for b in bands)
    y = 0
    while y < S:
        for b in bands:
            idx = P.add(b["color"])
            for _ in range(int(b["h"])):
                if y < S:
                    m[y, :] = idx
                    y += 1
    if "stud" in c:
        stud = P.add(c["stud"])
        step = int(c["studStep"])
        for row in range(int(c.get("studRow", total // 2)), S, total):
            m[row, ::step] = stud
    return m


PATTERNS = {
    "noise": p_noise,
    "brick": p_brick,
    "stone": p_stone,
    "planks": p_planks,
    "shingles": p_shingles,
    "tiles": p_tiles,
    "metal": p_metal,
    "grate": p_grate,
    "circuit": p_circuit,
    "glass": p_glass,
    "door": p_door,
    "stripes": p_stripes,
    "marble": p_marble,
    "rock": p_rock,
    "water": p_water,
    "fan": p_fan,
    "trim": p_trim,
}


def _overlay(m, ov, P, rng, S):
    """Clustered blobs of extra colours (moss, dirt, soot) on top of any pattern."""
    cols = P.many(ov["colors"])
    for _ in range(int(ov["blobs"])):
        x, y = int(rng.integers(0, S)), int(rng.integers(0, S))
        for _ in range(int(ov["blobSize"])):
            m[y % S, x % S] = int(rng.choice(cols))
            x += int(rng.integers(-1, 2))
            y += int(rng.integers(-1, 2))
    return m


def render_texture(tex_spec, glyphs, pattern_defaults):
    """Returns uint8 RGBA array (S, S, 4), top row first. `pattern_defaults[pattern]` supplies the
    shape parameters a texture does not override."""
    S = int(tex_spec["size"])
    pattern = tex_spec["pattern"]
    c = {**pattern_defaults.get(pattern, {}), **tex_spec["colors"]}
    P = Pal()
    rng = _rng(tex_spec)
    if pattern == "sign":
        m = p_sign(S, c, P, rng, glyphs)
    elif pattern in PATTERNS:
        m = PATTERNS[pattern](S, c, P, rng)
    else:
        raise ValueError(f"unknown texture pattern {pattern!r}")
    for ov in tex_spec.get("overlays", []):
        m = _overlay(m, ov, P, rng, S)
    pal = np.asarray(P.colors, dtype=np.uint8)
    rgb = pal[m]
    alpha = np.full((S, S, 1), 255, dtype=np.uint8)
    return np.concatenate([rgb, alpha], axis=2)


PATTERN_IDS = sorted(list(PATTERNS.keys()) + ["sign"])
