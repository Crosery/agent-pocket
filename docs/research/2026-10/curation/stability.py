VENDOR = {"key": "stability", "name": "Stability AI", "nameZh": "Stability AI", "country": "GB", "homepage": "https://stability.ai", "officialModelListUrl": "https://stability.ai/stable-assets", "changelogUrl": "https://stability.ai/news", "notes": "Wikipedia article carries almost no dates; most dates here are recalled from release posts and flagged background."}
W = "https://en.wikipedia.org/wiki/Stability_AI"
def e(name, date=None, month=None, notes="", **kw):
    d = {"displayName": name, "releaseDate": date, "sc": "background", "sources": [W], "ow": True, "notes": notes}
    if month:
        d["releaseMonth"] = month
    d.update(kw)
    return d
LINES = [
    {"family": "stable-diffusion", "category": "image", "chain": ["sd1", "sd2", "sdxl", "sd3", "sd35"]},
    {"family": "stable-video", "category": "video", "chain": ["svd"]},
    {"family": "stable-audio", "category": "music", "chain": ["sa1", "sa2", "sa25", "sa30"]},
]
EXTRA = {
    "sd1": e("Stable Diffusion 1.x", "2022-08-22", notes="Public weights release (with CompVis/Runway); Wikipedia: August 2022."),
    "sd2": e("Stable Diffusion 2.x", "2022-11-24"),
    "sdxl": e("SDXL 1.0", "2023-07-26"),
    "sd3": e("Stable Diffusion 3", "2024-06-12", notes="SD3 Medium weights; announced 2024-02-22."),
    "sd35": e("Stable Diffusion 3.5", "2024-10-22"),
    "svd": e("Stable Video Diffusion", "2023-11-21"),
    "sa1": e("Stable Audio", "2023-09-13", ow=False),
    "sa2": e("Stable Audio 2.0", "2024-04-03", ow=False),
    "sa25": e("Stable Audio 2.5", None, "2025-09", ow=False, notes="Provider listings 2025-10-08."),
    "sa30": e("Stable Audio 3.0", None, "2026-05", ow=False, notes="Only a single prior-research hint (2026-05-20); not verified."),
}
SPECIES = {"sd-1-5": "sd1", "sdxl": "sdxl"}
IGNORE = set()
EXCLUDED = ["Stable Audio Open (2024-06-05, open sibling), Stable Fast 3D / SPAR3D / TripoSR / SV3D / SV4D (3D), Stable Cascade, Stable LM / Stable Code."]
GAPS = ["Almost all dates recalled; Stable Audio 3.0 unverified; 2026 Stability releases not checked."]
