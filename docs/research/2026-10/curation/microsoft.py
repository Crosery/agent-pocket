VENDOR = {
    "key": "microsoft",
    "name": "Microsoft (Phi / MAI)",
    "nameZh": "微软 Phi / MAI",
    "country": "US",
    "homepage": "https://microsoft.ai",
    "officialModelListUrl": "https://ai.azure.com/catalog",
    "changelogUrl": "https://microsoft.ai/news/",
    "notes": "MAI models announced at Build 2026-06-02. Search budget ran out before the Phi line after Phi-4 could be checked.",
}
BUILD = "https://theaieconomy.substack.com/p/microsofts-mai-models-build-2026"
GIG = "https://gigazine.net/gsc_news/en/20260603-microsoft-ai-thinking/"
INN = "https://innfactory.ai/en/ai-models/microsoft-phi/"
IMG26 = "https://openrouter.ai/microsoft/mai-image-2.6"

LINES = [
    {"family": "phi", "category": "llm", "chain": ["phi3", "phi4", "phi4reasoning"]},
    {"family": "mai-llm", "category": "llm", "chain": ["mai1preview"]},
    {"family": "mai-llm", "category": "reasoning", "chain": ["maithinking1"]},
    {"family": "mai-code", "category": "code", "chain": ["maicode1flash", "maicode11flash"]},
    {"family": "mai-voice", "category": "speech-tts", "chain": ["maivoice1", "maivoice2"]},
    {"family": "mai-transcribe", "category": "speech-asr", "chain": ["maitranscribe1"]},
    {"family": "mai-image", "category": "image", "chain": ["maiimage1", "maiimage2", "maiimage25", "maiimage26"]},
    {"family": "github-copilot", "category": "agent", "chain": ["githubcopilot"]},
]

R = {
    "phi4": {"displayName": "Phi-4", "releaseDate": "2024-12-12", "ow": True, "sc": "background", "releaseDateBasis": "background", "sources": ["https://huggingface.co/microsoft/phi-4"], "category": "llm", "catbasis": "14B general-purpose small LLM (the reasoning variants are Phi-4-reasoning)", "notes": "OpenRouter lists 2025-01-10; MIT weights on HF from 2025-01-08. Roster tags Phi-4 as reasoning, which only fits Phi-4-reasoning."},
    "maicode1flash": {"displayName": "MAI-Code-1-Flash", "releaseDate": "2026-06-02", "ow": False, "sc": "secondary", "releaseDateBasis": "secondary", "sources": [BUILD, GIG]},
    "maicode11flash": {"displayName": "MAI-Code-1.1-Flash", "releaseDate": "2026-08-11", "ow": False},
}

EXTRA = {
    "phi3": {"displayName": "Phi-3", "releaseDate": "2024-04-23", "sc": "background", "sources": ["https://azure.microsoft.com/en-us/blog/introducing-phi-3-redefining-whats-possible-with-slms/"], "ow": True, "notes": "Phi-3-mini announced 2024-04-23 (recalled); 3.5 followed Aug 2024."},
    "phi4reasoning": {
        "displayName": "Phi-4-reasoning",
        "releaseDate": "2025-04-30",
        "sc": "background",
        "releaseDateBasis": "background",
        "sources": ["https://huggingface.co/microsoft/Phi-4-reasoning"],
        "ow": True,
        "relation": "post-train",
        "basis": "official",
        "category": "reasoning",
        "catbasis": "reasoning-tuned 14B (SFT on o3-mini traces) per model card (recalled)",
        "notes": "Fine-tuned from Phi-4; Phi-4-reasoning-plus adds RL; Phi-4-mini-flash-reasoning followed 2025-07. Date recalled, not re-opened.",
    },
    "mai1preview": {"displayName": "MAI-1-preview", "releaseDate": "2025-08-28", "sc": "secondary", "sources": [INN, "https://en.wikipedia.org/wiki/Microsoft_AI"], "ow": False, "status": "superseded", "notes": "First in-house foundation LLM, announced with MAI-Voice-1."},
    "maithinking1": {
        "displayName": "MAI-Thinking-1",
        "releaseDate": "2026-06-02",
        "sc": "secondary",
        "releaseDateBasis": "secondary",
        "sources": [BUILD, GIG],
        "ow": False,
        "status": "preview",
        "catbasis": "Microsoft's first reasoning model (MoE ~1T / ~35B active, 256K context)",
        "notes": "Private preview on Foundry at Build; claimed to beat Claude Sonnet 4.6 in human eval. Roster date 2026-06-02 matches.",
    },
    "maivoice1": {"displayName": "MAI-Voice-1", "releaseDate": "2025-08-28", "sc": "secondary", "sources": [INN], "ow": False, "catbasis": "speech generation model", "notes": "In Copilot Aug 2025; Foundry availability 2026-04-02."},
    "maivoice2": {"displayName": "MAI-Voice-2", "releaseDate": "2026-06-02", "sc": "secondary", "sources": [BUILD, "https://pasqualepillitteri.it/en/news/3894/microsoft-mai-voice-2-image-2-5-build-2026-en"], "ow": False, "catbasis": "speech generation with voice cloning (5-60 s sample)", "notes": "Public preview at Build; Flash variant 'coming soon'."},
    "maitranscribe1": {"displayName": "MAI-Transcribe-1", "releaseDate": "2026-04-02", "sc": "secondary", "sources": [INN], "ow": False, "catbasis": "speech transcription model"},
    "maiimage1": {"displayName": "MAI-Image-1", "releaseMonth": "2025-10", "releaseDate": None, "sc": "background", "sources": ["https://microsoft.ai/news/"], "ow": False, "catbasis": "text-to-image model", "notes": "First in-house image model (debuted on LMArena Oct 2025, recalled)."},
    "maiimage2": {"displayName": "MAI-Image-2", "releaseDate": "2026-03-19", "sc": "secondary", "sources": [INN], "ow": False, "catbasis": "text-to-image model", "notes": "MAI Playground 2026-03-19, Foundry 2026-04-02."},
    "maiimage25": {"displayName": "MAI-Image-2.5", "releaseDate": "2026-06-02", "sc": "secondary", "sources": [INN, BUILD], "ow": False, "catbasis": "text-to-image model", "notes": "Announced 2026-05-26, shown at Build 2026-06-02."},
    "maiimage26": {"displayName": "MAI-Image-2.6", "releaseDate": "2026-07-31", "sc": "secondary", "releaseDateBasis": "secondary", "sources": [INN, IMG26], "ow": False, "catbasis": "text-to-image model", "notes": "Preview 2026-07-31 per innFactory; OpenRouter lists 2026-09-04 (roster date). Includes a Flash version in PowerPoint/OneDrive."},
    "githubcopilot": {"displayName": "GitHub Copilot", "releaseDate": "2021-06-29", "sc": "background", "sources": ["https://github.com/features/copilot"], "ow": False, "catbasis": "AI coding assistant product (not a single model)", "parentExternal": {"name": "OpenAI Codex (2021)", "vendor": "openai", "url": "https://openai.com/blog/openai-codex"}, "relation": "successor", "basis": "reported", "notes": "Technical preview 2021-06-29 (recalled), GA 2022-06; roster date 2021-06 is the preview month."},
}

SPECIES = {
    "phi-4": "phi4",
    "mai-thinking": "maithinking1",
    "mai-image": "maiimage26",
    "github-copilot": "githubcopilot",
}
IGNORE = {"wizardlm28x22b"}
EXCLUDED = ["WizardLM-2 8x22B (community-origin release pulled by Microsoft), Phi-3.5/Phi-4-mini/multimodal splits, MAI-DS-R1, Copilot app features."]
GAPS = ["Phi line after Phi-4 (Phi-5?) not verified; Phi-3 / Phi-4-reasoning dates recalled from memory.", "MAI-Voice-2-Flash and MAI-Image-2.6-Flash omitted as tiers."]
