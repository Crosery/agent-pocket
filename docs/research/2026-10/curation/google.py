VENDOR = {
    "key": "google",
    "name": "Google (DeepMind)",
    "nameZh": "谷歌 / DeepMind",
    "country": "US",
    "homepage": "https://deepmind.google",
    "officialModelListUrl": "https://deepmind.google/models/",
    "changelogUrl": "https://ai.google.dev/gemini-api/docs/changelog",
    "notes": "Release dates mix models.dev, OpenRouter and secondary reporting; Google pages were not all fetched.",
}

G38 = "https://9to5google.com/2026/09/02/gemini-3-8-flash-launch/"
G38MC = "https://deepmind.google/models/model-cards/gemini-3-8-flash/"
ARGON = "https://techcrunch.com/2026/09/30/google-releases-gemini-4-argon-called-its-most-powerful-model-yet/"
LYRIA35 = (
    "https://blog.google/innovation-and-ai/models-and-research/google-labs/lyria-3-5/"
)
ROBO2 = "https://roboticsandautomationnews.com/2026/07/31/google-deepmind-unveils-gemini-robotics-2-as-apptronik-humanoid-demonstrates-whole-body-ai/103802/"
OMNI = "https://gemini.google/overview/video-generation/"
WIKI_GEMINI = "https://en.wikipedia.org/wiki/Gemini_(language_model)"

LINES = [
    {
        "family": "gemini-pro",
        "category": "llm",
        "chain": [
            "gemini10",
            "gemini15pro",
            "gemini25pro",
            "gemini3propreview",
            "gemini31propreview",
        ],
    },
    {
        "family": "gemini-argon",
        "category": "llm",
        "chain": ["gemini31propreview", "gemini4argon"],
        "tags": ["flagship"],
    },
    {
        "family": "gemini-flash",
        "category": "llm",
        "chain": [
            "gemini15pro",
            "gemini15flash",
            "gemini20flash",
            "gemini25flash",
            "gemini3flashpreview",
            "gemini35flash",
            "gemini36flash",
            "gemini37flash",
            "gemini38flash",
        ],
    },
    {
        "family": "gemini-flash-lite",
        "category": "llm",
        "chain": [
            "gemini25flash",
            "gemini25flashlite",
            "gemini31flashlitepreview",
            "gemini35flashlite",
        ],
    },
    {
        "family": "gemma",
        "category": "llm",
        "chain": ["gemma1", "gemma2", "gemma3", "gemma3n", "gemma4"],
        "tags": ["open-weights"],
    },
    {"family": "gemma", "category": "llm", "chain": ["gemma4", "diffusiongemma"]},
    {
        "family": "nano-banana",
        "category": "image",
        "chain": [
            "gemini25flashimage",
            "gemini31flashimagepreview",
            "gemininanobanana21",
        ],
    },
    {
        "family": "nano-banana",
        "category": "image",
        "chain": ["gemini25flashimage", "gemini3proimagepreview"],
    },
    {
        "family": "nano-banana",
        "category": "image",
        "chain": ["gemini31flashimagepreview", "gemini31flashliteimage"],
    },
    {"family": "imagen", "category": "image", "chain": ["imagen3", "imagen4"]},
    {
        "family": "veo",
        "category": "video",
        "chain": ["veo1", "veo2", "veo3", "veo31", "veo31litegeneratepreview"],
    },
    {
        "family": "gemini-omni",
        "category": "video",
        "chain": ["veo31", "geminiomniflashpreview"],
    },
    {
        "family": "lyria",
        "category": "music",
        "chain": ["lyria3clippreview", "lyria3propreview", "lyria35"],
    },
    {"family": "genie", "category": "world", "chain": ["genie1", "genie2", "genie3"]},
    {
        "family": "gemini-live",
        "category": "speech-tts",
        "chain": ["gemini31flashlivepreview", "gemini38live"],
    },
    {
        "family": "gemini-tts",
        "category": "speech-tts",
        "chain": [
            "gemini25flashpreviewtts",
            "gemini31flashttspreview",
            "gemini38flashtts",
        ],
    },
    {
        "family": "gemini-transcribe",
        "category": "speech-asr",
        "chain": ["gemini35transcribelive"],
    },
    {
        "family": "gemini-embedding",
        "category": "embedding",
        "chain": ["geminiembedding001", "geminiembedding2"],
    },
    {
        "family": "gemini-robotics",
        "category": "agent",
        "tags": ["embodied"],
        "chain": ["robotics1", "robotics15", "robotics2"],
    },
    {"family": "notebooklm", "category": "agent", "chain": ["notebooklm"]},
    {
        "family": "antigravity",
        "category": "agent",
        "tags": ["coding"],
        "chain": ["antigravity"],
    },
    {
        "family": "alpha",
        "category": "agent",
        "chain": ["alphago", "alphagozero", "alphazero", "muzero"],
    },
]

R = {
    "gemini25pro": {
        "displayName": "Gemini 2.5 Pro",
        "releaseDate": "2025-03-25",
        "releaseDateBasis": "secondary",
        "sources": [WIKI_GEMINI],
        "notes": "Experimental 2025-03-25; GA 2025-06-17 (models.dev/OpenRouter). Roster category 'reasoning' is a hybrid thinking flagship, so llm here.",
    },
    "gemini3propreview": {
        "displayName": "Gemini 3 Pro",
        "notes": "Preview 2025-11-18 (models.dev).",
    },
    "gemini31propreview": {
        "displayName": "Gemini 3.1 Pro",
        "notes": "Preview 2026-02-19. Still the newest Pro-tier model per reporting (3.5 Pro promised for June 2026, not released as of 2026-10-05).",
    },
    "gemini15flash": {
        "displayName": "Gemini 1.5 Flash",
        "relation": "distill",
        "basis": "reported",
    },
    "gemini25flash": {
        "displayName": "Gemini 2.5 Flash",
        "releaseDate": "2025-04-17",
        "releaseDateBasis": "catalog",
        "notes": "Preview 2025-04-17, GA 2025-06-17 (OpenRouter).",
    },
    "gemini3flashpreview": {"displayName": "Gemini 3 Flash"},
    "gemini35flash": {
        "displayName": "Gemini 3.5 Flash",
        "releaseDate": "2026-05-19",
        "notes": "Announced at Google I/O 2026.",
    },
    "gemini36flash": {"displayName": "Gemini 3.6 Flash", "releaseDate": "2026-07-21"},
    "gemini37flash": {"displayName": "Gemini 3.7 Flash", "releaseDate": "2026-08-13"},
    "gemini38flash": {
        "displayName": "Gemini 3.8 Flash",
        "releaseDate": "2026-09-02",
        "sc": "official",
        "sources": [G38MC, G38],
        "notes": "Third Flash in six weeks. A restricted 'Gemini 3.8 Flash Cyber' variant exists; Live (09-15), Flash TTS (09-22) followed.",
    },
    "gemini25flashlite": {
        "displayName": "Gemini 2.5 Flash-Lite",
        "releaseDate": "2025-06-17",
        "releaseDateBasis": "catalog",
        "notes": "OpenRouter lists 2025-07-22.",
    },
    "gemini31flashlitepreview": {
        "displayName": "Gemini 3.1 Flash-Lite",
        "notes": "Preview 2026-03-03; GA 2026-05-07.",
    },
    "gemini35flashlite": {
        "displayName": "Gemini 3.5 Flash-Lite",
        "releaseDate": "2026-07-21",
        "releaseDateBasis": "catalog",
    },
    "gemma1": {
        "displayName": "Gemma",
        "releaseDate": "2024-02-21",
        "sc": "background",
        "sources": ["https://blog.google/technology/developers/gemma-open-models/"],
        "ow": True,
        "catbasis": "open-weights LLM",
        "notes": "Gemma 1 (2B/7B).",
    },
    "gemma2": {
        "displayName": "Gemma 2",
        "releaseDate": "2024-06-27",
        "sc": "background",
        "sources": ["https://blog.google/technology/developers/google-gemma-2/"],
        "ow": True,
    },
    "gemma3": {
        "displayName": "Gemma 3",
        "releaseDate": "2025-03-12",
        "ow": True,
        "sources": ["https://en.wikipedia.org/wiki/Gemma_(language_model)"],
        "sc": "secondary",
        "notes": "1B-27B; OpenRouter/models.dev list 2025-03-12.",
    },
    "gemma3n": {
        "displayName": "Gemma 3n",
        "releaseDate": "2025-06-26",
        "sc": "background",
        "sources": [
            "https://developers.googleblog.com/en/introducing-gemma-3n-developer-guide/"
        ],
        "ow": True,
        "notes": "On-device E2B/E4B.",
    },
    "gemma4": {
        "displayName": "Gemma 4",
        "releaseDate": "2026-04-02",
        "ow": True,
        "sc": "secondary",
        "sources": ["https://en.wikipedia.org/wiki/Gemma_(language_model)"],
        "notes": "Apache 2.0 (Wikipedia, 2026-04-02). Sizes: 31B, 26B-A4B (MoE), E2B/E4B on-device; 12B unified multimodal added 2026-06-03 per Wikipedia (catalogs 06-09).",
    },
    "diffusiongemma": {
        "displayName": "DiffusionGemma",
        "releaseDate": "2026-06-09",
        "ow": True,
        "sc": "catalog",
        "sources": ["https://models.dev/"],
        "catbasis": "text-diffusion LLM (26B-A4B); models.dev modalities text,image->text",
        "notes": "Date from models.dev (google/diffusiongemma-26b-a4b-it); lineage to Gemma 4 assumed from naming only.",
    },
    "gemini25flashimage": {
        "displayName": "Nano Banana", "alt": ["Gemini 2.5 Flash Image"],
        "releaseDate": "2025-08-26",
        "releaseDateBasis": "catalog",
        "notes": "OpenRouter lists 2025-10-07.",
    },
    "gemini3proimagepreview": {
        "displayName": "Nano Banana Pro", "alt": ["Gemini 3 Pro Image"],
        "releaseDate": "2025-11-20",
        "notes": "Preview 2025-11-20; GA 2026-05-28 (models.dev).",
    },
    "gemini31flashimagepreview": {
        "displayName": "Nano Banana 2", "alt": ["Gemini 3.1 Flash Image"],
        "releaseDate": "2026-02-26",
        "notes": "Preview 2026-02-26; GA 2026-05-28 (models.dev)/2026-06-18 (OpenRouter).",
    },
    "gemini31flashliteimage": {
        "displayName": "Nano Banana 2 Lite", "alt": ["Gemini 3.1 Flash-Lite Image"]
    },
    "gemininanobanana21": {
        "displayName": "Nano Banana 2.1",
        "releaseDate": "2026-10-06",
        "notes": "Newest image model; OpenRouter/models.dev listing only (no official page opened).",
    },
    "veo3": {
        "displayName": "Veo 3",
        "releaseDate": "2025-05-20",
        "sc": "background",
        "sources": ["https://deepmind.google/models/veo/"],
    },
    "veo31": {"displayName": "Veo 3.1", "releaseDate": "2025-10-15", "sc": "secondary", "sources": ["https://en.wikipedia.org/wiki/Veo_(text-to-video_model)"]},
    "veo31litegeneratepreview": {"displayName": "Veo 3.1 Lite"},
    "geminiomniflashpreview": {
        "displayName": "Gemini Omni Flash",
        "releaseDate": "2026-05-19",
        "releaseDateBasis": "secondary",
        "sc": "secondary",
        "sources": [OMNI, "https://invideo.io/blog/gemini-omni-flash-guide/"],
        "parent": "veo31",
        "relation": "series-successor",
        "basis": "reported",
        "notes": "Announced at I/O 2026 (2026-05-19); current model is Omni 1.1 Flash; models.dev preview listing 2026-06-30. Any-to-any, built on Gemini's unified transformer, NOT a Veo checkpoint: replaces Veo only in the Gemini app. Veo 3.1 remains live elsewhere.",
    },
    "lyria3clippreview": {
        "displayName": "Lyria 3 Clip",
        "releaseDate": "2026-03-25",
        "notes": "Lyria 3 (clip) and 3 Pro previews: 2026-03-25 (models.dev), 2026-03-30 (OpenRouter).",
    },
    "lyria3propreview": {
        "displayName": "Lyria 3 Pro",
        "releaseDate": "2026-03-25",
        "parent": "lyria3clippreview",
    },
    "gemini31flashlivepreview": {
        "displayName": "Gemini 3.1 Flash Live",
        "releaseDate": "2026-03-26",
    },
    "gemini25flashpreviewtts": {
        "displayName": "Gemini 2.5 Flash TTS",
        "releaseDate": "2025-05-01",
        "notes": "Preview TTS 2025-05-01 (models.dev), GA 2025-09-30.",
    },
    "gemini31flashttspreview": {
        "displayName": "Gemini 3.1 Flash TTS",
        "releaseDate": "2026-04-15",
    },
    "gemini35transcribelive": {
        "displayName": "Gemini 3.5 Transcribe Live",
        "releaseDate": "2026-08-26",
        "catbasis": "speech-to-text; models.dev output text",
        "notes": "models.dev entry ~gemini-3.5-transcribe; OpenRouter absent.",
    },
    "geminiembedding001": {
        "displayName": "Gemini Embedding 001",
        "releaseDate": "2025-05-20",
    },
    "geminiembedding2": {
        "displayName": "Gemini Embedding 2",
        "releaseDate": "2026-04-22",
        "notes": "Multimodal embedding.",
    },
}

EXTRA = {
    "gemini10": {
        "displayName": "Gemini 1.0",
        "releaseDate": "2023-12-06",
        "sc": "background",
        "sources": ["https://blog.google/technology/ai/google-gemini-ai/"],
        "ow": False,
        "notes": "Ultra / Pro / Nano announced 2023-12-06.",
    },
    "gemini15pro": {
        "displayName": "Gemini 1.5 Pro",
        "releaseDate": "2024-02-15",
        "sc": "background",
        "sources": [
            "https://blog.google/technology/ai/google-gemini-next-generation-model-february-2024/"
        ],
        "ow": False,
    },
    "gemini15flash": {
        "displayName": "Gemini 1.5 Flash",
        "releaseDate": "2024-05-14",
        "sc": "background",
        "sources": [
            "https://blog.google/technology/ai/google-gemini-update-flash-ai-assistant-io-2024/"
        ],
        "ow": False,
    },
    "gemini20flash": {
        "displayName": "Gemini 2.0 Flash",
        "releaseDate": "2025-02-05",
        "sc": "background",
        "sources": [
            "https://blog.google/technology/google-deepmind/gemini-model-updates-february-2025/"
        ],
        "ow": False,
        "notes": "Experimental 2024-12-11; GA 2025-02-05.",
    },
    "gemini4argon": {
        "displayName": "Gemini 4 Argon",
        "releaseDate": "2026-09-30",
        "sc": "secondary",
        "releaseDateBasis": "secondary",
        "sources": [
            ARGON,
            "https://finance.yahoo.com/technology/article/google-debuts-gemini-4-argon-its-latest-frontier-model-204002322.html",
        ],
        "ow": False,
        "status": "preview",
        "notes": "Announced 2026-09-30; limited to Google cyber partners (Fairwind program), broad API/Ultra access pending. Uses a codename instead of a Pro/Flash tier. Parent set to Gemini 3.1 Pro as the previous flagship (series only).",
    },
    "imagen3": {
        "displayName": "Imagen 3",
        "releaseDate": "2024-08-15",
        "sc": "background",
        "sources": ["https://deepmind.google/models/imagen/"],
        "ow": False,
        "notes": "Imagen 3 broadly available in Gemini/ImageFX Aug 2024 (day approximate: release month 2024-08).",
    },
    "imagen4": {
        "displayName": "Imagen 4",
        "releaseDate": "2025-05-20",
        "sc": "background",
        "sources": ["https://deepmind.google/models/imagen/"],
        "ow": False,
    },
    "veo1": {
        "displayName": "Veo",
        "releaseDate": "2024-05-14",
        "sc": "background",
        "sources": ["https://deepmind.google/models/veo/"],
        "ow": False,
    },
    "veo2": {
        "displayName": "Veo 2",
        "releaseDate": "2024-12-16",
        "sc": "background",
        "sources": ["https://deepmind.google/models/veo/"],
        "ow": False,
    },
    "lyria35": {
        "displayName": "Lyria 3.5",
        "releaseDate": "2026-07-29",
        "sc": "official",
        "sources": [LYRIA35],
        "ow": False,
        "notes": "Flow Music 2026-07-29; Gemini app and API 2026-09-04. Replaces Lyria 3 Pro in Flow Music.",
    },
    "genie1": {
        "displayName": "Genie",
        "releaseDate": "2024-02-23",
        "sc": "background",
        "sources": ["https://deepmind.google/research/publications/60474/"],
        "ow": False,
        "catbasis": "generative interactive environment (world) model",
    },
    "genie2": {
        "displayName": "Genie 2",
        "releaseDate": "2024-12-04",
        "sc": "background",
        "sources": [
            "https://deepmind.google/discover/blog/genie-2-a-large-scale-foundation-world-model/"
        ],
        "ow": False,
    },
    "genie3": {
        "displayName": "Genie 3",
        "releaseDate": "2025-08-05",
        "sc": "background",
        "sources": [
            "https://deepmind.google/discover/blog/genie-3-a-new-frontier-for-world-models/"
        ],
        "ow": False,
        "notes": "Roster calls it 'Project Genie'; consumer rollout of Project Genie not verified here.",
    },
    "gemini38live": {
        "displayName": "Gemini 3.8 Live",
        "releaseDate": "2026-09-15",
        "sc": "secondary",
        "sources": [G38],
        "ow": False,
        "notes": "Live (09-15); a Live-with-Live-Avatar variant followed 2026-09-24 (reported).",
    },
    "gemini38flashtts": {
        "displayName": "Gemini 3.8 Flash TTS",
        "releaseDate": "2026-09-22",
        "sc": "secondary",
        "sources": [G38],
        "ow": False,
        "notes": "Flash-Lite TTS variant also listed in models.dev.",
    },
    "robotics1": {
        "displayName": "Gemini Robotics",
        "releaseDate": "2025-03-12",
        "sc": "background",
        "sources": ["https://deepmind.google/models/gemini-robotics/"],
        "ow": False,
        "catbasis": "vision-language-action model",
    },
    "robotics15": {
        "displayName": "Gemini Robotics 1.5",
        "releaseDate": "2025-09-25",
        "sc": "background",
        "sources": ["https://deepmind.google/models/gemini-robotics/"],
        "ow": False,
    },
    "robotics2": {
        "displayName": "Gemini Robotics 2",
        "releaseDate": "2026-07-30",
        "sc": "secondary",
        "sources": [ROBO2],
        "ow": False,
        "notes": "VLA with whole-body humanoid control; ships with Gemini Robotics ER 2 (public via API) and On-Device 2.",
    },
    "notebooklm": {
        "displayName": "NotebookLM",
        "releaseDate": "2023-07-12",
        "sc": "background",
        "sources": ["https://notebooklm.google/"],
        "ow": False,
        "catbasis": "research-assistant product on Gemini",
        "notes": "Product (announced as Project Tailwind at I/O 2023).",
    },
    "antigravity": {
        "displayName": "Google Antigravity",
        "releaseDate": "2025-11-18",
        "sc": "background",
        "sources": ["https://antigravity.google/"],
        "ow": False,
        "catbasis": "agentic IDE product",
        "notes": "Launched with Gemini 3.",
    },
    "alphago": {
        "displayName": "AlphaGo",
        "releaseDate": "2016-03-09",
        "sc": "background",
        "sources": ["https://deepmind.google/research/breakthroughs/alphago/"],
        "ow": False,
        "catbasis": "game-playing RL agent",
        "notes": "Date = first match vs Lee Sedol; Nature paper 2016-01-27.",
    },
    "alphagozero": {
        "displayName": "AlphaGo Zero",
        "releaseDate": "2017-10-18",
        "sc": "background",
        "sources": [
            "https://deepmind.google/discover/blog/alphago-zero-starting-from-scratch/"
        ],
        "ow": False,
    },
    "alphazero": {
        "displayName": "AlphaZero",
        "releaseDate": "2017-12-05",
        "sc": "background",
        "sources": [
            "https://deepmind.google/discover/blog/alphazero-shedding-new-light-on-chess-shogi-and-go/"
        ],
        "ow": False,
    },
    "muzero": {
        "displayName": "MuZero",
        "releaseDate": "2019-11-19",
        "sc": "background",
        "sources": [
            "https://deepmind.google/discover/blog/muzero-mastering-go-chess-shogi-and-atari-without-rules/"
        ],
        "ow": False,
    },
}

SPECIES = {
    "gemini-flash-lite": "gemini35flashlite",
    "gemini-flash": "gemini38flash",
    "gemini-argon": "gemini4argon",
    "gemini-live": "gemini38live",
    "gemini-1-5-pro": "gemini15pro",
    "gemini-2-5-pro": "gemini25pro",
    "gemini-3-1-pro": "gemini31propreview",
    "gemma-4": "gemma4",
    "nano-banana": "gemini25flashimage",
    "nano-banana-2": "gemini31flashimagepreview",
    "veo-3": "veo3",
    "gemini-omni": "geminiomniflashpreview",
    "lyria": "lyria35",
    "genie-3": "genie3",
    "notebooklm": "notebooklm",
    "google-antigravity": "antigravity",
    "gemini-robotics": "robotics2",
    "alpha": "alphago",
}

IGNORE = {
    "gemma227bit",
    "gemma312bit",
    "gemma327bit",
    "gemma34bit",
    "gemma426ba4bit",
    "gemma431bit",
    "gemma4e2bit",
    "gemma4e4bit",
    "gemma412bit",
    "gemini25propreview",
    "gemini25flashtts",
    "gemini25protts",
    "gemini25propreviewtts",
    "gemini25computerusepreview",
    "veo31fastgeneratepreview",
    "veo31generatepreview",
    "veo31litegeneratepreview",
    "gemini31propreviewcustomtools",
    "geminiroboticser16preview",
    "deepresearchmaxpreview",
    "deepresearchpreview",
    "gemini31flashlite",
    "gemini31flashimage",
    "gemini3proimage",
    "gemini35livetranslatepreview",
    "lyria3clippreview_x",
}

EXCLUDED = [
    "Gemma sizes (1B-31B, 26B-A4B, E2B/E4B/12B) collapsed per generation; DiffusionGemma kept as a distinct design.",
    "Preview vs GA duplicates (Gemini 3.1 Flash-Lite GA 2026-05-07, Nano Banana 2 / Pro GA 2026-05/06): collapsed into the first public release.",
    "Veo 3.1 Fast, Deep Research (Max) previews, Computer Use preview, Pro Custom Tools, Gemini 3.5 Live Translate: serving variants / agent features, not separate lineage models.",
    "AlphaFold, GraphCast, WeatherNext, AlphaGeometry: science models, no category in the enum.",
    "Gemini 3.8 Flash Cyber: restricted variant, no public record.",
]

GAPS = [
    "Gemini 1.x/2.0, Gemma 1-3n, Imagen, Veo 1-3, Genie 1-3, AlphaGo family dates are well-known history; source URLs are the canonical Google pages but were NOT opened this session (sourceCheck=background).",
    "Gemini Omni Pro announced but unreleased; Gemini 3.5 Pro promised but unreleased (as of 2026-10-05, secondary reporting).",
    "Project Genie consumer rollout date not verified.",
]
