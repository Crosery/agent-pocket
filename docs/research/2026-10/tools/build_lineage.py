"""Build lineage.json from catalog seeds + curation modules.

usage: python3 build_lineage.py <research-dir>

Inputs : seeds/<vendor>.json (from make_seeds.py), curation/<vendor>.py (hand-curated lines/overrides/extras)
Outputs: lineage.json, tools/species-map.json, plus a stderr report of seed candidates not assigned to any line.

A curation module defines:
  VENDOR   dict          vendor object (key, name, nameZh, country, homepage, officialModelListUrl, changelogUrl, notes)
  LINES    list of dict  {family, category, chain: [key, ...], relation?, basis?, src?: [urls], tags?: [...]}
                         chain keys are seed keys (see seeds/<vendor>.json "key") or EXTRA keys. The parent of
                         chain[i] is chain[i-1] with the line's relation (default series-successor / inferred-series).
  R        dict          key -> per-record overrides: displayName, releaseDate, releaseMonth, category, parent,
                         relation, basis, parentExternal, ow, status, tags, sources, sc, notes, family, catbasis
  EXTRA    dict          key -> records absent from the catalogs (same fields as R; displayName required)
  SPECIES  dict          roster species id -> key
  SEEDS    list          extra seed files to draw candidates from
  IGNORE   set           seed keys deliberately not used
  EXCLUDED list          one-line reasons for notable drops
  GAPS     list          things not verified
"""

import importlib.util
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(sys.argv[1])
TODAY = "2026-10-09"
OR_BASE = "https://openrouter.ai/"
MD_URL = "https://models.dev/"
CATEGORIES = [
    "llm",
    "reasoning",
    "code",
    "vision-language",
    "image",
    "video",
    "speech-tts",
    "speech-asr",
    "music",
    "embedding",
    "3d",
    "world",
    "agent",
]
RELATIONS = ["post-train", "distill", "successor", "series-successor", "merge"]


def slug(s):
    s = re.sub(r"[^a-z0-9.+]+", "-", s.lower()).replace("+", "-plus-").replace(".", "-")
    return re.sub(r"-+", "-", s).strip("-")


def pick_name(names):
    plain = [n for n in names if ": " not in n and "(latest)" not in n]
    n = plain[0] if plain else re.sub(r"^[^:]+:\s*", "", names[0])
    return re.sub(r"\s+\(\d{4}-\d{2}-\d{2}\)$", "", n).strip()


def load_mod(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {path}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def read_json(path):
    with open(path) as f:
        return json.load(f)


def best_date(c):
    h = c["releaseDateHints"]
    md = [
        v
        for k, v in h.items()
        if k.startswith("modelsdev") and v and re.fullmatch(r"\d{4}-\d{2}-\d{2}", v)
    ]
    orr = [v for k, v in h.items() if k == "openrouter" and v]
    pool = md or orr
    return min(pool) if pool else None


class Vendor:
    """Builds the raw (pre-id) records of one curation module."""

    def __init__(self, mod):
        self.mod = mod
        self.vkey = mod.VENDOR["key"]
        self.seed = {"candidates": []}
        seedp = ROOT / "seeds" / f"{self.vkey}.json"
        if seedp.exists():
            self.seed = read_json(seedp)
        for extra in getattr(mod, "SEEDS", []):
            sp = ROOT / "seeds" / f"{extra}.json"
            if sp.exists():
                self.seed["candidates"] += read_json(sp)["candidates"]
        self.R = getattr(mod, "R", {})
        self.EXTRA = getattr(mod, "EXTRA", {})
        self.local = {}
        self.assigned = set()

    def seed_info(self, key):
        for c in self.seed["candidates"]:
            if c["key"] == key:
                return c
        return None

    def make(self, key, line):
        if key in self.local:
            return self.local[key]
        c = self.seed_info(key)
        ov = self.R.get(key, {})
        ex = self.EXTRA.get(key, {})
        base = {}
        if c:
            srcs = []
            for cat, ids in c["catalogIds"].items():
                if cat == "openrouter":
                    srcs += [OR_BASE + i for i in ids if "/" in i][:1]
            if any(k.startswith("modelsdev") for k in c["catalogIds"]):
                srcs.append(MD_URL)
            base = {
                "displayName": pick_name(c["names"]),
                "releaseDate": best_date(c),
                "openWeights": c["openWeights"],
                "status": "deprecated" if c["deprecated"] else "current",
                "sources": srcs,
                "sc": "catalog",
                "releaseDateBasis": "catalog",
                "reach": {
                    "modelsDevProviders": sum(
                        1 for k in c["catalogIds"] if k.startswith("modelsdev")
                    ),
                    "openrouter": "openrouter" in c["catalogIds"],
                },
            }
            self.assigned.add(key)
        elif ex or "displayName" in ov:
            base = {"sources": [], "sc": "background", "releaseDateBasis": "background"}
        else:
            raise SystemExit(
                f"{self.vkey}: unknown key {key!r}: not in seeds and not in EXTRA"
            )
        rec = {**base, **ex, **ov}
        if "releaseDate" in ov or "releaseDate" in ex:
            rec["releaseDateBasis"] = (
                ov.get("releaseDateBasis")
                or ex.get("releaseDateBasis")
                or rec.get("sc", "secondary")
            )
        rec["sources"] = list(rec["sources"])
        self.local[key] = rec
        return rec

    def expand_auto(self):
        """AUTO entries {family, category, match, exclude?, tags?, relation?} -> chains of seed keys sorted by date."""
        ignore_re = [re.compile(x, re.I) for x in getattr(self.mod, "IGNORE_RE", [])]
        lines = []
        used = set()
        for ln in getattr(self.mod, "LINES", []):
            used.update(ln["chain"])
        for au in getattr(self.mod, "AUTO", []):
            pat = re.compile(au["match"], re.I)
            exc = re.compile(au["exclude"], re.I) if au.get("exclude") else None
            members = []
            for c in self.seed["candidates"]:
                nm = pick_name(c["names"])
                if c["key"] in used or c["key"] in getattr(self.mod, "IGNORE", set()):
                    continue
                if any(r.search(nm) or r.search(c["key"]) for r in ignore_re):
                    continue
                if pat.search(nm) and not (exc and exc.search(nm)):
                    members.append((best_date(c) or "9999", c["key"]))
            members.sort()
            if members:
                keys = [k for _, k in members]
                used.update(keys)
                lines.append({k: v for k, v in au.items() if k not in ("match", "exclude")} | {"chain": keys})
        return lines

    def apply_lines(self):
        for ln in getattr(self.mod, "LINES", []) + self.expand_auto():
            prev = None
            for key in ln["chain"]:
                rec = self.make(key, ln)
                rec.setdefault("family", ln["family"])
                rec.setdefault("category", ln["category"])
                rec["tags"] = sorted(set(rec.get("tags", []) + ln.get("tags", [])))
                for u in ln.get("src", []):
                    if u not in rec["sources"]:
                        rec["sources"].insert(0, u)
                if "parent" not in rec and prev is not None:
                    rec["parent"] = prev
                    rec.setdefault("relation", ln.get("relation", "series-successor"))
                    rec.setdefault("basis", ln.get("basis", "inferred-series"))
                elif rec.get("parent"):
                    rec.setdefault("relation", "series-successor")
                    rec.setdefault("basis", "inferred-series")
                prev = key
        for key in list(self.EXTRA) + [k for k in self.R if k not in self.local]:
            if key in self.local:
                continue
            if (
                key not in self.EXTRA
                and not self.seed_info(key)
                and "displayName" not in self.R.get(key, {})
            ):
                raise SystemExit(f"{self.vkey}: R override for unknown key {key!r}")
            merged = {**self.EXTRA.get(key, {}), **self.R.get(key, {})}
            fam = merged.get("family") or key
            cat = merged.get("category")
            if not cat:
                raise SystemExit(f"{self.vkey}: single {key} needs a category")
            rec = self.make(key, {"family": fam, "category": cat})
            rec.setdefault("family", fam)
            rec.setdefault("category", cat)
            rec["tags"] = sorted(set(rec.get("tags", [])))

    def finish(self, records, species_map):
        vkey = self.vkey
        country = self.mod.VENDOR["country"]
        key2id = {}
        for key, rec in self.local.items():
            key2id[key] = rec.get("id") or f"{vkey}/{slug(rec['displayName'])}"
        outs = {}
        for key, rec in self.local.items():
            p = rec.get("parent")
            par_id = key2id.get(p) if p else None
            if p and not par_id:
                raise SystemExit(f"{vkey}: parent {p!r} of {key!r} not in this vendor")
            ext = rec.get("parentExternal")
            has_parent = bool(par_id or ext)
            if rec["category"] not in CATEGORIES:
                raise SystemExit(f"{vkey}: bad category {rec['category']!r} for {key}")
            if has_parent and rec.get("relation") not in RELATIONS:
                raise SystemExit(
                    f"{vkey}: bad relation {rec.get('relation')!r} for {key}"
                )
            out = {
                "id": key2id[key],
                "displayName": rec["displayName"],
                "aliases": rec.get("alt", []),
                "vendor": vkey,
                "country": rec.get("country", country),
                "family": rec["family"],
                "category": rec["category"],
                "tags": rec.get("tags", []),
                "releaseDate": rec.get("releaseDate"),
                "releaseMonth": rec.get("releaseMonth"),
                "releaseDateBasis": rec.get("releaseDateBasis")
                if rec.get("releaseDate")
                else None,
                "parent": par_id,
                "relation": rec.get("relation") if has_parent else None,
                "parentBasis": rec.get("basis") if has_parent else None,
                "parentExternal": ext,
                "openWeights": rec.get("ow", rec.get("openWeights")),
                "status": rec.get("status", "current"),
                "gameSpeciesId": None,
                "categoryBasis": rec.get("catbasis"),
                "sourceCheck": rec.get("sc", "catalog"),
                "catalogReach": rec.get("reach"),
                "sources": rec["sources"],
                "verifiedAt": TODAY,
                "notes": rec.get("notes", ""),
            }
            if key2id[key] in records:
                raise SystemExit(f"duplicate id {key2id[key]}")
            records[key2id[key]] = out
            outs[key] = out
        for sid, key in getattr(self.mod, "SPECIES", {}).items():
            if key not in outs:
                raise SystemExit(f"{vkey}: SPECIES {sid} -> unknown key {key}")
            outs[key]["gameSpeciesId"] = sid
            species_map[sid] = outs[key]["id"]

    def unassigned(self):
        ignore = getattr(self.mod, "IGNORE", set())
        ignore_re = [re.compile(x, re.I) for x in getattr(self.mod, "IGNORE_RE", [])]
        rows = []
        for c in self.seed["candidates"]:
            if c["key"] in self.assigned or c["key"] in ignore:
                continue
            nm = pick_name(c["names"])
            if any(r.search(nm) or r.search(c["key"]) for r in ignore_re):
                continue
            ds = sorted(x for x in c["releaseDateHints"].values() if x)
            rows.append(
                f"{self.vkey}: unassigned {c['key']} | {c['names'][0]} | {ds[0] if ds else '?'}"
            )
        return rows


def chain_stage(records, r):
    d = 1
    seen = {r["id"]}
    while r.get("parent"):
        r = records[r["parent"]]
        if r["id"] in seen:
            raise SystemExit("cycle at " + r["id"])
        seen.add(r["id"])
        d += 1
    return d


def main():
    records, species_map, vendors, report, gaps, excluded = {}, {}, [], [], {}, {}
    for path in sorted((ROOT / "curation").glob("*.py")):
        v = Vendor(load_mod(path))
        v.apply_lines()
        v.finish(records, species_map)
        vendors.append({**v.mod.VENDOR, "verifiedAt": TODAY})
        report += v.unassigned()
        gaps[v.vkey] = getattr(v.mod, "GAPS", [])
        excluded[v.vkey] = getattr(v.mod, "EXCLUDED", [])
    official_hosts = (
        "kling.ai",
        "klingai.com",
        "ir.kuaishou.com",
        "huggingface.co",
        "github.com",
        "github.io",
        "nasdaq.com/press-release",
        "globenewswire.com",
        "x.com/Kling_ai",
    )
    for path in sorted((ROOT / "parts").glob("*.json")):
        part = read_json(path)
        vk = part["vendor"]["key"]
        if any(v["key"] == vk for v in vendors):
            continue
        vendors.append({**part["vendor"], "verifiedAt": TODAY})
        gaps[vk] = part.get("gaps", [])
        excluded[vk] = part.get("excluded", [])
        for rec in part["records"]:
            first = rec["sources"][0] if rec["sources"] else ""
            check = "official" if any(h in first for h in official_hosts) else "secondary"
            rec.setdefault("aliases", [])
            rec.setdefault("sourceCheck", check)
            rec.setdefault("catalogReach", None)
            rec["releaseDateBasis"] = (
                rec.get("releaseDateBasis") or rec["sourceCheck"] if rec["releaseDate"] else None
            )
            rec["verifiedAt"] = TODAY
            if rec["id"] in records:
                raise SystemExit(f"duplicate id {rec['id']}")
            records[rec["id"]] = rec
            if rec.get("gameSpeciesId"):
                species_map[rec["gameSpeciesId"]] = rec["id"]
    for r in records.values():
        r["chainStage"] = chain_stage(records, r)
    out = {
        "generatedAt": TODAY,
        "method": "see lineage-notes.md",
        "categoryEnum": CATEGORIES,
        "relationEnum": RELATIONS,
        "vendors": vendors,
        "records": sorted(
            records.values(),
            key=lambda r: (
                r["vendor"],
                r["family"],
                r["chainStage"],
                r["releaseDate"] or "9999",
            ),
        ),
        "gaps": gaps,
        "excluded": excluded,
    }
    with open(ROOT / "lineage.json", "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    with open(ROOT / "tools" / "species-map.json", "w") as f:
        json.dump(species_map, f, ensure_ascii=False, indent=1)
    print(len(records), "records", len(vendors), "vendors", file=sys.stderr)
    print("\n".join(report), file=sys.stderr)


main()
