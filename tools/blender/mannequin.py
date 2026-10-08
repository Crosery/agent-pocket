"""Chibi motion mannequin: shared skeleton + idle/walk pose curves; renders grey preview clips of the motion.

Run (Blender 5.2 background):
  blender -b -P tools/blender/mannequin.py -- --out /tmp/mannequin [--views down,left] [--still]
Spec: tools/blender/mannequin_spec.json. tools/blender/chibi.py imports the rig pivots and pose_idle/pose_walk.
Preview output: <out>/<view>/####.png, <out>/<view>.mp4 and <out>/timeline.json (frame index -> phase).
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import bpy

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SPEC = json.loads((HERE / "mannequin_spec.json").read_text())


def parse_args(argv: list[str]) -> dict:
    args = argv[argv.index("--") + 1 :] if "--" in argv else []
    opts = {
        "out": ROOT / "assets_src/raw/motion/ref",
        "views": list(SPEC["views"]),
        "still": False,
    }
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--out":
            opts["out"] = Path(args[i + 1]).resolve()
            i += 1
        elif a == "--views":
            opts["views"] = [v for v in args[i + 1].split(",") if v]
            i += 1
        elif a == "--still":
            opts["still"] = True
        else:
            raise SystemExit(f"unknown argument {a!r}")
        i += 1
    return opts


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name: str, rgb: list[float]) -> bpy.types.Material:
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1.0)
    return m


def pivot(name: str, parent, loc) -> bpy.types.Object:
    e = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(e)
    e.parent = parent
    e.location = loc
    e.rotation_mode = "XYZ"
    return e


def part(mesh_op, name: str, parent, loc, scale, mat, **kw) -> bpy.types.Object:
    mesh_op(location=(0, 0, 0), **kw)
    o = bpy.context.active_object
    o.name = name
    o.location = loc
    o.scale = scale
    o.data.materials.append(mat)
    o.color = (*mat.diffuse_color[:3], 1.0)
    o.parent = parent
    bpy.ops.object.shade_smooth()
    return o


def build() -> dict:
    b, c = SPEC["body"], SPEC["colors"]
    mats = {k: material(k, v) for k, v in c.items()}
    root = pivot("root", None, (0, 0, 0))
    hips = pivot("hips", root, (0, 0, b["hipZ"]))
    # torso hangs off the hips so the bob moves everything above the legs
    torso = pivot("torso", hips, (0, 0, 0))
    tz0, tz1 = b["torsoBottomZ"] - b["hipZ"], b["torsoTopZ"] - b["hipZ"]
    part(
        bpy.ops.mesh.primitive_uv_sphere_add,
        "torso_m",
        torso,
        (0, 0, (tz0 + tz1) / 2),
        (b["torsoW"] / 2, b["torsoD"] / 2, (tz1 - tz0) / 2),
        mats["torso"],
        segments=24,
        ring_count=12,
    )
    head = pivot("head", torso, (0, 0, b["neckZ"] - b["hipZ"]))
    hr = b["headR"]
    hz = b["headZ"] - b["neckZ"]
    part(
        bpy.ops.mesh.primitive_uv_sphere_add,
        "head_m",
        head,
        (0, 0, hz),
        (hr, hr * 0.96, hr * b["headSquash"]),
        mats["skin"],
        segments=32,
        ring_count=16,
    )
    # eyes on the -Y side mark the facing; without them front and back views are ambiguous
    for sx in (-1, 1):
        part(
            bpy.ops.mesh.primitive_uv_sphere_add,
            f"eye_{sx}",
            head,
            (sx * hr * 0.36, -hr * 0.86, hz - hr * 0.08),
            (hr * 0.09, hr * 0.05, hr * 0.15),
            mats["face"],
            segments=12,
            ring_count=8,
        )
    rig = {"root": root, "hips": hips, "torso": torso, "head": head}
    for side, sx in (("L", 1), ("R", -1)):
        limb = mats["limbLeft"] if side == "L" else mats["limbRight"]
        sh = pivot(
            f"shoulder.{side}",
            torso,
            (sx * b["shoulderX"], 0, b["shoulderZ"] - b["hipZ"]),
        )
        part(
            bpy.ops.mesh.primitive_cylinder_add,
            f"uarm.{side}",
            sh,
            (0, 0, -b["upperArm"] / 2),
            (b["armR"], b["armR"], b["upperArm"] / 2),
            limb,
            vertices=16,
        )
        el = pivot(f"elbow.{side}", sh, (0, 0, -b["upperArm"]))
        part(
            bpy.ops.mesh.primitive_uv_sphere_add,
            f"elbowj.{side}",
            el,
            (0, 0, 0),
            (b["armR"] * 1.05,) * 3,
            mats["joint"],
            segments=12,
            ring_count=8,
        )
        part(
            bpy.ops.mesh.primitive_cylinder_add,
            f"farm.{side}",
            el,
            (0, 0, -b["forearm"] / 2),
            (b["armR"] * 0.95, b["armR"] * 0.95, b["forearm"] / 2),
            limb,
            vertices=16,
        )
        part(
            bpy.ops.mesh.primitive_uv_sphere_add,
            f"hand.{side}",
            el,
            (0, 0, -b["forearm"] - b["handR"] * 0.6),
            (b["handR"],) * 3,
            mats["skin"],
            segments=16,
            ring_count=8,
        )
        hp = pivot(f"hip.{side}", hips, (sx * b["hipX"], 0, 0))
        part(
            bpy.ops.mesh.primitive_cylinder_add,
            f"thigh.{side}",
            hp,
            (0, 0, -b["thigh"] / 2),
            (b["legR"], b["legR"], b["thigh"] / 2),
            limb,
            vertices=16,
        )
        kn = pivot(f"knee.{side}", hp, (0, 0, -b["thigh"]))
        part(
            bpy.ops.mesh.primitive_uv_sphere_add,
            f"kneej.{side}",
            kn,
            (0, 0, 0),
            (b["legR"] * 1.05,) * 3,
            mats["joint"],
            segments=12,
            ring_count=8,
        )
        part(
            bpy.ops.mesh.primitive_cylinder_add,
            f"shin.{side}",
            kn,
            (0, 0, -b["shin"] / 2),
            (b["legR"] * 0.95, b["legR"] * 0.95, b["shin"] / 2),
            limb,
            vertices=16,
        )
        an = pivot(f"ankle.{side}", kn, (0, 0, -b["shin"]))
        part(
            bpy.ops.mesh.primitive_cube_add,
            f"foot.{side}",
            an,
            (0, -b["footLen"] * 0.25, -b["footH"] / 2),
            (b["legR"] * 1.2, b["footLen"] / 2, b["footH"] / 2),
            mats["joint"],
        )
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


def smooth01(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def pose_idle(t: float) -> dict:
    """t in [0,1) over one breath; returns joint -> (rx, ry, rz) degrees plus offsets."""
    i = SPEC["idle"]
    s = math.sin(2 * math.pi * t)
    return {
        "hips.z": i["bob"] * 0.5 * (1 - math.cos(2 * math.pi * t)) * -1,
        "hips.x": i["weightShiftX"] * math.sin(2 * math.pi * t * 0.5 + 0.3),
        "chest": 1 + i["chestScale"] * (0.5 - 0.5 * math.cos(2 * math.pi * t)),
        "shoulder.L": (i["armSwayDeg"] * s * 0.5, 0, 4),
        "shoulder.R": (-i["armSwayDeg"] * s * 0.5, 0, -4),
        "elbow.L": (-i["elbowDeg"], 0, 0),
        "elbow.R": (-i["elbowDeg"], 0, 0),
        "head": (
            i["headTiltDeg"] * 0.4 * s,
            0,
            i["headTiltDeg"] * math.sin(2 * math.pi * t + 1.1),
        ),
        "hip.L": (0, 0, 0),
        "hip.R": (0, 0, 0),
        "knee.L": (0, 0, 0),
        "knee.R": (0, 0, 0),
        "ankle.L": (0, 0, 0),
        "ankle.R": (0, 0, 0),
        "torso": (0, 0, 0),
    }


def pose_walk(t: float) -> dict:
    """t in [0,1) over one stride pair. t=0: left foot contact (left leg forward)."""
    w = SPEC["walk"]
    ph = 2 * math.pi * t
    s, cph = math.sin(ph + math.pi / 2), math.cos(ph + math.pi / 2)
    # thigh pitch: positive = leg forward (toward -Y, the facing direction) -> rotate about X negative
    thighL, thighR = w["thighSwingDeg"] * s, -w["thighSwingDeg"] * s

    def knee(leg_phase: float) -> float:
        # knee flexes while the leg swings forward (thigh moving forward = derivative positive)
        swing = max(0.0, math.sin(leg_phase))
        return w["kneeStanceDeg"] + w["kneeSwingDeg"] * swing**1.5

    kneeL = knee(ph + math.pi)
    kneeR = knee(ph)
    armL, armR = -w["armSwingDeg"] * s, w["armSwingDeg"] * s
    contact = abs(s)
    return {
        # lowest on contact (legs spread), highest when passing
        "hips.z": -w["bob"] * contact**1.2,
        "hips.x": w["hipSwayX"] * cph,
        "chest": 1.0,
        "torso": (w["torsoLeanDeg"], 0, w["torsoTwistDeg"] * s),
        "head": (-w["torsoLeanDeg"] * 0.6, 0, -w["headCounterDeg"] * s),
        "hip.L": (-thighL, 0, 0),
        "hip.R": (-thighR, 0, 0),
        "knee.L": (kneeL, 0, 0),
        "knee.R": (kneeR, 0, 0),
        "ankle.L": (-kneeL * 0.35 + thighL * 0.25, 0, 0),
        "ankle.R": (-kneeR * 0.35 + thighR * 0.25, 0, 0),
        "shoulder.L": (armL, 0, 6),
        "shoulder.R": (armR, 0, -6),
        "elbow.L": (-(w["elbowDeg"] + w["elbowSwingDeg"] * max(0.0, -s)), 0, 0),
        "elbow.R": (-(w["elbowDeg"] + w["elbowSwingDeg"] * max(0.0, s)), 0, 0),
    }


def blend(a: dict, b: dict, k: float) -> dict:
    out = {}
    for key, va in a.items():
        vb = b[key]
        if isinstance(va, tuple):
            out[key] = tuple(x + (y - x) * k for x, y in zip(va, vb))
        else:
            out[key] = va + (vb - va) * k
    return out


def timeline() -> list[dict]:
    tl = SPEC["timeline"]
    idle_n, blend_n, cyc, n_cyc = (
        tl["idleFrames"],
        tl["blendFrames"],
        tl["walkCycleFrames"],
        tl["walkCycles"],
    )
    frames = []
    for f in range(idle_n):
        frames.append(
            {"kind": "idle", "t": f / SPEC["idle"]["breathPeriodFrames"] % 1.0}
        )
    for f in range(blend_n):
        frames.append(
            {"kind": "blend", "k": smooth01((f + 1) / (blend_n + 1)), "t": 0.0}
        )
    for f in range(cyc * n_cyc):
        frames.append({"kind": "walk", "t": (f % cyc) / cyc, "cycle": f // cyc})
    for f in range(tl["tailIdleFrames"]):
        frames.append(
            {"kind": "idle", "t": f / SPEC["idle"]["breathPeriodFrames"] % 1.0}
        )
    return frames


def apply(rig: dict, pose: dict, b: dict) -> None:
    rig["hips"].location = (pose["hips.x"], 0, b["hipZ"] + pose["hips.z"])
    rig["torso"].scale = (pose["chest"], pose["chest"], 1.0)
    for key, val in pose.items():
        if key in rig and isinstance(val, tuple):
            rig[key].rotation_euler = tuple(math.radians(v) for v in val)


def keyframe_all(rig: dict, frame: int) -> None:
    for name, o in rig.items():
        if name == "root":
            continue
        o.keyframe_insert("location", frame=frame)
        o.keyframe_insert("rotation_euler", frame=frame)
        o.keyframe_insert("scale", frame=frame)


def setup_render(r: dict) -> bpy.types.Object:
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.render.resolution_x = sc.render.resolution_y = r["size"]
    sc.render.resolution_percentage = 100
    sc.render.fps = r["fps"]
    sc.render.film_transparent = False
    sh = sc.display.shading
    sh.light = "STUDIO"
    sh.color_type = "MATERIAL"
    sh.show_object_outline = r["outline"]
    sh.object_outline_color = (0.12, 0.1, 0.1)
    sh.show_cavity = False
    sh.background_type = "VIEWPORT"
    sh.background_color = tuple(r["background"])
    world = bpy.data.worlds.new("bg")
    world.color = tuple(r["background"])
    sc.world = world
    sc.view_settings.view_transform = "Standard"
    sc.render.image_settings.file_format = "PNG"
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


def main() -> None:
    opts = parse_args(sys.argv)
    reset_scene()
    rig = build()
    b = SPEC["body"]
    frames = timeline()
    walk0 = pose_walk(0.0)
    for i, fr in enumerate(frames):
        if fr["kind"] == "idle":
            p = pose_idle(fr["t"])
        elif fr["kind"] == "blend":
            p = blend(pose_idle(0.0), walk0, fr["k"])
        else:
            p = pose_walk(fr["t"])
        apply(rig, p, b)
        keyframe_all(rig, i + 1)
    for action in bpy.data.actions:
        for fc in getattr(action, "fcurves", []):
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"
    sc = bpy.context.scene
    sc.frame_start, sc.frame_end = 1, len(frames)
    setup_render(SPEC["render"])
    out: Path = opts["out"]
    out.mkdir(parents=True, exist_ok=True)
    (out / "timeline.json").write_text(
        json.dumps({"fps": SPEC["render"]["fps"], "frames": frames}, indent=1)
    )
    for view in opts["views"]:
        rig["root"].rotation_euler = (0, 0, math.radians(SPEC["views"][view]))
        vdir = out / view
        vdir.mkdir(parents=True, exist_ok=True)
        if opts["still"]:
            for f in (1, len(frames) // 2):
                sc.frame_set(f)
                sc.render.filepath = str(vdir / f"still_{f:04d}.png")
                bpy.ops.render.render(write_still=True)
            continue
        sc.render.filepath = str(vdir) + "/"
        bpy.ops.render.render(animation=True)
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-framerate",
                str(SPEC["render"]["fps"]),
                "-i",
                str(vdir / "%04d.png"),
                "-c:v",
                "libx264",
                "-crf",
                "14",
                "-pix_fmt",
                "yuv420p",
                str(out / f"{view}.mp4"),
            ],
            check=True,
        )
    print(json.dumps({"out": str(out), "frames": len(frames), "views": opts["views"]}))


if __name__ == "__main__":
    main()
