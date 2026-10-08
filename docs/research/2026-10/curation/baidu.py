VENDOR = {
    "key": "baidu",
    "name": "Baidu (ERNIE / Wenxin)",
    "nameZh": "百度 文心 ERNIE",
    "country": "CN",
    "homepage": "https://ernie.baidu.com",
    "officialModelListUrl": "https://cloud.baidu.com/doc/WENXINWORKSHOP/s/Nlks5zkzu",
    "changelogUrl": "https://ernie.baidu.com/blog/",
    "notes": "ERNIE 5.1 official blog was returned by search; no catalog seed except models.dev ~ernie-5.1 entries.",
}
E51 = "https://ernie.baidu.com/blog/posts/ernie-5.1-0508-release/"
DEC = "https://the-decoder.com/baidus-ernie-5-1-cuts-94-percent-of-pre-training-costs-while-competing-with-top-models/"
LIN = "https://presenc.ai/research/baidu-ernie-model-lineage-2026"

LINES = [
    {"family": "ernie", "category": "llm", "chain": ["erniebot", "ernie40", "ernie45", "ernie50", "ernie51"]},
    {"family": "ernie-x", "category": "reasoning", "chain": ["erniex1", "erniex11"]},
    {"family": "ernie-image", "category": "image", "chain": ["ernieimage"]},
]

EXTRA = {
    "erniebot": {"displayName": "ERNIE Bot (ERNIE 3.5)", "releaseDate": "2023-03-16", "sc": "background", "sources": ["https://en.wikipedia.org/wiki/Ernie_Bot"], "ow": False, "notes": "Ernie Bot chatbot launch 2023-03-16 (roster date)."},
    "ernie40": {"displayName": "ERNIE 4.0", "releaseDate": "2023-10-17", "sc": "background", "sources": [LIN], "ow": False, "notes": "Announced at Baidu World 2023; 4.0 Turbo followed June 2024."},
    "ernie45": {"displayName": "ERNIE 4.5", "releaseDate": "2025-03-16", "sc": "secondary", "sources": [LIN, "https://venturebeat.com/ai/baidu-just-dropped-an-open-source-multimodal-ai-that-it-claims-beats-gpt-5"], "ow": True, "notes": "Announced with X1 2025-03-16; ERNIE 4.5 family open-sourced (Apache 2.0) June 2025."},
    "ernie50": {"displayName": "ERNIE 5.0", "releaseDate": "2026-01-22", "sc": "secondary", "sources": [DEC, "https://www.scmp.com/tech/tech-trends/article/3340866/baidu-launches-ernie-50-firms-ai-assistant-users-reach-200-million-month"], "releaseDateBasis": "secondary", "ow": False, "tags": ["omni"], "notes": "Unveiled at Baidu World 2025-11-13; official version 2026-01-22. 2.4T-param natively omni-modal MoE, not open."},
    "ernie51": {
        "displayName": "ERNIE 5.1",
        "releaseDate": "2026-05-09",
        "sc": "official",
        "sources": [E51, DEC],
        "releaseDateBasis": "official",
        "ow": False,
        "relation": "distill",
        "basis": "reported",
        "notes": "Smaller (~800B) text-only model cut from ERNIE 5.0 with Once-For-All elastic training (press: 94% lower pre-training cost); preview on LMArena 2026-04-29; blog URL slug dated 0508. Newest ERNIE as of 2026-10-09.",
    },
    "erniex1": {"displayName": "ERNIE X1", "releaseDate": "2025-03-16", "sc": "secondary", "sources": [LIN], "ow": False, "notes": "Reasoning model announced with ERNIE 4.5; X1 Turbo April 2025."},
    "erniex11": {"displayName": "ERNIE X1.1", "releaseDate": "2025-09-09", "sc": "secondary", "sources": [DEC], "ow": False},
    "ernieimage": {"displayName": "ERNIE-Image", "releaseDate": "2026-04-15", "sc": "secondary", "sources": [DEC], "ow": False, "catbasis": "image generation (reported)", "notes": "Date from a single secondary timeline."},
}

SPECIES = {
    "ernie-bot": "erniebot",
    "ernie-4-5": "ernie45",
    "ernie-5-1": "ernie51",
}

EXCLUDED = ["ERNIE Speed/Lite/Tiny, ERNIE 4.5 Turbo / X1 Turbo, ERNIE 4.5 VL variants, PaddleOCR-VL, Qianfan-VL (not chain-relevant)."]
GAPS = ["No ERNIE 5.2 / X2 announcement found; Baidu usually unveils flagships at the autumn Baidu World event. ERNIE 4.0 exact date and ERNIE-Image date weakly sourced."]
