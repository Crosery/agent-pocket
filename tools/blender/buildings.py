"""Procedural HD-2D building/structure props → public/assets/models/<PropDef.model>.glb.

Run inside Blender (background):
  crosery-ct call blender_python script=<abs>/tools/blender/buildings.py \
      script_args=--only script_args=house_small,shop     # optional subset
  flags: --only k1,k2   --no-preview   --no-blend

Data sources: footprint/height/door from content/props.json (never duplicated); every style choice,
texture, material and part in tools/blender/buildings_spec.json. This file only orchestrates.
Writes: GLBs, assets_src/blender/buildings/{<key>.blend, textures/, previews/, preview.png, report.json}.
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy
from lib_bld_io import (
    build_objects,
    compose_sheet,
    export_glb,
    import_glb,
    measure,
    preview_dir,
    render_preview,
    reset_scene,
)
from lib_bld_spec import (
    MODELS_DIR,
    SRC_DIR,
    building_scope,
    load_props,
    load_spec,
)
from lib_bld_validate import validate_spec


def parse_args(argv):
    args = argv[argv.index("--") + 1 :] if "--" in argv else []
    opts = {"only": None, "preview": True, "blend": True}
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--only":
            opts["only"] = [k for k in args[i + 1].split(",") if k]
            i += 1
        elif a == "--no-preview":
            opts["preview"] = False
        elif a == "--no-blend":
            opts["blend"] = False
        else:
            raise SystemExit(f"unknown argument {a!r}")
        i += 1
    return opts


def check(key, prop, m, info, size, spec):
    """Compares the re-imported GLB against its PropDef; returns list of problem strings."""
    vd = dict(spec["defaults"]["verify"])
    vd.update(spec["buildings"][key].get("verify", {}))
    w, d = prop["footprint"]
    h = prop["height"]
    lo, hi = m["min"], m["max"]
    problems = []
    for axis, half in ((0, w / 2), (1, d / 2)):
        if (
            lo[axis] < -half - vd["footprintTol"]
            or hi[axis] > half + vd["footprintTol"]
        ):
            problems.append(
                f"axis {'XY'[axis]} extends to [{lo[axis]:.2f},{hi[axis]:.2f}] beyond ±{half}"
            )
    if abs(hi[2] - h) > vd["heightTol"] * h:
        problems.append(f"height {hi[2]:.2f} vs PropDef {h}")
    if lo[2] < vd["minZ"]:
        problems.append(f"min z {lo[2]:.2f} below {vd['minZ']}")
    if m["tris"] > vd["maxTris"]:
        problems.append(f"{m['tris']} tris > {vd['maxTris']}")
    if size > vd["maxBytes"]:
        problems.append(f"{size} bytes > {vd['maxBytes']}")
    if prop.get("door"):
        pts = info["doors"]
        if not pts:
            problems.append("PropDef has a door but the model has no door part")
        else:
            xs, ys = [q[0] for q in pts], [q[1] for q in pts]
            front_y = min(ys)
            if front_y > 0 or abs(front_y + d / 2) > vd["doorFacadeTol"]:
                problems.append(f"door front at y={front_y:.2f}, expected facade y≈{-d / 2} (front = -Y / glTF +Z)")
            tile_x = math.floor(w / 2) + prop["door"][0] - (w - 1) / 2
            if min(xs) > tile_x - vd["doorCover"] or max(xs) < tile_x + vd["doorCover"]:
                problems.append(f"door spans x[{min(xs):.2f},{max(xs):.2f}] but door tile centre is x={tile_x}")
    return problems


def main():
    opts = parse_args(sys.argv)
    spec = load_spec()
    props = load_props()
    errors = validate_spec(spec, props)
    if errors:
        raise SystemExit("buildings_spec.json invalid:\n  " + "\n  ".join(errors))
    keys = opts["only"] or list(spec["buildings"].keys())
    report = {}
    SRC_DIR.mkdir(parents=True, exist_ok=True)
    for key in keys:
        prop = props[key]
        scope = building_scope(spec, prop, spec["buildings"][key])
        reset_scene()
        objects, info = build_objects(key, spec, scope)
        out = MODELS_DIR / f"{prop['model']}.glb"
        export_glb(objects, out)
        if opts["blend"]:
            bpy.context.preferences.filepaths.save_version = 0
            bpy.ops.wm.save_as_mainfile(
                filepath=str(SRC_DIR / f"{key}.blend"), compress=True
            )
        reset_scene()
        imported = import_glb(out)
        m = measure(imported)
        size = out.stat().st_size
        problems = check(key, prop, m, info, size, spec)
        emit = sorted(k for k in m["byMat"] if k.startswith("EMIT_"))
        report[key] = {
            "glb": str(out.relative_to(MODELS_DIR.parent.parent.parent)),
            "bytes": size,
            "tris": m["tris"],
            "bboxMin": m["min"],
            "bboxMax": m["max"],
            "footprint": prop["footprint"],
            "height": prop["height"],
            "door": prop.get("door"),
            "doorCenters": info["doors"],
            "emissive": emit,
            "materials": sorted(m["byMat"].keys()),
            "problems": problems,
        }
        status = "OK " if not problems else "BAD"
        print(
            f"[{status}] {key:14s} tris={m['tris']:5d} bytes={size:7d} "
            f"x[{m['min'][0]:+.2f},{m['max'][0]:+.2f}] y[{m['min'][1]:+.2f},{m['max'][1]:+.2f}] "
            f"z[{m['min'][2]:+.2f},{m['max'][2]:+.2f}] fp={prop['footprint']} h={prop['height']} "
            + ("; ".join(problems)),
            flush=True,
        )
        if opts["preview"]:
            fp = prop["footprint"]
            label = f"{key}  {fp[0]}x{fp[1]} h{prop['height']}  {m['tris']}t"
            render_preview(
                imported, label, preview_dir() / f"{key}.png", spec["preview"]
            )
    report_path = SRC_DIR / "report.json"
    merged = (
        json.loads(report_path.read_text())
        if report_path.exists() and opts["only"]
        else {}
    )
    merged.update(report)
    merged = {k: merged[k] for k in spec["buildings"] if k in merged}
    report_path.write_text(json.dumps(merged, indent=1, ensure_ascii=False) + "\n")
    if opts["preview"]:
        tiles = [
            preview_dir() / f"{k}.png"
            for k in spec["buildings"]
            if (preview_dir() / f"{k}.png").exists()
        ]
        reset_scene()
        compose_sheet(
            tiles,
            int(spec["preview"]["cols"]),
            SRC_DIR / "preview.png",
            spec["preview"]["bg"],
        )
    bad = [k for k, r in report.items() if r["problems"]]
    print(f"built {len(report)} model(s); problems: {bad or 'none'}")


main()
