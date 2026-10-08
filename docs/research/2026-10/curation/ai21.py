VENDOR = {"key": "ai21", "name": "AI21 Labs", "nameZh": "AI21 Labs", "country": "IL", "homepage": "https://www.ai21.com", "officialModelListUrl": "https://docs.ai21.com/docs/jamba-foundation-models", "changelogUrl": "https://www.ai21.com/blog", "notes": "Prior research listed Jamba2 on 2026-01-08 (not re-verified here)."}
LINES = [
    {"family": "jamba", "category": "llm", "chain": ["jamba10", "jamba15large", "jambalarge"]},
    {"family": "jamba", "category": "llm", "chain": ["jambamini"]},
]
R = {
    "jambalarge": {"displayName": "Jamba Large", "releaseDate": "2025-07-01", "ow": True, "notes": "models.dev date; latest Large version name not confirmed (likely Jamba Large 1.7)."},
    "jambamini": {"displayName": "Jamba Mini", "releaseDate": None, "ow": True, "notes": "models.dev date 2026-01-01 looks like a placeholder; prior research mentions Jamba2 on 2026-01-08 (unverified)."},
}
EXTRA = {
    "jamba10": {"displayName": "Jamba", "releaseDate": "2024-03-28", "sc": "background", "sources": ["https://huggingface.co/ai21labs/Jamba-v0.1"], "ow": True, "notes": "First production Mamba-Transformer hybrid."},
    "jamba15large": {"displayName": "Jamba 1.5 Large", "releaseDate": "2024-08-22", "sc": "background", "sources": ["https://www.ai21.com/blog/announcing-jamba-model-family"], "ow": True},
}
SPECIES = {}
IGNORE = set()
EXCLUDED = []
GAPS = ["Jamba2 (2026-01) existence and relation not verified; Jamba Mini date unknown."]
