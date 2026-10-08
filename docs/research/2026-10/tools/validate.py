import collections
import json
import sys

d = json.load(open(sys.argv[1] + "/lineage.json"))
recs = d["records"]
ids = [r["id"] for r in recs]
byid = {r["id"]: r for r in recs}
print("records", len(recs), "vendors", len(d["vendors"]))
dup = [k for k, v in collections.Counter(ids).items() if v > 1]
print("dup ids", dup)
vk = {v["key"] for v in d["vendors"]}
bad = []
for r in recs:
    if r["vendor"] not in vk:
        bad.append(("vendor", r["id"]))
    if r["parent"] and r["parent"] not in byid:
        bad.append(("parent", r["id"]))
    if not r["sources"]:
        bad.append(("nosrc", r["id"]))
    if r["category"] not in d["categoryEnum"]:
        bad.append(("cat", r["id"]))
    if r["parent"] and not r["relation"]:
        bad.append(("norel", r["id"]))
    if not r["id"].startswith(r["vendor"] + "/"):
        bad.append(("idprefix", r["id"]))
print("structural problems", bad)
inv = []
for r in recs:
    p = byid.get(r["parent"]) if r["parent"] else None
    if p and r["releaseDate"] and p["releaseDate"] and r["releaseDate"] < p["releaseDate"]:
        inv.append((r["id"], r["releaseDate"], p["id"], p["releaseDate"]))
print("child earlier than parent", len(inv))
for x in inv:
    print("  ", x)
print("no date", sum(1 for r in recs if not r["releaseDate"]), "no date and no month", sum(1 for r in recs if not r["releaseDate"] and not r["releaseMonth"]))
print("sourceCheck", dict(collections.Counter(r["sourceCheck"] for r in recs)))
print("category", dict(collections.Counter(r["category"] for r in recs)))
print("relation", dict(collections.Counter(r["relation"] for r in recs)))
print("with gameSpeciesId", sum(1 for r in recs if r["gameSpeciesId"]))
print("ids with weird chars", [i for i in ids if not all(c.isalnum() or c in "/-" for c in i)][:10])
print("long ids", [i for i in ids if len(i) > 48])
print("vendor counts", dict(sorted(collections.Counter(r["vendor"] for r in recs).items())))
