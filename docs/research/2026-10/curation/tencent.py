VENDOR = {
    "key": "tencent",
    "name": "Tencent (Hunyuan / Hy)",
    "nameZh": "腾讯 混元 Hunyuan / Hy",
    "country": "CN",
    "homepage": "https://hy.tencent.com",
    "officialModelListUrl": "https://cloud.tencent.com/document/product/1729/104753",
    "changelogUrl": "https://github.com/Tencent-Hunyuan",
    "notes": "International branding 'Hy' since 2026, Chinese market keeps 混元/Hunyuan. OpenRouter lists tencent/hy3-preview, hy3, hy4-preview, hy-mt2-*.",
}
HY = "https://en.wikipedia.org/wiki/Tencent_Hy"
HY4 = "https://www.eesel.ai/blog/tencent-hy4"
HY4B = "https://intuitionlabs.ai/articles/tencent-hy4-preview-analysis"
LIN = "https://presenc.ai/research/tencent-hunyuan-model-lineage-2026"
WORLD = "https://explainx.ai/blog/tencent-hunyuan-hy-world-2-world-mirror-3d-world-model-2026"
D3 = "https://www.tencent.com/tencent-announces-global-launch-of-hunyuan-3d-engine-to-empower-creators-with-advanced-creation-tools/"

LINES = [
    {"family": "hunyuan", "category": "llm", "src": [HY], "chain": ["hunyuan", "hunyuanlarge", "hunyuanturbos", "hunyuant1", "hunyuan20instruct", "hy3preview", "hy3", "hy4preview"]},
    {"family": "hunyuan-open", "category": "llm", "chain": ["hunyuanlarge", "hunyuana13binstruct"], "tags": ["open-weights"]},
    {"family": "hunyuan-mt", "category": "llm", "tags": ["translate"], "chain": ["hymt230ba3b"]},
    {"family": "hunyuan-image", "category": "image", "chain": ["hunyuanimage21", "hunyuanimage30", "hunyuanimage35"]},
    {"family": "hunyuan-video", "category": "video", "chain": ["hunyuanvideo", "hunyuanvideo15"]},
    {"family": "hunyuan-3d", "category": "3d", "chain": ["hunyuan3d20", "hunyuan3d31"]},
    {"family": "hunyuan-world", "category": "world", "chain": ["hunyuanworld10", "hunyuanworld15", "hyworld20"]},
]

R = {
    "hunyuanturbos": {"displayName": "Hunyuan-TurboS", "releaseMonth": "2025-02", "releaseDate": None, "releaseDateBasis": None, "sc": "background", "sources": ["https://cloud.tencent.com/document/product/1729/104753"], "ow": False, "notes": "Fast-thinking flagship (Feb 2025); catalog date 2026-03-08 is the Tencent coding-plan listing."},
    "hunyuant1": {"displayName": "Hunyuan-T1", "releaseDate": "2025-03-21", "releaseDateBasis": "background", "sc": "background", "sources": ["https://cloud.tencent.com/document/product/1729/104753"], "category": "reasoning", "ow": False, "relation": "post-train", "basis": "reported", "notes": "Reasoning model post-trained from TurboS (reported); date from memory."},
    "hunyuan20instruct": {"displayName": "Hunyuan 2.0 (HY 2.0)", "releaseMonth": "2025-12", "releaseDate": None, "releaseDateBasis": None, "sc": "catalog", "sources": ["https://models.dev/"], "ow": False, "notes": "Instruct and Think variants; models.dev lists 2026-03-08 (provider listing date), true release month unverified."},
    "hy3preview": {"displayName": "Hy3-preview", "releaseDate": "2026-04-20", "sc": "secondary", "sources": [LIN, HY], "releaseDateBasis": "catalog", "ow": True, "status": "superseded", "notes": "295B-A21B MoE, 256K context; first model on Tencent's rebuilt pre-training/RL stack. Dates: 04-20 (models.dev), 04-22 (OpenRouter), 04-23 (secondary); Hy Community License."},
    "hy3": {"displayName": "Hy3", "releaseDate": "2026-07-06", "sc": "secondary", "sources": [HY4, HY], "releaseDateBasis": "secondary", "ow": True, "notes": "Full release 2026-07-06; Apache 2.0 (reported)."},
    "hy4preview": {
        "displayName": "Hy4-preview",
        "releaseDate": "2026-08-28",
        "sc": "secondary",
        "sources": [HY4, HY4B, "https://finance.biggo.com/news/439ad16c-57ce-4efc-bfd0-83f079cfdc9c"],
        "releaseDateBasis": "secondary",
        "ow": True,
        "status": "preview",
        "notes": "Newest Hunyuan model: 770B-A49B MoE, >1M context, Apache 2.0; launched in WorkBuddy, CodeBuddy, Yuanbao, ima; API on TokenHub/OpenRouter. Tencent labels it a preview.",
    },
    "hunyuana13binstruct": {"displayName": "Hunyuan-A13B", "releaseDate": "2025-06-27", "releaseDateBasis": "background", "sc": "background", "sources": ["https://github.com/Tencent-Hunyuan/Hunyuan-A13B"], "ow": True, "relation": "series-successor", "basis": "inferred-series", "notes": "80B-A13B MoE open weights (OpenRouter lists 2025-07-08)."},
    "hymt230ba3b": {"displayName": "Hy-MT2", "releaseDate": "2026-08-20", "releaseDateBasis": "catalog", "ow": True, "category": "llm", "catbasis": "translation LANGUAGE model (text->text); not an image model", "notes": "1.8B / 7B / 30B-A3B sizes listed by OpenRouter 2026-08-19/20; models.dev also lists Hy-MT2 Lite/Plus/Pro (cloud) from May/June 2026."},
}

EXTRA = {
    "hunyuan": {"displayName": "Hunyuan (混元)", "releaseDate": "2023-09-07", "sc": "background", "sources": [HY], "ow": False, "notes": "Launched at Tencent Global Digital Ecosystem Summit (roster date); not re-verified."},
    "hunyuanlarge": {"displayName": "Hunyuan-Large", "releaseDate": "2024-11-05", "sc": "background", "sources": ["https://github.com/Tencent/Tencent-Hunyuan-Large"], "ow": True, "notes": "389B-A52B MoE open weights."},
    "hunyuanimage21": {"displayName": "HunyuanImage 2.1", "releaseDate": "2025-09-09", "sc": "background", "sources": ["https://github.com/Tencent-Hunyuan/HunyuanImage-2.1"], "ow": True, "catbasis": "text-to-image"},
    "hunyuanimage30": {"displayName": "HunyuanImage 3.0", "releaseDate": "2025-09-28", "sc": "background", "sources": ["https://github.com/Tencent-Hunyuan/HunyuanImage-3.0"], "ow": True, "notes": "Native multimodal image generation, 80B MoE; 3.0-Instruct followed 2026-01-29."},
    "hunyuanimage35": {
        "displayName": "HunyuanImage 3.5",
        "releaseDate": "2026-09-22",
        "sc": "secondary",
        "sources": ["https://baike.baidu.com/en/item/Tencent%20HY/1450766"],
        "releaseDateBasis": "secondary",
        "ow": False,
        "status": "preview",
        "catbasis": "text-to-image / image-to-image / multi-turn (Hy Image3.5 preview)",
        "notes": "Date 2026-09-22 from a Baike entry (single weak source); roster says 2026-09-24. Unverified.",
    },
    "hunyuanvideo": {"displayName": "HunyuanVideo", "releaseDate": "2024-12-03", "sc": "background", "sources": ["https://github.com/Tencent-Hunyuan/HunyuanVideo"], "ow": True, "catbasis": "text-to-video, 13B open weights"},
    "hunyuanvideo15": {"displayName": "HunyuanVideo 1.5", "releaseMonth": "2025-11", "releaseDate": None, "sc": "secondary", "sources": [LIN], "ow": True, "notes": "Lightweight DiT video model, Nov 2025 (reported)."},
    "hunyuan3d20": {"displayName": "Hunyuan3D 2.0", "releaseDate": "2025-01-21", "sc": "background", "sources": ["https://github.com/Tencent-Hunyuan/Hunyuan3D-2"], "ow": True, "catbasis": "3D asset generation"},
    "hunyuan3d31": {"displayName": "Hunyuan3D 3.1", "releaseMonth": "2026-02", "releaseDate": None, "sc": "secondary", "sources": ["https://www.vset3d.com/hunyuan-3d-3-1-international-version/", D3], "ow": False, "notes": "International version article Feb 2026; global Hunyuan 3D engine launch 2025-11-25."},
    "hunyuanworld10": {"displayName": "HunyuanWorld 1.0", "releaseDate": "2025-07-26", "sc": "background", "sources": ["https://github.com/Tencent-Hunyuan/HunyuanWorld-1.0"], "ow": True, "catbasis": "3D world generation from text/pixels"},
    "hunyuanworld15": {"displayName": "HunyuanWorld 1.5 (WorldPlay)", "releaseDate": "2025-12-18", "sc": "secondary", "sources": [WORLD], "ow": True, "notes": "HunyuanWorld 1.1 (WorldMirror) 2025-10-22 sits between 1.0 and 1.5."},
    "hyworld20": {"displayName": "HY-World 2.0", "releaseDate": "2026-04-16", "sc": "secondary", "sources": [WORLD], "ow": True, "notes": "Open part so far: WorldMirror 2.0 (~1.2B)."},
}

SPECIES = {
    "hunyuan": "hunyuan",
    "hy3": "hy3",
    "hy4": "hy4preview",
    "hunyuan-image": "hunyuanimage35",
}

IGNORE = {"hymt27b", "hymt218b", "kimik25", "glm5", "minimaxm25", "hunyuan20thinking"}

EXCLUDED = [
    "Hy-MT2 7B / 1.8B (collapsed into Hy-MT2), Hy-MT2 cloud Lite/Plus/Pro tiers, HY-1.8B-2Bit (2026-02-10), FP8 builds, Hunyuan-TurboS older snapshots, HunyuanOCR, WorldClaw (2026-08-11; one unverified source claims it runs on Claude Opus 4.8).",
]

GAPS = [
    "No official tencent.com/hy.tencent.com page was fetched; Hy3/Hy4 dates rely on secondary articles + OpenRouter/models.dev.",
    "HunyuanImage 3.5 date conflict (09-22 vs roster 09-24); Hunyuan 2.0 true release month; HunyuanVideo 1.5 / Hunyuan3D 3.1 exact days.",
    "Hy3-preview exact date: 04-20 / 04-22 / 04-23 across sources.",
]


# roster product record
LINES.append({"family": 'yuanbao', "category": 'agent', "chain": ['yuanbao']})
EXTRA['yuanbao'] = {'displayName': 'Tencent Yuanbao', 'releaseDate': '2024-05-30', 'sc': 'background', 'sources': ['https://yuanbao.tencent.com'], 'ow': False, 'catbasis': 'consumer AI assistant app (roster description)', 'notes': 'Product record for a roster entry; date from the roster, not verified (search budget exhausted). WeChat-based assistant running Hunyuan plus DeepSeek.'}
SPECIES['yuanbao'] = 'yuanbao'


# roster product record
LINES.append({"family": 'workbuddy', "category": 'agent', "chain": ['workbuddy']})
EXTRA['workbuddy'] = {'displayName': 'WorkBuddy', 'releaseDate': '2026-03-09', 'sc': 'background', 'sources': ['https://www.codebuddy.cn'], 'ow': False, 'catbasis': 'desktop office agent product (roster description)', 'notes': 'Product record for a roster entry; date from the roster, not verified (search budget exhausted). Desktop office agent (OpenClaw-compatible), can switch between Hy3, Hy4 preview and DeepSeek; QClaw shut down 2026-09-24 (roster).'}
SPECIES['workbuddy'] = 'workbuddy'
