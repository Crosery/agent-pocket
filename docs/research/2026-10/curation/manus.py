VENDOR = {"key": "manus", "name": "Manus (Butterfly Effect)", "nameZh": "Manus 蝴蝶效应", "country": "SG", "homepage": "https://manus.im", "officialModelListUrl": "https://manus.im", "changelogUrl": "https://manus.im/blog", "notes": "HQ moved to Singapore mid-2025; Meta deal blocked by China NDRC 2026-04-27, Meta cut ties 2026-06-15, Manus independent again 2026-08-11 (Wikipedia). Manus does not train foundation models."}
W = "https://en.wikipedia.org/wiki/Manus_(AI_agent)"
LINES = [{"family": "manus", "category": "agent", "chain": ["m10", "m16", "m20"]}]
EXTRA = {
    "m10": {"displayName": "Manus", "releaseDate": "2025-03-06", "sc": "secondary", "sources": [W], "ow": False, "catbasis": "general AI agent product built on third-party models", "notes": "Invitation-only beta."},
    "m16": {"displayName": "Manus 1.6", "releaseDate": "2025-12-15", "sc": "secondary", "sources": [W], "ow": False, "catbasis": "agent product", "notes": "Stable release per Wikipedia infobox; Manus 1.5 (Oct 2025) not verified."},
    "m20": {"displayName": "Manus 2.0", "releaseMonth": "2026-09", "releaseDate": None, "sc": "background", "sources": [W], "ow": False, "catbasis": "agent product", "notes": "Roster says 2026-09-28; not in Wikipedia; unverified."},
}
SPECIES = {"manus": "m10", "manus-2": "m20"}
IGNORE = set()
EXCLUDED = []
GAPS = ["Manus 1.5 and 2.0 unverified. Version steps are product releases, not model post-training (roster says post-training)."]
