"""Hand-built chibi characters: parametric 3D models on the mannequin rig, rendered to pixel data.

Run (Blender 5.2 background):
  blender -b -P tools/blender/chibi.py -- --ids hero_girl[,nurse] [--out assets_src/raw/chibi] [--views down,left]
Specs: assets_src/chibi/cast.json (per character), assets_src/chibi/style.json (render, shading, anchors).
Per character it writes <out>/<id>/frames.npz: for every view x pose a 4x-supersampled colour layer (sRGB 0-255),
a part-id layer, a depth layer and the projected face anchors. tools/chibi_post.py turns that into the atlas.

Shading is unlit: every material is an emission node tree that picks base / shade / highlight by the angle to a
light fixed relative to the camera, so the four facings are lit identically and colours stay an exact palette.
"""

from __future__ import annotations

import colorsys
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import mannequin as mq

STYLE = json.loads((ROOT / "assets_src/chibi/style.json").read_text())
_CAST_DOC = json.loads((ROOT / "assets_src/chibi/cast.json").read_text())
CAST = {
    c["id"]: {**c, "colors": {**_CAST_DOC["defaults"]["colors"], **c["colors"]}}
    for c in _CAST_DOC["characters"]
}
B = {**mq.SPEC["body"], **STYLE.get("body", {})}


def parse_args(argv: list[str]) -> dict:
    args = argv[argv.index("--") + 1 :] if "--" in argv else []
    opts = {"ids": [], "out": ROOT / STYLE["outDir"], "views": list(mq.SPEC["views"])}
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--ids":
            opts["ids"] = [x for x in args[i + 1].split(",") if x]
            i += 1
        elif a == "--out":
            opts["out"] = Path(args[i + 1]).resolve()
            i += 1
        elif a == "--views":
            opts["views"] = [v for v in args[i + 1].split(",") if v]
            i += 1
        else:
            raise SystemExit(f"unknown argument {a!r}")
        i += 1
    if opts["ids"] == ["all"]:
        opts["ids"] = list(CAST)
    return opts


# ---------------------------------------------------------------------------
# colour + materials
# ---------------------------------------------------------------------------


def hex_rgb(h: str) -> tuple[float, float, float]:
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore[return-value]


def to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def tone(rgb: tuple[float, float, float], spec: dict) -> tuple[float, float, float]:
    h, s, v = colorsys.rgb_to_hsv(*rgb)
    # shadows drift toward blue-violet, highlights toward warm: the usual pixel-art hue shift
    target = spec["hueTarget"]
    dh = ((target - h + 0.5) % 1.0) - 0.5
    h = (h + dh * spec["hueShift"]) % 1.0
    s = min(1.0, max(0.0, s * spec["sat"] + spec.get("satAdd", 0.0)))
    v = min(1.0, max(0.0, v * spec["val"] + spec.get("valAdd", 0.0)))
    return colorsys.hsv_to_rgb(h, s, v)


_MATS: dict[str, bpy.types.Material] = {}


def mat(key: str, ch: dict) -> bpy.types.Material:
    """Toon emission material for a palette key of the character (or a literal #hex)."""
    if key in _MATS:
        return _MATS[key]
    hexv = ch["colors"].get(key, key)
    base = hex_rgb(hexv)
    sh = STYLE["shading"]
    shade = tone(base, sh["shade"])
    hi = tone(base, sh["highlight"])
    gloss = key in sh["glossy"] or key.startswith("hair")
    m = bpy.data.materials.new(f"m_{key}")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    dot = nt.nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    L = Vector(sh["light"]).normalized()
    dot.inputs[1].default_value = (L.x, L.y, L.z)
    nt.links.new(geo.outputs["Normal"], dot.inputs[0])
    gt = nt.nodes.new("ShaderNodeMath")
    gt.operation = "GREATER_THAN"
    gt.inputs[1].default_value = sh["threshold"]
    nt.links.new(dot.outputs["Value"], gt.inputs[0])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    nt.links.new(gt.outputs[0], mix.inputs["Factor"])
    mix.inputs["A"].default_value = (*[to_linear(c) for c in shade], 1)
    mix.inputs["B"].default_value = (*[to_linear(c) for c in base], 1)
    last = mix.outputs["Result"]
    if gloss:
        gt2 = nt.nodes.new("ShaderNodeMath")
        gt2.operation = "GREATER_THAN"
        gt2.inputs[1].default_value = sh["highlightThreshold"]
        nt.links.new(dot.outputs["Value"], gt2.inputs[0])
        mix2 = nt.nodes.new("ShaderNodeMix")
        mix2.data_type = "RGBA"
        nt.links.new(gt2.outputs[0], mix2.inputs["Factor"])
        nt.links.new(last, mix2.inputs["A"])
        mix2.inputs["B"].default_value = (*[to_linear(c) for c in hi], 1)
        last = mix2.outputs["Result"]
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(last, em.inputs["Color"])
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    _MATS[key] = m
    return m


def data_material() -> bpy.types.Material:
    """Override for the data pass: R = part index / 255, G/B = view depth in two bytes."""
    r = STYLE["render"]
    m = bpy.data.materials.new("m_data")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    info = nt.nodes.new("ShaderNodeObjectInfo")
    cam = nt.nodes.new("ShaderNodeCameraData")
    rng = nt.nodes.new("ShaderNodeMapRange")
    rng.inputs["From Min"].default_value = r["depthNear"]
    rng.inputs["From Max"].default_value = r["depthFar"]
    nt.links.new(cam.outputs["View Z Depth"], rng.inputs["Value"])
    idx = nt.nodes.new("ShaderNodeMath")
    idx.operation = "DIVIDE"
    idx.inputs[1].default_value = 255.0
    nt.links.new(info.outputs["Object Index"], idx.inputs[0])
    comb = nt.nodes.new("ShaderNodeCombineXYZ")
    nt.links.new(idx.outputs[0], comb.inputs["X"])
    nt.links.new(rng.outputs["Result"], comb.inputs["Y"])
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(comb.outputs[0], em.inputs["Color"])
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    return m


# ---------------------------------------------------------------------------
# geometry helpers (all coordinates are local to the parent pivot)
# ---------------------------------------------------------------------------

_PARTS: list[
    tuple[str, str]
] = []  # (object name, part kind) -> pass index = position + 1


def _register(o: bpy.types.Object, kind: str) -> bpy.types.Object:
    _PARTS.append((o.name, kind))
    o.pass_index = len(_PARTS)
    return o


def _finish(o, parent, m, kind, smooth=True):
    o.data.materials.append(m)
    o.parent = parent
    if smooth:
        for p in o.data.polygons:
            p.use_smooth = True
    return _register(o, kind)


def ellipsoid(name, parent, center, radii, m, kind, rot=(0, 0, 0), segs=24, rings=14):
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=segs, ring_count=rings, location=(0, 0, 0)
    )
    o = bpy.context.active_object
    o.name = name
    o.location = center
    o.scale = radii
    o.rotation_euler = tuple(math.radians(a) for a in rot)
    return _finish(o, parent, m, kind)


def taper(name, parent, p0, p1, r0, r1, m, kind, caps=True, flat=1.0, segs=16, depth=1.0):
    """Tapered capsule from p0 to p1 (radius r0 -> r1). `flat`/`depth` squash the cross-section along local X/Y."""
    a, b = Vector(p0), Vector(p1)
    d = b - a
    bpy.ops.mesh.primitive_cone_add(
        vertices=segs, radius1=r0, radius2=r1, depth=d.length, location=(0, 0, 0)
    )
    o = bpy.context.active_object
    o.name = name
    o.scale = (flat, depth, 1.0)
    bpy.ops.object.transform_apply(scale=True)
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    o.location = a + d * 0.5
    _finish(o, parent, m, kind)
    if caps:
        ellipsoid(
            name + "_c0",
            parent,
            tuple(a),
            (r0 * flat, r0, r0),
            m,
            kind,
            segs=12,
            rings=8,
        )
        ellipsoid(
            name + "_c1",
            parent,
            tuple(b),
            (max(r1, 0.004) * flat, max(r1, 0.004), max(r1, 0.004)),
            m,
            kind,
            segs=12,
            rings=8,
        )
    return o


def cylinder(
    name,
    parent,
    center,
    radius,
    depth,
    m,
    kind,
    scale=(1, 1, 1),
    rot=(0, 0, 0),
    segs=24,
):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=segs, radius=radius, depth=depth, location=(0, 0, 0)
    )
    o = bpy.context.active_object
    o.name = name
    o.location = center
    o.scale = scale
    o.rotation_euler = tuple(math.radians(a) for a in rot)
    return _finish(o, parent, m, kind)


def cone(
    name,
    parent,
    center,
    r_bottom,
    r_top,
    depth,
    m,
    kind,
    scale=(1, 1, 1),
    rot=(0, 0, 0),
    segs=24,
    open_front: float = 0.0,
):
    bpy.ops.mesh.primitive_cone_add(
        vertices=segs,
        radius1=r_bottom,
        radius2=r_top,
        depth=depth,
        location=(0, 0, 0),
        end_fill_type="NOTHING",
    )
    o = bpy.context.active_object
    o.name = name
    if open_front > 0:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        kill = [
            f
            for f in bm.faces
            if f.calc_center_median().y < 0
            and abs(f.calc_center_median().x) < open_front
        ]
        bmesh.ops.delete(bm, geom=kill, context="FACES")
        bm.to_mesh(o.data)
        bm.free()
    o.location = center
    o.scale = scale
    o.rotation_euler = tuple(math.radians(a) for a in rot)
    # thin shells render both sides in Cycles; recalc so the toon normal faces outward
    return _finish(o, parent, m, kind)


def shell(name, parent, center, radii, m, kind, keep, segs=32, rings=18):
    """Ellipsoid shell keeping only faces whose unit-sphere centre satisfies keep(x, y, z)."""
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=segs, ring_count=rings, location=(0, 0, 0)
    )
    o = bpy.context.active_object
    o.name = name
    bm = bmesh.new()
    bm.from_mesh(o.data)
    kill = [f for f in bm.faces if not keep(*f.calc_center_median())]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bm.to_mesh(o.data)
    bm.free()
    o.location = center
    o.scale = radii
    return _finish(o, parent, m, kind)


def paint(o, ch: dict, rules: list[dict]) -> None:
    """Per-face material regions on an existing part: rules match the face centre in object-local units."""
    for rule in rules:
        m = mat(rule["color"], ch)
        if m.name not in [x.name for x in o.data.materials]:
            o.data.materials.append(m)
        idx = [x.name for x in o.data.materials].index(m.name)
        for p in o.data.polygons:
            c = p.center
            ok = True
            if "x" in rule:
                ok &= rule["x"][0] <= c.x <= rule["x"][1]
            if "az" in rule:
                ok &= abs(math.degrees(math.atan2(c.x, -c.y))) <= rule["az"]
            if "absX" in rule:
                ok &= rule["absX"][0] <= abs(c.x) <= rule["absX"][1]
            if "y" in rule:
                ok &= rule["y"][0] <= c.y <= rule["y"][1]
            if "z" in rule:
                ok &= rule["z"][0] <= c.z <= rule["z"][1]
            if "zStripe" in rule:
                period, width = rule["zStripe"]
                ok &= ((c.z % period) / period) < width
            if ok:
                p.material_index = idx


# ---------------------------------------------------------------------------
# rig + character assembly
# ---------------------------------------------------------------------------


def pivot(name, parent, loc):
    return mq.pivot(name, parent, loc)


def build_rig(ch: dict) -> dict:
    root = pivot("root", None, (0, 0, 0))
    s = ch.get("scale", 1.0)
    root.scale = (s, s, s)
    hips = pivot("hips", root, (0, 0, B["hipZ"]))
    torso = pivot("torso", hips, (0, 0, 0))
    head = pivot("head", torso, (0, 0, B["neckZ"] - B["hipZ"]))
    rig = {"root": root, "hips": hips, "torso": torso, "head": head}
    for side, sx in (("L", 1), ("R", -1)):
        sh = pivot(
            f"shoulder.{side}",
            torso,
            (sx * B["shoulderX"] * ch.get("build", 1.0), 0, B["shoulderZ"] - B["hipZ"]),
        )
        el = pivot(f"elbow.{side}", sh, (0, 0, -B["upperArm"]))
        hp = pivot(f"hip.{side}", hips, (sx * B["hipX"] * ch.get("build", 1.0), 0, 0))
        kn = pivot(f"knee.{side}", hp, (0, 0, -B["thigh"]))
        an = pivot(f"ankle.{side}", kn, (0, 0, -B["shin"]))
        rig.update(
            {
                f"shoulder.{side}": sh,
                f"elbow.{side}": el,
                f"hip.{side}": hp,
                f"knee.{side}": kn,
                f"ankle.{side}": an,
            }
        )
    return rig


def build_body(ch: dict, rig: dict) -> None:
    c = ch
    build = ch.get("build", 1.0)
    R = B["headR"]
    hz = B["headZ"] - B["neckZ"]
    skin = "skin"
    top = c.get("top", {})
    bottom = c.get("bottom", {})
    legs = c.get("legs", {})
    # head + neck
    # kind "face": the post step stamps eyes/mouth only on these pixels
    ellipsoid(
        "head_m",
        rig["head"],
        (0, 0, hz),
        (R, R * 0.97, R * B["headSquash"]),
        mat(skin, c),
        "face",
    )
    taper(
        "neck",
        rig["head"],
        (0, 0, -0.04),
        (0, 0, hz - R * 0.7),
        0.075,
        0.075,
        mat(skin, c),
        "skin",
        caps=False,
    )
    for sx in (-1, 1):
        ellipsoid(
            f"ear{sx}",
            rig["head"],
            (sx * R * 0.96, R * 0.05, hz - R * 0.1),
            (R * 0.12, R * 0.08, R * 0.16),
            mat(skin, c),
            "skin",
        )
    # torso
    tz0, tz1 = B["torsoBottomZ"] - B["hipZ"], B["torsoTopZ"] - B["hipZ"]
    tw = B["torsoW"] / 2 * build * top.get("width", 1.0)
    td = B["torsoD"] / 2 * build
    t = ellipsoid(
        "torso",
        rig["torso"],
        (0, 0, (tz0 + tz1) / 2),
        (tw, td, (tz1 - tz0) / 2 * 1.04),
        mat(top.get("color", "shirt"), c),
        "torso",
        segs=28,
        rings=16,
    )
    paint(t, c, top.get("regions", []))
    if top.get("belly"):
        ellipsoid(
            "belly",
            rig["torso"],
            (0, -td * 0.25, tz0 + 0.12),
            (tw * 0.95, td * 0.95, 0.16),
            mat(top.get("color", "shirt"), c),
            "torso",
        )
    # arms
    sleeve = top.get("sleeve", "long")
    arm_col = top.get("sleeveColor", top.get("color", "shirt"))
    for side, sx in (("L", 1), ("R", -1)):
        sh, el = rig[f"shoulder.{side}"], rig[f"elbow.{side}"]
        ar = B["armR"] * top.get("armScale", 1.0) * build
        ellipsoid(
            f"shoulderball.{side}",
            sh,
            (0, 0, -0.01),
            (ar * 1.35, ar * 1.35, ar * 1.35),
            mat(arm_col, c),
            "arm",
        )
        up_col = skin if sleeve == "none" else arm_col
        taper(
            f"uarm.{side}",
            sh,
            (0, 0, 0),
            (0, 0, -B["upperArm"]),
            ar * 1.1,
            ar,
            mat(up_col, c),
            "arm",
        )
        fore_col = arm_col if sleeve == "long" else skin
        taper(
            f"farm.{side}",
            el,
            (0, 0, 0),
            (0, 0, -B["forearm"]),
            ar * (1.05 if sleeve == "long" else 0.92),
            ar * 0.9,
            mat(fore_col, c),
            "arm",
        )
        if sleeve == "long" and top.get("cuff"):
            cylinder(
                f"cuff.{side}",
                el,
                (0, 0, -B["forearm"] * 0.85),
                ar * 1.12,
                0.035,
                mat(top["cuff"], c),
                "arm",
            )
        hand = top.get("gloves", skin)
        ellipsoid(
            f"hand.{side}",
            el,
            (0, -0.005, -B["forearm"] - B["handR"] * 0.55),
            (B["handR"],) * 3,
            mat(hand, c),
            "hand",
        )
    # legs
    thigh_col = legs.get("thigh", skin)
    shin_col = legs.get("shin", thigh_col)
    shoe = legs.get("shoes", "shoes")
    lr = B["legR"] * legs.get("scale", 1.0) * build
    for side in ("L", "R"):
        hp, kn, an = rig[f"hip.{side}"], rig[f"knee.{side}"], rig[f"ankle.{side}"]
        taper(
            f"thigh.{side}",
            hp,
            (0, 0, 0.02),
            (0, 0, -B["thigh"]),
            lr * 1.1,
            lr,
            mat(thigh_col, c),
            "leg",
        )
        taper(
            f"shin.{side}",
            kn,
            (0, 0, 0),
            (0, 0, -B["shin"] + 0.02),
            lr * 0.98,
            lr * 0.85,
            mat(shin_col, c),
            "leg",
        )
        if legs.get("socks"):
            cylinder(
                f"sock.{side}",
                kn,
                (0, 0, -B["shin"] * legs.get("sockTop", 0.45)),
                lr * 1.02,
                B["shin"] * legs.get("sockLen", 0.6),
                mat(legs["socks"], c),
                "leg",
            )
        ellipsoid(
            f"shoe.{side}",
            an,
            (0, -0.035, -0.035),
            (lr * 1.25, B["footLen"] * 0.6, 0.055),
            mat(shoe, c),
            "shoe",
        )
        if legs.get("boots"):
            taper(
                f"boot.{side}",
                kn,
                (0, 0, -B["shin"] * 0.35),
                (0, 0, -B["shin"]),
                lr * 1.15,
                lr * 1.12,
                mat(shoe, c),
                "shoe",
                caps=False,
            )
    # lower clothing
    kind = bottom.get("type")
    if kind in ("skirt", "dress", "coat", "robe"):
        length = bottom.get("length", 0.16)
        top_z = bottom.get("top", tz0 + 0.06)
        cone(
            "skirt",
            rig["hips"],
            (0, 0, top_z - length / 2),
            bottom.get("flare", 0.33) * build,
            tw * 0.95,
            length,
            mat(bottom.get("color", "skirt"), c),
            "skirt",
            scale=(1, bottom.get("depth", 0.85), 1),
            open_front=bottom.get("openFront", 0.0),
        )
        if bottom.get("hem"):
            cylinder(
                "hem",
                rig["hips"],
                (0, 0, top_z - length + 0.015),
                bottom.get("flare", 0.33) * build * 1.01,
                0.03,
                mat(bottom["hem"], c),
                "skirt",
                scale=(1, bottom.get("depth", 0.85), 1),
            )
    if kind in ("shorts", "pants"):
        for side in ("L", "R"):
            hp = rig[f"hip.{side}"]
            length = B["thigh"] * (0.75 if kind == "shorts" else 1.0)
            taper(
                f"pant.{side}",
                hp,
                (0, 0, 0.04),
                (0, 0, -length),
                lr * 1.3,
                lr * 1.18,
                mat(bottom["color"], c),
                "pants",
                caps=False,
            )
        ellipsoid(
            "seat",
            rig["hips"],
            (0, 0, 0.0),
            (tw * 0.98, td * 0.95, 0.09),
            mat(bottom["color"], c),
            "pants",
        )
    if bottom.get("belt"):
        cylinder(
            "belt",
            rig["torso"],
            (0, 0, tz0 + 0.04),
            tw * 1.02,
            0.04,
            mat(bottom["belt"], c),
            "torso",
            scale=(1, td / tw, 1),
        )


def build_hair(ch: dict, rig: dict) -> dict:
    hair = ch.get("hair", {})
    c = ch
    R = B["headR"]
    hz = B["headZ"] - B["neckZ"]
    col = hair.get("color", "hair")
    hm = mat(col, c)
    style = hair.get("style", "short")
    sway = {}
    if style == "none":
        return sway
    vol = hair.get("volume", 1.0)
    # cap: keeps everything except the face window; "bald" keeps only the fringe of hair around the back
    face_top = hair.get("fringe", 0.18)
    bald_top = hair.get("bald", 2.0)
    shell(
        "haircap",
        rig["head"],
        (0, R * 0.04, hz + R * 0.05),
        (R * 1.07 * vol, R * 1.07 * vol, R * 1.02 * vol),
        hm,
        "hair",
        keep=lambda x, y, z: z < bald_top and not (y < hair.get("faceSide", -0.05) and z < face_top),
    )
    # fringe: overlapping locks across the forehead
    fr = hair.get("bangs", {"count": 7, "length": 0.42, "spread": 70})
    n = fr.get("count", 7)
    for i in range(n):
        a = math.radians(
            -fr.get("spread", 70) + 2 * fr.get("spread", 70) * i / max(1, n - 1)
        )
        base = Vector((math.sin(a) * R * 1.02, -math.cos(a) * R * 1.02, hz + R * 0.42))
        tip_len = fr.get("length", 0.42) * R * (1.0 - 0.25 * abs(math.sin(a)))
        tip = Vector(
            (
                math.sin(a) * R * 1.08,
                -math.cos(a) * R * 1.06,
                hz + R * 0.42 - tip_len - R * 0.12,
            )
        )
        taper(
            f"bang{i}",
            rig["head"],
            tuple(base),
            tuple(tip),
            R * 0.2,
            R * 0.02,
            hm,
            "hair",
            flat=0.55,
        )
    if hair.get("sidelocks"):
        sl = hair["sidelocks"]
        for sx in (-1, 1):
            taper(
                f"sidelock{sx}",
                rig["head"],
                (sx * R * 0.9, -R * sl.get("forward", 0.2), hz + R * 0.1),
                (sx * R * 0.92, -R * sl.get("forward", 0.2) * 1.1, hz - R * sl.get("length", 0.8)),
                R * 0.17,
                R * 0.06,
                hm,
                "hair",
                flat=0.6,
            )
    if style in ("long", "twintails", "ponytail", "bob", "wavy", "loops", "bun"):
        ln = hair.get("length", 0.9)
        width = hair.get("width", 0.92)
        ellipsoid(
            "hairback",
            rig["head"],
            (0, R * 0.42, hz - R * 0.25),
            (R * width, R * 0.55, R * 0.85),
            hm,
            "hair",
        )
        if ln > 0.9:
            back = pivot("hairback_p", rig["head"], (0, R * 0.5, hz - R * 0.4))
            taper(
                "hairlong",
                back,
                (0, 0, 0),
                (0, R * 0.12, -R * (ln - 0.3)),
                R * width * 0.56,
                R * width * 0.64,
                hm,
                "hair",
                depth=hair.get("depth", 0.5),
            )
            sway["hairback_p"] = {"obj": back, "amp": hair.get("sway", 6), "axis": "x"}
    if style == "twintails":
        tl = hair.get("tails", {})
        for sx, side in ((1, "L"), (-1, "R")):
            p = pivot(f"tail.{side}", rig["head"], (sx * R * 0.86, R * tl.get("back", 0.22), hz + R * tl.get("height", 0.35)))
            ellipsoid(f"tie.{side}", p, (0, 0, 0), (R * 0.15,) * 3, mat(tl.get("tie", col), c), "hairtie")
            length = tl.get("length", 1.1) * R
            spread = tl.get("spread", 0.35) * R
            rad = tl.get("radius", 0.3) * R
            # bulge in the middle, tip curling back in: the classic anime twin-tail silhouette
            pts = [
                (Vector((0, 0, 0)), rad * 0.6),
                (Vector((sx * spread * 0.8, R * 0.04, -length * 0.3)), rad),
                (Vector((sx * spread, R * 0.08, -length * 0.62)), rad * 0.8),
                (Vector((sx * spread * 0.55, R * 0.12, -length * 0.86)), rad * 0.45),
                (Vector((sx * spread * 0.85, R * 0.12, -length)), R * 0.03),
            ]
            for k in range(len(pts) - 1):
                (a, ra), (b, rb) = pts[k], pts[k + 1]
                taper(f"tail{k}.{side}", p, tuple(a), tuple(b), ra, rb, hm, "hair", flat=0.82)
            sway[f"tail.{side}"] = {"obj": p, "amp": tl.get("sway", 10), "axis": "y", "side": sx}
    if style == "ponytail":
        tl = hair.get("tails", {})
        p = pivot("pony", rig["head"], (0, R * 0.85, hz + R * tl.get("height", 0.45)))
        ellipsoid(
            "ponytie",
            p,
            (0, 0, 0),
            (R * 0.15,) * 3,
            mat(tl.get("tie", col), c),
            "hairtie",
        )
        length = tl.get("length", 1.0) * R
        taper(
            "ponyA",
            p,
            (0, 0, 0),
            (0, R * 0.35, -length * 0.4),
            R * tl.get("radius", 0.3),
            R * 0.25,
            hm,
            "hair",
        )
        taper(
            "ponyB",
            p,
            (0, R * 0.35, -length * 0.4),
            (0, R * 0.3, -length),
            R * 0.25,
            R * 0.05,
            hm,
            "hair",
        )
        sway["pony"] = {"obj": p, "amp": tl.get("sway", 10), "axis": "x"}
    if style == "spiky":
        sp = hair.get("spikes", {"count": 9, "length": 0.45})
        for i in range(sp.get("count", 9)):
            a = 2 * math.pi * i / sp.get("count", 9)
            d = Vector(
                (math.cos(a) * 0.75, math.sin(a) * 0.75 + 0.25, 0.55)
            ).normalized()
            if d.y < -0.4:
                continue
            base = Vector((0, R * 0.05, hz + R * 0.1)) + d * R * 0.95
            tip = (
                base + d * R * sp.get("length", 0.45) + Vector((0, R * 0.1, -R * 0.05))
            )
            taper(
                f"spike{i}",
                rig["head"],
                tuple(base),
                tuple(tip),
                R * 0.22,
                R * 0.02,
                hm,
                "hair",
            )
    if style == "bun" or hair.get("bun"):
        ellipsoid(
            "bun",
            rig["head"],
            (0, R * 0.55, hz + R * 0.75),
            (R * 0.36,) * 3,
            hm,
            "hair",
        )
    if style == "loops":
        for sx in (-1, 1):
            ellipsoid(
                f"loop{sx}",
                rig["head"],
                (sx * R * 0.85, R * 0.3, hz + R * 0.55),
                (R * 0.3, R * 0.22, R * 0.32),
                hm,
                "hair",
            )
    if hair.get("ahoge"):
        taper(
            "ahoge",
            rig["head"],
            (0, -R * 0.1, hz + R * 1.0),
            (R * 0.15, -R * 0.25, hz + R * 1.35),
            R * 0.06,
            R * 0.01,
            hm,
            "hair",
        )
    if hair.get("streak"):
        taper(
            "streak",
            rig["head"],
            (R * 0.35, -R * 0.95, hz + R * 0.4),
            (R * 0.42, -R * 1.05, hz - R * 0.05),
            R * 0.12,
            R * 0.02,
            mat(hair["streak"], c),
            "hair",
            flat=0.6,
        )
    return sway


def build_headwear(ch: dict, rig: dict) -> dict:
    sway = {}
    R = B["headR"]
    hz = B["headZ"] - B["neckZ"]
    c = ch
    for hw in ch.get("headwear", []):
        t = hw["type"]
        m = mat(hw.get("color", "hat"), c)
        if t == "sunhat":
            # tilted back so the brim frames the face instead of hiding it from the high camera
            tilt = hw.get("tilt", 16)
            hat = pivot("sunhat", rig["head"], (0, R * hw.get("back", 0.16), hz + R * hw.get("lift", 0.6)))
            hat.rotation_euler = (math.radians(-tilt), 0, 0)
            ellipsoid("hatdome", hat, (0, 0, R * 0.1), (R * 1.0, R * 0.98, R * 0.68), m, "hat")
            cylinder("hatbrim", hat, (0, 0, 0), R * hw.get("brim", 1.32), 0.03, m, "hat", segs=40)
            cylinder("hatband", hat, (0, 0, R * 0.12), R * 1.03, R * 0.2, mat(hw["band"], c), "hatband",
                     scale=(1, 0.98, 1))
            if hw.get("bow"):
                bm_ = mat(hw["bow"], c)
                for i, (bx, by, bz, rz) in enumerate(((0.66, -0.55, 0.18, 30), (0.98, -0.38, 0.22, -25))):
                    ellipsoid(f"bow{i}", hat, (R * bx, R * by, R * bz), (R * 0.36, R * 0.13, R * 0.28), bm_,
                              "hatband", rot=(0, 20, rz))
                ellipsoid("bowknot", hat, (R * 0.8, R * 0.5 * -1.0, R * 0.17), (R * 0.08,) * 3, bm_, "hatband")
        elif t == "cap":
            shell(
                "capdome",
                rig["head"],
                (0, R * 0.04, hz + R * 0.22),
                (R * 1.1, R * 1.1, R * 1.0),
                m,
                "hat",
                keep=lambda x, y, z: z > 0.15,
            )
            if hw.get("front"):
                shell(
                    "capfront",
                    rig["head"],
                    (0, R * 0.035, hz + R * 0.225),
                    (R * 1.11, R * 1.11, R * 1.01),
                    mat(hw["front"], c),
                    "hat",
                    keep=lambda x, y, z: z > 0.15 and y < -0.2 and abs(x) < 0.55,
                )
            cylinder(
                "capbill",
                rig["head"],
                (0, -R * 0.95, hz + R * 0.4),
                R * 0.55,
                0.035,
                mat(hw.get("bill", hw.get("color", "hat")), c),
                "hat",
                scale=(1, 0.75, 1),
                rot=(-8, 0, 0),
            )
            if hw.get("button"):
                ellipsoid(
                    "capbutton",
                    rig["head"],
                    (0, R * 0.04, hz + R * 1.22),
                    (R * 0.1,) * 3,
                    mat(hw["button"], c),
                    "hat",
                )
        elif t == "beret":
            ellipsoid(
                "beret",
                rig["head"],
                (R * 0.1, R * 0.1, hz + R * 0.78),
                (R * 1.08, R * 1.0, R * 0.35),
                m,
                "hat",
                rot=(-10, 12, 0),
            )
        elif t == "nursecap":
            ellipsoid(
                "nursecap",
                rig["head"],
                (0, -R * 0.2, hz + R * 0.95),
                (R * 0.55, R * 0.22, R * 0.28),
                m,
                "hat",
            )
            cylinder(
                "nursecross",
                rig["head"],
                (0, -R * 0.42, hz + R * 0.98),
                R * 0.1,
                0.02,
                mat(hw["mark"], c),
                "hatband",
                rot=(90, 0, 0),
            )
        elif t == "hood":
            shell(
                "hood",
                rig["head"],
                (0, R * 0.08, hz + R * 0.05),
                (R * 1.18, R * 1.18, R * 1.15),
                m,
                "hat",
                keep=lambda x, y, z: (
                    not (y < -0.35 and abs(x) < 0.62 and -0.75 < z < 0.5)
                ),
            )
        elif t == "headphones":
            band = mat(hw.get("color", "phones"), c)
            for sx in (-1, 1):
                ellipsoid(
                    f"cup{sx}",
                    rig["head"],
                    (sx * R * 1.02, R * 0.05, hz - R * 0.05),
                    (R * 0.18, R * 0.3, R * 0.33),
                    band,
                    "hat",
                )
            shell(
                "phoneband",
                rig["head"],
                (0, R * 0.05, hz + R * 0.1),
                (R * 1.13, R * 0.25, R * 1.13),
                band,
                "hat",
                keep=lambda x, y, z: z > 0.2,
            )
            if hw.get("catEars"):
                for sx in (-1, 1):
                    taper(
                        f"catear{sx}",
                        rig["head"],
                        (sx * R * 0.55, 0, hz + R * 0.95),
                        (sx * R * 0.7, 0, hz + R * 1.4),
                        R * 0.22,
                        R * 0.02,
                        band,
                        "hat",
                        flat=0.5,
                    )
        elif t == "goggles":
            band = mat(hw.get("color", "goggles"), c)
            shell(
                "gogband",
                rig["head"],
                (0, R * 0.02, hz + R * 0.35),
                (R * 1.1, R * 1.1, R * 0.16),
                band,
                "hat",
                keep=lambda x, y, z: True,
            )
            for sx in (-1, 1):
                cylinder(
                    f"lens{sx}",
                    rig["head"],
                    (sx * R * 0.35, -R * 1.0, hz + R * 0.45),
                    R * 0.2,
                    R * 0.12,
                    mat(hw.get("lens", "lens"), c),
                    "hatband",
                    rot=(90, 0, 0),
                )
        elif t == "bandana":
            shell(
                "bandana",
                rig["head"],
                (0, R * 0.02, hz + R * 0.32),
                (R * 1.09, R * 1.09, R * 0.18),
                m,
                "hat",
                keep=lambda x, y, z: True,
            )
        elif t == "deerstalker":
            ellipsoid(
                "dsdome",
                rig["head"],
                (0, R * 0.05, hz + R * 0.48),
                (R * 1.08, R * 1.08, R * 0.75),
                m,
                "hat",
            )
            cylinder(
                "dsbill",
                rig["head"],
                (0, -R * 0.95, hz + R * 0.3),
                R * 0.45,
                0.035,
                m,
                "hat",
                scale=(1, 0.6, 1),
                rot=(-14, 0, 0),
            )
        elif t == "clip":
            ellipsoid(
                "clip",
                rig["head"],
                (R * 0.62, -R * 0.75, hz + R * 0.5),
                (R * 0.17, R * 0.08, R * 0.17),
                m,
                "hatband",
            )
        elif t == "crown":
            cylinder(
                "crown",
                rig["head"],
                (0, R * 0.1, hz + R * 0.98),
                R * 0.3,
                R * 0.15,
                m,
                "hat",
                segs=10,
            )
        elif t == "visor":
            shell(
                "visor",
                rig["head"],
                (0, 0, hz - R * 0.05),
                (R * 1.04, R * 1.04, R * 0.22),
                m,
                "visor",
                keep=lambda x, y, z: y < -0.3,
            )
        elif t == "mask":
            shell(
                "mask",
                rig["head"],
                (0, 0, hz - R * 0.25),
                (R * 1.01, R * 1.01, R * 0.5),
                m,
                "visor",
                keep=lambda x, y, z: y < -0.2 and z < -0.15,
            )
        elif t == "beard":
            shell(
                "beard",
                rig["head"],
                (0, -R * 0.05, hz - R * 0.35),
                (R * 0.92, R * 0.98, R * 0.75),
                m,
                "beard",
                keep=lambda x, y, z: y < -0.1 and z < hw.get("top", -0.2),
            )
            ellipsoid(
                "moustache",
                rig["head"],
                (0, -R * 0.93, hz - R * 0.32),
                (R * 0.42, R * 0.1, R * 0.12),
                m,
                "beard",
            )
    return sway


def build_accessories(ch: dict, rig: dict) -> dict:
    sway = {}
    c = ch
    tz0, tz1 = B["torsoBottomZ"] - B["hipZ"], B["torsoTopZ"] - B["hipZ"]
    td = B["torsoD"] / 2 * ch.get("build", 1.0)
    tw = B["torsoW"] / 2 * ch.get("build", 1.0)
    for acc in ch.get("accessories", []):
        t = acc["type"]
        m = mat(acc.get("color", "acc"), c)
        if t == "backpack":
            s = acc.get("size", 1.0)
            ellipsoid(
                "pack",
                rig["torso"],
                (0, td + 0.07 * s, (tz0 + tz1) / 2),
                (tw * 0.8 * s, 0.1 * s, 0.17 * s),
                m,
                "pack",
            )
            if acc.get("flap"):
                ellipsoid(
                    "packflap",
                    rig["torso"],
                    (0, td + 0.1 * s, (tz0 + tz1) / 2 + 0.08 * s),
                    (tw * 0.7 * s, 0.08 * s, 0.09 * s),
                    mat(acc["flap"], c),
                    "pack",
                )
        elif t == "scarf":
            cylinder(
                "scarf",
                rig["torso"],
                (0, 0, tz1 - 0.02),
                tw * 0.85,
                0.08,
                m,
                "scarf",
                scale=(1, td / tw * 1.1, 1),
            )
            p = pivot("scarftail", rig["torso"], (tw * 0.35, -td * 0.9, tz1 - 0.04))
            taper(
                "scarftailm",
                p,
                (0, 0, 0),
                (0.02, -0.03, -0.2),
                0.05,
                0.045,
                m,
                "scarf",
                flat=0.5,
            )
            sway["scarftail"] = {"obj": p, "amp": 12, "axis": "x"}
        elif t == "tie":
            taper(
                "tie",
                rig["torso"],
                (0, -td * 0.98, tz1 - 0.05),
                (0, -td * 1.0, tz0 + 0.12),
                0.035,
                0.05,
                m,
                "tie",
                flat=0.4,
            )
        elif t == "bow":
            for sx in (-1, 1):
                ellipsoid(
                    f"chestbow{sx}",
                    rig["torso"],
                    (sx * 0.05, -td * 0.98, tz1 - 0.06),
                    (0.05, 0.025, 0.035),
                    m,
                    "tie",
                    rot=(0, sx * 20, 0),
                )
        elif t == "cape":
            p = pivot("cape", rig["torso"], (0, td * 0.6, tz1 - 0.02))
            cone(
                "capem",
                p,
                (0, 0.05, -acc.get("length", 0.55) / 2),
                acc.get("flare", 0.36),
                tw * 0.9,
                acc.get("length", 0.55),
                m,
                "cape",
                scale=(1, 0.5, 1),
                open_front=0.9,
            )
            sway["cape"] = {"obj": p, "amp": 8, "axis": "x"}
        elif t == "pauldrons":
            for side, sx in (("L", 1), ("R", -1)):
                ellipsoid(
                    f"paul.{side}",
                    rig[f"shoulder.{side}"],
                    (0, 0, 0.02),
                    (0.11, 0.11, 0.08),
                    m,
                    "armor",
                )
        elif t == "hold":
            side = acc.get("hand", "R")
            el = rig[f"elbow.{side}"]
            sz = acc.get("size", [0.12, 0.04, 0.16])
            hand_z = -B["forearm"] - B["handR"] * 0.6
            name = f"held_{acc.get('name', 'item')}"
            if acc.get("round"):
                ellipsoid(
                    name,
                    el,
                    (0, -0.06, hand_z + sz[2] * 0.3),
                    tuple(sz),
                    m,
                    "held",
                    segs=12,
                    rings=8,
                )
            else:
                _box(name, el, (0, -0.07, hand_z + sz[2] * 0.25), sz, m)
            if acc.get("screen"):
                _box(
                    "held_screen",
                    el,
                    (0, -0.07 - sz[1] * 0.55, hand_z + sz[2] * 0.25),
                    (sz[0] * 0.8, 0.005, sz[2] * 0.75),
                    mat(acc["screen"], c),
                )
        elif t == "staff":
            side = acc.get("hand", "R")
            el = rig[f"elbow.{side}"]
            hand_z = -B["forearm"] - B["handR"] * 0.6
            taper(
                "staff",
                el,
                (0, -0.05, hand_z + 0.25),
                (0, -0.05, hand_z - acc.get("length", 0.45)),
                0.022,
                0.022,
                m,
                "held",
            )
        elif t == "onback":
            p = pivot("onback", rig["torso"], (0, td + 0.06, (tz0 + tz1) / 2))
            sz = acc.get("size", [0.18, 0.05, 0.4])
            _box("onbackm", p, (0, 0, 0), sz, m, rot=(0, 0, acc.get("tilt", 25)))
        elif t == "shield":
            el = rig["elbow.L"]
            cylinder(
                "shield",
                el,
                (0.07, -0.02, -B["forearm"] * 0.5),
                0.15,
                0.03,
                m,
                "held",
                rot=(0, 90, 0),
            )
        elif t == "drone":
            for i, sx in enumerate((-1, 1)):
                p = pivot(f"drone{i}", rig["torso"], (sx * 0.42, -0.05, tz1 + 0.12))
                ellipsoid(f"dronem{i}", p, (0, 0, 0), (0.06, 0.06, 0.035), m, "fx")
                ellipsoid(
                    f"droneeye{i}",
                    p,
                    (0, -0.05, 0),
                    (0.025, 0.012, 0.02),
                    mat(acc.get("glow", "#7CF9FF"), c),
                    "fx",
                )
                sway[f"drone{i}"] = {
                    "obj": p,
                    "amp": 0.03,
                    "axis": "bob",
                    "phase": i * 0.5,
                }
        elif t == "book":
            p = pivot("floatbook", rig["torso"], (-0.4, -0.12, tz1 + 0.05))
            _box("floatbookm", p, (0, 0, 0), (0.13, 0.04, 0.16), m, rot=(0, 0, 15))
            sway["floatbook"] = {"obj": p, "amp": 0.025, "axis": "bob", "phase": 0.25}
        elif t == "apron":
            t_o = ellipsoid(
                "apron",
                rig["torso"],
                (0, -td * 0.3, (tz0 + tz1) / 2 - 0.05),
                (tw * 0.85, td * 0.8, 0.26),
                m,
                "apron",
            )
            paint(t_o, c, acc.get("regions", []))
    return sway


def _box(name, parent, center, size, m, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
    o = bpy.context.active_object
    o.name = name
    o.location = center
    o.scale = size
    o.rotation_euler = tuple(math.radians(a) for a in rot)
    bev = o.modifiers.new("bevel", "BEVEL")
    bev.width = min(size) * 0.25
    bev.segments = 2
    return _finish(o, parent, m, "held", smooth=False)


def face_anchors(rig: dict) -> dict:
    R = B["headR"]
    hz = B["headZ"] - B["neckZ"]
    fa = STYLE["face"]
    anchors = {}
    for name, (x, z) in fa["anchors"].items():
        # anchor on the head surface; its outward normal decides visibility per view
        y = -math.sqrt(max(0.0, 1 - x * x - z * z))
        e = pivot(
            f"anchor_{name}",
            rig["head"],
            (x * R, y * R * 0.97, hz + z * R * B["headSquash"]),
        )
        anchors[name] = (e, Vector((x, y, z)).normalized())
    return anchors


# ---------------------------------------------------------------------------
# posing, secondary motion, rendering
# ---------------------------------------------------------------------------


def apply_sway(sway: dict, kind: str, t: float) -> None:
    for item in sway.values():
        o = item["obj"]
        amp = item["amp"]
        ph = 2 * math.pi * t
        lag = STYLE["sway"]["lag"]
        if item["axis"] == "bob":
            if "_base_z" not in o:
                o["_base_z"] = o.location.z
            o.location.z = o["_base_z"] + amp * math.sin(
                ph * (1 if kind == "idle" else 2) + item.get("phase", 0) * 6.28
            )
            continue
        if kind == "walk":
            # walk: double-frequency bounce drives front/back flop; the stride drives the side swing
            flop = amp * math.cos(2 * ph - lag)
            side = amp * 0.6 * math.sin(ph - lag) * item.get("side", 1)
        else:
            flop = amp * 0.25 * math.sin(ph - lag)
            side = amp * 0.15 * math.sin(ph + 0.6) * item.get("side", 1)
        if item["axis"] == "x":
            o.rotation_euler = (math.radians(flop + amp * 0.3 * (kind == "walk")), 0, 0)
        else:
            o.rotation_euler = (math.radians(flop * 0.5), math.radians(side), 0)


def setup_scene() -> bpy.types.Object:
    r = STYLE["render"]
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 1
    sc.cycles.use_denoising = False
    sc.cycles.max_bounces = 0
    sc.cycles.pixel_filter_type = "BOX"
    sc.cycles.filter_width = 0.01
    sc.render.film_transparent = True
    sc.render.resolution_x = sc.render.resolution_y = r["size"]
    sc.render.resolution_percentage = 100
    sc.view_settings.view_transform = "Standard"
    sc.render.image_settings.file_format = "OPEN_EXR"
    sc.render.image_settings.color_depth = "32"
    sc.render.image_settings.color_mode = "RGBA"
    world = bpy.data.worlds.new("bg")
    world.color = (0, 0, 0)
    sc.world = world
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = r["orthoScale"]
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    e = math.radians(r["elevationDeg"])
    d = r["distance"]
    cam.location = (0, -d * math.cos(e), r["targetZ"] + d * math.sin(e))
    cam.rotation_euler = (math.pi / 2 - e, 0, 0)
    sc.camera = cam
    return cam


def render_layer(path: Path) -> np.ndarray:
    sc = bpy.context.scene
    sc.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(str(path))
    w, h = img.size
    arr = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(arr)
    bpy.data.images.remove(img)
    path.unlink()
    return arr.reshape(h, w, 4)[::-1]


def srgb8(lin: np.ndarray) -> np.ndarray:
    a = np.clip(lin, 0, 1)
    s = np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(a, 1 / 2.4) - 0.055)
    return np.clip(np.rint(s * 255), 0, 255).astype(np.uint8)


def poses() -> list[tuple[str, int, float]]:
    out = []
    n_idle = STYLE["frames"]["idle"]
    n_walk = STYLE["frames"]["walk"]
    for k in range(n_idle):
        out.append(("idle", k, k / n_idle))
    for k in range(n_walk):
        out.append(("walk", k, k / n_walk))
    return out


def render_character(cid: str, views: list[str], out_root: Path) -> None:
    ch = CAST[cid]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _MATS.clear()
    _PARTS.clear()
    rig = build_rig(ch)
    build_body(ch, rig)
    sway = build_hair(ch, rig)
    sway.update(build_headwear(ch, rig))
    sway.update(build_accessories(ch, rig))
    anchors = face_anchors(rig)
    cam = setup_scene()
    sc = bpy.context.scene
    data_mat = data_material()
    out = out_root / cid
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / "_tmp.exr"
    colour, data, meta = [], [], []
    bpy.context.view_layer.update()
    cam_dir = (cam.matrix_world.to_quaternion() @ Vector((0, 0, -1))).normalized()
    for view in views:
        rig["root"].rotation_euler = (0, 0, math.radians(mq.SPEC["views"][view]))
        for kind, k, t in poses():
            pose = mq.pose_idle(t) if kind == "idle" else mq.pose_walk(t)
            mq.apply(rig, pose, B)
            apply_sway(sway, kind, t)
            bpy.context.view_layer.update()
            sc.view_layers[0].material_override = None
            col = render_layer(tmp)
            sc.view_layers[0].material_override = data_mat
            dat = render_layer(tmp)
            colour.append(
                np.concatenate(
                    [srgb8(col[..., :3]), (col[..., 3:4] > 0.5).astype(np.uint8) * 255],
                    axis=2,
                )
            )
            pid = np.rint(dat[..., 0] * 255).astype(np.uint8)
            pid[dat[..., 3] < 0.5] = 0
            depth = np.clip(dat[..., 1], 0, 1).astype(np.float32)
            data.append(np.stack([pid.astype(np.float32), depth], axis=2))
            fa = {}
            for name, (e, normal_local) in anchors.items():
                p = world_to_camera_view(sc, cam, e.matrix_world.translation)
                n_world = (
                    e.parent.matrix_world.to_quaternion() @ normal_local
                ).normalized()
                fa[name] = [float(p.x), float(1 - p.y), float(-n_world.dot(cam_dir))]
            meta.append({"view": view, "kind": kind, "k": k, "t": t, "anchors": fa})
    parts = [
        {"index": i + 1, "name": n, "kind": kd} for i, (n, kd) in enumerate(_PARTS)
    ]
    np.savez_compressed(
        out / "frames.npz", colour=np.stack(colour), data=np.stack(data)
    )
    (out / "frames.json").write_text(
        json.dumps(
            {"id": cid, "views": views, "frames": meta, "parts": parts}, indent=1
        )
    )
    print(
        json.dumps(
            {"id": cid, "frames": len(meta), "parts": len(parts), "out": str(out)}
        )
    )


def main() -> None:
    opts = parse_args(sys.argv)
    for cid in opts["ids"]:
        render_character(cid, opts["views"], opts["out"])


if __name__ == "__main__":
    main()
