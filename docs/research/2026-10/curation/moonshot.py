VENDOR = {
    "key": "moonshot",
    "name": "Moonshot AI (Kimi)",
    "nameZh": "月之暗面 Moonshot AI / Kimi",
    "country": "CN",
    "homepage": "https://www.moonshot.ai",
    "officialModelListUrl": "https://platform.kimi.ai/docs/models",
    "changelogUrl": "https://platform.kimi.ai/docs/updates",
    "notes": "Dates from models.dev/OpenRouter plus secondary reporting for K2.8 / K3.",
}
K28 = "https://letsdatascience.com/news/moonshot-deploys-kimi-k28-preview-to-coding-tools-0d15f07f"
K3 = "https://www.firecrawl.dev/blog/kimi-k3"

LINES = [
    {
        "family": "kimi",
        "category": "llm",
        "chain": ["kimichat", "kimik15", "kimik2", "kimik2thinking", "kimik25", "kimik26", "kimik3"],
    },
    {"family": "kimi", "category": "code", "chain": ["kimik26", "kimik27code", "kimik28preview"]},
    {"family": "kimi", "category": "llm", "chain": ["kimik2", "k20905"]},
]

R = {
    "kimik2": {"displayName": "Kimi K2", "releaseDate": "2025-07-11", "ow": True, "notes": "1T-param MoE (32B active); OpenRouter moonshotai/kimi-k2 = 0711."},
    "k20905": {"displayName": "Kimi K2 0905", "releaseDate": "2025-09-05", "releaseDateBasis": "catalog", "sc": "catalog", "sources": ["https://openrouter.ai/moonshotai/kimi-k2-0905"], "ow": True, "relation": "post-train", "basis": "reported", "notes": "Updated K2 instruct snapshot (OpenRouter id moonshotai/kimi-k2-0905, listed 2025-09-04)."},
    "kimik2thinking": {"displayName": "Kimi K2 Thinking", "releaseDate": "2025-11-06", "category": "reasoning", "ow": True, "relation": "post-train", "basis": "reported", "parent": "kimik2"},
    "kimik25": {"displayName": "Kimi K2.5", "releaseDate": "2026-01-27", "ow": True, "relation": "successor", "basis": "reported", "notes": "Native multimodal; reported as continued pre-training on K2-Base (not re-verified)."},
    "kimik26": {"displayName": "Kimi K2.6", "releaseDate": "2026-04-21", "ow": True, "notes": "models.dev 2026-04-21; OpenRouter 2026-04-20."},
    "kimik27code": {"displayName": "Kimi K2.7 Code", "releaseDate": "2026-06-12", "ow": True, "category": "code", "notes": "Coding-specialised; 'HighSpeed' serving variant not recorded."},
    "kimik3": {
        "displayName": "Kimi K3",
        "releaseDate": "2026-07-16",
        "sc": "secondary",
        "sources": [K3, "https://openrouter.ai/moonshotai/kimi-k3"],
        "releaseDateBasis": "secondary",
        "ow": True,
        "parent": "kimik26",
        "relation": "series-successor",
        "basis": "inferred-series",
        "notes": "API 2026-07-16, weights 2026-07-27 (custom Kimi K3 License). 2.8T-param MoE, 104B active, 1M context, native image/video input.",
    },
    "kimik28preview": {
        "displayName": "Kimi K2.8 Preview",
        "releaseDate": "2026-09-11",
        "sc": "secondary",
        "sources": [K28],
        "releaseDateBasis": "secondary",
        "ow": False,
        "category": "code",
        "status": "preview",
        "notes": "Behind the kimi-for-coding alias in Kimi Code since 2026-09-11; performance 'close to K3'; no Hugging Face weights or license.",
    },
}

EXTRA = {
    "kimichat": {"displayName": "Kimi Chat", "releaseMonth": "2023-10", "releaseDate": None, "sc": "background", "sources": ["https://kimi.moonshot.cn/"], "ow": False, "notes": "Consumer assistant launched Oct 2023 (long-context 200K); day not verified."},
    "kimik15": {"displayName": "Kimi k1.5", "releaseDate": "2025-01-20", "sc": "background", "sources": ["https://github.com/MoonshotAI/Kimi-k1.5"], "ow": False, "category": "reasoning", "notes": "Reasoning model announced same day as DeepSeek-R1."},
}

SPECIES = {
    "kimi-chat": "kimichat",
    "kimi-k2": "kimik2",
    "kimi-k3": "kimik3",
}

IGNORE = {"kimik27codehighspeed"}

EXCLUDED = ["Kimi K2.7 Code HighSpeed (serving variant), Kimi-VL / Kimi-Audio / Kimi Linear research releases, Kimi Work/Code products (see products.py)."]

GAPS = ["K1.5/K2.5/K2.6 official pages not opened; Kimi Chat exact launch date unverified."]


# roster product record
LINES.append({"family": 'kimi-work', "category": 'agent', "chain": ['kimiwork']})
EXTRA['kimiwork'] = {'displayName': 'Kimi Work / Kimi Code', 'releaseDate': '', 'sc': 'background', 'sources': ['https://www.kimi.com'], 'ow': False, 'catbasis': 'desktop multi-agent and terminal coding agent products (roster description)', 'notes': 'Product record for a roster entry; date from the roster, not verified (search budget exhausted). Desktop multi-agent Kimi Work plus the terminal Kimi Code agent; Kimi Claw 2026-02-16.', 'releaseMonth': '2026-06'}
SPECIES['kimi-work'] = 'kimiwork'
