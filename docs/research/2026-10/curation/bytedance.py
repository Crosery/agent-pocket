VENDOR = {
    "key": "bytedance",
    "name": "ByteDance (Seed / Doubao)",
    "nameZh": "字节跳动 Seed / 豆包",
    "country": "CN",
    "homepage": "https://seed.bytedance.com",
    "officialModelListUrl": "https://www.volcengine.com/docs/82379/1330310",
    "changelogUrl": "https://seed.bytedance.com/en/blog",
    "notes": "Seed 2.1 / Seedance 2.5 / Seedream 5.0 were announced together at Volcano Engine FORCE (late June 2026).",
}
S25 = "https://seed.bytedance.com/en/blog/one-take-creation-flexible-referencing-introducing-seedance-2-5"
S21 = "https://datanorth.ai/news/bytedance-releases-seed-2-1-pro-and-seed-2-1-turbo"
SEED = "https://techjacksolutions.com/ai-tools/bytedance-seed/what-is-bytedance-seed/"
FORCE = "https://kie.ai/blog/seedance-2-5-release-deep-dive"

LINES = [
    {"family": "doubao-seed", "category": "llm", "chain": ["doubaopro", "seed16", "seed18", "seed20pro", "seed21pro"]},
    {"family": "doubao-seed-fast", "category": "llm", "chain": ["seed16flash", "seed20lite", "seed21turbo"]},
    {"family": "doubao-seed-fast", "category": "llm", "chain": ["seed16flash", "seed20mini"]},
    {"family": "doubao-seed", "category": "code", "chain": ["seed20pro", "seed20code"]},
    {"family": "seed-vision", "category": "vision-language", "chain": ["seed16vision"]},
    {"family": "seed-oss", "category": "llm", "tags": ["open-weights"], "chain": ["seedoss36b"]},
    {"family": "seedream", "category": "image", "chain": ["seedream3", "seedream4", "seedream45", "seedream5", "seedream5pro"]},
    {"family": "seedance", "category": "video", "chain": ["seedance10", "seedance20", "seedance25"]},
    {"family": "seedance", "category": "video", "chain": ["seedance20", "seedance20mini"]},
    {"family": "seed-audio", "category": "speech-tts", "chain": ["seedaudio10"]},
]

R = {
    "seed16": {"displayName": "Doubao-Seed-1.6", "releaseDate": "2025-06-11", "releaseDateBasis": "background", "sc": "background", "sources": ["https://seed.bytedance.com/en/blog"], "ow": False, "notes": "Seed 1.6 launched at FORCE 2025-06-11 (memory); models.dev lists the 251015 snapshot."},
    "seed16flash": {"displayName": "Doubao-Seed-1.6-Flash", "releaseDate": "2025-06-11", "releaseDateBasis": "background", "sc": "background", "sources": ["https://seed.bytedance.com/en/blog"], "ow": False},
    "seed16vision": {"displayName": "Doubao-Seed-1.6-Vision", "releaseDate": "2025-08-15", "ow": False},
    "seed18": {"displayName": "Doubao-Seed-1.8", "releaseDate": "2025-12-28", "releaseDateBasis": "catalog", "ow": False, "notes": "models.dev snapshot 251228; first announced ~2025-12-18 (memory, unverified)."},
    "seed20pro": {"displayName": "Doubao-Seed-2.0 Pro", "releaseDate": "2026-02-14", "ow": False, "notes": "Seed 2.0 family: Pro / Lite / Mini / Code, models.dev 2026-02-14; roster says 2026-02-14."},
    "seed20lite": {"displayName": "Doubao-Seed-2.0 Lite", "releaseDate": "2026-02-14", "ow": False},
    "seed20mini": {"displayName": "Doubao-Seed-2.0 Mini", "releaseDate": "2026-02-14", "ow": False},
    "seed20code": {"displayName": "Doubao-Seed-2.0 Code", "releaseDate": "2026-02-14", "ow": False, "category": "code", "notes": "Preview 260215."},
    "seed21pro": {"displayName": "Doubao-Seed-2.1 Pro", "releaseDate": "2026-06-23", "sc": "secondary", "sources": [S21], "releaseDateBasis": "secondary", "ow": False, "notes": "Announced 2026-06-23/24 (FORCE); powers Doubao 2.1 Pro."},
    "seed21turbo": {"displayName": "Doubao-Seed-2.1 Turbo", "releaseDate": "2026-06-23", "sc": "secondary", "sources": [S21], "releaseDateBasis": "secondary", "ow": False, "notes": "Faster/cheaper tier; OpenRouter lists 2026-08-12."},
}

EXTRA = {
    "doubaopro": {"displayName": "Doubao (豆包) Pro", "releaseDate": "2024-05-15", "sc": "background", "sources": ["https://www.volcengine.com/product/doubao"], "ow": False, "notes": "Doubao large model family launched at Volcano Engine FORCE 2024-05-15 (roster date); not re-verified."},
    "seedoss36b": {"displayName": "Seed-OSS-36B", "releaseDate": "2025-08-20", "sc": "background", "sources": ["https://huggingface.co/ByteDance-Seed/Seed-OSS-36B-Instruct"], "ow": True, "notes": "Open-weights 36B; models.dev lists 2025-09-04."},
    "seedream3": {"displayName": "Seedream 3.0", "releaseMonth": "2025-04", "releaseDate": None, "sc": "background", "sources": ["https://seed.bytedance.com/en/seedream3_0"], "ow": False, "catbasis": "text-to-image", "notes": "Roster date 2025-04."},
    "seedream4": {"displayName": "Seedream 4.0", "releaseDate": "2025-09-09", "sc": "background", "sources": ["https://seed.bytedance.com/en/seedream4_0"], "ow": False},
    "seedream45": {"displayName": "Seedream 4.5", "releaseMonth": "2025-12", "releaseDate": None, "sc": "catalog", "sources": ["https://models.dev/"], "ow": False, "notes": "Listed in models.dev media entries; exact date not verified."},
    "seedream5": {"displayName": "Seedream 5.0", "releaseMonth": "2026-02", "releaseDate": None, "sc": "background", "sources": ["https://seed.bytedance.com/en/blog"], "ow": False, "notes": "Roster date 2026-02 (Lite / Pro / Flash tiers); day not verified."},
    "seedream5pro": {"displayName": "Seedream 5.0 Pro", "releaseDate": "2026-06-23", "sc": "secondary", "sources": [FORCE], "releaseDateBasis": "secondary", "ow": False, "notes": "Announced at FORCE (late June 2026); models.dev media entry shows 2026-07-11."},
    "seedance10": {"displayName": "Seedance 1.0", "releaseDate": "2025-06-11", "sc": "background", "sources": ["https://seed.bytedance.com/en/seedance"], "ow": False, "catbasis": "text/image-to-video"},
    "seedance20": {"displayName": "Seedance 2.0", "releaseDate": "2026-02-12", "sc": "background", "sources": [FORCE], "ow": False, "notes": "Roster date 2026-02-12; gained 4K output at FORCE June 2026 (secondary)."},
    "seedance20mini": {"displayName": "Seedance 2.0 Mini", "releaseDate": "2026-06-22", "sc": "catalog", "sources": ["https://models.dev/"], "ow": False, "notes": "models.dev media entry (~seedance-2.0-mini)."},
    "seedance25": {
        "displayName": "Seedance 2.5",
        "releaseDate": "2026-07-31",
        "sc": "official",
        "sources": [S25, FORCE],
        "releaseDateBasis": "secondary",
        "ow": False,
        "notes": "Announced late June 2026 (enterprise beta), stable rollout 2026-07-31; 30 s clips, up to 50 reference inputs; skipped 2.1-2.4.",
    },
    "seedaudio10": {"displayName": "Seed-Audio 1.0", "releaseDate": "2026-07-20", "sc": "secondary", "sources": [FORCE], "ow": False, "catbasis": "audio generation/speech (reported alongside Seedance 2.5)", "notes": "Mentioned only in a secondary article; category unverified. SeedRealtime 2026-08-05 also mentioned."},
}

SPECIES = {
    "doubao-pro": "doubaopro",
    "doubao-seed-2": "seed20pro",
    "doubao-seed-2-1": "seed21pro",
    "seedream-3": "seedream3",
    "seedream-5": "seedream5",
    "seedance-1": "seedance10",
    "seedance-2": "seedance20",
    "seedance-2-5": "seedance25",
}

IGNORE = {"uitars157b", "seedcharacter", "seedevolving"}

EXCLUDED = [
    "UI-TARS 1.5 7B (OpenRouter-only listing 2025-07-22), Seed Character and Seed Evolving (2026-06-23, specialised Seed 2.1 variants; purpose unverified), Seedance 2.0 Fast, Seedream 5.0 Lite/Flash tiers, Doubao app (see products).",
]

GAPS = [
    "Doubao 1.5 / Seed 1.5-Thinking / Seed1.5-VL, Seed-Coder, Seed Diffusion, Doubao TTS not recorded.",
    "Seed 1.8 first-announcement date, Seedream 4.5/5.0 days, Seed-Audio/SeedRealtime details unverified.",
]


# roster product record
LINES.append({"family": 'doubao-app', "category": 'agent', "chain": ['doubaoapp']})
EXTRA['doubaoapp'] = {'displayName': 'Doubao App', 'releaseDate': '', 'sc': 'background', 'sources': ['https://www.doubao.com'], 'ow': False, 'catbasis': 'consumer AI app (roster description)', 'notes': 'Product record for a roster entry; date from the roster, not verified (search budget exhausted). Consumer chatbot app; phone assistant on Nubia NaviX Ultra in Sept 2026.', 'releaseMonth': '2023-08'}
SPECIES['doubao-app'] = 'doubaoapp'


# roster product record
LINES.append({"family": 'trae', "category": 'agent', "chain": ['trae']})
EXTRA['trae'] = {'displayName': 'Trae', 'releaseDate': '', 'sc': 'background', 'sources': ['https://www.trae.ai'], 'ow': False, 'catbasis': 'AI-native IDE product (roster description)', 'notes': 'Product record for a roster entry; date from the roster, not verified (search budget exhausted). AI-native IDE, successor of Doubao MarsCode; SOLO version March 2026.', 'releaseMonth': '2025-01'}
SPECIES['trae'] = 'trae'


# roster product record
LINES.append({"family": 'coze', "category": 'agent', "chain": ['coze']})
EXTRA['coze'] = {'displayName': 'Coze', 'releaseDate': '', 'sc': 'background', 'sources': ['https://www.coze.com'], 'ow': False, 'catbasis': 'agent-building platform (roster description)', 'notes': 'Product record for a roster entry; date from the roster, not verified (search budget exhausted). Agent-building platform; Coze Studio open-sourced July 2025.', 'releaseMonth': '2024-02'}
SPECIES['coze'] = 'coze'
