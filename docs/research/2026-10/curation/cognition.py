VENDOR = {"key": "cognition", "name": "Cognition (Devin / Windsurf)", "nameZh": "Cognition Devin / Windsurf", "country": "US", "homepage": "https://cognition.ai", "officialModelListUrl": "https://docs.devin.ai", "changelogUrl": "https://cognition.ai/blog", "notes": "Cognition acquired Windsurf in July 2025; Windsurf was renamed Devin Desktop on 2026-06-02 (Wikipedia)."}
W = "https://en.wikipedia.org/wiki/Cognition_AI"
LINES = [
    {"family": "devin", "category": "agent", "chain": ["devin"]},
    {"family": "windsurf", "category": "agent", "chain": ["windsurf", "devindesktop"]},
]
EXTRA = {
    "devin": {"displayName": "Devin", "releaseDate": "2024-03-12", "sc": "secondary", "sources": [W], "ow": False, "catbasis": "autonomous software-engineering agent product", "notes": "Demo March 2024 (day from roster); GA date not in source."},
    "windsurf": {"displayName": "Windsurf", "releaseDate": "2024-11-13", "sc": "background", "sources": [W], "ow": False, "catbasis": "agentic IDE product (Codeium)", "notes": "Windsurf Editor launch day from the roster (Codeium, Nov 2024); Cognition signed to acquire it 2025-07-14."},
    "devindesktop": {"displayName": "Devin Desktop", "releaseDate": "2026-06-02", "sc": "secondary", "sources": [W], "ow": False, "relation": "successor", "basis": "official", "catbasis": "rename of Windsurf", "notes": "Windsurf renamed Devin Desktop (announced 2026-06-02)."},
}
SPECIES = {"devin": "devin", "windsurf": "devindesktop"}
IGNORE = set()
EXCLUDED = ["SWE-1 / SWE-1.5 in-house models (not in the source)."]
GAPS = ["Roster still calls it Windsurf; the product is now Devin Desktop."]
