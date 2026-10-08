VENDOR = {"key": "midjourney", "name": "Midjourney", "nameZh": "Midjourney", "country": "US", "homepage": "https://www.midjourney.com", "officialModelListUrl": "https://docs.midjourney.com/hc/en-us/articles/32199405667853-Version", "changelogUrl": "https://updates.midjourney.com/", "notes": "Version dates from Wikipedia; Midjourney posts use US time, so +-1 day differences with other trackers are expected."}
W = "https://en.wikipedia.org/wiki/Midjourney"
LINES = [
    {"family": "midjourney", "category": "image", "chain": ["v1", "v2", "v3", "v4", "v5", "v51", "v52", "v6", "v61", "v7", "v8", "v81", "v82"]},
    {"family": "niji", "category": "image", "chain": ["niji", "niji5", "niji6", "niji7"]},
    {"family": "midjourney-video", "category": "video", "chain": ["videov1"]},
]
def e(name, date=None, month=None, notes="", **kw):
    d = {"displayName": name, "releaseDate": date, "sc": "secondary", "sources": [W], "ow": False, "notes": notes}
    if month:
        d["releaseMonth"] = month
    d.update(kw)
    return d
EXTRA = {
    "v1": e("Midjourney V1", None, "2022-02", "Closed beta."),
    "v2": e("Midjourney V2", "2022-04-12"),
    "v3": e("Midjourney V3", "2022-07-25"),
    "v4": e("Midjourney V4", "2022-11-05", notes="Alpha."),
    "v5": e("Midjourney V5", "2023-03-15", notes="Alpha."),
    "v51": e("Midjourney V5.1", "2023-05-03", notes="Other trackers: 2023-05-04."),
    "v52": e("Midjourney V5.2", "2023-06-22"),
    "v6": e("Midjourney V6", "2023-12-21", notes="Alpha; other trackers: 2023-12-20."),
    "v61": e("Midjourney V6.1", "2024-07-31", notes="Other trackers: 2024-07-30."),
    "v7": e("Midjourney V7", "2025-04-04", notes="Alpha; roster/other trackers say 2025-04-03 (US time)."),
    "v8": e("Midjourney V8", "2026-03-17", notes="Alpha."),
    "v81": e("Midjourney V8.1", "2026-04-14", notes="Alpha; Wikipedia infobox lists it as current stable."),
    "v82": e("Midjourney V8.2", "2026-07-24", notes="Newest version as of 2026-10-09 (listed in the Wikipedia version table; infobox lags)."),
    "niji": e("Niji", "2022-12-20", notes="Anime-tuned model made with Spellbrush."),
    "niji5": e("Niji 5", "2023-04-02"),
    "niji6": e("Niji 6", "2024-01-29"),
    "niji7": e("Niji 7", "2026-01-09"),
    "videov1": {"displayName": "Midjourney Video V1", "releaseDate": "2025-06-18", "sc": "background", "sources": ["https://updates.midjourney.com/"], "ow": False, "catbasis": "image-to-video model (recalled)", "notes": "Launch day recalled, not verified."},
}
SPECIES = {"midjourney-v5": "v5", "midjourney-v7": "v7", "midjourney-v8": "v8"}
IGNORE = set()
EXCLUDED = ["--beta/test/testp 2022 test models, style/personalisation releases."]
GAPS = ["Video V1 date recalled. Roster 'Midjourney V8 (V8.2)' mixes V8 (2026-03-17) and V8.2 (2026-07-24)."]
