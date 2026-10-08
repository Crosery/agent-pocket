#!/usr/bin/env python3
"""Export complete-body candidates without replacing any shipped assets."""

from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor
import json
import pathlib

import numpy as np

from assetlib import ROOT, content_json, pipeline_cfg, save_png, to_image, write_json
from walk_video import rows


def build(sheet_id: str, out: pathlib.Path) -> dict:
    got = rows(sheet_id)
    sprites = content_json("content/config.json")["sprites"]
    cell = sprites["sheetCell"]
    order = sprites["sheetRows"]
    report = {"id": sheet_id, "accepted": False, "rows": {d: rep for d, (_, rep) in got.items()}}
    if any(d not in got or got[d][0] is None for d in order):
        return report
    count = pipeline_cfg()["walkVideo"]["atlas"]["frames"] + 1
    atlas = np.zeros((cell * len(order), cell * count, 4), np.float32)
    for direction, r in order.items():
        for c, f in enumerate(got[direction][0]):
            atlas[r * cell : (r + 1) * cell, c * cell : (c + 1) * cell] = f
    save_png(to_image(atlas), out / f"{sheet_id}.png")
    return {**report, "accepted": True}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=pathlib.Path, default=ROOT / "output/motion-qa/full-body")
    ap.add_argument("--only", help="comma-separated character ids")
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()
    ids = args.only.split(",") if args.only else [c["id"] for c in content_json("content/characters.json")]
    args.out.mkdir(parents=True, exist_ok=True)
    reports = []
    with ProcessPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = [pool.submit(build, sheet_id, args.out) for sheet_id in ids]
        for future in futures:
            report = future.result()
            reports.append(report)
            print(json.dumps(report), flush=True)
    accepted = sum(r["accepted"] for r in reports)
    result = {"sheets": len(reports), "accepted": accepted, "rejected": len(reports) - accepted, "reports": reports}
    write_json(args.out / "report.json", result)
    print(json.dumps({k: v for k, v in result.items() if k != "reports"}))
    return int(accepted != len(reports))


if __name__ == "__main__":
    raise SystemExit(main())
