VENDOR = {
    "key": "mistral",
    "name": "Mistral AI",
    "nameZh": "Mistral AI",
    "country": "FR",
    "homepage": "https://mistral.ai",
    "officialModelListUrl": "https://docs.mistral.ai/getting-started/models/models_overview/",
    "changelogUrl": "https://docs.mistral.ai/resources/changelogs",
    "notes": "Dates for 2025-2026 releases cross-checked via the Mistral changelog, model-card pages and secondary timelines returned by search; 2023-2024 roots are from background knowledge.",
}
CL = "https://docs.mistral.ai/resources/changelogs"
ML4 = "https://artificialanalysis.ai/articles/mistral-large-4-france-ai"
ML4B = "https://thenextweb.com/news/mistral-releases-large-4-a-1-trillion-parameter-open-weight-ai-model"
MM35 = "https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04"
MM35B = "https://mistral.ai/news/vibe-remote-agents-mistral-medium-3-5/"
DEV2 = "https://mistral.ai/news/devstral-2-vibe-cli/"
SM4 = "https://openrouter.ai/mistralai/mistral-small-2603"

LINES = [
    {"family": "mistral-open", "category": "llm", "chain": ["mistral7b", "mixtral8x7b", "mixtral8x22binstruct"]},
    {"family": "mistral-large", "category": "llm", "chain": ["mistrallarge24", "mistrallarge2", "mistrallarge", "mistrallarge4"]},
    {"family": "mistral-medium", "category": "llm", "chain": ["mistralmedium3", "mistralmedium31", "mistralmedium"]},
    {"family": "mistral-small", "category": "llm", "chain": ["mistralsmall24binstruct", "mistralsmall3124binstruct", "mistralsmall3224binstruct", "mistralsmall"]},
    {"family": "mistral-nemo", "category": "llm", "chain": ["mistralnemo"]},
    {"family": "ministral", "category": "llm", "chain": ["ministral8binstruct", "ministral38binstruct"]},
    {"family": "ministral", "category": "llm", "chain": ["ministral33binstruct"]},
    {"family": "ministral", "category": "llm", "chain": ["ministral14b"]},
    {"family": "magistral", "category": "reasoning", "chain": ["magistralsmall"]},
    {"family": "magistral", "category": "reasoning", "chain": ["magistralmedium"]},
    {"family": "devstral", "category": "code", "chain": ["devstralsmall", "devstralsmall2"]},
    {"family": "devstral", "category": "code", "chain": ["devstralmedium", "devstral"]},
    {"family": "codestral", "category": "code", "chain": ["codestral22bv01", "codestral"]},
    {"family": "pixtral", "category": "vision-language", "chain": ["pixtral12b", "pixtrallarge"]},
    {"family": "voxtral", "category": "speech-asr", "chain": ["voxtralmini3b"]},
    {"family": "voxtral", "category": "speech-asr", "chain": ["voxtralsmall24b"]},
    {"family": "mistral-embed", "category": "embedding", "chain": ["mistralembed"]},
    {"family": "mistral-saba", "category": "llm", "chain": ["mistralsaba"]},
    {"family": "mistral-ocr", "category": "vision-language", "chain": ["mistralocr"]},
]

R = {
    "mixtral8x22binstruct": {"displayName": "Mixtral 8x22B", "releaseDate": "2024-04-17", "ow": True, "sc": "background", "releaseDateBasis": "background", "sources": ["https://mistral.ai/news/mixtral-8x22b/"], "notes": "Open-weights sparse MoE (Apache 2.0)."},
    "mistralsmall24binstruct": {"displayName": "Mistral Small 3", "releaseDate": "2025-01-30", "ow": True, "notes": "24B Apache 2.0; OpenRouter lists the same day."},
    "mistralsmall3124binstruct": {"displayName": "Mistral Small 3.1", "releaseDate": "2025-03-17", "ow": True},
    "mistralsmall3224binstruct": {"displayName": "Mistral Small 3.2", "releaseDate": "2025-06-20", "ow": True},
    "mistralsmall": {
        "displayName": "Mistral Small 4",
        "releaseDate": "2026-03-16",
        "sc": "secondary",
        "releaseDateBasis": "secondary",
        "sources": [SM4, CL],
        "ow": True,
        "relation": "successor",
        "basis": "reported",
        "notes": "119B MoE (6B active), Apache 2.0; unifies Small, Magistral, Pixtral and Devstral into one model with adjustable reasoning effort.",
    },
    "mistralmedium3": {"displayName": "Mistral Medium 3", "releaseDate": "2025-05-07", "ow": False},
    "mistralmedium31": {"displayName": "Mistral Medium 3.1", "releaseDate": "2025-08-13", "ow": False},
    "mistralmedium": {
        "displayName": "Mistral Medium 3.5",
        "releaseDate": "2026-04-29",
        "sc": "official",
        "releaseDateBasis": "official",
        "sources": [MM35, MM35B],
        "ow": True,
        "relation": "successor",
        "basis": "reported",
        "notes": "128B dense, 256K context, modified-MIT open weights; merges Medium 3.1 + Magistral + Devstral 2 into one model. Model card id 26-04; OpenRouter lists 2026-04-30 (roster uses 04-30). First open-weights Medium.",
    },
    "mistrallarge": {
        "displayName": "Mistral Large 3",
        "releaseDate": "2025-12-02",
        "sc": "secondary",
        "releaseDateBasis": "secondary",
        "sources": [CL],
        "ow": True,
        "notes": "675B-A41B MoE, Apache 2.0, released with the Ministral 3 family. Seed date 2024-02-26 is an older Large entry under the same key.",
    },
    "mistrallarge4": {
        "displayName": "Mistral Large 4",
        "releaseDate": "2026-10-06",
        "sc": "secondary",
        "releaseDateBasis": "secondary",
        "sources": [ML4, ML4B, "https://huggingface.co/mistralai/Mistral-Large-4.0-1T05-A52B"],
        "ow": None,
        "status": "preview",
        "notes": "~1T-param MoE (49B active), trained from scratch; public preview 2026-10-06 via Mistral Studio/API. Weights announced for late October (Oct 27 or Oct 31 per source), licence not yet announced. Newest Mistral flagship.",
    },
    "mistralnemo": {"displayName": "Mistral NeMo", "releaseDate": "2024-07-18", "ow": True, "notes": "12B, co-developed with NVIDIA, Apache 2.0."},
    "ministral8binstruct": {"displayName": "Ministral 8B", "releaseDate": "2024-10-16", "ow": True, "notes": "Released with Ministral 3B on 2024-10-16 (Mistral Research License for 8B)."},
    "ministral38binstruct": {
        "displayName": "Ministral 3 8B",
        "releaseDate": "2025-12-02",
        "ow": True,
        "relation": "distill",
        "basis": "reported",
        "sc": "secondary",
        "sources": [CL, "https://huggingface.co/mistralai"],
        "notes": "Ministral 3 family (3B/8B/14B) released 2025-12-02 with Large 3. Cascade distillation from Mistral Small 3.1 per the tech report ([unverified] recalled, not re-opened). Parent shown is the previous Ministral 8B.",
    },
    "ministral33binstruct": {"displayName": "Ministral 3 3B", "releaseDate": "2025-12-02", "ow": True},
    "ministral14b": {"displayName": "Ministral 3 14B", "releaseDate": "2025-12-02", "ow": True},
    "magistralsmall": {
        "displayName": "Magistral Small",
        "releaseDate": "2025-06-10",
        "sc": "secondary",
        "releaseDateBasis": "secondary",
        "sources": [CL, "https://simonwillison.net/2025/Sep/19/magistral/"],
        "ow": True,
        "parent": "mistralsmall3124binstruct",
        "relation": "post-train",
        "basis": "reported",
        "notes": "First Mistral reasoning model (Apache 2.0, 24B); fine-tuned from Mistral Small 3.1 (recalled from model card, [unverified]). Magistral 1.2 (2025-09-17/18, vision) folded into this record. Folded into Small 4 / Medium 3.5 in 2026.",
    },
    "devstralsmall": {
        "displayName": "Devstral Small",
        "releaseDate": "2025-05-21",
        "sc": "background",
        "releaseDateBasis": "background",
        "sources": ["https://mistral.ai/news/devstral"],
        "ow": True,
        "parent": "mistralsmall3124binstruct",
        "relation": "post-train",
        "basis": "reported",
        "notes": "Agentic coding model built with All Hands AI on Mistral Small 3.1 (recalled; [unverified]). 1.1 shipped 2025-07-10 (catalog date).",
    },
    "devstralmedium": {"displayName": "Devstral Medium", "releaseDate": "2025-07-10", "ow": False, "notes": "API-only."},
    "devstral": {
        "displayName": "Devstral 2",
        "releaseDate": "2025-12-09",
        "sc": "official",
        "releaseDateBasis": "official",
        "sources": [DEV2, CL],
        "ow": True,
        "status": "deprecated",
        "notes": "123B dense, 256K, modified MIT. Wikipedia says 2025-12-10. API docs mark Devstral 2 deprecated (Sept 2026) in favour of Medium 3.5.",
    },
    "devstralsmall2": {"displayName": "Devstral Small 2", "releaseDate": "2025-12-09", "sc": "official", "releaseDateBasis": "official", "sources": [DEV2], "ow": True, "status": "deprecated", "notes": "24B Apache 2.0."},
    "codestral22bv01": {"displayName": "Codestral 22B", "releaseDate": "2024-05-29", "ow": True, "notes": "First Codestral (Mistral Non-Production License)."},
    "codestral": {"displayName": "Codestral 2508", "releaseDate": "2025-07-30", "ow": False, "notes": "Latest Codestral refresh in the catalogs (2025-07-30 / 08-01)."},
    "pixtral12b": {"displayName": "Pixtral 12B", "releaseDate": "2024-09-11", "sc": "background", "releaseDateBasis": "background", "sources": ["https://mistral.ai/news/pixtral-12b/"], "ow": True, "notes": "First Mistral multimodal model, built on Mistral NeMo 12B; catalog dates 09-01/09-25 are weights/listing dates."},
    "pixtrallarge": {"displayName": "Pixtral Large", "releaseDate": "2024-11-18", "sc": "background", "releaseDateBasis": "background", "sources": ["https://mistral.ai/news/pixtral-large/"], "ow": True, "notes": "124B multimodal on Mistral Large 2; catalog date 2025-04-08 is the Bedrock listing."},
    "voxtralmini3b": {"displayName": "Voxtral Mini 3B", "releaseDate": "2025-07-15", "ow": True, "catbasis": "audio-in speech transcription + understanding (text output)"},
    "voxtralsmall24b": {"displayName": "Voxtral Small 24B", "releaseDate": "2025-07-15", "ow": True, "catbasis": "audio-in speech transcription + understanding (text output)"},
    "mistralembed": {"displayName": "Mistral Embed", "releaseDate": "2023-12-11", "ow": False},
    "mistralsaba": {"displayName": "Mistral Saba", "releaseDate": "2025-02-17", "ow": False, "notes": "Regional-language model (Middle East, South Asia)."},
}

EXTRA = {
    "mistral7b": {"displayName": "Mistral 7B", "releaseDate": "2023-09-27", "sc": "background", "sources": ["https://mistral.ai/news/announcing-mistral-7b/"], "ow": True, "notes": "Apache 2.0 root of the Mistral open line."},
    "mixtral8x7b": {"displayName": "Mixtral 8x7B", "releaseDate": "2023-12-11", "sc": "background", "sources": ["https://mistral.ai/news/mixtral-of-experts/"], "ow": True, "notes": "Sparse MoE successor to Mistral 7B (shared tokenizer/architecture ideas; not a post-train)."},
    "mistrallarge24": {"displayName": "Mistral Large", "releaseDate": "2024-02-26", "sc": "background", "sources": ["https://mistral.ai/news/mistral-large/"], "ow": False, "notes": "First Large (24.02), API-only."},
    "mistrallarge2": {"displayName": "Mistral Large 2", "releaseDate": "2024-07-24", "sc": "background", "sources": ["https://mistral.ai/news/mistral-large-2407/"], "ow": True, "notes": "123B, Mistral Research License."},
    "magistralmedium": {
        "displayName": "Magistral Medium",
        "releaseDate": "2025-06-10",
        "sc": "secondary",
        "sources": [CL],
        "ow": False,
        "parent": "mistralmedium3",
        "relation": "post-train",
        "basis": "reported",
        "notes": "API-only reasoning model; RL on top of Mistral Medium 3 (recalled from the Magistral paper, [unverified]).",
    },
    "mistralocr": {"displayName": "Mistral OCR", "releaseDate": "2025-03-06", "sc": "background", "sources": ["https://mistral.ai/news/mistral-ocr"], "ow": False, "catbasis": "document OCR / understanding API"},
}

SPECIES = {
    "mistral-7b": "mistral7b",
    "mistral-medium": "mistralmedium",
}

IGNORE = {"mistrallarge40", "mistralmedium35", "ministral3b", "ministral314binstruct", "ministral8b"}
EXCLUDED = ["Mistral Large 4 duplicate OpenRouter entry, duplicate Ministral 3 hosting entries, dated snapshots (2402/2407/2411/2501/2503/2506/2509), Codestral Embed / Mamba / Mathstral / Magistral 1.2 splits, Mistral Vibe CLI, Le Chat."]
GAPS = [
    "Mistral Large 4 licence/weights date not published (Oct 27 vs Oct 31 vs 'late October').",
    "Ministral 3 distillation parent, Magistral Small/Medium and Devstral Small parents are recalled from model cards, not re-opened.",
    "Codestral 25.01, Codestral Mamba, Mathstral, Mistral Small 3.0 variants and Voxtral 2 not recorded.",
]
