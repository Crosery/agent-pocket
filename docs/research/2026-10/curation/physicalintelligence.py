VENDOR = {"key": "physicalintelligence", "name": "Physical Intelligence", "nameZh": "Physical Intelligence", "country": "US", "homepage": "https://www.physicalintelligence.company", "officialModelListUrl": "https://www.physicalintelligence.company/research", "changelogUrl": "https://www.physicalintelligence.company/blog", "notes": "Wikipedia page did not resolve (redirect to an unrelated article); dates recalled and the pi0.7 month from the roster."}
LINES = [{"family": "pi", "category": "agent", "tags": ["embodied"], "chain": ["pi0", "pi05", "pistar06", "pi07"]}]
U = "https://www.physicalintelligence.company/blog"
EXTRA = {
    "pi0": {"displayName": "pi0", "releaseDate": "2024-10-31", "sc": "background", "sources": [U], "ow": True, "catbasis": "vision-language-action robot foundation model", "notes": "Recalled; open-sourced Feb 2025."},
    "pi05": {"displayName": "pi0.5", "releaseDate": "2025-04-22", "sc": "background", "sources": [U], "ow": True, "catbasis": "VLA model with open-world generalisation"},
    "pistar06": {"displayName": "pi*0.6", "releaseDate": "2025-11-17", "sc": "background", "sources": [U], "ow": False, "catbasis": "VLA trained with RL from experience (Recap)"},
    "pi07": {"displayName": "pi0.7", "releaseMonth": "2026-04", "releaseDate": None, "sc": "background", "sources": [U], "ow": False, "catbasis": "VLA model", "notes": "Roster: 2026-04; unverified."},
}
SPECIES = {"pi-zero": "pi07"}
IGNORE = set()
EXCLUDED = ["pi0-FAST (action tokenizer variant)."]
GAPS = ["All dates recalled; pi0.7 unverified."]
