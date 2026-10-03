"""Build nature & furniture prop GLBs from tools/blender/nature_spec.json + content/props.json.

Run (Blender 5.2 background):
  crosery-ct call blender_python script=<abs>/tools/blender/nature.py [script_args=--only] [script_args=tree_oak,bush]
Options (after --): --only k1,k2   build a subset   |  --verify-only   skip building  |  --no-preview
Outputs: public/assets/models/<key>.glb, assets_src/blender/nature/{textures/*.png,renders/*.png,preview.png,report.json}
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

import nature_lib as nl


def parse_args(argv: list[str]) -> dict:
    args = argv[argv.index("--") + 1 :] if "--" in argv else []
    opts = {"only": None, "verify_only": False, "preview": True}
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--only":
            opts["only"] = [k for k in args[i + 1].split(",") if k]
            i += 1
        elif a == "--verify-only":
            opts["verify_only"] = True
        elif a == "--no-preview":
            opts["preview"] = False
        else:
            raise SystemExit(f"unknown argument {a!r}")
        i += 1
    return opts


def check(key: str, info: dict, pdef: dict, pspec: dict, spec: dict) -> list[str]:
    defaults = spec["defaults"]
    filters = [spec["export"]["magFilter"], spec["export"]["minFilter"]]
    errs = []
    budget = pspec.get("budget", defaults["maxTris"])
    if info["tris"] > budget:
        errs.append(f"{key}: {info['tris']} tris > budget {budget}")
    if info["bytes"] > defaults["maxBytes"]:
        errs.append(f"{key}: {info['bytes']} bytes > {defaults['maxBytes']}")
    h = info["max"][2] - info["min"][2]
    if abs(h - pdef["height"]) > defaults["heightTolerance"] * max(pdef["height"], 1):
        errs.append(f"{key}: height {h:.3f} != PropDef.height {pdef['height']}")
    if abs(info["min"][2]) > 1e-3:
        errs.append(f"{key}: ground offset {info['min'][2]:.3f}")
    if any(f != filters for f in info["samplers"]):
        errs.append(f"{key}: sampler filters {info['samplers']} != {filters}")
    emit_names = [
        m for m in info["materials"] if m.startswith(defaults["emissivePrefix"])
    ]
    if sorted(emit_names) != sorted(info["emissive"]):
        errs.append(
            f"{key}: emissive materials {info['emissive']} vs {defaults['emissivePrefix']} names {emit_names}"
        )
    if pdef.get("light") and not emit_names:
        errs.append(
            f"{key}: PropDef has a light but no {defaults['emissivePrefix']} material"
        )
    if pdef.get("sway") and defaults["foliageMaterial"] not in info["materials"]:
        errs.append(
            f"{key}: PropDef.sway but no {defaults['foliageMaterial']} material"
        )
    return errs


def main() -> None:
    opts = parse_args(sys.argv)
    spec = json.loads((HERE / "nature_spec.json").read_text())
    props = {p["key"]: p for p in json.loads((ROOT / spec["propsFile"]).read_text())}
    models_dir, src_dir = ROOT / spec["modelsDir"], ROOT / spec["srcDir"]
    keys = list(spec["props"])
    unknown = [k for k in keys if k not in props]
    billboards = [k for k in keys if props.get(k, {}).get("billboard")]
    if unknown or billboards:
        raise SystemExit(
            f"spec keys not in props.json: {unknown}; billboard keys must not be modelled: {billboards}"
        )
    if opts["only"]:
        missing = [k for k in opts["only"] if k not in spec["props"]]
        if missing:
            raise SystemExit(f"--only keys not in spec: {missing}")
        keys = [k for k in keys if k in opts["only"]]

    bank = nl.TextureBank(spec["textures"])
    if not opts["verify_only"]:
        for tkey in spec["textures"]:
            nl.write_png(src_dir / "textures" / f"{tkey}.png", bank.get(tkey))
        for key in keys:
            t0 = time.time()
            stats = nl.build_prop(
                key,
                spec["props"][key],
                props[key],
                spec,
                bank,
                models_dir / f"{key}.glb",
            )
            print(
                f"[nature] built {key:14s} tris={stats['tris']:5d} in {time.time() - t0:.2f}s",
                flush=True,
            )

    report_path = src_dir / "report.json"
    report = json.loads(report_path.read_text()) if report_path.exists() else {}
    report = {k: v for k, v in report.items() if k in spec["props"]}
    errors = []
    for key in keys:
        glb = models_dir / f"{key}.glb"
        if not glb.exists():
            errors.append(f"{key}: missing {glb}")
            continue
        info = nl.inspect_glb(glb)
        report[key] = info
        errs = check(key, info, props[key], spec["props"][key], spec)
        errors += errs
        size = [round(info["max"][i] - info["min"][i], 3) for i in range(3)]
        print(
            f"[verify] {key:14s} tris={info['tris']:5d} bytes={info['bytes']:6d} size(xyz)={size} "
            f"center=({(info['max'][0] + info['min'][0]) / 2:+.2f},{(info['max'][1] + info['min'][1]) / 2:+.2f}) "
            f"mats={info['materials']} {'OK' if not errs else 'FAIL'}",
            flush=True,
        )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(dict(sorted(report.items())), indent=1) + "\n")

    if opts["preview"]:
        prev = spec["preview"]
        for key in keys:
            nl.render_preview(
                models_dir / f"{key}.glb", key, src_dir / "renders" / f"{key}.png", prev
            )
        nl.compose_sheet(
            [src_dir / "renders" / f"{k}.png" for k in spec["props"]],
            src_dir / "preview.png",
            prev,
        )
        print(f"[nature] contact sheet -> {src_dir / 'preview.png'}", flush=True)

    if errors:
        print("\n".join(f"[error] {e}" for e in errors), flush=True)
        raise SystemExit(1)
    print(f"[nature] {len(keys)} prop(s) OK", flush=True)


main()
