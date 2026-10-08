VENDOR = {
    "key": "nvidia",
    "name": "NVIDIA (Nemotron)",
    "nameZh": "英伟达 Nemotron",
    "country": "US",
    "homepage": "https://www.nvidia.com/en-us/ai-data-science/foundation-models/nemotron/",
    "officialModelListUrl": "https://developer.nvidia.com/topics/ai/nemotron",
    "changelogUrl": "https://research.nvidia.com/labs/nemotron/Nemotron-3",
    "notes": "Nemotron 3 Ultra completes the Nano/Super/Ultra ladder promised in Dec 2025.",
}
N3 = "https://research.nvidia.com/labs/nemotron/Nemotron-3"
AA = "https://artificialanalysis.ai/articles/nvidia-nemotron-3-ultra-released"
NEWS = "https://nvidianews.nvidia.com/news/nvidia-debuts-nemotron-3-family-of-open-models"

LINES = [
    {"family": "nemotron-nano", "category": "llm", "chain": ["nemotronmini4binstruct", "nemotronnano9bv2", "nemotron3nano30ba3b", "nemotron35lightning"]},
    {"family": "nemotron-nano", "category": "vision-language", "chain": ["nemotron3nano30ba3b", "nemotron3nanoomni30ba3breasoning"]},
    {"family": "nemotron-super", "category": "llm", "chain": ["llama33nemotronsuper49bv1", "llama33nemotronsuper49bv15", "nemotron3super120ba12b"]},
    {"family": "nemotron-ultra", "category": "llm", "chain": ["llama31nemotronultra253b", "nemotron3ultra550ba55b"]},
    {"family": "nemotron-llama", "category": "llm", "chain": ["llama31nemotron70binstruct"]},
    {"family": "nemotron-nano", "category": "vision-language", "chain": ["nemotronnano12bv2vl"]},
    {"family": "nemotron-embed", "category": "embedding", "chain": ["llamanemotronembedvl1bv2"]},
    {"family": "nemotron-embed", "category": "embedding", "chain": ["llamanemotronrerankvl1bv2"]},
    {"family": "nemotron-voice", "category": "speech-tts", "chain": ["nemotronvoicechat"]},
]

R = {
    "nemotronmini4binstruct": {"displayName": "Nemotron-Mini-4B-Instruct", "releaseDate": "2024-08-21", "ow": True, "notes": "Minitron-pruned from Nemotron-4 15B (recalled)."},
    "nemotronnano9bv2": {"displayName": "Nemotron Nano 9B v2", "releaseDate": "2025-08-18", "ow": True, "notes": "Hybrid Mamba-Transformer."},
    "nemotron3nano30ba3b": {
        "displayName": "Nemotron 3 Nano",
        "releaseMonth": "2025-12",
        "releaseDate": None,
        "sc": "official",
        "sources": [NEWS, N3],
        "ow": True,
        "notes": "30B-A3B (3.2B active) hybrid Mamba-Transformer MoE with 1M context; released December 2025, first of Nano/Super/Ultra. Catalog dates (2024-12 / 2026-01-27) are wrong or listing dates.",
    },
    "nemotron35lightning": {"displayName": "Nemotron 3.5 Lightning", "releaseDate": "2026-08-11", "ow": True, "notes": "30B-A3B open MoE for high-throughput agentic work (OpenRouter description); same size class as Nano 3, treated as its successor. OpenRouter/models.dev listing date."},
    "nemotron3nanoomni30ba3breasoning": {"displayName": "Nemotron 3 Nano Omni", "releaseDate": "2026-04-28", "ow": True, "relation": "successor", "basis": "reported", "catbasis": "multimodal reasoning variant of Nano 3 (models.dev modalities)"},
    "llama33nemotronsuper49bv1": {
        "displayName": "Llama-3.3-Nemotron-Super-49B",
        "releaseDate": "2025-03-18",
        "sc": "background",
        "releaseDateBasis": "background",
        "sources": ["https://huggingface.co/nvidia/Llama-3_3-Nemotron-Super-49B-v1"],
        "ow": True,
        "parentExternal": {"name": "Llama 3.3 70B Instruct", "vendor": "meta", "url": "https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct"},
        "relation": "distill",
        "basis": "official",
        "notes": "NAS-pruned and distilled derivative of Llama 3.3 70B (model card, recalled); announced at GTC 2025-03-18; catalog dates 2025-04-07/08-08 are listing dates.",
    },
    "llama33nemotronsuper49bv15": {"displayName": "Llama-3.3-Nemotron-Super-49B v1.5", "releaseDate": "2025-07-25", "ow": True, "relation": "post-train", "basis": "reported"},
    "nemotron3super120ba12b": {
        "displayName": "Nemotron 3 Super",
        "releaseDate": "2026-03-11",
        "sc": "secondary",
        "releaseDateBasis": "secondary",
        "sources": [AA, N3],
        "ow": True,
        "notes": "120B-A12B LatentMoE, 1M context; 85 days before Ultra (2026-06-04). Own pre-training (not Llama-derived).",
    },
    "llama31nemotronultra253b": {
        "displayName": "Llama-3.1-Nemotron-Ultra-253B",
        "releaseDate": "2025-04-07",
        "ow": True,
        "parentExternal": {"name": "Llama 3.1 405B Instruct", "vendor": "meta", "url": "https://huggingface.co/meta-llama/Llama-3.1-405B-Instruct"},
        "relation": "distill",
        "basis": "official",
        "notes": "NAS-pruned reasoning derivative of Llama 3.1 405B (model card, recalled).",
    },
    "nemotron3ultra550ba55b": {
        "displayName": "Nemotron 3 Ultra",
        "releaseDate": "2026-06-04",
        "sc": "secondary",
        "releaseDateBasis": "secondary",
        "sources": [AA, "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16", N3],
        "ow": True,
        "notes": "550B-A55B LatentMoE, text-only, announced Computex 2026-06-01, weights 2026-06-04; largest US open-weights model. Roster files it as 'reasoning'; it is a general hybrid-reasoning flagship (llm).",
    },
    "llama31nemotron70binstruct": {
        "displayName": "Llama-3.1-Nemotron-70B-Instruct",
        "releaseDate": "2024-10-15",
        "sc": "background",
        "releaseDateBasis": "background",
        "sources": ["https://huggingface.co/nvidia/Llama-3.1-Nemotron-70B-Instruct-HF"],
        "ow": True,
        "parentExternal": {"name": "Llama 3.1 70B Instruct", "vendor": "meta", "url": "https://huggingface.co/meta-llama/Llama-3.1-70B-Instruct"},
        "relation": "post-train",
        "basis": "official",
        "notes": "RLHF (REINFORCE) fine-tune of Llama 3.1 70B; catalog date 2025-04-15 is a listing date.",
    },
    "nemotronnano12bv2vl": {"displayName": "Nemotron Nano 12B v2 VL", "releaseDate": "2025-10-28", "ow": True},
    "llamanemotronembedvl1bv2": {"displayName": "Llama-Nemotron-Embed-VL-1B v2", "releaseDate": "2026-02-10", "ow": True},
    "llamanemotronrerankvl1bv2": {"displayName": "Llama-Nemotron-Rerank-VL-1B v2", "releaseDate": "2026-03-31", "ow": True},
    "nemotronvoicechat": {"displayName": "Nemotron VoiceChat", "releaseDate": "2026-03-16", "ow": True, "catbasis": "end-to-end spoken-dialogue model (catalog, unverified)"},
}

SPECIES = {"nemotron": "nemotron3ultra550ba55b"}
IGNORE = {"mistralnemotron", "llama31nemotronsafetyguard8bv3", "nemotroncontentsafetyreasoning4b", "nemotron3contentsafety", "nemotron35contentsafety", "switchyard"}
EXCLUDED = ["Safety/guardrail models (Nemotron content-safety, safety-guard; 3.5 Content Safety is Gemma-3-4B based), Switchyard (open-source router), Mistral-NeMo-Minitron / mistral-nemotron hosting, Nemotron-4 340B (2024-06) and Cosmos/GR00T/Parakeet lines."]
GAPS = ["Nemotron 3 Nano exact day (December 2025), Nemotron-Mini-4B parent, Nemotron 3.5 Lightning architecture beyond OpenRouter's description.", "Cosmos (world), GR00T (robot VLA), Parakeet/Canary (ASR) not covered."]
