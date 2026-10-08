VENDOR = {"key": "skywork", "name": "Skywork AI (Kunlun Tech)", "nameZh": "昆仑万维 天工 Skywork", "country": "CN", "homepage": "https://www.skywork.ai", "officialModelListUrl": "https://github.com/SkyworkAI", "changelogUrl": "https://github.com/SkyworkAI", "notes": "Dates for SkyReels V1-V3 come from prior research (GitHub release notes); not re-opened."}
GH = "https://github.com/SkyworkAI/SkyReels-V2"
LINES = [
    {"family": "skyreels", "category": "video", "chain": ["sr1", "sr2", "sr3", "sr4"]},
    {"family": "mureka", "category": "music", "chain": ["mureka9"]},
]
EXTRA = {
    "sr1": {"displayName": "SkyReels V1", "releaseDate": "2025-02-18", "sc": "background", "sources": [GH], "ow": True, "parentExternal": {"name": "HunyuanVideo", "vendor": "tencent", "url": GH}, "relation": "post-train", "basis": "reported", "notes": "Fine-tune of HunyuanVideo (prior research)."},
    "sr2": {"displayName": "SkyReels V2", "releaseDate": "2025-04-21", "sc": "background", "sources": [GH], "ow": True},
    "sr3": {"displayName": "SkyReels V3", "releaseDate": "2026-01-29", "sc": "background", "sources": [GH], "ow": None},
    "sr4": {"displayName": "SkyReels V4", "releaseMonth": "2026-03", "releaseDate": None, "sc": "background", "sources": [GH], "ow": None, "notes": "Roster/prior research: 2026-03."},
    "mureka9": {"displayName": "Mureka V9", "releaseMonth": "2026-03", "releaseDate": None, "sc": "background", "sources": ["https://www.mureka.ai"], "ow": False, "notes": "Roster/prior research: 2026-03; earlier Mureka versions not recorded."},
}
SPECIES = {"skyreels": "sr4", "mureka": "mureka9"}
IGNORE = set()
EXCLUDED = ["Skywork-OR1 / R1V / Matrix-Game / Matrix-3D lines."]
GAPS = ["Unverified beyond prior research."]
