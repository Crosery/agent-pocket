VENDOR = {"key": "poolside", "name": "Poolside", "nameZh": "Poolside", "country": "US", "homepage": "https://poolside.ai", "officialModelListUrl": "https://poolside.ai/models", "changelogUrl": "https://poolside.ai/blog", "notes": "Catalog-level only."}
LINES = [
    {"family": "laguna-xs", "category": "code", "chain": ["lagunaxs2", "lagunaxs21"]},
    {"family": "laguna-m", "category": "code", "chain": ["lagunam1"]},
    {"family": "laguna-s", "category": "code", "chain": ["lagunas21"]},
]
R = {
    "lagunaxs2": {"displayName": "Laguna XS.2", "releaseDate": "2026-04-28", "ow": True},
    "lagunaxs21": {"displayName": "Laguna XS 2.1", "releaseDate": "2026-07-02", "ow": True, "notes": "33B-A3B; OpenRouter calls it a step forward from XS.2."},
    "lagunam1": {"displayName": "Laguna M.1", "releaseDate": "2026-04-28", "ow": True},
    "lagunas21": {"displayName": "Laguna S 2.1", "releaseDate": "2026-07-21", "ow": True, "notes": "118B-A8B coding-agent model."},
}
EXTRA = {}
SPECIES = {}
IGNORE = set()
EXCLUDED = []
GAPS = ["Relation of Laguna S 2.1 to Laguna M.1 not stated."]
