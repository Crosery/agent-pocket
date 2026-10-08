VENDOR = {
    "key": "xiaomi",
    "name": "Xiaomi (MiMo)",
    "nameZh": "小米 MiMo",
    "country": "CN",
    "homepage": "https://mimo.xiaomi.com",
    "officialModelListUrl": "https://mimo.xiaomi.com",
    "changelogUrl": "https://mimo.mi.com/docs/en-US/news/latest/v2-6",
    "notes": "MiMo-V2.6 official release note (mimo.mi.com) is dated 2026-09-22.",
}
V26 = "https://mimo.mi.com/docs/en-US/news/latest/v2-6"
V26B = "https://technode.com/2026/09/22/xiaomi-open-sources-mimo-v2-6-models-after-scaling-reinforcement-learning/"
WIKI = "https://en.wikipedia.org/wiki/Xiaomi_MiMo"

LINES = [
    {"family": "mimo-flash", "category": "llm", "chain": ["mimo7b", "mimov2flash", "mimov26flash"]},
    {"family": "mimo-pro", "category": "llm", "chain": ["mimov2pro", "mimov25pro", "mimov26pro"]},
    {"family": "mimo-omni", "category": "llm", "tags": ["omni"], "chain": ["mimov2omni", "mimov25"]},
]

R = {
    "mimov2flash": {"displayName": "MiMo-V2-Flash", "releaseDate": "2025-12-16", "ow": True, "notes": "309B-A15B MoE, MIT; roster says 2025-12-17."},
    "mimov2pro": {"displayName": "MiMo-V2-Pro", "releaseDate": "2026-03-18", "sc": "secondary", "sources": [WIKI], "ow": False, "notes": "1T+ params (42B active), proprietary at launch; ran anonymously on OpenRouter as 'Hunter Alpha'."},
    "mimov2omni": {"displayName": "MiMo-V2-Omni", "releaseDate": "2026-03-18", "ow": False, "notes": "Proprietary omni model."},
    "mimov25": {"displayName": "MiMo-V2.5", "releaseDate": "2026-04-22", "ow": True, "notes": "Native full-modal (text/image/video/audio); open-sourced later (tracker: 2026-06-29)."},
    "mimov25pro": {"displayName": "MiMo-V2.5-Pro", "releaseDate": "2026-04-22", "ow": True},
    "mimov26flash": {
        "displayName": "MiMo-V2.6-Flash",
        "releaseDate": "2026-09-22",
        "sc": "official",
        "sources": [V26, V26B],
        "releaseDateBasis": "official",
        "ow": True,
        "notes": "Official note (update time 2026-09-22; some sources 09-21) gives no parameter counts or licence; secondary reports say ~310B-A15B, MIT, natively multimodal. Xiaomi says it outperforms V2.5-Pro; the note does not say it was trained from V2.5 weights (scaled-up RL), so the link is series-only.",
    },
    "mimov26pro": {
        "displayName": "MiMo-V2.6-Pro",
        "releaseDate": "2026-09-22",
        "sc": "official",
        "sources": [V26, V26B],
        "releaseDateBasis": "official",
        "ow": True,
        "notes": "Official note (2026-09-22) open-sources weights, tech report, RL code and environments but gives no sizes or licence; secondary reports say ~1.02T-A42B, MIT. Roster date 2026-09-21. Lineage to V2.5-Pro not stated, series-only.",
    },
}

EXTRA = {
    "mimo7b": {"displayName": "MiMo-7B", "releaseDate": "2025-04-30", "sc": "secondary", "sources": [WIKI], "ow": True, "category": "reasoning", "catbasis": "reasoning-first 7B (pretrained for reasoning)", "notes": "First MiMo, April 2025; day from roster."},
}

SPECIES = {
    "mimo-7b": "mimo7b",
    "mimo-v2-flash": "mimov2flash",
    "mimo-v2-6-pro": "mimov26pro",
}

IGNORE = {"mimov25proultraspeed", "mimov26proultraspeed"}
EXCLUDED = ["UltraSpeed serving tiers (V2.5-Pro / V2.6-Pro-UltraSpeed, claimed up to 20x faster output), MiMo-VL, MiMo-Audio, MiMo-V2.6-Distill-Qwen-9B."]
GAPS = ["MiMo-7B-RL / MiMo-VL / MiMo-Audio lines not recorded."]
