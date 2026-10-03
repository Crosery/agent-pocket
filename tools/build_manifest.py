#!/usr/bin/env python3
"""Scan public/assets/** and write public/assets/manifest.json (the client's list of present files).

Kinds, directories and extensions come from assets_src/pipeline.json `manifest`. Ids are file paths relative
to the kind's directory without extension, e.g. textures -> "terrain/grass" (resolved against /assets/textures/).
Safe to run by any agent at any time; output is sorted and deterministic.

Usage: python3 tools/build_manifest.py [--check]   (--check: exit 1 if the manifest on disk is stale)
"""

from __future__ import annotations

import argparse
import json
import sys

from assetlib import ROOT, pipeline_cfg

ASSETS = ROOT / "public" / "assets"
MANIFEST = ASSETS / "manifest.json"


def scan() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for kind, spec in pipeline_cfg()["manifest"].items():
        base = ASSETS / spec["dir"]
        ids: set[str] = set()
        if base.is_dir():
            files = base.rglob("*") if spec.get("recursive") else base.glob("*")
            for f in files:
                if (
                    f.is_file()
                    and (f.suffix.lower() in spec["ext"] or f.suffix.lower() == ".webp")
                    and not f.name.startswith((".", "_"))
                    and not f.name.endswith(".part" + f.suffix)
                ):
                    # .webp entries keep their extension (client default is the layout ext); webp wins over a stale sibling.
                    rel = f.relative_to(base)
                    ids.add(rel.as_posix() if f.suffix.lower() == ".webp" else rel.with_suffix("").as_posix())
        webp = {i[:-5] for i in ids if i.endswith(".webp")}
        out[kind] = sorted(i for i in ids if i.endswith(".webp") or i not in webp)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    data = scan()
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if a.check:
        current = MANIFEST.read_text() if MANIFEST.exists() else ""
        print("manifest up to date" if current == text else "manifest STALE")
        return 0 if current == text else 1
    tmp = MANIFEST.with_suffix(".json.tmp")
    tmp.write_text(text)
    tmp.replace(MANIFEST)
    print(
        f"{MANIFEST.relative_to(ROOT)}: "
        + ", ".join(f"{k}={len(v)}" for k, v in data.items())
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
