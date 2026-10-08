VENDOR = {"key": "nous", "name": "Nous Research", "nameZh": "Nous Research", "country": "US", "homepage": "https://nousresearch.com", "officialModelListUrl": "https://huggingface.co/NousResearch", "changelogUrl": "https://nousresearch.com/news", "notes": "Hermes models are post-trains of other labs' open weights."}
LINES = [
    {"family": "hermes", "category": "llm", "chain": ["hermes3llama31405b", "hermes4405b"]},
    {"family": "hermes-agent", "category": "agent", "chain": ["hermesagent"]},
]
R = {
    "hermes3llama31405b": {"displayName": "Hermes 3 405B", "releaseDate": "2024-08-16", "ow": True, "parentExternal": {"name": "Llama 3.1 405B", "vendor": "meta", "url": "https://openrouter.ai/nousresearch/hermes-3-llama-3.1-405b"}, "relation": "post-train", "basis": "official", "notes": "Fine-tune of Llama 3.1 405B; 70B sibling dropped. OpenRouter listing date."},
    "hermes4405b": {"displayName": "Hermes 4 405B", "releaseDate": "2025-08-26", "ow": True, "parentExternal": {"name": "Llama 3.1 405B", "vendor": "meta", "url": "https://openrouter.ai/nousresearch/hermes-4-405b"}, "relation": "post-train", "basis": "official", "notes": "Hybrid-reasoning post-train of Llama 3.1 405B (OpenRouter description); parent shown is Hermes 3."},
}
EXTRA = {
    "hermesagent": {"displayName": "Hermes Agent", "releaseMonth": "2026-03", "releaseDate": None, "sc": "background", "sources": ["https://nousresearch.com"], "ow": True, "catbasis": "open-source agent framework/product (roster description)", "notes": "Roster says 2026-03-12; not verified (Wikipedia page for Nous Research returned 404, search budget exhausted)."},
}
SPECIES = {"hermes-agent": "hermesagent"}
IGNORE = {"hermes3llama3170b"}
EXCLUDED = ["Hermes 3 70B (size sibling), Hermes 2 and Hermes 4.x point releases."]
GAPS = ["Hermes Agent date and nature unverified; Hermes 4 14B/70B and later 4.x not recorded."]
