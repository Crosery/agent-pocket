VENDOR = {"key": "suno", "name": "Suno", "nameZh": "Suno", "country": "US", "homepage": "https://suno.com", "officialModelListUrl": "https://help.suno.com/", "changelogUrl": "https://suno.com/blog", "notes": "Version dates from the Wikipedia 'Suno AI' article (retrieved 2026-10-09)."}
W = "https://en.wikipedia.org/wiki/Suno_AI"
LINES = [{"family": "suno", "category": "music", "chain": ["v3", "v35", "v4", "v45", "v5", "v55", "v6"]}]
def e(name, date=None, month=None, notes="", **kw):
    d = {"displayName": name, "releaseDate": date, "sc": "secondary", "sources": [W], "ow": False, "notes": notes}
    if month:
        d["releaseMonth"] = month
    d.update(kw)
    return d
EXTRA = {
    "v3": e("Suno v3", "2024-03-21"),
    "v35": e("Suno v3.5", None, "2024-05", notes="Not dated in Wikipedia; May 2024 recalled."),
    "v4": e("Suno v4", "2024-11-19"),
    "v45": e("Suno v4.5", None, "2025-05", notes="v4.5-all (free) followed 2025-10-21."),
    "v5": e("Suno v5", "2025-09-23", notes="Wikipedia: September 2025 with Suno Studio; day from roster."),
    "v55": e("Suno v5.5", "2026-03-26", notes="Adds Voices, custom models, My Taste. Missing from the roster."),
    "v6": e("Suno v6", "2026-09-09", notes="v6 family: v6 (flagship), v6-wild (experimental, Pro/Premier), v6-mini (free, faster); all earlier models retired that day."),
}
SPECIES = {"suno-v3": "v35", "suno-v5": "v5", "suno-v6": "v6"}
IGNORE = set()
EXCLUDED = ["Bark (2023 open TTS), Suno Studio (2025-09-25 product, 2.0 on 2026-08-13), Speech beta (2026-10-01), v6-wild / v6-mini tiers."]
GAPS = ["v3.5 and v4.5 days not in the source."]
