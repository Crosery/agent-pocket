VENDOR = {"key": "runway", "name": "Runway", "nameZh": "Runway", "country": "US", "homepage": "https://runwayml.com", "officialModelListUrl": "https://runwayml.com/research", "changelogUrl": "https://runwayml.com/news", "notes": "Wikipedia article lists models without dates; dates mix news-citation dates and recall."}
W = "https://en.wikipedia.org/wiki/Runway_(company)"
LINES = [
    {"family": "runway-gen", "category": "video", "chain": ["gen1", "gen2", "gen3", "gen4", "gen45"]},
    {"family": "runway-aleph", "category": "video", "chain": ["aleph", "aleph2"]},
    {"family": "runway-gwm", "category": "world", "chain": ["gwm1"]},
]
def e(name, date=None, month=None, notes="", **kw):
    d = {"displayName": name, "releaseDate": date, "sc": "secondary", "sources": [W], "ow": False, "notes": notes}
    if month:
        d["releaseMonth"] = month
    d.update(kw)
    return d
EXTRA = {
    "gen1": e("Runway Gen-1", "2023-02-06", notes="MIT Technology Review citation dated 2023-02-06."),
    "gen2": e("Runway Gen-2", "2023-03-20", notes="Verge citation dated 2023-03-20."),
    "gen3": e("Runway Gen-3 Alpha", "2024-06-17", sc="background", releaseDateBasis="background", notes="Recalled, not in Wikipedia article."),
    "gen4": e("Runway Gen-4", "2025-03-31", notes="Verge coverage dated 2025-04-01; announcement day recalled as 03-31."),
    "gen45": e("Runway Gen-4.5", "2025-12-01", sc="background", releaseDateBasis="background", notes="Date from roster/prior research (matches recall); infobox lists it as a current product."),
    "aleph": e("Runway Aleph", "2025-07-25", sc="background", releaseDateBasis="background", notes="Video editing/in-context model; date from prior research (matches recall)."),
    "aleph2": e("Runway Aleph 2.0", None, notes="Listed in the Wikipedia infobox; release date unknown."),
    "gwm1": e("Runway GWM-1", None, "2025-12", sc="background", notes="General World Model 1; December 2025 recalled, not verified.", category="world"),
}
SPECIES = {"runway": "gen45"}
IGNORE = set()
EXCLUDED = ["Gen-4 Turbo, Act-One/Act-Two, Frames, Edit Studio, Runway Dev."]
GAPS = ["Gen-3 Alpha/GWM-1 dates recalled; nothing after Gen-4.5/Aleph 2.0 verified."]
