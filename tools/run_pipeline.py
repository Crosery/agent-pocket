#!/usr/bin/env python3
"""One-shot 2D asset pipeline: build jobs -> generate missing renders -> process -> rebuild manifest.

Adding a character/terrain/biome/type to content/*.json and running this is all that is needed.
Usage: python3 tools/run_pipeline.py [--kind K ...] [--only ids] [--force ids] [--no-generate] [--concurrency N]
                                     [--backend aigw|crosery]
"""

from __future__ import annotations

import argparse
import subprocess
import sys

from assetlib import ROOT


def step(*args: str) -> int:
    print("$ python3 " + " ".join(args), flush=True)
    return subprocess.run(
        [sys.executable, *args], cwd=ROOT / "tools", check=False
    ).returncode


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--kind", action="append", default=[])
    ap.add_argument("--only", default="")
    ap.add_argument("--force", default="")
    ap.add_argument("--no-generate", action="store_true")
    ap.add_argument("--concurrency", default="")
    ap.add_argument(
        "--backend", default="", help="aigw | crosery (default: pipeline.json)"
    )
    a = ap.parse_args()
    sel = [x for k in a.kind for x in ("--kind", k)] + (
        ["--only", a.only] if a.only else []
    )
    rc = step("build_jobs.py")
    if rc == 0 and not a.no_generate:
        gen = (
            sel
            + (["--force", a.force] if a.force else [])
            + (["--concurrency", a.concurrency] if a.concurrency else [])
            + (["--backend", a.backend] if a.backend else [])
        )
        rc = step(
            "gen_images.py", *gen
        )  # failures are logged; still process whatever exists
    proc = step(
        "process_all.py", *sel
    )  # forced renders are newer than their outputs -> reprocessed
    man = step("build_manifest.py")
    return rc or proc or man


if __name__ == "__main__":
    sys.exit(main())
