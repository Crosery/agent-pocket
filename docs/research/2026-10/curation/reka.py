VENDOR = {"key": "reka", "name": "Reka AI", "nameZh": "Reka AI", "country": "US", "homepage": "https://reka.ai", "officialModelListUrl": "https://docs.reka.ai", "changelogUrl": "https://reka.ai/news", "notes": "Catalog-level only."}
LINES = [
    {"family": "reka-flash", "category": "llm", "chain": ["rekaflash3"]},
    {"family": "reka-edge", "category": "vision-language", "chain": ["rekaedge"]},
]
R = {"rekaflash3": {"displayName": "Reka Flash 3", "releaseDate": "2025-03-12", "ow": True, "notes": "21B open reasoning-capable LLM."}, "rekaedge": {"displayName": "Reka Edge", "releaseDate": "2026-03-20", "ow": None, "catbasis": "OpenRouter: 7B image/video+text to text"}}
EXTRA = {}
SPECIES = {}
IGNORE = set()
EXCLUDED = []
GAPS = ["Reka Core/Flash 1-2 not recorded."]
