VENDOR = {"key": "figure", "name": "Figure AI", "nameZh": "Figure AI", "country": "US", "homepage": "https://www.figure.ai", "officialModelListUrl": "https://www.figure.ai/news", "changelogUrl": "https://www.figure.ai/news", "notes": "Robot hardware (Figure 01/02/03) and Helix VLA models."}
W = "https://en.wikipedia.org/wiki/Figure_AI"
LINES = [
    {"family": "helix", "category": "agent", "tags": ["embodied"], "chain": ["helix", "helix02", "helix25"]},
    {"family": "figure-robot", "category": "agent", "tags": ["embodied"], "chain": ["figure03"]},
]
EXTRA = {
    "helix": {"displayName": "Helix", "releaseMonth": "2025-02", "releaseDate": None, "sc": "secondary", "sources": [W], "ow": False, "catbasis": "vision-language-action model for humanoid control", "notes": "Announced early 2025 (sources from Feb 2025)."},
    "helix02": {"displayName": "Helix 02", "releaseDate": "2026-01-27", "sc": "secondary", "sources": [W], "ow": False, "catbasis": "full-body VLA model"},
    "helix25": {"displayName": "Helix 2.5", "releaseMonth": "2026-09", "releaseDate": None, "sc": "background", "sources": [W], "ow": False, "catbasis": "VLA model", "notes": "Prior research says 2026-09-17; not in Wikipedia (article covers only Helix 01-02); unverified."},
    "figure03": {"displayName": "Figure 03", "releaseDate": "2025-10-09", "sc": "secondary", "sources": [W], "ow": False, "catbasis": "humanoid robot (hardware) driven by Helix", "notes": "Company announcement 2025-10-09; Figure 04 design locked May 2026, unreleased."},
}
SPECIES = {"figure-03": "figure03"}
IGNORE = set()
EXCLUDED = ["Figure 01 (2022 prototype) and Figure 02 (Aug 2024) hardware."]
GAPS = ["Helix 2.5 unverified."]
