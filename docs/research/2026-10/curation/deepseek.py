VENDOR = {
    "key": "deepseek",
    "name": "DeepSeek",
    "nameZh": "深度求索 DeepSeek",
    "country": "CN",
    "homepage": "https://www.deepseek.com",
    "officialModelListUrl": "https://api-docs.deepseek.com/quick_start/pricing",
    "changelogUrl": "https://api-docs.deepseek.com/updates/",
    "notes": "Official change log and Hugging Face cards were opened this session; lineage statements below quote them.",
}
UPD = "https://api-docs.deepseek.com/updates/"
HF = "https://huggingface.co/deepseek-ai/"

LINES = [
    {"family": "deepseek-chat", "category": "llm", "src": [UPD], "chain": ["v2", "v25", "deepseekv3", "deepseekchatv3", "deepseekv31", "deepseekv31terminus", "deepseekv32exp", "deepseekv32"]},
    {"family": "deepseek-pro", "category": "llm", "src": [UPD], "chain": ["deepseekv32", "deepseekv4pro", "v4pro0813"]},
    {"family": "deepseek-flash", "category": "llm", "src": [UPD], "chain": ["deepseekv32", "deepseekv4flash", "v4flash0731", "deepseekv41flash"]},
    {"family": "deepseek-flash", "category": "llm", "src": [UPD], "chain": ["v4flash0731", "deepseekv4flashvisionexp"]},
    {"family": "deepseek-r1", "category": "reasoning", "src": [UPD], "chain": ["deepseekv3", "deepseekr1", "r10528"]},
    {"family": "deepseek-ocr", "category": "vision-language", "chain": ["deepseekocr", "deepseekocr2"]},
]

R = {
    "deepseekv3": {"displayName": "DeepSeek-V3", "releaseDate": "2024-12-26", "sc": "background", "sources": [HF + "DeepSeek-V3", "https://arxiv.org/abs/2412.19437"], "releaseDateBasis": "catalog"},
    "deepseekchatv3": {"displayName": "DeepSeek-V3-0324", "releaseDate": "2025-03-24", "sc": "official", "sources": [UPD], "releaseDateBasis": "official"},
    "deepseekv31": {
        "displayName": "DeepSeek-V3.1",
        "parent": "deepseekv3",
        "releaseDate": "2025-08-21",
        "sc": "official",
        "sources": [UPD, HF + "DeepSeek-V3.1"],
        "releaseDateBasis": "official",
        "relation": "successor",
        "basis": "official",
        "notes": "HF card: 'post-trained on the top of DeepSeek-V3.1-Base ... built upon the original V3 base checkpoint through a two-phase long context extension'. Hybrid thinking/non-thinking.",
    },
    "deepseekv31terminus": {"displayName": "DeepSeek-V3.1-Terminus", "releaseDate": "2025-09-22", "sc": "official", "sources": [UPD], "releaseDateBasis": "official", "relation": "post-train", "basis": "reported", "notes": "Fixes language-mixing and agent issues of V3.1 (change log)."},
    "deepseekv32exp": {
        "displayName": "DeepSeek-V3.2-Exp",
        "releaseDate": "2025-09-29",
        "sc": "official",
        "sources": [UPD, HF + "DeepSeek-V3.2-Exp"],
        "releaseDateBasis": "official",
        "relation": "successor",
        "basis": "official",
        "notes": "HF card: 'V3.2-Exp builds upon V3.1-Terminus by introducing DeepSeek Sparse Attention.'",
    },
    "deepseekv32": {"displayName": "DeepSeek-V3.2", "releaseDate": "2025-12-01", "sc": "official", "sources": [UPD], "releaseDateBasis": "official", "relation": "successor", "basis": "reported", "notes": "Ships with V3.2-Speciale (temporary endpoint until 2025-12-15, not recorded)."},
    "deepseekr1": {
        "displayName": "DeepSeek-R1",
        "releaseDate": "2025-01-20",
        "sc": "official",
        "sources": [UPD, HF + "DeepSeek-R1"],
        "releaseDateBasis": "official",
        "category": "reasoning",
        "relation": "post-train",
        "basis": "official",
        "notes": "HF card: 'DeepSeek-R1-Zero & DeepSeek-R1 are trained based on DeepSeek-V3-Base.'",
    },
    "deepseekv4pro": {
        "displayName": "DeepSeek-V4-Pro",
        "releaseDate": "2026-04-24",
        "sc": "official",
        "sources": [UPD],
        "releaseDateBasis": "official",
        "notes": "Preview release 2026-04-24; GA snapshot 0813. 1M context, thinking low/high/max. Lineage to V3.2 is by version number only (no stated base).",
    },
    "deepseekv4flash": {"displayName": "DeepSeek-V4-Flash", "releaseDate": "2026-04-24", "sc": "official", "sources": [UPD], "releaseDateBasis": "official", "notes": "Preview release (Flash-Preview) 2026-04-24."},
    "deepseekv41flash": {
        "displayName": "DeepSeek-V4.1-Flash",
        "releaseDate": "2026-09-10",
        "sc": "official",
        "sources": [UPD],
        "releaseDateBasis": "official",
        "relation": "successor",
        "basis": "reported",
        "notes": "Change log: smallest model of a 'new architecture family' with native multimodal vision; V4 Flash and Vision-Exp retired and routed to V4.1.",
    },
    "deepseekv4flashvisionexp": {
        "displayName": "DeepSeek-V4-Flash-Vision-Exp",
        "releaseDate": "2026-08-21",
        "sc": "official",
        "sources": [UPD],
        "releaseDateBasis": "official",
        "category": "vision-language",
        "status": "retired",
        "relation": "successor",
        "basis": "reported",
        "notes": "Experimental multimodal Flash (text skills said to match official V4-Flash). Retired at V4.1-Flash launch.",
    },
    "deepseekocr2": {"displayName": "DeepSeek-OCR 2", "releaseDate": "2026-01-27", "sc": "catalog", "notes": "models.dev date (HF open weights)."},
}

EXTRA = {
    "v2": {"displayName": "DeepSeek-V2", "releaseDate": "2024-05-06", "sc": "background", "sources": ["https://huggingface.co/deepseek-ai/DeepSeek-V2"], "ow": True, "catbasis": "text LLM (MoE)"},
    "v25": {"displayName": "DeepSeek-V2.5", "releaseDate": "2024-09-05", "sc": "background", "sources": ["https://huggingface.co/deepseek-ai/DeepSeek-V2.5"], "ow": True, "relation": "successor", "basis": "reported", "notes": "Merges V2-Chat and Coder-V2 (reported)."},
    "v4pro0813": {
        "displayName": "DeepSeek-V4-Pro 0813",
        "releaseDate": "2026-08-13",
        "sc": "official",
        "sources": [UPD],
        "releaseDateBasis": "official",
        "ow": True,
        "notes": "GA of V4-Pro on app/web/API with stronger agent results; adds Responses API and thinking effort levels.",
    },
    "v4flash0731": {
        "displayName": "DeepSeek-V4-Flash 0731",
        "releaseDate": "2026-07-31",
        "sc": "official",
        "sources": [UPD],
        "releaseDateBasis": "official",
        "ow": True,
        "relation": "post-train",
        "basis": "official",
        "notes": "Change log: 'keeps the same model architecture and size as DeepSeek-V4-Flash-Preview', only re-post-trained.",
    },
    "r10528": {"displayName": "DeepSeek-R1-0528", "releaseDate": "2025-05-28", "sc": "official", "sources": [UPD], "releaseDateBasis": "official", "ow": True, "category": "reasoning", "relation": "post-train", "basis": "reported", "notes": "Upgrade of R1 (change log)."},
    "deepseekocr": {"displayName": "DeepSeek-OCR", "releaseDate": "2025-10-20", "sc": "background", "sources": ["https://huggingface.co/deepseek-ai/DeepSeek-OCR"], "ow": True, "catbasis": "optical-compression document OCR model"},
}

SPECIES = {
    "deepseek-v3": "deepseekv3",
    "deepseek-r1": "deepseekr1",
    "deepseek-v4": "deepseekv4pro",
}

IGNORE = {"deepseekchat", "deepseekreasoner", "deepseekchatv31"}

EXCLUDED = ["deepseek-chat / deepseek-reasoner API aliases; V3.2-Speciale temporary endpoint; OpenRouter ~latest aliases; Janus, Prover, Coder, Math families (older, not chain-relevant)."]

GAPS = ["DeepSeek Harness (roster agent species, 2026-08-13) not found in the change log: see products.py notes.", "V2/V2.5/OCR dates are from memory with HF links not opened this session (sourceCheck=background)."]


# roster product record
LINES.append({"family": 'deepseek-harness', "category": 'agent', "chain": ['harness']})
EXTRA['harness'] = {'displayName': 'DeepSeek Harness', 'releaseDate': '2026-08-13', 'sc': 'background', 'sources': ['https://github.com/deepseek-ai'], 'ow': False, 'catbasis': 'agent framework (roster description)', 'notes': 'Product record for a roster entry; date from the roster, not verified (search budget exhausted). Open-source (MIT) model-agnostic agent framework; desktop version late September 2026 (roster).'}
SPECIES['deepseek-harness'] = 'harness'
