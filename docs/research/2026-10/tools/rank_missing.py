"""Rank lineage records that are absent from the game roster by a transparent notability score.

score = reach + flagship + recency + vendor + fame
  reach    : 0.4 * models.dev providers hosting it (cap 25) + 3 if on OpenRouter
  flagship : +4 when it is the newest current record of its (vendor, family)
  recency  : +3 released >= 2026-06, +2 for 2026-01..05, +1 for 2025
  vendor   : +2 for the top-tier vendor set
  fame     : hand-assigned landmark bonus (FAME) for historically important models
usage: python3 rank_missing.py <research-dir> [json]
"""
import collections
import json
import sys

ROOT = sys.argv[1]
d = json.load(open(ROOT + "/lineage.json"))
recs = d["records"]
TOP = {"openai", "anthropic", "google", "xai", "meta", "deepseek", "alibaba", "moonshot", "zhipu", "minimax", "bytedance", "mistral", "tencent", "nvidia"}
FAME = json.load(open(ROOT + "/tools/fame.json"))

newest = {}
for r in recs:
    k = (r["vendor"], r["family"])
    if r["status"] in ("current", "preview") and r["releaseDate"]:
        if k not in newest or r["releaseDate"] > newest[k][0]:
            newest[k] = (r["releaseDate"], r["id"])

rows = []
for r in recs:
    if r["gameSpeciesId"]:
        continue
    reach = r.get("catalogReach") or {}
    s = 0.4 * min(reach.get("modelsDevProviders", 0), 25) + (3 if reach.get("openrouter") else 0)
    why = []
    if newest.get((r["vendor"], r["family"]), (0, 0))[1] == r["id"]:
        s += 4
        why.append("newest in its line")
    dt = r["releaseDate"] or (r["releaseMonth"] + "-15" if r["releaseMonth"] else "")
    if dt >= "2026-06":
        s += 3
    elif dt >= "2026-01":
        s += 2
    elif dt >= "2025":
        s += 1
    if r["vendor"] in TOP:
        s += 2
    f = FAME.get(r["id"])
    if f:
        s += f["bonus"]
        why.append(f["why"])
    rows.append((round(s, 1), r, why))
rows.sort(key=lambda x: (-x[0], x[1]["id"]))
if len(sys.argv) > 2:
    json.dump([{"score": s, "id": r["id"], "why": w} for s, r, w in rows], open(sys.argv[2], "w"), indent=1)
else:
    for s, r, w in rows[:int(100)]:
        reach = r.get("catalogReach") or {}
        print(s, r["id"], r["releaseDate"] or r["releaseMonth"], r["category"], r["status"], reach.get("modelsDevProviders", "-"), ";".join(w))
