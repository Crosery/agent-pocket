VENDOR = {
    "key": "xai",
    "name": "SpaceXAI (formerly xAI)",
    "nameZh": "SpaceXAI(原 xAI)",
    "country": "US",
    "homepage": "https://x.ai",
    "officialModelListUrl": "https://docs.x.ai/docs/models",
    "changelogUrl": "https://x.ai/news",
    "notes": "SpaceX acquired xAI (closed 2026-02-02), xAI dissolved 2026-05-06 and renamed SpaceXAI 2026-07-06; Musk said 2026-10-04 it will be renamed SpaceXSI (not yet effective). OpenRouter shows the vendor as 'SpaceXAI'.",
}
CORP = "https://en.wikipedia.org/wiki/SpaceXAI"
G47 = "https://siliconangle.com/2026/09/21/spacex-launches-grok-4-7-with-long-horizon-processing-safety-upgrades/"
HIST = "https://www.scriptbyai.com/spacexai-timeline-grok/"

LINES = [
    {"family": "grok", "category": "llm", "chain": ["grok1", "grok2", "grok3", "grok4", "grok41fast", "grok420", "grok43", "grok45", "grok46", "grok47"]},
    {"family": "grok-build", "category": "code", "chain": ["grokbuild01"]},
    {"family": "grok-imagine", "category": "image", "chain": ["grokimagineimage", "grokimagineimagequality", "grokimagineimage20"]},
    {"family": "grok-imagine", "category": "video", "chain": ["grokimaginevideo", "grokimaginevideo15", "grokimaginevideo15lite"]},
    {"family": "grok-voice", "category": "speech-tts", "chain": ["grokvoicetts10"]},
    {"family": "grok-voice", "category": "speech-asr", "chain": ["grokvoicestt10"]},
    {"family": "grok-companions", "category": "agent", "tags": ["companion"], "chain": ["grokani"]},
]

R = {
    "grok4": {"displayName": "Grok 4", "releaseDate": "2025-07-09", "sc": "background", "sources": [HIST], "releaseDateBasis": "secondary", "ow": False},
    "grok41fast": {"displayName": "Grok 4.1 Fast", "notes": "Reasoning and non-reasoning modes; models.dev 2025-11-19."},
    "grok420": {"displayName": "Grok 4.20", "releaseDate": "2026-03-09", "releaseDateBasis": "catalog", "notes": "Reasoning / non-reasoning / multi-agent variants dated 0309 in models.dev; OpenRouter lists 2026-03-31."},
    "grok43": {"displayName": "Grok 4.3", "releaseDate": "2026-04-17", "releaseDateBasis": "catalog", "notes": "OpenRouter lists 2026-04-30."},
    "grok45": {"displayName": "Grok 4.5", "releaseDate": "2026-07-08", "sc": "secondary", "sources": [HIST, "https://codersera.com/blog/grok-4-5-launch-guide-2026/"], "releaseDateBasis": "secondary", "notes": "Frontier model replacing 4.3; co-developed with Cursor (reported)."},
    "grok46": {"displayName": "Grok 4.6", "releaseDate": "2026-08-12", "sc": "secondary", "sources": ["https://codersera.com/blog/grok-4-6-launch-guide-2026/"], "releaseDateBasis": "secondary"},
    "grok47": {"displayName": "Grok 4.7", "releaseDate": "2026-09-21", "sc": "secondary", "sources": [G47], "releaseDateBasis": "secondary", "notes": "New larger base model + longer RL run (company claim). Grok 5 not shipped."},
    "grokbuild01": {"displayName": "Grok Build 0.1", "releaseDate": None, "notes": "Coding model; listing dates conflict (models.dev 2026-04-16, OpenRouter 2026-05-20); treated as its own line, no parent claim."},
    "grokimagineimage": {"displayName": "Grok Imagine Image", "ow": False},
    "grokimagineimagequality": {"displayName": "Grok Imagine Image Quality"},
    "grokimagineimage20": {"displayName": "Grok Imagine Image 2.0"},
    "grokimaginevideo": {"displayName": "Grok Imagine Video"},
    "grokimaginevideo15": {"displayName": "Grok Imagine Video 1.5"},
    "grokimaginevideo15lite": {"displayName": "Grok Imagine Video 1.5 Lite"},
    "grokvoicetts10": {"displayName": "Grok Voice TTS 1.0"},
    "grokvoicestt10": {"displayName": "Grok Voice STT 1.0"},
}

EXTRA = {
    "grok1": {"displayName": "Grok-1", "releaseDate": "2023-11-04", "sc": "background", "sources": ["https://x.ai/news/grok-os"], "ow": True, "notes": "Chatbot debuted 2023-11-04; weights open-sourced 2024-03-17 (314B MoE)."},
    "grok2": {"displayName": "Grok-2", "releaseDate": "2024-08-13", "sc": "background", "sources": ["https://x.ai/news/grok-2"], "ow": False, "notes": "Weights released later (2025-08)."},
    "grok3": {"displayName": "Grok 3", "releaseDate": "2025-02-17", "sc": "background", "sources": ["https://x.ai/news/grok-3"], "ow": False},
    "grokani": {"displayName": "Ani (Grok Companions)", "releaseDate": "2025-07-14", "sc": "background", "sources": [HIST], "ow": False, "catbasis": "companion avatar feature in the Grok app", "notes": "Product feature, not a model; date from roster, not re-verified."},
}

SPECIES = {
    "grok-1": "grok1",
    "grok-4": "grok4",
    "grok-4-7": "grok47",
    "grok-ani": "grokani",
    "grok-imagine": "grokimaginevideo15",
}

IGNORE = {"grok41fastreasoning", "grok4200309nonreasoning", "grok4200309reasoning", "grok420multiagent"}

EXCLUDED = ["Grok 4.1 Fast Reasoning/Non-reasoning and Grok 4.20 reasoning/non-reasoning/multi-agent: mode variants of the same release."]

GAPS = [
    "Grok 1.5, 2 mini, 3 mini, Grok 4 Heavy/Fast/Code not recorded individually.",
    "x.ai pages not fetched; dates from models.dev/OpenRouter plus secondary timelines.",
]
