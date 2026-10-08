#!/usr/bin/env python3
"""Normalise the raw OpenRouter + models.dev snapshots into per-vendor candidate seeds.

usage: make_seeds.py <research-dir>
Reads raw-openrouter.json / raw-modelsdev.json, writes seeds/<vendor>.json.
Seeds are *candidates* for verification, not final lineage records.
"""
import json, re, sys, datetime, pathlib

root = pathlib.Path(sys.argv[1])
OR = json.load(open(root / 'raw-openrouter.json'))['data']
MD = json.load(open(root / 'raw-modelsdev.json'))

OR_VENDOR = {
    'openai': 'openai', 'anthropic': 'anthropic', 'google': 'google', 'x-ai': 'xai',
    'meta': 'meta', 'meta-llama': 'meta', 'mistralai': 'mistral', 'cohere': 'cohere',
    'amazon': 'amazon', 'microsoft': 'microsoft', 'nvidia': 'nvidia',
    'deepseek': 'deepseek', 'qwen': 'alibaba', 'z-ai': 'zhipu', 'moonshotai': 'moonshot',
    'minimax': 'minimax', 'tencent': 'tencent', 'bytedance': 'bytedance', 'bytedance-seed': 'bytedance',
    'stepfun': 'stepfun', 'xiaomi': 'xiaomi', 'meituan': 'meituan', 'inclusionai': 'ant',
    'upstage': 'upstage', 'sakana': 'sakana', 'thinkingmachines': 'thinkingmachines',
    'poolside': 'poolside', 'perplexity': 'perplexity', 'ibm-granite': 'ibm', 'inception': 'inception',
    'liquid': 'liquid', 'nousresearch': 'nous', 'arcee-ai': 'arcee', 'rekaai': 'reka',
    'writer': 'writer', 'aion-labs': 'aion', 'nex-agi': 'nex', 'perceptron': 'perceptron',
    'prism-ml': 'prismml', 'apodex': 'apodex', 'dots-studio': 'dots', 'inference-net': 'inferencenet',
    'fireworks': 'fireworks',
}
MD_PROVIDER_VENDOR = {
    'anthropic': 'anthropic', 'openai': 'openai', 'google': 'google', 'xai': 'xai', 'meta': 'meta',
    'llama': 'meta', 'mistral': 'mistral', 'cohere': 'cohere', 'nova': 'amazon', 'nvidia': 'nvidia',
    'deepseek': 'deepseek', 'alibaba': 'alibaba', 'alibaba-cn': 'alibaba', 'zai': 'zhipu', 'zhipuai': 'zhipu',
    'moonshotai': 'moonshot', 'moonshotai-cn': 'moonshot', 'minimax': 'minimax', 'minimax-cn': 'minimax',
    'tencent-token-plan': 'tencent', 'tencent-tokenhub': 'tencent', 'tencent-coding-plan': 'tencent',
    'volcengine': 'bytedance', 'stepfun': 'stepfun', 'stepfun-ai': 'stepfun', 'xiaomi': 'xiaomi',
    'sensenova': 'sensetime', 'longcat': 'meituan', 'bailing': 'ant', 'sakana': 'sakana', 'upstage': 'upstage',
    'ai21': 'ai21', 'inception': 'inception', 'poolside': 'poolside', 'thinkingmachines': 'thinkingmachines',
    'perplexity': 'perplexity', 'kimi-code-plan-cn': 'moonshot', 'kimi-code-plan-global': 'moonshot',
}
CANON_ORG_VENDOR = {
    'openai': 'openai', 'anthropic': 'anthropic', 'google': 'google', 'xai': 'xai', 'meta': 'meta',
    'mistral': 'mistral', 'cohere': 'cohere', 'amazon': 'amazon', 'microsoft': 'microsoft', 'nvidia': 'nvidia',
    'deepseek': 'deepseek', 'alibaba': 'alibaba', 'zhipuai': 'zhipu', 'moonshotai': 'moonshot',
    'minimax': 'minimax', 'tencent': 'tencent', 'bytedance-seed': 'bytedance', 'bytedance': 'bytedance',
    'stepfun': 'stepfun', 'xiaomi': 'xiaomi', 'meituan': 'meituan', 'inclusionai': 'ant',
    'upstage': 'upstage', 'sakana': 'sakana', 'thinkingmachines': 'thinkingmachines', 'poolside': 'poolside',
    'ai21': 'ai21', 'inception': 'inception', 'openbmb': 'modelbest', 'quiverai': 'quiverai',
    'baidu': 'baidu', 'black-forest-labs': 'bfl', 'ibm': 'ibm',
}
# community fine-tunes / routers / rehosts / safety guards: not "official base models"
DROP_ID = re.compile(r'(:batch|:free|:nitro|:extended|:thinking|-latest$|^~|/auto|router|/free$|bodybuilder|pareto|jev-|fusion|'
                     r'-(fp8|fp4|nvfp4|awq|gguf|int4|int8|gptq)(-|$)|uncensored|abliterat|obliterat|-tee$|distilled)', re.I)
DROP_NAME = re.compile(r'\((batch|free)\)|latest|router|Uncensored|abliterat|TEE|FP8|NVFP4|AWQ|GGUF', re.I)
DROP_PREFIX = ('anthracite-org', 'gryphe', 'sao10k', 'thedrummer', 'undi95', 'mancer', 'cognitivecomputations',
               'morph', 'relace', 'openrouter', 'typesafe', 'unbiased', 'aion-labs')
DATE_SUFFIX = re.compile(r'(-\d{4}-\d{2}-\d{2}|-\d{8}|-\d{4}$|-\d{2}-\d{4}|-\d{6}$)')

def d(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.UTC).strftime('%Y-%m-%d') if ts else None

def norm_key(s):
    s = s.lower().split('/')[-1]
    s = DATE_SUFFIX.sub('', s)
    return re.sub(r'[^a-z0-9]+', '', s)

seeds = {}
def add(vendor, key, rec):
    e = seeds.setdefault(vendor, {}).setdefault(key, {
        'key': key, 'names': [], 'releaseDateHints': {}, 'openWeights': None, 'modalities': [], 'catalogIds': {}, 'deprecated': False})
    nm = rec['name']
    if nm and nm not in e['names']:
        e['names'].append(nm)
    e['releaseDateHints'][rec['src']] = rec['date']
    if rec.get('ow') is not None:
        e['openWeights'] = rec['ow'] if e['openWeights'] is None else (e['openWeights'] or rec['ow'])
    if rec.get('mod') and rec['mod'] not in e['modalities']:
        e['modalities'].append(rec['mod'])
    e['catalogIds'].setdefault(rec['src'], []).append(rec['id'])
    if rec.get('dep'):
        e['deprecated'] = True

for m in OR:
    mid = m['id']
    org = mid.split('/')[0]
    if org.startswith('~') or org in DROP_PREFIX:
        continue
    if DROP_ID.search(mid) or DROP_NAME.search(m['name']):
        continue
    v = OR_VENDOR.get(org)
    if not v:
        v = 'other'
    a = m.get('architecture', {})
    mod = '+'.join(a.get('input_modalities', [])) + '->' + '+'.join(a.get('output_modalities', []))
    add(v, norm_key(mid), {'name': m['name'], 'date': d(m.get('created')), 'src': 'openrouter', 'id': mid, 'mod': mod})

for pk, pv in MD.items():
    for mid, mm in pv['models'].items():
        canon = (mm.get('canonical_model_id') or '')
        v = MD_PROVIDER_VENDOR.get(pk)
        if not v and canon:
            v = CANON_ORG_VENDOR.get(canon.split('/')[0])
        if not v:
            continue
        # aggregator hosts of other vendors' models: attribute to the canonical owner when known
        if canon and canon.split('/')[0] in CANON_ORG_VENDOR and pk not in ('openrouter',):
            v = CANON_ORG_VENDOR[canon.split('/')[0]]
        if pk in ('nvidia', 'mistral', 'arcee', 'ambient') and not canon:
            continue
        nm = mm.get('name') or mid
        if DROP_ID.search(mid) or DROP_NAME.search(nm) or DROP_ID.search(canon):
            continue
        mod = ','.join(mm.get('modalities', {}).get('input', [])) + '->' + ','.join(mm.get('modalities', {}).get('output', []))
        key = norm_key(canon or mid)
        add(v, key, {'name': nm, 'date': mm.get('release_date'), 'src': 'modelsdev:' + pk, 'id': mid, 'mod': mod,
                     'ow': bool(mm.get('open_weights')), 'dep': mm.get('status') == 'deprecated'})

out = root / 'seeds'
out.mkdir(exist_ok=True)
for v, recs in seeds.items():
    rows = sorted(recs.values(), key=lambda r: (min([x for x in r['releaseDateHints'].values() if x] or ['9999']), r['key']))
    json.dump({'vendor': v, 'count': len(rows), 'note': 'candidates from OpenRouter+models.dev; verify against official sources',
               'candidates': rows}, open(out / f'{v}.json', 'w'), ensure_ascii=False, indent=1)
    print(v, len(rows))
