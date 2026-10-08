VENDOR = {
    "key": "stepfun",
    "name": "StepFun",
    "nameZh": "阶跃星辰 StepFun",
    "country": "CN",
    "homepage": "https://www.stepfun.com",
    "officialModelListUrl": "https://platform.stepfun.com/docs/overview/concept",
    "changelogUrl": "https://platform.stepfun.com/docs/changelog",
    "notes": "Step 5 Preview dates conflict across catalogs (models.dev 2026-09-16, OpenRouter listing 2026-10-08, press 09-18/09-20).",
}
S5 = "https://runtimewire.com/article/stepfun-step-5-preview-600b-agent-model-pricing"
S5B = "https://explainx.ai/blog/stepfun-step-5-preview-pareto-frontier-launch-2026"

LINES = [
    {"family": "step", "category": "llm", "chain": ["step2", "step3", "step35flash", "step37flash", "step5preview"]},
    {"family": "step-audio", "category": "speech-tts", "chain": ["steptts2", "stepaudio25tts"]},
    {"family": "step-audio", "category": "speech-asr", "chain": ["stepaudio25asr"]},
]

R = {
    "step35flash": {"displayName": "Step 3.5 Flash", "releaseDate": "2026-01-29", "ow": True, "notes": "2603 refresh listed 2026-04-02 (models.dev)."},
    "step37flash": {"displayName": "Step 3.7 Flash", "releaseDate": "2026-05-29", "ow": True, "notes": "Multimodal (text, image, video in). models.dev 2026-05-29, OpenRouter 2026-05-28."},
    "step5preview": {
        "displayName": "Step 5 Preview",
        "releaseDate": "2026-09-20",
        "sc": "secondary",
        "sources": [S5, S5B],
        "releaseDateBasis": "secondary",
        "ow": False,
        "status": "preview",
        "notes": "600B-A27B sparse MoE, 1M context, text/image/video in; announced 2026-09-20 (one tracker: 09-18; models.dev 09-16; OpenRouter listing 10-08). Open weights scheduled 2026-10-15 (reported).",
    },
    "steptts2": {"displayName": "Step TTS 2", "releaseDate": "2026-03-01", "ow": False},
    "stepaudio25tts": {"displayName": "StepAudio 2.5 TTS", "releaseDate": "2026-04-16", "ow": False},
    "stepaudio25asr": {"displayName": "StepAudio 2.5 ASR", "releaseDate": "2026-04-24", "ow": False, "catbasis": "models.dev: audio->text"},
}

EXTRA = {
    "step2": {"displayName": "Step-2", "releaseMonth": "2024-07", "releaseDate": None, "sc": "background", "sources": ["https://platform.stepfun.com"], "ow": False, "notes": "Trillion-parameter flagship shown at WAIC July 2024 (memory); models.dev lists step-2-16k only with a placeholder date."},
    "step3": {"displayName": "Step 3", "releaseDate": "2025-07-25", "sc": "background", "sources": ["https://github.com/stepfun-ai/Step3"], "ow": True, "notes": "Open VLM 321B-A38B at WAIC 2025; date from memory."},
}

SPECIES = {
    "step-flash": "step35flash",
    "step-5": "step5preview",
}

IGNORE = {"step132k", "step216k"}
EXCLUDED = ["Step-1 / Step-1V, Step-Video-T2V, Step1X-Edit, Step-Audio 1/2 research releases (not recorded)."]
GAPS = ["Step 3 and Step-2 dates from memory.", "Step 5 Preview exact day (09-16 / 09-18 / 09-20)."]
