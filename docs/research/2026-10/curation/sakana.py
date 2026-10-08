VENDOR = {"key": "sakana", "name": "Sakana AI", "nameZh": "Sakana AI", "country": "JP", "homepage": "https://sakana.ai", "officialModelListUrl": "https://sakana.ai/fugu/", "changelogUrl": "https://sakana.ai/blog/", "notes": "Fugu is a learned multi-agent orchestration system, not a single model (OpenRouter description)."}
OR = "https://openrouter.ai/sakana/"
LINES = [
    {"family": "fugu", "category": "agent", "chain": ["fugu"]},
    {"family": "fugu-ultra", "category": "agent", "chain": ["fuguultra", "fuguultrav2"]},
    {"family": "fugu-max", "category": "agent", "chain": ["fugumax"]},
    {"family": "namazu", "category": "reasoning", "chain": ["sakananamazu"]},
]
R = {
    "fugu": {"displayName": "Sakana Fugu", "releaseDate": "2026-06-15", "ow": False, "catbasis": "learned multi-agent orchestration system (OpenRouter description)"},
    "fuguultra": {"displayName": "Fugu Ultra", "releaseDate": "2026-06-15", "ow": False, "catbasis": "higher-performance Fugu orchestration tier", "notes": "models.dev 06-15, OpenRouter 06-24."},
    "fuguultrav2": {"displayName": "Fugu Ultra v2", "releaseDate": "2026-09-11", "ow": False, "catbasis": "orchestration system"},
    "fugumax": {"displayName": "Fugu Max", "releaseDate": "2026-09-11", "ow": False, "catbasis": "cost-performance Fugu tier"},
    "sakananamazu": {"displayName": "Sakana Namazu", "releaseDate": "2026-08-03", "ow": False, "parentExternal": {"name": "Kimi K2.6", "vendor": "moonshot", "url": "https://openrouter.ai/sakana/sakana-namazu"}, "relation": "post-train", "basis": "reported", "catbasis": "Japanese-specialised reasoning LLM (OpenRouter)", "notes": "Based on Kimi K2.6 plus Japanese/business training; models.dev 08-03, OpenRouter 08-11."},
}
EXTRA = {}
SPECIES = {"sakana-fugu": "fugu"}
IGNORE = set()
EXCLUDED = ["Research artefacts (AI Scientist, Evolutionary Model Merge, ShinkaEvolve, Transformer^2)."]
GAPS = ["Fugu base release date is the models.dev listing; Sakana's own announcement not opened."]
