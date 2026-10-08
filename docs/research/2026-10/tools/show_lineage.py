import json, sys
d = json.load(open('lineage.json'))
v = sys.argv[1] if len(sys.argv) > 1 else None
for r in d['records']:
    if v and r['vendor'] != v:
        continue
    par = (r['parent'] or '-').split('/')[-1]
    print(f"{r['family'][:14]:14} s{r['chainStage']} {r['id'].split('/')[-1][:34]:34} {r['category'][:8]:8} {r['releaseDate'] or r['releaseMonth'] or '?':10} <- {par[:26]:26} {r['relation'] or ''} {('['+r['gameSpeciesId']+']') if r['gameSpeciesId'] else ''}")
