#!/usr/bin/env python3
"""Derive the image-generation job list from content/*.json + assets_src/prompts/*.json.

Every asset id comes from the content tables named in templates.json (`kinds.<kind>.source`), so adding a
character/terrain/biome/type to content automatically adds its jobs. Prompt wording lives in
templates.json; per-id descriptive detail in details.json (missing ids fall back to `detailFallback`).

Usage: python3 tools/build_jobs.py [--out assets_src/prompts/jobs.json]
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter

from assetlib import (
    DETAILS_PATH,
    JOBS_PATH,
    ROOT,
    TEMPLATES_PATH,
    content_json,
    load_json,
    write_json,
)

PLACEHOLDER = re.compile(r"\{([a-zA-Z0-9_.]+)\}")


def fill(template: str, values: dict) -> str:
    def sub(m: re.Match) -> str:
        key = m.group(1)
        if key not in values:
            raise KeyError(f"prompt placeholder {{{key}}} has no value")
        return str(values[key])

    # Two passes so style snippets may themselves contain placeholders.
    return PLACEHOLDER.sub(sub, PLACEHOLDER.sub(sub, template))


def records_for(kind_cfg: dict) -> list[dict]:
    if "static" in kind_cfg:
        return [dict(r) for r in kind_cfg["static"]]
    src = kind_cfg["source"]
    data = content_json(src["file"])
    if src.get("path"):
        for part in src["path"].split("."):
            data = data[part]
    where = src.get("where", {})
    exclude = set(src.get("exclude", []))
    seen: set[str] = set()
    out = []
    kept = []
    for rec in data:
        if any(rec.get(k) != v for k, v in where.items()):
            continue
        rid = rec.get(src["id"])
        if not rid or rid in exclude or rid in seen:
            continue
        seen.add(rid)
        row = {"id": rid}
        for name, field in src.get("fields", {}).items():
            row[name] = rec.get(field, "")
        out.append(row)
        kept.append(rec)
    # groupCount {name: field}: how many selected records share this record's field value (e.g. family size)
    for name, field in src.get("groupCount", {}).items():
        counts = Counter(r.get(field) for r in kept)
        for row, rec in zip(out, kept, strict=True):
            row[name] = counts[rec.get(field)]
    return out


def references(kind: str, rid: str, cfg: dict, values: dict) -> list[str]:
    """kinds.<kind>.references [{path, note, optional}]: reference images (paths relative to the repo root) sent
    with the prompt in order. Each used image's note (with {n} = its 1-based index) is joined into {refNotes};
    an optional image whose file is missing is skipped."""
    images: list[str] = []
    notes: list[str] = []
    for ref in cfg.get("references", []):
        path = fill(ref["path"], values)
        if not (ROOT / path).is_file():
            if ref.get("optional"):
                continue
            raise FileNotFoundError(f"{kind}/{rid}: reference image {path} not found")
        images.append(path)
        notes.append(fill(ref["note"], {**values, "n": len(images)}))
    if "references" in cfg:
        values["refNotes"] = " ".join(notes)
    return images


def build(templates: dict, details: dict) -> list[dict]:
    style = {f"style.{k}": v for k, v in templates["style"].items()}
    jobs = []
    for kind, cfg in templates["kinds"].items():
        table = details.get(cfg.get("details", ""), {})
        for rec in records_for(cfg):
            values = {**style, **rec, "idWords": rec["id"].replace("_", " ")}
            # lookups {name: {key, values, default}}: a text picked by a key built from the record's fields
            for name, lk in cfg.get("lookups", {}).items():
                text = lk["values"].get(fill(lk["key"], values), lk.get("default"))
                if text is None:
                    raise KeyError(f"{kind}/{rec['id']}: lookup {name} has no value")
                values[name] = fill(text, values)
            if "details" in cfg:
                dkey = rec.get(cfg.get("detailKey", "id"), rec["id"])
                values["detail"] = table.get(dkey) or fill(
                    templates["detailFallback"], values
                )
            images = references(kind, rec["id"], cfg, values)
            jobs.append(
                {
                    "id": rec["id"],
                    "kind": kind,
                    "prompt": fill(cfg["prompt"], values),
                    "variant": cfg["variant"],
                    "quality": cfg["quality"],
                    "process": cfg["process"],
                    "out": fill(cfg["out"], values),
                    **({"images": images} if images else {}),
                    **(
                        {"meta": {k: v for k, v in rec.items() if k != "id"}}
                        if len(rec) > 1
                        else {}
                    ),
                }
            )
    return jobs


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--out", default=str(JOBS_PATH))
    args = ap.parse_args()
    jobs = build(load_json(TEMPLATES_PATH), load_json(DETAILS_PATH))
    write_json(args.out, jobs)
    counts: dict[str, int] = {}
    for j in jobs:
        counts[j["kind"]] = counts.get(j["kind"], 0) + 1
    print(
        f"{len(jobs)} jobs -> {args.out}  "
        + ", ".join(f"{k}:{v}" for k, v in counts.items())
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
