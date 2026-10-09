VENDOR = {"key": "ibm", "name": "IBM (Granite)", "nameZh": "IBM Granite", "country": "US", "homepage": "https://www.ibm.com/granite", "officialModelListUrl": "https://huggingface.co/ibm-granite", "changelogUrl": "https://www.ibm.com/new/announcements", "notes": "Catalog-level only."}
LINES = [
    {"family": "granite-4", "category": "llm", "chain": ["granite4hmicro"]},
    {"family": "granite-4", "category": "llm", "chain": ["granite4hsmall", "granite428b"]},
]
R = {
    "granite4hmicro": {"displayName": "Granite 4.0 H Micro", "releaseDate": "2025-10-02", "ow": True, "notes": "3B hybrid Mamba-Transformer."},
    "granite4hsmall": {"displayName": "Granite 4.0 H Small", "releaseDate": "2025-10-02", "ow": True},
    "granite428b": {"displayName": "Granite 4.2 8B", "releaseDate": "2026-08-31", "ow": True, "category": "reasoning", "catbasis": "OpenRouter: dense reasoning model with low/high effort modes", "notes": "OpenRouter listing date; parent shown is the previous Granite 4 dense/hybrid release (size differs)."},
}
EXTRA = {}
SPECIES = {}
IGNORE = {"granite40hmicro"}
EXCLUDED = ["Duplicate OpenRouter Granite 4.0 Micro, Granite 3.x, Granite Vision/Speech/Guardian."]
GAPS = ["Granite 4.1 and earlier lineage not recorded."]
