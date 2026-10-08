VENDOR = {"key": "upstage", "name": "Upstage", "nameZh": "Upstage", "country": "KR", "homepage": "https://www.upstage.ai", "officialModelListUrl": "https://console.upstage.ai/docs/capabilities/chat", "changelogUrl": "https://console.upstage.ai/docs/getting-started/changelog", "notes": "Catalog-level dates (models.dev / OpenRouter); no Upstage page opened."}
LINES = [
    {"family": "solar-pro", "category": "llm", "chain": ["solarpro2", "solarpro3", "solarpro4"]},
    {"family": "solar-mini", "category": "llm", "chain": ["solarmini", "solarmini4"]},
]
R = {
    "solarmini": {"displayName": "Solar Mini", "releaseDate": "2024-06-12", "ow": False, "notes": "Solar-mini API; 10.7B Solar open model dates from Dec 2023."},
    "solarpro2": {"displayName": "Solar Pro 2", "releaseDate": "2025-05-20", "ow": False},
    "solarpro3": {"displayName": "Solar Pro 3", "releaseDate": "2026-01-27", "ow": False, "notes": "102B-A12B MoE; models.dev lists 2026-01."},
    "solarpro4": {"displayName": "Solar Pro 4", "releaseDate": "2026-08-06", "ow": False, "notes": "524K context, agentic/office focus. Roster lists category 'agent' and 2026-08-12; catalogs say 2026-08-06 (models.dev) / 08-10 (OpenRouter) and it is a plain LLM."},
    "solarmini4": {"displayName": "Solar Mini 4", "releaseDate": "2026-09-23", "ow": False, "notes": "35B-A3B MoE, 524K context."},
}
EXTRA = {}
SPECIES = {"solar-pro": "solarpro4"}
IGNORE = set()
EXCLUDED = []
GAPS = ["Solar Pro 1 / Solar 10.7B open model not recorded."]
