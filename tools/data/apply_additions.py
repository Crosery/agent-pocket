#!/usr/bin/env python3
"""Merge a roster batch (docs/research/additions-*.json) into the generator's source tables.

Inputs  : the batch file; docs/research/roster-final.json, docs/research/designs.json and
          assets_src/prompts/creatures.json (the image-prompt roster) are rewritten in place.
Batch   : {"species": [...new records...], "patches": [{"id", "set": {...}}]}
          species record = roster-final fields + "design": {chibiDesign, personality, communityPersona,
          officialMascotOrLogo, sourceUrls} + optional "lineRef" (neighbouring evolution form whose raw render is
          attached to the image prompt) + "sources" (evidence URLs, kept in the batch file only).
          patch "set" overwrites roster-final fields of an existing id (stage / family / evolvesTo / evolveLevel ...);
          the same fields are mirrored into creatures.json when it carries them.
Idempotent: records are keyed by id (replaced when present, appended otherwise), patches are plain overwrites.
Then run python3 tools/data/build_species.py and python3 tools/build_jobs.py.

Usage: python3 tools/data/apply_additions.py docs/research/additions-2026-10.json
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
RULES = json.loads(pathlib.Path(__file__).with_name("species_rules.json").read_text())
ROSTER = ROOT / RULES["sources"]["roster"]
DESIGNS = ROOT / RULES["sources"]["designs"]
CREATURES = ROOT / "assets_src/prompts/creatures.json"

ROSTER_KEYS = [
    "id",
    "nameZh",
    "nameEn",
    "company",
    "country",
    "category",
    "family",
    "stage",
    "evolvesTo",
    "evolveLevel",
    "types",
    "rarity",
    "baseStats",
    "habitats",
    "releaseDate",
    "capabilityScore",
    "hotnessScore",
    "statRationale",
    "dexEntryZh",
    "lookZh",
]
DESIGN_KEYS = [
    "id",
    "chibiDesign",
    "personality",
    "communityPersona",
    "officialMascotOrLogo",
    "sourceUrls",
]
CREATURE_MIRROR = ["nameEn", "nameZh", "family", "stage", "types", "rarity"]


def load(p):
    return json.loads(p.read_text())


def dump(p, data):
    p.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")


def upsert(rows, rec):
    for i, r in enumerate(rows):
        if r["id"] == rec["id"]:
            rows[i] = rec
            return
    rows.append(rec)


def main():
    batch = load(pathlib.Path(sys.argv[1]).resolve())
    roster, designs, creatures = load(ROSTER), load(DESIGNS), load(CREATURES)
    for s in batch["species"]:
        rec = {
            k: s.get(k, "" if k == "evolvesTo" else 0 if k == "evolveLevel" else None)
            for k in ROSTER_KEYS
        }
        missing = [k for k in ROSTER_KEYS if rec[k] is None]
        if missing:
            raise SystemExit(f"{s['id']}: missing roster fields {missing}")
        d = {"id": s["id"], **{k: s["design"].get(k, "") for k in DESIGN_KEYS[1:]}}
        if not d["chibiDesign"] or not d["personality"]:
            raise SystemExit(f"{s['id']}: design.chibiDesign / personality required")
        c = {
            "id": s["id"],
            "nameEn": rec["nameEn"],
            "nameZh": rec["nameZh"],
            "family": rec["family"],
            "stage": rec["stage"],
            "types": rec["types"],
            "rarity": rec["rarity"],
            "design": d["chibiDesign"],
            "lookZh": rec["lookZh"],
            "personality": d["personality"],
        }
        if s.get("lineRef"):
            c["lineRef"] = s["lineRef"]
        upsert(roster, rec)
        upsert(designs, d)
        upsert(creatures, c)
    by = {r["id"]: r for r in roster}
    cby = {r["id"]: r for r in creatures}
    for p in batch.get("patches", []):
        if p["id"] not in by:
            raise SystemExit(f"patch: unknown id {p['id']}")
        by[p["id"]].update(p["set"])
        for k in CREATURE_MIRROR:
            if k in p["set"] and p["id"] in cby:
                cby[p["id"]][k] = p["set"][k]
        if "lineRef" in p["set"] and p["id"] in cby:
            cby[p["id"]]["lineRef"] = p["set"]["lineRef"]
    dump(ROSTER, roster)
    dump(DESIGNS, designs)
    dump(CREATURES, creatures)
    print(
        f"merged {len(batch['species'])} species, {len(batch.get('patches', []))} patches"
    )


if __name__ == "__main__":
    main()
