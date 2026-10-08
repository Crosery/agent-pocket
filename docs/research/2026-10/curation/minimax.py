VENDOR = {
    "key": "minimax",
    "name": "MiniMax",
    "nameZh": "稀宇科技 MiniMax / 海螺",
    "country": "CN",
    "homepage": "https://www.minimax.io",
    "officialModelListUrl": "https://platform.minimax.io/docs/guides/models-intro",
    "changelogUrl": "https://releasebot.io/updates/minimax",
    "notes": "HF org MiniMaxAI listing opened via API (Music3 2026-08-07, H3 2026-07-28, M3 2026-06-02). MiniMax release-note aggregator and the official H3 blog were returned by search.",
}
H3 = "https://www.minimax.io/blog/minimax-h3"
H3S = "https://datanorth.ai/news/minimax-releases-minimax-h3"
M31 = "https://apimaster.ai/blog/minimax-m3-1-api"
M31B = "https://github.com/MiniMax-M31/MiniMax-M3.1-Flash/releases/tag/MiniMaxM3.1"
MUS = "https://www.marktechpost.com/2026/08/17/minimax-releases-minimax-music3/"
HFAPI = "https://huggingface.co/api/models?author=MiniMaxAI&sort=createdAt&direction=-1&limit=10"
SPEECH = "https://invideo.io/blog/minimax-ai-voice-models/"
REL = "https://releasebot.io/updates/minimax"

LINES = [
    {"family": "minimax-llm", "category": "llm", "chain": ["abab", "minimax01", "minimaxm1", "minimaxm2", "minimaxm21", "minimaxm25", "minimaxm27", "minimaxm3", "minimaxm31flashpreview"]},
    {"family": "hailuo", "category": "video", "chain": ["hailuo01", "hailuo02", "hailuo23", "minimaxh3"]},
    {"family": "minimax-speech", "category": "speech-tts", "chain": ["speech25", "speech26", "speech28"]},
    {"family": "minimax-music", "category": "music", "chain": ["music3"]},
]

R = {
    "minimax01": {"displayName": "MiniMax-01", "releaseDate": "2025-01-15", "ow": True, "notes": "Text-01 + VL-01 (456B, lightning attention); OpenRouter date."},
    "minimaxm1": {"displayName": "MiniMax-M1", "releaseDate": "2025-06-16", "releaseDateBasis": "background", "sc": "background", "sources": ["https://github.com/MiniMax-AI/MiniMax-M1"], "ow": True, "relation": "successor", "basis": "reported", "category": "reasoning", "notes": "Reasoning model built on MiniMax-Text-01 (reported); OpenRouter lists 2025-06-17."},
    "minimaxm2": {"displayName": "MiniMax-M2", "releaseDate": "2025-10-27", "ow": True, "notes": "Agent/coding focus; models.dev 2025-10-27, OpenRouter 2025-10-23."},
    "minimaxm21": {"displayName": "MiniMax-M2.1", "releaseDate": "2025-12-23", "ow": True},
    "minimaxm25": {"displayName": "MiniMax-M2.5", "releaseDate": "2026-02-12", "ow": True, "notes": "Highspeed serving variant 2026-02-13 not recorded."},
    "minimaxm27": {"displayName": "MiniMax-M2.7", "releaseDate": "2026-03-18", "ow": True, "notes": "HF repo created 2026-04-09."},
    "minimaxm3": {
        "displayName": "MiniMax-M3",
        "releaseDate": "2026-06-01",
        "sc": "secondary",
        "sources": [HFAPI],
        "releaseDateBasis": "catalog",
        "ow": True,
        "notes": "Natively multimodal (text, image, video in). models.dev 2026-06-01, OpenRouter 2026-05-31, HF repo 2026-06-02.",
    },
    "minimaxm31flashpreview": {
        "displayName": "MiniMax-M3.1-Flash-Preview",
        "releaseDate": "2026-09-27",
        "sc": "secondary",
        "sources": [M31, "https://startupfortune.com/minimax-slips-a-new-coding-model-into-its-agent-tool-without-a-price-tag/"],
        "releaseDateBasis": "secondary",
        "ow": False,
        "status": "preview",
        "notes": "Newest MiniMax model. Preview inside MiniMax Code only (no model card, benchmarks, pricing or weights). Do NOT confuse with the fake 'MiniMax-M31' GitHub repo (malware lure).",
    },
    "minimaxh3": {
        "displayName": "MiniMax H3 (Hailuo 3.0)",
        "releaseDate": "2026-07-31",
        "sc": "official",
        "sources": [H3, H3S],
        "releaseDateBasis": "official",
        "ow": True,
        "catbasis": "official: omni-modal generation model, video with native audio up to 2K/15s",
        "notes": "Unveiled at WAIC 2026-07-17; released 2026-07-31 (HF repo 2026-07-28); base weights open 2026-08-03 under a community licence; successor of Hailuo 2.3. H3 Max (Aug/Sep 2026) not recorded: reported as a fal.ai post-trained speed tier, not announced by MiniMax.",
    },
}

EXTRA = {
    "abab": {"displayName": "abab 6.5", "releaseDate": "2024-04-17", "sc": "background", "sources": ["https://www.minimaxi.com/news"], "ow": False, "notes": "Roster date; abab line (5/5.5/6/6.5/7) predates MiniMax-01. Not re-verified."},
    "hailuo01": {"displayName": "Hailuo Video-01", "releaseMonth": "2024-09", "releaseDate": None, "sc": "background", "sources": ["https://hailuoai.video/"], "ow": False, "catbasis": "video generation", "notes": "Launched Sept 2024 (roster); day not verified."},
    "hailuo02": {"displayName": "Hailuo 02", "releaseDate": "2025-06-18", "sc": "background", "sources": ["https://www.minimax.io/news/minimax-hailuo-02"], "ow": False, "notes": "Date from memory."},
    "hailuo23": {"displayName": "Hailuo 2.3", "releaseMonth": "2025-10", "releaseDate": None, "sc": "secondary", "sources": [H3S], "ow": False, "notes": "H3 is 'the direct successor to Hailuo 2.3', ~9 months older than H3 (reported)."},
    "speech25": {"displayName": "MiniMax Speech 2.5", "releaseDate": "2025-08-07", "sc": "secondary", "sources": [SPEECH], "ow": False, "catbasis": "text-to-speech/voice clone"},
    "speech26": {"displayName": "MiniMax Speech 2.6", "releaseDate": "2025-10-30", "sc": "secondary", "sources": [SPEECH], "ow": False},
    "speech28": {"displayName": "MiniMax Speech 2.8", "releaseDate": "2026-01-23", "sc": "secondary", "sources": [SPEECH], "ow": False, "notes": "HD and Turbo tiers; newest MiniMax speech model, no 'Speech 3' found."},
    "music3": {
        "displayName": "MiniMax Music 3.0",
        "releaseDate": "2026-07-16",
        "sc": "secondary",
        "sources": [MUS, REL],
        "releaseDateBasis": "secondary",
        "ow": True,
        "catbasis": "official: lyrics+caption to full song (up to 5 min)",
        "notes": "API 2026-07-16; open weights announced 2026-08-13 (HF repo MiniMaxAI/MiniMax-Music3 created 2026-08-07). Earlier Music 1.5/2.0/2.5 not recorded.",
    },
}

SPECIES = {
    "abab": "abab",
    "minimax-m2": "minimaxm2",
    "minimax-m3": "minimaxm3",
    "hailuo": "hailuo01",
    "minimax-h3": "minimaxh3",
    "minimax-music": "music3",
}

IGNORE = {"minimaxm2her", "minimaxm25highspeed", "minimaxm27highspeed"}

EXCLUDED = [
    "MiniMax-M2-her (roleplay variant), M2.5/M2.7 Highspeed serving variants, H3 Max (reported as fal.ai-retrained speed tier; MiniMax release notes have no entry).",
    "Unverified rumours: MiniMax M3.1 full release, M3 Pro, M4 (nothing official).",
]

GAPS = [
    "MiniMax-M3.1 full release not announced; only Flash-Preview inside MiniMax Code.",
    "Hailuo 2.3 / Video-01 exact days, Music 1.5/2.0/2.5, Speech-02 and image-01 not recorded.",
]
