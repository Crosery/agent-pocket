VENDOR = {
    "key": "zhipu",
    "name": "Zhipu AI (Z.ai)",
    "nameZh": "智谱 AI",
    "country": "CN",
    "homepage": "https://z.ai",
    "officialModelListUrl": "https://docs.z.ai/guides/overview/overview",
    "changelogUrl": "https://docs.z.ai/release-notes/new-released",
    "notes": "docs.z.ai release-notes page opened this session (model dates below). Z.ai is also listed as Zhipu AI / THUDM roots.",
}
REL = "https://docs.z.ai/release-notes/new-released"
SPEED = "https://codersera.com/blog/glm-5-3-prime-flashx-guide-2026/amp/"

LINES = [
    {"family": "glm", "category": "llm", "src": [REL], "chain": ["chatglm", "glm4", "glm45", "glm46", "glm47", "glm5", "glm51", "glm52", "glm53"]},
    {"family": "glm", "category": "llm", "chain": ["glm45", "glm45air"]},
    {"family": "glm", "category": "llm", "chain": ["glm5", "glm5turbo"]},
    {"family": "glm-flash", "category": "llm", "src": [REL], "chain": ["glm47", "glm47flash", "glm53flash"]},
    {"family": "glm-v", "category": "vision-language", "src": [REL], "chain": ["glm45air", "glm45v", "glm46v", "glm5vturbo"]},
    {"family": "glm-media", "category": "image", "chain": ["glmimage"]},
    {"family": "glm-media", "category": "video", "chain": ["cogvideox3"]},
    {"family": "glm-media", "category": "speech-asr", "chain": ["glmasr2512"]},
    {"family": "glm-media", "category": "vision-language", "chain": ["glmocr"]},
    {"family": "autoglm", "category": "agent", "chain": ["autoglm", "autoglmphone"]},
]

R = {
    "glm45": {"displayName": "GLM-4.5", "releaseDate": "2025-07-28", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": True, "notes": "GLM-4.5 series: 355B/32B-active plus Air; MoE."},
    "glm45air": {"displayName": "GLM-4.5-Air", "releaseDate": "2025-07-28", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": True},
    "glm45v": {"displayName": "GLM-4.5V", "releaseDate": "2025-08-11", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": True, "relation": "post-train", "basis": "reported", "notes": "Reported to be built on GLM-4.5-Air (not re-verified on the model card)."},
    "glm46": {"displayName": "GLM-4.6", "releaseDate": "2025-09-30", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": True},
    "glm46v": {"displayName": "GLM-4.6V", "releaseDate": "2025-12-08", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": True},
    "glm47": {"displayName": "GLM-4.7", "releaseDate": "2025-12-22", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": True},
    "glm47flash": {"displayName": "GLM-4.7-Flash", "releaseDate": "2026-01-19", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": True, "relation": "distill", "basis": "reported", "notes": "Release notes: base GLM-4.7, 'free-tier version' (relation to weights is not stated beyond 'Base: GLM-4.7')."},
    "glm5": {"displayName": "GLM-5", "releaseDate": "2026-02-12", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": True, "notes": "Uses DeepSeek Sparse Attention (release notes)."},
    "glm5turbo": {"displayName": "GLM-5-Turbo", "releaseDate": "2026-03-15", "ow": False, "notes": "Closed; models.dev lists 2026-03-16, OpenRouter 2026-03-15."},
    "glm5vturbo": {"displayName": "GLM-5V-Turbo", "releaseDate": "2026-04-01", "ow": False, "notes": "Closed vision model."},
    "glm51": {"displayName": "GLM-5.1", "releaseDate": "2026-04-07", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": True, "notes": "Zhipu platform listed it 2026-03-27 (models.dev zhipuai); open weights 2026-04-07."},
    "glm52": {"displayName": "GLM-5.2", "releaseDate": "2026-06-16", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": True, "notes": "models.dev lists 2026-06-13."},
    "glm53": {
        "displayName": "GLM-5.3",
        "releaseDate": "2026-08-18",
        "sc": "official",
        "sources": [REL, SPEED],
        "releaseDateBasis": "official",
        "ow": True,
        "relation": "post-train",
        "basis": "reported",
        "notes": "Reported as a post-training refresh of GLM-5.2 (same 744B-A40B MoE, 1M context). Dates in the wild: 08-14 (models.dev), 08-18 (release notes), 08-25 (HF upload). Roster says 2026-08-14.",
    },
    "glm53flash": {"displayName": "GLM-5.3-Flash", "releaseDate": "2026-08-26", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": True, "notes": "320B-A18B native multimodal, MIT; appeared anonymously as 'Ox Alpha' beforehand (reported)."},
    "glmimage": {"displayName": "GLM-Image", "releaseDate": "2026-01-14", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": True, "catbasis": "official: image generation (autoregressive + diffusion)"},
}

EXTRA = {
    "chatglm": {"displayName": "ChatGLM-6B", "releaseDate": "2023-03-14", "sc": "background", "sources": ["https://github.com/THUDM/ChatGLM-6B"], "ow": True, "notes": "Tsinghua KEG/Zhipu; later ChatGLM2 (2023-06-25) and ChatGLM3 (2023-10-27) not recorded."},
    "glm4": {"displayName": "GLM-4", "releaseDate": "2024-01-16", "sc": "background", "sources": ["https://github.com/THUDM/GLM-4"], "ow": False, "notes": "Closed flagship at launch; GLM-4-9B open-sourced 2024-06."},
    "cogvideox3": {"displayName": "CogVideoX-3", "releaseDate": "2025-07-15", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": False, "catbasis": "official: video generation"},
    "glmasr2512": {"displayName": "GLM-ASR-2512", "releaseDate": "2025-12-10", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": False, "catbasis": "official: speech recognition"},
    "glmocr": {"displayName": "GLM-OCR", "releaseDate": "2026-02-03", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": True, "catbasis": "OCR model (CogViT + GLM-0.5B decoder)"},
    "autoglm": {"displayName": "AutoGLM", "releaseDate": "2024-10-25", "sc": "background", "sources": ["https://xiao9905.github.io/AutoGLM/"], "ow": False, "catbasis": "phone/GUI agent", "notes": "Date from the roster/background; not re-verified."},
    "autoglmphone": {"displayName": "AutoGLM-Phone-Multilingual", "releaseDate": "2025-12-11", "sc": "official", "sources": [REL], "releaseDateBasis": "official", "ow": True, "catbasis": "phone-automation agent model"},
}

SPECIES = {
    "chatglm": "chatglm",
    "glm-4-5": "glm45",
    "glm-5-3": "glm53",
    "autoglm": "autoglm",
}

IGNORE = {"glm47flashx", "glm53flashx", "glm53prime", "glm45flash", "glm46vflash"}

EXCLUDED = [
    "GLM-5.3-FlashX (2026-09-18) and GLM-5.3-Prime (2026-09-23): accelerated serving tiers of GLM-5.3-Flash / GLM-5.3, no separate weights (codersera analysis).",
    "GLM-4.7-FlashX, GLM-4.5-Flash (free tiers), GLM Slide/Poster Agent (beta agent), CogView older versions.",
]

GAPS = ["GLM-4.5V base model ('built on GLM-4.5-Air') not re-verified on the model card.", "ChatGLM2/3, GLM-4 sub-models, GLM-4.5-Air vs GLM-4.5 relation (separate sizes) not detailed."]
