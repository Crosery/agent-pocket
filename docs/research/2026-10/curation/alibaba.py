VENDOR = {
    "key": "alibaba",
    "name": "Alibaba (Qwen / Tongyi / Wan)",
    "nameZh": "阿里巴巴 通义千问 / 万相",
    "country": "CN",
    "homepage": "https://qwen.ai",
    "officialModelListUrl": "https://www.alibabacloud.com/help/en/model-studio/models",
    "changelogUrl": "https://docs.qwencloud.com/changelog/models",
    "notes": "Qwen blog posts for 3.8 Max / Flash-Next were returned by search; dates cross-checked with models.dev and OpenRouter.",
}
Q38 = "https://qwen.ai/blog?id=qwen3.8"
Q38FN = "https://qwen.ai/blog?id=qwen3.8-flash-next"
Q38N = "https://www.testingcatalog.com/qwen-released-qwen3-8-max-with-open-weights-coming-soon/"
OMNI = "https://technode.com/2026/09/18/alibabas-qwen-releases-qwen3-8-omni-flash-with-1m-token-context/"
IMG21 = "https://www.marktechpost.com/2026/09/21/alibaba-qwen-releases-qwen-image-2-1/"
WAN3 = "https://technode.com/2026/08/24/alibaba-launches-wan3-0-video-model-with-30-second-generation-and-document-input/"
AUD31 = "https://www.orcarouter.ai/blog/qwen-audio-3-1-vs-qwen-audio-3-0-tts"
TTS3 = "https://github.com/QwenLM/Qwen3-TTS"

LINES = [
    {"family": "qwen-open", "category": "llm", "chain": ["qwen1", "qwen15", "qwen2", "qwen25", "qwen3", "qwen3235ba22binstruct", "qwen35397ba17b", "qwen3824ta95b"], "tags": ["open-weights"]},
    {"family": "qwen-27b", "category": "llm", "chain": ["qwen3527b", "qwen3627b", "qwen3827b"], "tags": ["open-weights", "dense"]},
    {"family": "qwen-moe-small", "category": "llm", "chain": ["qwen3535ba3b", "qwen3635ba3b", "qwen38flashnext"], "tags": ["open-weights"]},
    {"family": "qwen-max", "category": "llm", "chain": ["qwenmax1", "qwen25max", "qwen3max", "qwen3maxthinking", "qwen36maxpreview", "qwen37max", "qwen38max"]},
    {"family": "qwen-plus", "category": "llm", "chain": ["qwenplus", "qwen35plus", "qwen36plus", "qwen37plus"]},
    {"family": "qwen-flash", "category": "llm", "chain": ["qwenturbo", "qwenflash", "qwen35flash", "qwen36flash", "qwen37flash", "qwen38flash"]},
    {"family": "qwen-coder", "category": "code", "chain": ["qwen25coder32binstruct", "qwen3coder", "qwen3codernext"]},
    {"family": "qwen-vl", "category": "vision-language", "chain": ["qwenvl", "qwen25vl72binstruct", "qwen3vl235ba22binstruct"]},
    {"family": "qwq", "category": "reasoning", "chain": ["qwen25", "qwq32b"]},
    {"family": "qwen-omni", "category": "llm", "tags": ["omni"], "chain": ["qwen25omni7b", "qwen3omniflash", "qwen38omniflash"]},
    {"family": "qwen-image", "category": "image", "chain": ["qwenimage1", "qwenimage21"]},
    {"family": "qwen-audio", "category": "speech-tts", "chain": ["qwen3tts", "qwenaudio30tts", "qwenaudio31tts"]},
    {"family": "qwen-audio", "category": "speech-asr", "chain": ["qwen3asrflash", "qwenaudio31asr"]},
    {"family": "wan", "category": "video", "chain": ["wan21", "wan22", "wan25", "wan27", "wan30"]},
    {"family": "happyhorse", "category": "video", "chain": ["happyhorse10", "happyhorse11"]},
]

R = {
    "qwen3235ba22binstruct": {"displayName": "Qwen3-235B-A22B-Instruct-2507", "releaseDate": "2025-07-21", "ow": True, "sc": "catalog", "notes": "2507 refresh of Qwen3 flagship open weights; Thinking-2507 sibling 2025-07-25."},
    "qwen35397ba17b": {"displayName": "Qwen3.5-397B-A17B", "releaseDate": "2026-02-16", "ow": True, "notes": "models.dev 2026-02-15, OpenRouter 2026-02-16. Plus API sibling Qwen3.5-Plus."},
    "qwen3824ta95b": {
        "displayName": "Qwen3.8-2.4T-A95B",
        "releaseDate": "2026-08-12",
        "sc": "secondary",
        "sources": [Q38N],
        "releaseDateBasis": "secondary",
        "ow": True,
        "relation": "series-successor",
        "basis": "reported",
        "notes": "Open weights of Qwen3.8-Max (2.4T MoE, 95B active), minus image input / non-thinking mode; custom licence. Built on the Qwen3.5 architecture (blog).",
    },
    "qwen3527b": {"displayName": "Qwen3.5-27B", "releaseDate": "2026-02-23", "ow": True},
    "qwen3627b": {"displayName": "Qwen3.6-27B", "releaseDate": "2026-04-22", "ow": True},
    "qwen3827b": {"displayName": "Qwen3.8-27B", "releaseDate": "2026-08-14", "sc": "secondary", "sources": [Q38N], "releaseDateBasis": "secondary", "ow": True, "notes": "Dense 27B VLM, Apache-2.0; OpenRouter lists 2026-09-02 (models.dev 2026-08-14)."},
    "qwen3535ba3b": {"displayName": "Qwen3.5-35B-A3B", "releaseDate": "2026-02-23", "ow": True},
    "qwen3635ba3b": {"displayName": "Qwen3.6-35B-A3B", "releaseDate": "2026-04-17", "ow": True, "notes": "models.dev 2026-04-17; OpenRouter lists 2026-04-27."},
    "qwen38flashnext": {
        "displayName": "Qwen3.8-Flash-Next",
        "releaseDate": "2026-08-26",
        "sc": "official",
        "sources": [Q38FN, "https://huggingface.co/Qwen/Qwen3.8-Flash-Next"],
        "releaseDateBasis": "official",
        "ow": True,
        "notes": "Multimodal MoE, 125B total / 6B active; blog calls it an early preview of the architecture used in Qwen4. (models.dev lists 2026-08-27.)",
    },
    "qwen25max": {"displayName": "Qwen2.5-Max", "releaseDate": "2025-01-28", "sc": "background", "sources": ["https://qwenlm.github.io/blog/qwen2.5-max/"], "ow": False, "category": "llm"},
    "qwen3max": {"displayName": "Qwen3-Max", "releaseDate": "2025-09-23", "ow": False},
    "qwen3maxthinking": {"displayName": "Qwen3-Max-Thinking", "releaseDate": "2026-02-09", "ow": False, "category": "reasoning", "notes": "Thinking-mode release of Qwen3-Max (OpenRouter listing)."},
    "qwen36maxpreview": {"displayName": "Qwen3.6-Max-Preview", "releaseDate": "2026-04-20", "ow": False, "status": "superseded"},
    "qwen37max": {"displayName": "Qwen3.7-Max", "releaseDate": "2026-05-21", "ow": False},
    "qwen38max": {
        "displayName": "Qwen3.8-Max",
        "releaseDate": "2026-08-03",
        "sc": "official",
        "sources": [Q38, Q38N],
        "releaseDateBasis": "official",
        "ow": False,
        "notes": "Most capable Qwen to date; API 2026-08-03 (preview listed 2026-07-19/22), snapshot Qwen3.8-Max-0902 (09-02), open weights as Qwen3.8-2.4T-A95B. 'Max Prime' (OpenRouter 2026-09-23) not recorded (likely a speed tier, unverified).",
    },
    "qwenplus": {"displayName": "Qwen-Plus", "releaseDate": "2024-01-25", "ow": False, "notes": "Rolling API alias; 0728 snapshot 2025-07-28 (OpenRouter)."},
    "qwen35plus": {"displayName": "Qwen3.5-Plus", "releaseDate": "2026-02-16", "ow": False},
    "qwen36plus": {"displayName": "Qwen3.6-Plus", "releaseDate": "2026-04-02", "ow": False},
    "qwen37plus": {"displayName": "Qwen3.7-Plus", "releaseDate": "2026-06-02", "ow": False, "notes": "models.dev 2026-06-02, OpenRouter 2026-06-03."},
    "qwenturbo": {"displayName": "Qwen-Turbo", "releaseDate": "2024-11-01", "ow": False},
    "qwenflash": {"displayName": "Qwen-Flash", "releaseDate": "2025-07-28", "ow": False},
    "qwen35flash": {"displayName": "Qwen3.5-Flash", "releaseDate": "2026-02-23", "ow": False},
    "qwen36flash": {"displayName": "Qwen3.6-Flash", "releaseDate": "2026-04-27", "ow": False},
    "qwen37flash": {"displayName": "Qwen3.7-Flash", "releaseDate": "2026-07-15", "ow": False, "notes": "models.dev 2026-07-15; OpenRouter 2026-07-27."},
    "qwen38flash": {"displayName": "Qwen3.8-Flash", "releaseDate": "2026-08-26", "ow": False, "notes": "Hosted API tier; distinct from the open Qwen3.8-Flash-Next."},
    "qwen25coder32binstruct": {"displayName": "Qwen2.5-Coder", "releaseDate": "2024-11-12", "ow": True, "relation": "post-train", "basis": "reported", "parent": "qwen25", "notes": "0.5B-32B open code models built on Qwen2.5."},
    "qwen3coder": {"displayName": "Qwen3-Coder", "releaseDate": "2025-07-23", "ow": True, "notes": "480B-A35B open weights; Coder-Plus API 2025-07/09."},
    "qwen3codernext": {"displayName": "Qwen3-Coder-Next", "releaseDate": "2026-02-04", "ow": True},
    "qwen25vl72binstruct": {"displayName": "Qwen2.5-VL", "releaseDate": "2025-01-28", "sc": "background", "sources": ["https://qwenlm.github.io/blog/qwen2.5-vl/"], "ow": True, "releaseDateBasis": "background", "notes": "3B/7B/32B/72B; catalogs show 2024-09/2025-02."},
    "qwen3vl235ba22binstruct": {"displayName": "Qwen3-VL", "releaseDate": "2025-09-23", "ow": True, "notes": "235B-A22B first, smaller sizes through 2025-10."},
    "qwq32b": {"displayName": "QwQ-32B", "releaseDate": "2025-03-05", "ow": True, "relation": "post-train", "basis": "reported", "notes": "RL-trained from Qwen2.5-32B; preview 2024-11-28."},
    "qwen25omni7b": {"displayName": "Qwen2.5-Omni", "releaseDate": "2025-03-26", "releaseDateBasis": "background", "sc": "background", "sources": ["https://qwenlm.github.io/blog/qwen2.5-omni/"], "ow": True, "notes": "catalog says 2024-12; Qwen2.5-Omni-7B blog is dated 2025-03-26."},
    "qwen3omniflash": {"displayName": "Qwen3-Omni", "releaseDate": "2025-09-22", "sc": "background", "sources": ["https://github.com/QwenLM/Qwen3-Omni"], "releaseDateBasis": "background", "ow": True, "notes": "Open Qwen3-Omni 2025-09-22 (catalog 2025-09-15 is the Flash API)."},
    "qwen38omniflash": {
        "displayName": "Qwen3.8-Omni-Flash",
        "releaseDate": "2026-09-18",
        "sc": "secondary",
        "sources": [OMNI],
        "releaseDateBasis": "secondary",
        "ow": False,
        "parent": "qwen38flashnext",
        "relation": "post-train",
        "basis": "reported",
        "notes": "Native omnimodal, 1M context; built on Qwen3.8-Flash-Next (reported); OpenRouter lists 2026-09-21. No open weights.",
    },
    "qwen3asrflash": {"displayName": "Qwen3-ASR-Flash", "releaseDate": "2025-09-08", "ow": False, "catbasis": "models.dev: audio->text"},
    "wan21": {"displayName": "Wan 2.1", "releaseDate": "2025-02-25", "sc": "background", "sources": ["https://github.com/Wan-Video/Wan2.1"], "ow": True},
}

EXTRA = {
    "qwen1": {"displayName": "Qwen", "releaseDate": "2023-08-03", "sc": "background", "sources": ["https://github.com/QwenLM/Qwen"], "ow": True, "notes": "Qwen-7B open 2023-08-03; Tongyi Qianwen 1.0 service launched 2023-04-07; roster date 2023-08."},
    "qwen15": {"displayName": "Qwen1.5", "releaseDate": "2024-02-04", "sc": "background", "sources": ["https://qwenlm.github.io/blog/qwen1.5/"], "ow": True},
    "qwen2": {"displayName": "Qwen2", "releaseDate": "2024-06-07", "sc": "background", "sources": ["https://qwenlm.github.io/blog/qwen2/"], "ow": True},
    "qwen25": {"displayName": "Qwen2.5", "releaseDate": "2024-09-19", "sc": "background", "sources": ["https://qwenlm.github.io/blog/qwen2.5/"], "ow": True},
    "qwen3": {"displayName": "Qwen3", "releaseDate": "2025-04-29", "sc": "background", "sources": ["https://qwenlm.github.io/blog/qwen3/"], "ow": True, "notes": "Dense 0.6B-32B and MoE 30B-A3B/235B-A22B; hybrid thinking. OpenRouter lists 2025-04-28."},
    "qwenmax1": {"displayName": "Qwen-Max", "releaseDate": "2024-04-03", "releaseDateBasis": "catalog", "sc": "catalog", "sources": ["https://models.dev/"], "ow": False, "notes": "Closed flagship API line; models.dev date 2024-04-03."},
    "qwenvl": {"displayName": "Qwen-VL", "releaseDate": "2023-08-24", "sc": "background", "sources": ["https://github.com/QwenLM/Qwen-VL"], "ow": True},
    "qwenimage1": {"displayName": "Qwen-Image", "releaseDate": "2025-08-04", "sc": "background", "sources": ["https://github.com/QwenLM/Qwen-Image"], "ow": True, "catbasis": "official: text-to-image foundation model (20B MMDiT)", "notes": "Edit variant 2025-08-18; 2.0/2512 releases not recorded."},
    "qwenimage21": {
        "displayName": "Qwen-Image-2.1",
        "releaseDate": "2026-09-20",
        "sc": "secondary",
        "sources": [IMG21, "https://pandaily.com/alibaba-qwen-image-2-1-7b-rgba-open-weight"],
        "releaseDateBasis": "secondary",
        "ow": True,
        "catbasis": "text-to-image + editing, 7B open-weight, native RGBA",
        "notes": "Open-sourced 2026-09-20 (models.dev 2026-09-14 preview). Roster name 'Qwen-Image 3.1 / 2026-09-22' is wrong.",
    },
    "qwen3tts": {"displayName": "Qwen3-TTS", "releaseDate": "2026-01-22", "sc": "secondary", "sources": [TTS3], "ow": True, "catbasis": "text-to-speech (0.6B/1.7B), voice clone", "notes": "API Dec 2025; open weights 2026-01-22 (GitHub)."},
    "qwenaudio30tts": {"displayName": "Qwen-Audio-3.0-TTS", "releaseDate": "2026-07-20", "sc": "secondary", "sources": [AUD31], "ow": False, "notes": "Hosted Flash / Plus tiers, API-only."},
    "qwenaudio31tts": {
        "displayName": "Qwen-Audio-3.1-TTS",
        "releaseDate": "2026-09-23",
        "sc": "secondary",
        "sources": [AUD31, "https://x.com/Alibaba_Qwen/status/2102687258990026993"],
        "ow": False,
        "notes": "Announced at Apsara 2026-09-23 with ASR, ASR-Next, TTS-Next, Realtime (five-model Audio 3.1 stack).",
    },
    "qwenaudio31asr": {"displayName": "Qwen-Audio-3.1-ASR", "releaseDate": "2026-09-23", "sc": "secondary", "sources": [AUD31], "ow": False, "catbasis": "speech recognition; part of the Qwen-Audio-3.1 stack"},
    "wan22": {"displayName": "Wan 2.2", "releaseDate": "2025-07-28", "sc": "background", "sources": ["https://github.com/Wan-Video/Wan2.2"], "ow": True, "notes": "Last open-weights Wan (per reporting)."},
    "wan25": {"displayName": "Wan 2.5", "releaseDate": "2025-09-24", "sc": "background", "sources": ["https://wan.video/"], "ow": False, "notes": "Preview with native audio; day from memory."},
    "wan27": {"displayName": "Wan 2.7", "releaseDate": None, "releaseMonth": None, "sc": "secondary", "sources": [WAN3], "ow": False, "notes": "Predecessor of Wan3.0 (15-second clips) per TechNode; release date not verified. Wan2.7 Image 2026-05-29 (models.dev)."},
    "wan30": {
        "displayName": "Wan 3.0",
        "releaseDate": "2026-08-24",
        "sc": "secondary",
        "sources": [WAN3, "https://thenextweb.com/news/alibaba-wan3-video-model-after-share-sale"],
        "releaseDateBasis": "secondary",
        "ow": False,
        "notes": "Public beta 2026-08-06, formal release 2026-08-24; 30-second clips, doc/slide input, no open weights.",
    },
    "happyhorse10": {"displayName": "HappyHorse 1.0", "releaseDate": "2026-04-07", "sc": "background", "sources": ["https://models.dev/"], "ow": False, "catbasis": "video generation (Alibaba ATH)", "notes": "Date from roster; not verified here (models.dev lists HappyHorse 1.1 video endpoints 2026-07-17)."},
    "happyhorse11": {"displayName": "HappyHorse 1.1", "releaseDate": "2026-07-17", "sc": "catalog", "sources": ["https://models.dev/"], "ow": False, "catbasis": "models.dev: text/image->video"},
}

SPECIES = {
    "qwen-1": "qwen1",
    "qwen2-5": "qwen25",
    "qwen3-8-max": "qwen38max",
    "qwen-flash-next": "qwen38flashnext",
    "qwen-image": "qwenimage21",
    "qwen-audio": "qwenaudio31tts",
    "wan-2-1": "wan21",
    "wan-3": "wan30",
    "happyhorse": "happyhorse11",
}

IGNORE_RE = [
    r"deepseek", r"kimi|moonshot", r"glm|minimax", r"character|Intent|Doc Turbo|Deep Research|Math|Long$|MT |OCR",
    r"Qwen3 (14B|32B|8B|30B)|Qwen3-VL (30B|8B|32B|235B-A22B (Thinking))|Coder (30B|Flash|Plus|480B)|Next 80B|25 ?VL 7B|Qwen2.5 (7B|14B|32B|72B)|Coder.*(7B|0.5B)",
    r"Qwen3.5 (9B|122B|Plus 20)|Qwen: Qwen3.5-(9B|122B)|Qwen3.5-122B|Qwen3.5-9B", r"Plus 2026-04-20|Plus 2026-02-15|Flash 0223|Flash-0223|Qwen3.5-Flash$",
    r"Omni Turbo|Realtime|LiveTranslate|QwQ Plus|QVQ|VL (Plus|Max|OCR)|Qwen3-VL Plus|Qwen3 VL Plus|Qwen-VL Plus|Thinking 2507|Thinking$|Instruct 2507 \(|Qwen3 Max Thinking$",
    r"Qwen3.8 Max Preview|Qwen3.8 Max Prime|Coder Flash",
]

EXCLUDED = [
    "Qwen size variants (0.5B-72B, 3B-32B, 4B/8B/14B/30B-A3B etc.), 2507 Thinking/Instruct splits, Math/Plus-Character/Doc/DeepResearch/MT/OCR/LiveTranslate SKUs, third-party hosted copies of DeepSeek/Kimi/GLM/MiniMax in the Alibaba catalogs.",
    "Qwen3.8-Max-Preview (2026-07-19/22) and Qwen3.8-Max-0902 snapshot: folded into Qwen3.8-Max; Qwen3.8-Max-Prime (OpenRouter 2026-09-23): unverified, probably a serving tier.",
]

GAPS = [
    "Qwen-Image 2.0 / 2512 / Edit versions, Wan 2.6 and Wan 2.7 dates, Qwen3.5-Omni, Qwen3-Embedding / Reranker not recorded.",
    "Qwen 1/1.5/2/2.5/3 dates are from memory with official blog links not re-opened this session (sourceCheck=background).",
    "Qwen3.8-Max-Prime meaning unverified.",
]

IGNORE = {
    "qwenmax",
    "qwen25vl7binstruct",
    "qwen3235ba22b",
    "qwen3vl235ba22b",
    "qwen3vl30ba3binstruct",
    "qwen3vl8binstruct",
    "qwen3vl32binstruct",
}


# roster product record
LINES.append({"family": 'qwen-app', "category": 'agent', "chain": ['qwenapp']})
EXTRA['qwenapp'] = {'displayName': 'Qwen App', 'releaseDate': '', 'sc': 'background', 'sources': ['https://qwen.ai'], 'ow': False, 'catbasis': 'consumer AI app (roster description)', 'notes': 'Product record for a roster entry; date from the roster, not verified (search budget exhausted). Consumer app (formerly Tongyi app, renamed Qwen in Nov 2025); selected as the China Apple Intelligence model in July 2026 (roster, unverified).', 'releaseMonth': '2025-11'}
SPECIES['qwen-app'] = 'qwenapp'


# roster product record
LINES.append({"family": 'qoder', "category": 'agent', "chain": ['qoder']})
EXTRA['qoder'] = {'displayName': 'Qoder', 'releaseDate': '2025-08-21', 'sc': 'background', 'sources': ['https://qoder.com'], 'ow': False, 'catbasis': 'agentic IDE product (roster description)', 'notes': 'Product record for a roster entry; date from the roster, not verified (search budget exhausted). Agentic IDE; separate line from Tongyi Lingma; Qoder CN in China from May 2026.'}
SPECIES['qoder'] = 'qoder'


# roster product record
LINES.append({"family": 'happyoyster', "category": 'world', "chain": ['happyoyster']})
EXTRA['happyoyster'] = {'displayName': 'HappyOyster', 'releaseDate': '2026-06-17', 'sc': 'background', 'sources': ['https://models.dev/'], 'ow': False, 'catbasis': 'interactive world model (roster description); roster category is other', 'notes': "Product record for a roster entry; date from the roster, not verified (search budget exhausted). Open-ended interactive world model of Alibaba ATH's 'Happy' family (1.0 on 2026-06-17; 2.0 preview 2026-09-22 per roster)."}
SPECIES['happyoyster'] = 'happyoyster'


# roster product record
LINES.append({"family": 'happyshrimp', "category": 'music', "chain": ['happyshrimp']})
EXTRA['happyshrimp'] = {'displayName': 'HappyShrimp', 'releaseDate': '', 'sc': 'background', 'sources': ['https://models.dev/'], 'ow': False, 'catbasis': 'AI music generation platform (roster description)', 'notes': "Product record for a roster entry; date from the roster, not verified (search budget exhausted). AI music platform ('Suno of China'): 1.0 in August 2026, 1.1 in September.", 'releaseMonth': '2026-08'}
SPECIES['happyshrimp'] = 'happyshrimp'
