"""Static validation of buildings_spec.json against content/props.json (no bpy needed for most checks).

python3 tools/blender/lib_bld_validate.py      # prints problems, exit 1 if any
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib_bld_spec import (
    SpecError,
    building_scope,
    load_props,
    load_spec,
)
from lib_bld_tex import PATTERN_IDS as TEXTURE_PATTERNS

EMIT_PREFIX = "EMIT_"


def _part_types():
    try:
        from lib_bld_geo import BUILDERS

        return set(BUILDERS)
    except ImportError:  # outside Blender: bmesh/mathutils unavailable
        return None


def _part_mats(p):
    out = []
    if "mat" in p:
        out.append(p["mat"])
    out += list(p.get("mats", {}).values())
    return out


def validate_spec(spec, props):
    errs = []
    for k in ("pxPerTile", "roughness", "verify", "parts", "patterns"):
        if k not in spec.get("defaults", {}):
            errs.append(f"defaults.{k} missing")
    glyphs = spec.get("glyphs", {})
    for gid, rows in glyphs.items():
        if not rows or any(not isinstance(r, str) for r in rows):
            errs.append(f"glyph {gid}: rows must be non-empty strings")
    for tid, t in spec.get("textures", {}).items():
        if t.get("pattern") not in TEXTURE_PATTERNS:
            errs.append(f"texture {tid}: unknown pattern {t.get('pattern')!r}")
        size = t.get("size")
        if not isinstance(size, int) or size < 8 or size & (size - 1):
            errs.append(f"texture {tid}: size must be a power of two >= 8")
        if (
            t.get("pattern") == "sign"
            and "glyph" in t.get("colors", {})
            and t["colors"]["glyph"] not in glyphs
        ):
            errs.append(f"texture {tid}: unknown glyph {t['colors']['glyph']!r}")
    for mid, m in spec.get("materials", {}).items():
        if "emitTex" in m and m["emitTex"] not in spec.get("textures", {}):
            errs.append(f"material {mid}: unknown emitTex {m['emitTex']!r}")
        if m.get("tex") not in spec.get("textures", {}):
            errs.append(f"material {mid}: unknown texture {m.get('tex')!r}")
        if m.get("uv", "world") not in ("world", "fit"):
            errs.append(f"material {mid}: uv must be world|fit")
        if mid.startswith(EMIT_PREFIX) != (float(m.get("emit", 0)) > 0):
            errs.append(
                f"material {mid}: {EMIT_PREFIX} prefix and emit > 0 must go together"
            )
    types = _part_types()
    for key, b in spec.get("buildings", {}).items():
        if key not in props:
            errs.append(f"building {key}: no PropDef in content/props.json")
            continue
        try:
            building_scope(spec, props[key], b)  # evaluates every var expression
        except SpecError as exc:
            errs.append(f"building {key}: {exc}")
            continue
        parts = b.get("parts", [])
        if not parts:
            errs.append(f"building {key}: no parts")
        nodes = set(b.get("nodes", {})) | {""}
        for i, p in enumerate(parts):
            where = f"building {key} part #{i} ({p.get('type')})"
            if types is not None and p.get("type") not in types:
                errs.append(f"{where}: unknown part type")
            if p.get("node", "") not in nodes:
                errs.append(f"{where}: undeclared node {p.get('node')!r}")
            mats = _part_mats(p)
            if not mats:
                errs.append(f"{where}: no material")
            for mid in mats:
                if mid not in spec.get("materials", {}):
                    errs.append(f"{where}: unknown material {mid!r}")
        if props[key].get("door") and not any(p.get("type") == "door" for p in parts):
            errs.append(f"building {key}: PropDef has a door but spec has no door part")
    return errs


if __name__ == "__main__":
    problems = validate_spec(load_spec(), load_props())
    for e in problems:
        print(e)
    print(f"{len(problems)} problem(s)")
    sys.exit(1 if problems else 0)
