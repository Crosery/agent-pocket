"""Low-poly geometry builders for the buildings pipeline (bpy/bmesh).

Each part type in buildings_spec.json maps to a builder here. A builder creates closed geometry
around its local origin in a scratch bmesh, tagging every face with a role ('top', 'side', ...);
the part's `mat` / `mats` map roles to material ids. Builders contain shape algorithms only — every
size, count and position comes from the spec.
"""

import itertools
import math

import bmesh
from lib_bld_spec import SpecError, ev, ev_vec
from mathutils import Matrix, Vector

# Facade decorations sink EMBED into their wall so they never float; glass/door slabs stand PROUD of
# their frames to avoid z-fighting. Structural offsets, not style parameters.
EMBED = 0.01
PROUD = 0.01

# --------------------------------------------------------------------------- scratch mesh


class Scratch:
    """Mesh under construction for one part: verts + faces with role names."""

    def __init__(self):
        self.verts = []
        self.faces = []

    def v(self, x, y, z):
        self.verts.append(Vector((x, y, z)))
        return len(self.verts) - 1

    def f(self, idxs, role):
        self.faces.append((list(idxs), role))

    def merge(self, other, matrix=None):
        base = len(self.verts)
        for co in other.verts:
            self.verts.append(matrix @ co if matrix is not None else co.copy())
        for idxs, role in other.faces:
            self.faces.append(([i + base for i in idxs], role))
        return self


def hexa(sc, corners, roles):
    """8 corners: bottom quad (0..3, CCW from above) then top quad (4..7). roles: 6 role names
    in order bottom, top, front(0-1), right(1-2), back(2-3), left(3-0)."""
    i = [sc.v(*c) for c in corners]
    sc.f([i[3], i[2], i[1], i[0]], roles[0])
    sc.f([i[4], i[5], i[6], i[7]], roles[1])
    sc.f([i[0], i[1], i[5], i[4]], roles[2])
    sc.f([i[1], i[2], i[6], i[5]], roles[3])
    sc.f([i[2], i[3], i[7], i[6]], roles[4])
    sc.f([i[3], i[0], i[4], i[7]], roles[5])
    return sc


def box_corners(sx, sy, sz, tx=1.0, ty=1.0, z0=0.0):
    hx, hy = sx / 2, sy / 2
    tx_, ty_ = hx * tx, hy * ty
    return [
        (-hx, -hy, z0),
        (hx, -hy, z0),
        (hx, hy, z0),
        (-hx, hy, z0),
        (-tx_, -ty_, z0 + sz),
        (tx_, -ty_, z0 + sz),
        (tx_, ty_, z0 + sz),
        (-tx_, ty_, z0 + sz),
    ]


# --------------------------------------------------------------------------- primitive builders


def b_box(p, s):
    sx, sy, sz = ev_vec(p["size"], s, 3)
    taper = p.get("taper", 1)
    tx, ty = (
        ev_vec(taper, s, 2) if isinstance(taper, list) else [float(ev(taper, s))] * 2
    )
    return hexa(
        Scratch(),
        box_corners(sx, sy, sz, tx, ty),
        ["bottom", "top", "front", "right", "back", "left"],
    )


def _solve_rise(top, half_span, thick):
    """Underside rise r such that r + thick*sqrt(1+(r/half)^2) == top (top-surface ridge height)."""
    r = max(0.01, top - thick)
    for _ in range(40):
        r = max(0.01, top - thick * math.sqrt(1 + (r / half_span) ** 2))
    return r


def b_gable(p, s):
    """Gable roof: two thick slabs meeting at a ridge along local X, optional gable-end fill and ridge cap.
    roles: top (roof surface), under (soffit), edge (slab ends / fascia), fill (gable triangles), ridge."""
    L, S = float(ev(p["length"], s)), float(ev(p["span"], s))
    t = float(ev(p["thick"], s))
    ox, oy = ev_vec(p.get("overhang", [0, 0]), s, 2)
    hs = S / 2
    rise = (
        float(ev(p["rise"], s))
        if "rise" in p
        else _solve_rise(float(ev(p["top"], s)), hs, t)
    )
    tan_a = rise / hs
    sec = math.sqrt(1 + tan_a * tan_a)
    sc = Scratch()
    lx = L / 2 + ox
    for side in (-1, 1):
        ye = side * (hs + oy)
        z_eave_under = -oy * tan_a
        z_ridge_under = rise
        n_y, n_z = side * tan_a / sec, 1 / sec
        under = [(0.0, z_ridge_under), (ye, z_eave_under)]
        top = [(y + t * n_y, z + t * n_z) for y, z in under]
        # ridge top lines of both slabs must meet on y=0: slide the top ridge point back along the slope
        top[0] = (0.0, z_ridge_under + t * sec)
        pts = [under[0], under[1], top[1], top[0]]
        c = []
        for x in (-lx, lx):
            for y, z in pts:
                c.append((x, y, z))
        # c: x=-lx: u0 u1 t1 t0 ; x=+lx: u0 u1 t1 t0
        i = [sc.v(*q) for q in c]
        a0, a1, a2, a3, b0, b1, b2, b3 = i
        faces = [
            ([a0, a1, b1, b0], "under"),
            ([a3, b3, b2, a2], "top"),
            ([a1, a2, b2, b1], "edge"),
            ([a0, b0, b3, a3], "edge"),
            ([a0, a3, a2, a1], "edge"),
            ([b0, b1, b2, b3], "edge"),
        ]
        for idxs, role in faces:
            sc.f(idxs, role)
    if p["fill"]:
        lf = L / 2
        i = [
            sc.v(-lf, -hs, 0),
            sc.v(-lf, hs, 0),
            sc.v(-lf, 0, rise),
            sc.v(lf, -hs, 0),
            sc.v(lf, hs, 0),
            sc.v(lf, 0, rise),
        ]
        sc.f([i[0], i[1], i[2]], "fill")
        sc.f([i[3], i[5], i[4]], "fill")
        sc.f([i[0], i[3], i[4], i[1]], "fill")
        sc.f([i[0], i[2], i[5], i[3]], "fill")
        sc.f([i[1], i[4], i[5], i[2]], "fill")
    if "ridgeCap" in p:
        rc = p["ridgeCap"]
        w, h = float(ev(rc["w"], s)), float(ev(rc["h"], s))
        z0 = rise + t * sec - h / 2
        hexa(
            sc,
            box_corners(2 * lx, w, h, z0=z0),
            ["ridge"] * 6,
        )
    return sc


def beam(sc, a, b, w, h, role):
    """Box of cross-section w x h centred on segment a→b, rolled so its height axis stays upright."""
    a, b = Vector(a), Vector(b)
    d = b - a
    ln = d.length
    if ln < 1e-6:
        return sc
    x = d / ln
    side = Vector((0, 0, 1)).cross(x)
    if side.length < 1e-6:
        side = Vector((0, 1, 0))
    side.normalize()
    up = x.cross(side).normalized()
    m = Matrix.Identity(4)
    m.col[0][:3] = x
    m.col[1][:3] = side
    m.col[2][:3] = up
    m.col[3][:3] = a
    return sc.merge(_boxsc(ln, w, h, [role] * 6, cx=ln / 2, z0=-h / 2), m)


def b_hip(p, s):
    """Hip / pyramid roof with a fascia band. Ridge runs along the longer axis unless `ridge` given.
    Optional `trim` {w, h} caps the ridge and hip lines. roles: top, edge (fascia), under, trim."""
    L, S = float(ev(p["length"], s)), float(ev(p["span"], s))
    ox, oy = ev_vec(p.get("overhang", [0, 0]), s, 2)
    t = float(ev(p["thick"], s))
    top = float(ev(p["top"], s))
    ex, ey = L / 2 + ox, S / 2 + oy
    if "ridge" in p:
        rl = float(ev(p["ridge"], s))
    else:
        rl = max(0.0, abs(L - S))
    along_x = L >= S
    sc = Scratch()
    b = [sc.v(-ex, -ey, 0), sc.v(ex, -ey, 0), sc.v(ex, ey, 0), sc.v(-ex, ey, 0)]
    f = [sc.v(-ex, -ey, t), sc.v(ex, -ey, t), sc.v(ex, ey, t), sc.v(-ex, ey, t)]
    sc.f([b[3], b[2], b[1], b[0]], "under")
    for k in range(4):
        sc.f([b[k], b[(k + 1) % 4], f[(k + 1) % 4], f[k]], "edge")
    if rl <= 1e-4:
        apex = sc.v(0, 0, top)
        for k in range(4):
            sc.f([f[k], f[(k + 1) % 4], apex], "top")
        ridge_ends = [apex] * 4
    elif along_x:
        r0, r1 = sc.v(-rl / 2, 0, top), sc.v(rl / 2, 0, top)
        sc.f([f[0], f[1], r1, r0], "top")
        sc.f([f[1], f[2], r1], "top")
        sc.f([f[2], f[3], r0, r1], "top")
        sc.f([f[3], f[0], r0], "top")
        ridge_ends = [r0, r1, r1, r0]
    else:
        r0, r1 = sc.v(0, -rl / 2, top), sc.v(0, rl / 2, top)
        sc.f([f[0], f[1], r0], "top")
        sc.f([f[1], f[2], r1, r0], "top")
        sc.f([f[2], f[3], r1], "top")
        sc.f([f[3], f[0], r0, r1], "top")
        ridge_ends = [r0, r0, r1, r1]
    if "trim" in p:
        w, h = float(ev(p["trim"]["w"], s)), float(ev(p["trim"]["h"], s))
        corners = [sc.verts[i].copy() for i in f]
        ends = [sc.verts[i].copy() for i in ridge_ends]
        if rl > 1e-4:
            beam(sc, ends[0], ends[2], w, h, "trim")
        for c, e in zip(corners, ends):
            beam(sc, c, e, w, h, "trim")
    return sc


def b_cyl(p, s):
    """Cylinder / frustum / cone along local Z. roles: side, top, bottom."""
    if "r" in p:
        rb = rt = float(ev(p["r"], s))
    else:
        rb, rt = ev_vec(p["radii"], s, 2)
    h = float(ev(p["h"], s))
    n = int(ev(p["seg"], s))
    a0 = math.radians(float(ev(p.get("angle0", 180.0 / n), s)))
    sx, sy = ev_vec(p.get("squash", [1, 1]), s, 2)
    sc = Scratch()
    bot = [
        sc.v(
            rb * sx * math.cos(a0 + 2 * math.pi * k / n),
            rb * sy * math.sin(a0 + 2 * math.pi * k / n),
            0,
        )
        for k in range(n)
    ]
    if rt <= 1e-5:
        apex = sc.v(0, 0, h)
        for k in range(n):
            sc.f([bot[k], bot[(k + 1) % n], apex], "side")
    else:
        top = [
            sc.v(
                rt * sx * math.cos(a0 + 2 * math.pi * k / n),
                rt * sy * math.sin(a0 + 2 * math.pi * k / n),
                h,
            )
            for k in range(n)
        ]
        for k in range(n):
            sc.f([bot[k], bot[(k + 1) % n], top[(k + 1) % n], top[k]], "side")
        sc.f(top, "top")
    sc.f(list(reversed(bot)), "bottom")
    return sc


def b_tube(p, s):
    """Hollow cylinder (basins, rims, collars). roles: outer, inner, top, bottom."""
    ro, ri = float(ev(p["rOuter"], s)), float(ev(p["rInner"], s))
    h = float(ev(p["h"], s))
    n = int(ev(p["seg"], s))
    a0 = math.radians(float(ev(p.get("angle0", 180.0 / n), s)))
    sc = Scratch()

    def ring(r, z):
        return [
            sc.v(
                r * math.cos(a0 + 2 * math.pi * k / n),
                r * math.sin(a0 + 2 * math.pi * k / n),
                z,
            )
            for k in range(n)
        ]

    ob, ot, ib, it = ring(ro, 0), ring(ro, h), ring(ri, 0), ring(ri, h)
    for k in range(n):
        j = (k + 1) % n
        sc.f([ob[k], ob[j], ot[j], ot[k]], "outer")
        sc.f([ib[j], ib[k], it[k], it[j]], "inner")
        sc.f([ot[k], ot[j], it[j], it[k]], "top")
        sc.f([ob[j], ob[k], ib[k], ib[j]], "bottom")
    return sc


def b_sphere(p, s):
    """UV sphere / dome (hemi). roles: main, bottom (hemi cap)."""
    r = float(ev(p["r"], s))
    n = int(ev(p["seg"], s))
    rings = int(ev(p["rings"], s))
    hemi = bool(p.get("hemi", False))
    sx, sy, sz = ev_vec(p.get("scale", [1, 1, 1]), s, 3)
    sc = Scratch()
    lat0 = 0.0 if hemi else -math.pi / 2
    layers = []
    for j in range(rings + 1):
        lat = lat0 + (math.pi / 2 - lat0) * j / rings
        if j == rings:
            layers.append([sc.v(0, 0, r * sz)])
            break
        if not hemi and j == 0:
            layers.append([sc.v(0, 0, -r * sz)])
            continue
        cr, z = r * math.cos(lat), r * math.sin(lat) * sz
        layers.append(
            [
                sc.v(
                    cr * sx * math.cos(2 * math.pi * k / n),
                    cr * sy * math.sin(2 * math.pi * k / n),
                    z,
                )
                for k in range(n)
            ]
        )
    for j in range(len(layers) - 1):
        a, b = layers[j], layers[j + 1]
        for k in range(n):
            k1 = (k + 1) % n
            if len(a) == 1:
                sc.f([a[0], b[k1], b[k]], "main")
            elif len(b) == 1:
                sc.f([a[k], a[k1], b[0]], "main")
            else:
                sc.f([a[k], a[k1], b[k1], b[k]], "main")
    if hemi:
        sc.f(list(reversed(layers[0])), "bottom")
    return sc


def b_torus(p, s):
    """Ring around local Z. roles: main."""
    R, r = float(ev(p["R"], s)), float(ev(p["r"], s))
    n, m = int(ev(p["seg"], s)), int(ev(p["segMinor"], s))
    sz = float(ev(p.get("zScale", 1), s))
    sc = Scratch()
    grid = []
    for i in range(n):
        a = 2 * math.pi * i / n
        row = []
        for j in range(m):
            b = 2 * math.pi * j / m + math.pi / m
            rr = R + r * math.cos(b)
            row.append(sc.v(rr * math.cos(a), rr * math.sin(a), r * math.sin(b) * sz))
        grid.append(row)
    for i in range(n):
        for j in range(m):
            i1, j1 = (i + 1) % n, (j + 1) % m
            sc.f([grid[i][j], grid[i1][j], grid[i1][j1], grid[i][j1]], "main")
    return sc


def b_extrude(p, s):
    """Polygon in the local XZ plane extruded along Y (centred). roles: face, side."""
    pts = [ev_vec(q, s, 2) for q in p["poly"]]
    d = float(ev(p["depth"], s))
    sc = Scratch()
    fr = [sc.v(x, -d / 2, z) for x, z in pts]
    bk = [sc.v(x, d / 2, z) for x, z in pts]
    n = len(pts)
    sc.f(fr, "face")
    sc.f(list(reversed(bk)), "face")
    for k in range(n):
        j = (k + 1) % n
        sc.f([fr[k], bk[k], bk[j], fr[j]], "side")
    return sc


def b_loft(p, s):
    """Skin through cross-sections along local Y (equal point counts). Each section is either
    {y, pts:[[x,z]...]} or, with a shared `profile` [[x,z]...], {y, sx, sz, dz} meaning
    (x*sx, z*sz+dz). roles: side, cap."""
    secs = p["sections"]
    profile = [ev_vec(q, s, 2) for q in p["profile"]] if "profile" in p else None
    rings = []
    sc = Scratch()
    for sec in secs:
        y = float(ev(sec["y"], s))
        if profile is not None:
            sx, sz = float(ev(sec.get("sx", 1), s)), float(ev(sec.get("sz", 1), s))
            dz = float(ev(sec.get("dz", 0), s))
            pts = [(x * sx, z * sz + dz) for x, z in profile]
        else:
            pts = [ev_vec(q, s, 2) for q in sec["pts"]]
        rings.append([sc.v(x, y, z) for x, z in pts])
    n = len(rings[0])
    if any(len(r) != n for r in rings):
        raise SpecError("loft sections need equal point counts")
    closed = bool(p["closedSection"])
    for a, b in itertools.pairwise(rings):
        for k in range(n if closed else n - 1):
            j = (k + 1) % n
            sc.f([a[k], a[j], b[j], b[k]], "side")
    if p["caps"]:
        sc.f(list(reversed(rings[0])), "cap")
        sc.f(rings[-1], "cap")
    return sc


def b_arch(p, s):
    """Round arch in the XZ plane: two legs + segmented semicircle. `skip` drops segment indices
    (broken ruins). roles: main."""
    r, t, d = float(ev(p["r"], s)), float(ev(p["thick"], s)), float(ev(p["depth"], s))
    leg_h = float(ev(p["legH"], s))
    n = int(ev(p["seg"], s))
    skip = {int(ev(k, s)) for k in p.get("skip", [])}
    legs = p.get("legs", [True, True])
    sc = Scratch()
    hy = d / 2
    for side, keep in zip((-1, 1), legs):
        if keep:
            xc = side * (r + t / 2)
            hexa(
                sc,
                [
                    (xc - t / 2, -hy, 0),
                    (xc + t / 2, -hy, 0),
                    (xc + t / 2, hy, 0),
                    (xc - t / 2, hy, 0),
                    (xc - t / 2, -hy, leg_h),
                    (xc + t / 2, -hy, leg_h),
                    (xc + t / 2, hy, leg_h),
                    (xc - t / 2, hy, leg_h),
                ],
                ["main"] * 6,
            )
    for k in range(n):
        if k in skip:
            continue
        a0, a1 = math.pi * k / n, math.pi * (k + 1) / n
        pi0 = (r * math.cos(a0), leg_h + r * math.sin(a0))
        pi1 = (r * math.cos(a1), leg_h + r * math.sin(a1))
        po0 = ((r + t) * math.cos(a0), leg_h + (r + t) * math.sin(a0))
        po1 = ((r + t) * math.cos(a1), leg_h + (r + t) * math.sin(a1))
        quad = [pi0, po0, po1, pi1]
        c = [(x, -hy, z) for x, z in quad] + [(x, hy, z) for x, z in quad]
        i = [sc.v(*q) for q in c]
        sc.f([i[0], i[1], i[2], i[3]], "main")
        sc.f([i[7], i[6], i[5], i[4]], "main")
        for a in range(4):
            b = (a + 1) % 4
            sc.f([i[b], i[a], i[a + 4], i[b + 4]], "main")
    return sc


def b_rock(p, s):
    """Jittered low-poly icosphere boulder (deterministic per seed). roles: main."""
    import random

    r = float(ev(p["r"], s))
    sx, sy, sz = ev_vec(p.get("scale", [1, 1, 1]), s, 3)
    jit = float(ev(p["jitter"], s))
    rnd = random.Random(int(ev(p["seed"], s)))
    bm = bmesh.new()
    bmesh.ops.create_icosphere(
        bm, subdivisions=int(ev(p["subdiv"], s)), radius=r
    )
    sc = Scratch()
    for v in bm.verts:
        k = 1 + rnd.uniform(-jit, jit)
        co = v.co * k
        sc.v(co.x * sx, co.y * sy, max(co.z * sz, 0.0))
    for f in bm.faces:
        sc.f([v.index for v in f.verts], "main")
    bm.free()
    return sc


# --------------------------------------------------------------------------- facade helpers
# A facade frame maps (u along the wall, z up, out = outward normal) to local XYZ.

FACES = {
    "front": (Vector((1, 0, 0)), Vector((0, -1, 0))),
    "back": (Vector((-1, 0, 0)), Vector((0, 1, 0))),
    "left": (Vector((0, -1, 0)), Vector((-1, 0, 0))),
    "right": (Vector((0, 1, 0)), Vector((1, 0, 0))),
}


def facade_matrix(face, d, u, z, out=0.0):
    """Matrix placing facade-local geometry (x=u, y=-out, z) on a wall `d` from the origin."""
    if face not in FACES:
        raise SpecError(f"unknown face {face!r}")
    uax, nax = FACES[face]
    origin = nax * (d + out) + uax * u + Vector((0, 0, z))
    m = Matrix.Identity(4)
    m.col[0][:3] = uax
    m.col[1][:3] = -nax
    m.col[2][:3] = (0, 0, 1)
    m.col[3][:3] = origin
    return m


def _boxsc(sx, sy, sz, roles, cx=0.0, cy=0.0, z0=0.0):
    c = [(x + cx, y + cy, z) for x, y, z in box_corners(sx, sy, sz, z0=z0)]
    return hexa(Scratch(), c, roles)


def _distribute(p, s):
    if "xs" in p:
        return [float(ev(x, s)) for x in p["xs"]]
    n = int(ev(p["count"], s))
    a, b = ev_vec(p["span"], s, 2)
    if n <= 0:
        return []
    if n == 1:
        return [(a + b) / 2]
    return [a + (b - a) * i / (n - 1) for i in range(n)]


def b_windows(p, s):
    """Framed windows on a facade. roles: glass, frame, sill, shutter, lintel."""
    sc = Scratch()
    face, d = p["face"], float(ev(p["d"], s))
    w, h = ev_vec(p["size"], s, 2)
    fw = float(ev(p["frameW"], s))
    depth = float(ev(p["depth"], s))
    zs = [float(ev(z, s)) for z in (p["zs"] if "zs" in p else [p["z"]])]
    for z in zs:
        for u in _distribute(p, s):
            m = facade_matrix(face, d, u, z)
            if fw > 0:
                sc.merge(
                    _boxsc(
                        w + 2 * fw,
                        depth,
                        h + 2 * fw,
                        ["frame"] * 6,
                        cy=-depth / 2 + EMBED,
                        z0=-fw,
                    ),
                    m,
                )
            sc.merge(
                _boxsc(
                    w, depth + 2 * PROUD, h, ["glass"] * 6, cy=-(depth + 2 * PROUD) / 2 + EMBED
                ),
                m,
            )
            if "sill" in p:
                sw, sd, sh = ev_vec(p["sill"], s, 3)
                sc.merge(
                    _boxsc(sw, sd, sh, ["sill"] * 6, cy=-sd / 2 + EMBED, z0=-fw - sh), m
                )
            if "lintel" in p:
                lw, ld, lh = ev_vec(p["lintel"], s, 3)
                sc.merge(
                    _boxsc(lw, ld, lh, ["lintel"] * 6, cy=-ld / 2 + EMBED, z0=h + fw), m
                )
            if "shutter" in p:
                shw, shd = ev_vec(p["shutter"], s, 2)
                for side in (-1, 1):
                    sc.merge(
                        _boxsc(
                            shw,
                            shd,
                            h + 2 * fw,
                            ["shutter"] * 6,
                            cx=side * (w / 2 + fw + shw / 2),
                            cy=-shd / 2 + EMBED,
                            z0=-fw,
                        ),
                        m,
                    )
    return sc


def b_door(p, s):
    """Door slab + frame on a facade at u = x (defaults to PropDef door offset DX), optional steps and
    canopy in front. roles: door, frame, step, canopy."""
    sc = Scratch()
    face, d = p.get("face", "front"), float(ev(p["d"], s))
    u = float(ev(p.get("x", "DX"), s))
    w, h = ev_vec(p["size"], s, 2)
    z = float(ev(p.get("z", 0), s))
    fw = float(ev(p["frameW"], s))
    depth = float(ev(p["depth"], s))
    m = facade_matrix(face, d, u, z)
    if fw > 0:
        sc.merge(
            _boxsc(w + 2 * fw, depth, h + fw, ["frame"] * 6, cy=-depth / 2 + EMBED), m
        )
    sc.merge(_boxsc(w, depth + 3 * PROUD, h, ["door"] * 6, cy=-(depth + 3 * PROUD) / 2 + EMBED), m)
    if "steps" in p:
        st = p["steps"]
        n = int(ev(st["n"], s))
        sw, sdepth, sh = (
            float(ev(st["w"], s)),
            float(ev(st["depth"], s)),
            float(ev(st["h"], s)),
        )
        mg = facade_matrix(face, d, u, 0)
        for i in range(n):
            dd = sdepth * (n - i) / n
            sc.merge(
                _boxsc(sw, dd, sh / n, ["step"] * 6, cy=-dd / 2 + 2 * EMBED, z0=i * sh / n),
                mg,
            )
    if "canopy" in p:
        cp = p["canopy"]
        cw, cd, ch = ev_vec(cp["size"], s, 3)
        cz = float(ev(cp["z"], s))
        mc = facade_matrix(face, d, u, 0)
        sc.merge(_boxsc(cw, cd, ch, ["canopy"] * 6, cy=-cd / 2, z0=cz), mc)
        if "posts" in cp:
            pr = float(ev(cp["posts"], s))
            for side in (-1, 1):
                sc.merge(
                    _boxsc(
                        pr, pr, cz, ["canopy"] * 6, cx=side * (cw / 2 - pr), cy=-cd + pr
                    ),
                    mc,
                )
    return sc


def b_timber(p, s):
    """Half-timber frame on a box of `size` (centred, base z=0): corner posts, rails at `rails` heights,
    vertical studs at `studs.<face>` u-positions. roles: beam."""
    sx, sy, sz = ev_vec(p["size"], s, 3)
    bt = float(ev(p["beam"], s))
    out = float(ev(p["out"], s))
    sc = Scratch()
    for cx in (-1, 1):
        for cy in (-1, 1):
            sc.merge(
                _boxsc(
                    bt,
                    bt,
                    sz,
                    ["beam"] * 6,
                    cx=cx * (sx / 2 - bt / 2 + out),
                    cy=cy * (sy / 2 - bt / 2 + out),
                )
            )
    for z in p.get("rails", []):
        zz = float(ev(z, s))
        sc.merge(
            _boxsc(
                sx + 2 * out,
                bt,
                bt,
                ["beam"] * 6,
                cy=-(sy / 2 - bt / 2 + out),
                z0=zz - bt / 2,
            )
        )
        sc.merge(
            _boxsc(
                sx + 2 * out,
                bt,
                bt,
                ["beam"] * 6,
                cy=(sy / 2 - bt / 2 + out),
                z0=zz - bt / 2,
            )
        )
        sc.merge(
            _boxsc(
                bt,
                sy + 2 * out,
                bt,
                ["beam"] * 6,
                cx=-(sx / 2 - bt / 2 + out),
                z0=zz - bt / 2,
            )
        )
        sc.merge(
            _boxsc(
                bt,
                sy + 2 * out,
                bt,
                ["beam"] * 6,
                cx=(sx / 2 - bt / 2 + out),
                z0=zz - bt / 2,
            )
        )
    half = {"front": sy / 2, "back": sy / 2, "left": sx / 2, "right": sx / 2}
    for face, us in p.get("studs", {}).items():
        span = p.get("studSpan", [0, sz])
        z0, z1 = float(ev(span[0], s)), float(ev(span[1], s))
        for u in us:
            m = facade_matrix(face, half[face], float(ev(u, s)), z0)
            sc.merge(_boxsc(bt, bt, z1 - z0, ["beam"] * 6, cy=-bt / 2 + out + EMBED / 2), m)
    for face, braces in p.get("braces", {}).items():
        for br in braces:
            u0, z0, u1, z1 = ev_vec(br, s, 4)
            ln = math.hypot(u1 - u0, z1 - z0)
            ang = math.atan2(z1 - z0, u1 - u0)
            m = facade_matrix(face, half[face], (u0 + u1) / 2, (z0 + z1) / 2)
            rot = Matrix.Rotation(-ang, 4, "Y")
            sc.merge(
                _boxsc(ln, bt, bt, ["beam"] * 6, cy=-bt / 2 + out + EMBED / 2, z0=-bt / 2),
                m @ rot,
            )
    return sc


def b_awning(p, s):
    """Sloped awning slab on a facade with a front valance. roles: cloth, valance, bracket."""
    sc = Scratch()
    face, d = p.get("face", "front"), float(ev(p["d"], s))
    u = float(ev(p.get("x", 0), s))
    w, depth = float(ev(p["w"], s)), float(ev(p["depth"], s))
    z, drop = float(ev(p["z"], s)), float(ev(p["drop"], s))
    t = float(ev(p["thick"], s))
    ln = math.hypot(depth, drop)
    ang = math.atan2(drop, depth)
    m = facade_matrix(face, d, u, z)
    slab = _boxsc(w, ln, t, ["cloth"] * 6, cy=-ln / 2)
    sc.merge(slab, m @ Matrix.Rotation(ang, 4, "X"))
    if "valance" in p:
        vh = float(ev(p["valance"], s))
        sc.merge(_boxsc(w, t, vh, ["valance"] * 6, cy=-depth, z0=-drop - vh + t), m)
    if "brackets" in p:
        br = float(ev(p["brackets"], s))
        for side in (-1, 1):
            bm_ = (
                m
                @ Matrix.Translation((side * (w / 2 - br), 0, 0))
                @ Matrix.Rotation(ang, 4, "X")
            )
            sc.merge(_boxsc(br, ln, br, ["bracket"] * 6, cy=-ln / 2, z0=-br), bm_)
    return sc


def b_blades(p, s):
    """Windmill sails radiating in the local XZ plane around the origin, facing -Y.
    roles: hub, spar, sail."""
    sc = Scratch()
    n = int(ev(p["n"], s))
    ln, sw = float(ev(p["len"], s)), float(ev(p["sailW"], s))
    spar = float(ev(p["spar"], s))
    st = float(ev(p["sailT"], s))
    a0 = float(ev(p.get("angle0", 0), s))
    s0 = float(ev(p["sailStart"], s))
    hr, hd = ev_vec(p["hub"], s, 2)
    hub = b_cyl({"r": hr, "h": hd, "seg": p["hubSeg"]}, s)
    hub.faces = [(idxs, "hub") for idxs, _ in hub.faces]
    sc.merge(
        hub,
        Matrix.Translation((0, -hd + float(ev(p["hubEmbed"], s)), 0))
        @ Matrix.Rotation(math.radians(-90), 4, "X"),
    )
    for k in range(n):
        rot = Matrix.Rotation(math.radians(a0 + 360.0 * k / n), 4, "Y")
        sc.merge(_boxsc(spar, spar, ln, ["spar"] * 6, cy=-hd), rot)
        sc.merge(
            _boxsc(
                sw,
                st,
                ln * (1 - s0),
                ["sail"] * 6,
                cx=sw / 2 + spar / 2,
                cy=-hd + spar / 2,
                z0=ln * s0,
            ),
            rot,
        )
    return sc


BUILDERS = {
    "box": b_box,
    "gable": b_gable,
    "hip": b_hip,
    "cyl": b_cyl,
    "tube": b_tube,
    "sphere": b_sphere,
    "torus": b_torus,
    "extrude": b_extrude,
    "loft": b_loft,
    "arch": b_arch,
    "rock": b_rock,
    "windows": b_windows,
    "door": b_door,
    "timber": b_timber,
    "awning": b_awning,
    "blades": b_blades,
}

# role → material key fallback order when a part's `mats` does not name the role
ROLE_FALLBACK = {
    "bottom": ("bottom", "side"),
    "top": ("top",),
    "front": ("front", "side"),
    "back": ("back", "side"),
    "left": ("left", "side"),
    "right": ("right", "side"),
    "outer": ("outer", "side"),
    "inner": ("inner", "side"),
}


# --------------------------------------------------------------------------- part placement


def part_matrices(p, s):
    rot = ev_vec(p.get("rot", [0, 0, 0]), s, 3)
    r = (
        Matrix.Rotation(math.radians(rot[2]), 4, "Z")
        @ Matrix.Rotation(math.radians(rot[1]), 4, "Y")
        @ Matrix.Rotation(math.radians(rot[0]), 4, "X")
    )
    positions = (
        [ev_vec(q, s, 3) for q in p["at"]]
        if "at" in p
        else [ev_vec(p.get("pos", [0, 0, 0]), s, 3)]
    )
    mats = [Matrix.Translation(Vector(q)) @ r for q in positions]
    mirror = p.get("mirror", "")
    out = list(mats)
    for axis in mirror:
        flip = Matrix.Diagonal(
            (-1 if axis == "x" else 1, -1 if axis == "y" else 1, 1, 1)
        )
        out += [flip @ m for m in out]
    return out


def resolve_role(p, role):
    mats = p.get("mats", {})
    for key in ROLE_FALLBACK.get(role, (role,)):
        if key in mats:
            return mats[key]
    if role in mats:
        return mats[role]
    if "mat" not in p:
        raise SpecError(f"part {p.get('type')} has no material for role {role!r}")
    return p["mat"]


def build_part(p, s):
    """Returns list of (Scratch, matrix) instances for a part."""
    t = p.get("type")
    if t not in BUILDERS:
        raise SpecError(f"unknown part type {t!r}")
    if "if" in p and not ev(p["if"], s):
        return []
    sc = BUILDERS[t](p, s)
    return [(sc, m) for m in part_matrices(p, s)]


def with_defaults(p, part_defaults):
    """Part spec merged over spec-level defaults.parts[<type>] (spec values win)."""
    return {**part_defaults.get(p.get("type"), {}), **p}
