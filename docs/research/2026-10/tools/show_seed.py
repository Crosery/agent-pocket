import json,sys
v=sys.argv[1]
d=json.load(open(f'seeds/{v}.json'))
for c in d['candidates']:
    ds=sorted(x for x in c['releaseDateHints'].values() if x)
    src=''.join('O' if k=='openrouter' else 'M' for k in sorted(c['releaseDateHints']))
    print(c['key'],'|',c['names'][0][:48],'|',ds[0] if ds else '?', ds[-1] if len(ds)>1 and ds[-1]!=ds[0] else '','|','OW' if c['openWeights'] else '', '|',(c['modalities'][0].split('->')[1] if c['modalities'] else ''),'|',src)
