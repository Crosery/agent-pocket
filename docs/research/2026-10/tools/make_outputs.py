"""Derive missing-in-game.json and evolution-proposals.json from lineage.json + content/species.json.

usage: python3 make_outputs.py <research-dir> <species.json>
"""
import collections
import json
import subprocess
import sys

ROOT, SPECIES = sys.argv[1], sys.argv[2]
lin = json.load(open(ROOT + "/lineage.json"))
recs = {r["id"]: r for r in lin["records"]}
roster = json.load(open(SPECIES))
roster = roster if isinstance(roster, list) else list(roster.values())
sp = {s["id"]: s for s in roster}
smap = json.load(open(ROOT + "/tools/species-map.json"))
rec2sp = {v: k for k, v in smap.items()}
children = collections.defaultdict(list)
for r in recs.values():
    if r["parent"]:
        children[r["parent"]].append(r["id"])

ranked = json.loads(
    subprocess.run(
        [sys.executable, "-I", ROOT + "/tools/rank_missing.py", ROOT, "/dev/stdout"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
)
fame = json.load(open(ROOT + "/tools/fame.json"))


def ancestors(rid):
    out = []
    while recs[rid]["parent"]:
        rid = recs[rid]["parent"]
        out.append(rid)
    return out


def nearest_roster(rid):
    for a in ancestors(rid):
        if a in rec2sp:
            return {"speciesId": rec2sp[a], "recordId": a, "direction": "ancestor-in-roster (this model would be a later stage)"}
    stack = list(children[rid])
    while stack:
        c = stack.pop(0)
        if c in rec2sp:
            return {"speciesId": rec2sp[c], "recordId": c, "direction": "descendant-in-roster (this model would be an earlier stage)"}
        stack += children[c]
    return None


def reason(r, why, score):
    bits = []
    bits += why
    reach = (r.get("catalogReach") or {}).get("modelsDevProviders")
    if reach:
        bits.append(f"on {reach} providers")
    when = r["releaseDate"] or r["releaseMonth"] or "date unknown"
    return f"{r['displayName']} ({when}, {r['category']}): " + ("; ".join(bits) if bits else "catalogued model absent from roster")


# ---------- missing-in-game ----------
items = []
cap_family, cap_vendor = 2, 6
seen_f, seen_v = collections.Counter(), collections.Counter()
for rank, x in enumerate(ranked, 1):
    r = recs[x["id"]]
    it = {
        "rank": rank,
        "id": r["id"],
        "displayName": r["displayName"],
        "vendor": r["vendor"],
        "category": r["category"],
        "releaseDate": r["releaseDate"],
        "releaseMonth": r["releaseMonth"],
        "status": r["status"],
        "score": x["score"],
        "reason": reason(r, x["why"], x["score"]),
        "slot": nearest_roster(r["id"]),
        "sourceCheck": r["sourceCheck"],
    }
    items.append(it)
diverse = []
for it in items:
    r = recs[it["id"]]
    kf, kv = (r["vendor"], r["family"]), r["vendor"]
    if seen_f[kf] >= cap_family or seen_v[kv] >= cap_vendor:
        continue
    seen_f[kf] += 1
    seen_v[kv] += 1
    diverse.append(it["id"])
    if len(diverse) == 60:
        break
for it in items:
    it["inDiverseTop"] = it["id"] in diverse
by_cat = collections.defaultdict(list)
for it in items:
    if len(by_cat[it["category"]]) < 6:
        by_cat[it["category"]].append(it["id"])
out = {
    "generatedAt": lin["generatedAt"],
    "method": "score = 0.4*models.dev providers (cap 25) + 3 if OpenRouter + 4 if newest current record of its (vendor,family) + recency (3 for >=2026-06, 2 for 2026-01..05, 1 for 2025) + 2 for top-tier vendors + hand-assigned landmark bonus (tools/fame.json). OpenRouter has no popularity API, so provider count is a proxy. 'inDiverseTop' = greedy top 60 with at most 2 per (vendor,family) and 6 per vendor.",
    "rosterSpeciesCount": len(roster),
    "lineageRecordCount": len(recs),
    "missingCount": len(items),
    "diverseTopIds": diverse,
    "topByCategory": dict(by_cat),
    "items": items,
}
json.dump(out, open(ROOT + "/missing-in-game.json", "w"), ensure_ascii=False, indent=1)

# ---------- evolution proposals ----------
CATMAP = {
    "llm": {"llm", "reasoning", "vision-language"},
    "reasoning": {"reasoning"},
    "code": {"code", "agent"},
    "multimodal": {"llm", "vision-language", "reasoning", "agent"},
    "image": {"image"},
    "video": {"video"},
    "music": {"music"},
    "audio": {"speech-tts", "speech-asr", "music"},
    "agent": {"agent"},
    "embodied": {"agent"},
    "search": {"agent"},
    "other": None,
}


def path_between(a, b):
    """lineage path a -> b (a must be an ancestor of b); None otherwise."""
    p = [b]
    cur = b
    while recs[cur]["parent"]:
        cur = recs[cur]["parent"]
        p.append(cur)
        if cur == a:
            return list(reversed(p))
    return None


checks = []
for s in roster:
    ev = s.get("evolvesTo")
    if not ev:
        continue
    a, b = s["id"], ev["id"]
    ra, rb = smap.get(a), smap.get(b)
    c = {"from": a, "to": b, "rosterKind": ev.get("kind"), "rosterLevel": ev.get("level"), "fromRecord": ra, "toRecord": rb}
    if not ra or not rb:
        c.update(verdict="unmapped", comment="one side is not a model (placeholder/other)")
    else:
        p = path_between(ra, rb)
        A, B = recs[ra], recs[rb]
        c["dateOrderOk"] = bool(A["releaseDate"] and B["releaseDate"] and A["releaseDate"] <= B["releaseDate"]) if A["releaseDate"] and B["releaseDate"] else None
        if p:
            hops = len(p) - 1
            rel = [recs[x]["relation"] for x in p[1:]]
            weights = any(r in ("post-train", "distill") for r in rel)
            c.update(
                verdict="consistent-direct" if hops == 1 else "consistent-skips-versions",
                hops=hops,
                path=p,
                relations=rel,
                skipped=[recs[x]["displayName"] for x in p[1:-1]],
                kindEvidence="weights-claim (post-train/distill in path)" if weights else "series-only (no weights claim)",
            )
            msg = f"{hops} lineage hop(s)"
            if hops > 1:
                msg += f" (skips {', '.join(c['skipped'])})"
            if ev.get("kind") == "post-training" and not weights:
                msg += "; roster kind 'post-training' is stronger than the evidence"
            c["comment"] = msg
        else:
            same_family = A["vendor"] == B["vendor"] and A["family"] == B["family"]
            same_vendor = A["vendor"] == B["vendor"]
            if same_vendor:
                c.update(verdict="contradicts-lineage", comment=f"{A['displayName']} and {B['displayName']} are different lines of {A['vendor']} ({A['family']} vs {B['family']}); no ancestor path")
            else:
                c.update(verdict="contradicts-lineage", comment=f"different vendors ({A['vendor']} vs {B['vendor']}); no ancestor path")
    checks.append(c)

# lineage-derived edges among roster species (nearest mapped descendant)
edges = []
for rid, sid in rec2sp.items():
    stack = list(children[rid])
    found = []
    via_map = {c: [c] for c in stack}
    while stack:
        c = stack.pop(0)
        if c in rec2sp:
            found.append((c, via_map[c]))
            continue
        for g in children[c]:
            via_map[g] = via_map[c] + [g]
            stack.append(g)
    for c, via in found:
        inter = [recs[x]["displayName"] for x in via[:-1]]
        rel = [recs[x]["relation"] for x in via]
        bas = [recs[x]["parentBasis"] for x in via]
        conf = "high" if all(b in ("official", "reported") for b in bas) else ("medium" if any(b in ("official", "reported") for b in bas) else "series-only")
        edges.append({"from": sid, "to": rec2sp[c], "fromRecord": rid, "toRecord": c, "hops": len(via), "intermediateModels": inter, "relations": rel, "parentBasis": bas, "confidence": conf})

roster_edges = {(c["from"], c["to"]) for c in checks}
for e in edges:
    e["inRosterAlready"] = (e["from"], e["to"]) in roster_edges

# extensions: roster species at the tail of a lineage whose line has newer unmapped descendants
ext = []
for rid, sid in rec2sp.items():
    st = list(children[rid])
    desc = []
    while st:
        c = st.pop(0)
        if c in rec2sp:
            continue
        desc.append(c)
        st += children[c]
    if desc:
        newest = sorted(desc, key=lambda x: recs[x]["releaseDate"] or recs[x]["releaseMonth"] or "")[-3:]
        ext.append({"speciesId": sid, "record": rid, "unmappedDescendants": len(desc), "newestUnmapped": [{"id": x, "displayName": recs[x]["displayName"], "releaseDate": recs[x]["releaseDate"]} for x in newest]})

# roster vs lineage discrepancies (date, category)
import datetime


def to_date(x):
    return datetime.date.fromisoformat(x) if x and len(x) == 10 else None


def date_gap(rd, d):
    """None when compatible; else days apart (month precision compares months)."""
    if not rd or not d or rd == "TBD":
        return None
    if len(rd) == 7 or len(d) == 7:
        return None if rd[:7] == d[:7] else 99
    return abs((to_date(rd) - to_date(d)).days)


disc = []
for sid, rid in smap.items():
    s, r = sp[sid], recs[rid]
    rd = s.get("releaseDate")
    item = {"species": sid, "record": rid}
    flags = []
    chain_dates = []
    cur = rid
    while cur:
        chain_dates.append((recs[cur]["releaseDate"] or recs[cur]["releaseMonth"], cur))
        cur = recs[cur]["parent"]
    raw = [(date_gap(rd, d), cid) for d, cid in chain_dates if d]
    compatible = any(g is None or g == 0 for g, _ in raw)
    gaps = [(g, cid) for g, cid in raw if g is not None]
    if gaps and not compatible:
        best = min(gaps)
        flags.append({"field": "releaseDate", "roster": rd, "lineage": recs[best[1]]["releaseDate"] or recs[best[1]]["releaseMonth"], "lineageRecord": best[1], "daysApart": best[0], "severity": "minor (<=2 days: timezone/listing)" if best[0] <= 2 else "major", "sourceCheck": recs[best[1]]["sourceCheck"]})
    allowed = CATMAP.get(s["category"])
    if allowed is not None and r["category"] not in allowed:
        flags.append({"field": "category", "roster": s["category"], "lineage": r["category"], "basis": r["categoryBasis"]})
    if flags:
        item["flags"] = flags
        disc.append(item)

proposal = {
    "generatedAt": lin["generatedAt"],
    "semantics": {
        "chainStage": "depth in the lineage parent chain (1 = root). Replaces the old 'generation' column and maps to the game's stage.",
        "relation": "post-train / distill need an official or reported source; successor = direct technical continuation; series-successor = next version of the same product line, no weights claim.",
    },
    "rosterChainChecks": checks,
    "rosterChainSummary": dict(collections.Counter(c["verdict"] for c in checks)),
    "lineageEdgesBetweenRosterSpecies": edges,
    "lineageExtensions": ext,
    "rosterDiscrepancies": disc,
}
json.dump(proposal, open(ROOT + "/evolution-proposals.json", "w"), ensure_ascii=False, indent=1)
print("missing", len(items), "diverse", len(diverse), "checks", dict(collections.Counter(c["verdict"] for c in checks)), "edges", len(edges), "ext", len(ext), "disc", len(disc))
