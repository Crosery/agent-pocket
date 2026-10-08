VENDOR = {"key": "anysphere", "name": "Anysphere (Cursor)", "nameZh": "Anysphere Cursor", "country": "US", "homepage": "https://cursor.com", "officialModelListUrl": "https://cursor.com/docs/models", "changelogUrl": "https://cursor.com/changelog", "notes": "SpaceX exercised its Cursor option 2026-06-16; deal closed 2026-08-14 and Cursor is being integrated into SpaceXAI (Wikipedia)."}
W = "https://en.wikipedia.org/wiki/Cursor_(code_editor)"
LINES = [
    {"family": "cursor", "category": "agent", "chain": ["cursor", "cursor2"]},
    {"family": "composer", "category": "code", "chain": ["composer", "composer2"]},
]
EXTRA = {
    "cursor": {"displayName": "Cursor", "releaseMonth": "2023-03", "releaseDate": None, "sc": "background", "sources": [W], "ow": False, "catbasis": "AI code editor/agent product", "notes": "Roster: 2023-03."},
    "cursor2": {"displayName": "Cursor 2.0", "releaseDate": "2025-10-29", "sc": "secondary", "sources": [W], "ow": False, "catbasis": "AI code editor/agent product", "notes": "Parallel agents; shipped with Composer. Cloud Agents followed 2025-10-30."},
    "composer": {"displayName": "Cursor Composer", "releaseDate": "2025-10-29", "sc": "secondary", "sources": [W], "ow": False, "notes": "First in-house coding model, introduced with Cursor 2.0."},
    "composer2": {"displayName": "Cursor Composer 2", "releaseMonth": "2026-03", "releaseDate": None, "sc": "secondary", "sources": [W], "ow": False, "parentExternal": {"name": "Kimi K2.5", "vendor": "moonshot", "url": W}, "relation": "post-train", "basis": "reported", "notes": "Built on Moonshot's open-weights Kimi K2.5; Cursor says ~1/4 of final-model compute came from the base. Parent shown is Composer; the weights base is Kimi K2.5."},
}
SPECIES = {"cursor": "cursor2"}
IGNORE = set()
EXCLUDED = ["Bugbot, Cursor CLI/Web agents, Supermaven."]
GAPS = ["Wikipedia flags LLM-generated text; Composer 2 day unknown. Roster 'cursor' (2023-03) is the product, mapped to the latest version."]
