#!/usr/bin/env python3
"""Run the matching processor for every job whose raw render exists (assets_src/raw/<kind>/<id>.png).

A job is (re)processed when its output is missing or older than the raw render, or when --all is given.
Per-job results are written to assets_src/raw/_process_report.json; failures exit non-zero.

Usage: python3 tools/process_all.py [--jobs assets_src/prompts/jobs.json] [--kind K ...] [--only ids] [--all]
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback

from assetlib import (
    JOBS_PATH,
    RAW_DIR,
    ROOT,
    load_json,
    load_jobs,
    out_path,
    pipeline_cfg,
    raw_path,
    write_json,
)
from process_creature import process_creature
from process_portrait import process_portrait
from process_sheet import process_sheet
from process_texture import process_texture, process_tuft
from process_ui import process_backdrop, process_icon, process_logo

PROCESSORS = {
    "sheet": lambda j, s, d: process_sheet(s, d, j["id"]),
    "portrait": lambda j, s, d: process_portrait(s, d),
    "texture": lambda j, s, d: process_texture(s, d, j["id"], j["kind"]),
    "tuft": lambda j, s, d: process_tuft(s, d),
    "icon": lambda j, s, d: process_icon(s, d, j.get("meta", {}).get("color")),
    "backdrop": lambda j, s, d: process_backdrop(s, d),
    # title key art (AI-girl cover, tools/build_cover.py): source size kept, no palette
    "keyart": lambda j, s, d: process_backdrop(
        s, d, pipeline_cfg()["cover"]["fix"]["backdrop"]
    ),
    "logo": lambda j, s, d: process_logo(s, d),
    "creature": lambda j, s, d: process_creature(s, d),
}


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--jobs", default=str(JOBS_PATH))
    ap.add_argument("--kind", action="append", default=[])
    ap.add_argument("--only", default="", help="comma list of ids or kind/id")
    ap.add_argument(
        "--all",
        action="store_true",
        help="reprocess even when the output is up to date",
    )
    a = ap.parse_args()
    only = {x.strip() for x in a.only.split(",") if x.strip()}
    report_path = RAW_DIR / "_process_report.json"
    report = json.loads(report_path.read_text()) if report_path.exists() else {}
    done = failed = missing = 0
    chibi = {c["id"] for c in load_json(ROOT / "assets_src/chibi/cast.json")["characters"]}
    for job in load_jobs(a.jobs):
        tag = f"{job['kind']}/{job['id']}"
        if (a.kind and job["kind"] not in a.kind) or (
            only and job["id"] not in only and tag not in only
        ):
            continue
        if job["process"] == "sheet" and job["id"] in chibi:
            continue  # built by tools/blender/chibi.py + tools/chibi_post.py, never from the old AI render
        src, dst = raw_path(job), out_path(job)
        if not src.exists():
            missing += 1
            continue
        if not a.all and dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            continue
        try:
            rep = PROCESSORS[job["process"]](job, str(src), str(dst))
            report[tag] = {"ok": True, **rep}
            done += 1
            print(
                f"[ok]   {tag} -> {job['out']}  {json.dumps(rep, ensure_ascii=False)}"
            )
        except Exception as e:  # noqa: BLE001 - report every failure, keep going
            report[tag] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            failed += 1
            print(f"[fail] {tag}: {e}", file=sys.stderr)
            traceback.print_exc(limit=2)
    write_json(report_path, report)
    print(f"processed {done}, failed {failed}, raw missing {missing}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
