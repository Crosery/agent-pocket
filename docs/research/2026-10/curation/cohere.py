VENDOR = {
    "key": "cohere",
    "name": "Cohere",
    "nameZh": "Cohere",
    "country": "CA",
    "homepage": "https://cohere.com",
    "officialModelListUrl": "https://docs.cohere.com/docs/models",
    "changelogUrl": "https://docs.cohere.com/changelog",
    "notes": "Cohere merger agreement with Aleph Alpha announced 2026-09-16 (reported).",
}
A = "https://docs.cohere.com/docs/command-a-plus"
AB = "https://cohere.com/blog/cohere-releases-command-a-plus"
BK = "https://betakit.com/cohere-releases-its-most-powerful-ai-model-as-open-source/"

LINES = [
    {"family": "command", "category": "llm", "chain": ["commandrplus", "commanda", "commandaplus"]},
    {"family": "command-r", "category": "llm", "chain": ["commandr"]},
    {"family": "command-r", "category": "llm", "chain": ["commandr7b"]},
    {"family": "command-a-variants", "category": "vision-language", "chain": ["commandavision"]},
    {"family": "command-a-variants", "category": "reasoning", "chain": ["commandareasoning"]},
    {"family": "command-a-variants", "category": "llm", "tags": ["translate"], "chain": ["commandatranslate"]},
    {"family": "aya", "category": "llm", "chain": ["c4aiayaexpanse32b", "tinyayaglobal"]},
    {"family": "aya", "category": "vision-language", "chain": ["c4aiayavision32b"]},
    {"family": "north", "category": "code", "chain": ["northminicode10"]},
    {"family": "north", "category": "llm", "tags": ["translate"], "chain": ["northsmalltranslate10"]},
    {"family": "cohere-embed", "category": "embedding", "chain": ["embed4", "embed5"]},
]

R = {
    "commandr": {"displayName": "Command R", "releaseDate": "2024-03-11", "sc": "background", "releaseDateBasis": "background", "sources": ["https://cohere.com/blog/command-r"], "ow": True, "notes": "Open weights are non-commercial (CC-BY-NC); 08-2024 refresh is the catalog date."},
    "commandrplus": {"displayName": "Command R+", "releaseDate": "2024-04-04", "sc": "background", "releaseDateBasis": "background", "sources": ["https://cohere.com/blog/command-r-plus-microsoft-azure"], "ow": True, "notes": "104B; 08-2024 refresh is the catalog date."},
    "commandr7b": {"displayName": "Command R7B", "releaseDate": "2024-12-13", "sc": "background", "releaseDateBasis": "background", "sources": ["https://cohere.com/blog/command-r7b"], "ow": True},
    "commanda": {
        "displayName": "Command A",
        "releaseDate": "2025-03-13",
        "ow": True,
        "relation": "successor",
        "basis": "reported",
        "sc": "secondary",
        "sources": ["https://cohere.com/blog/command-a"],
        "notes": "111B, positioned as the successor to Command R+; weights CC-BY-NC.",
    },
    "commandaplus": {
        "displayName": "Command A+",
        "releaseDate": "2026-05-20",
        "sc": "official",
        "releaseDateBasis": "official",
        "sources": [A, AB, BK],
        "ow": True,
        "relation": "successor",
        "basis": "reported",
        "notes": "218B-A25B MoE (Cohere blog says 24B active), Apache 2.0, text+image in; first Cohere MoE. The 2026-09-22 date seen on OpenRouter/aggregators is a listing date. Newest Cohere flagship.",
    },
    "commandavision": {"displayName": "Command A Vision", "releaseDate": "2025-07-31", "ow": True, "parent": "commanda", "relation": "successor", "basis": "reported", "catbasis": "vision-language variant of Command A (image+text in)"},
    "commandareasoning": {"displayName": "Command A Reasoning", "releaseDate": "2025-08-21", "ow": True, "parent": "commanda", "relation": "post-train", "basis": "reported", "category": "reasoning", "catbasis": "Cohere's reasoning model for agentic work, built on Command A"},
    "commandatranslate": {"displayName": "Command A Translate", "releaseDate": "2025-08-28", "ow": True, "parent": "commanda", "relation": "post-train", "basis": "reported", "catbasis": "text-to-text translation LLM (output is text)"},
    "c4aiayaexpanse32b": {"displayName": "Aya Expanse 32B", "releaseDate": "2024-10-24", "ow": True},
    "c4aiayavision32b": {"displayName": "Aya Vision 32B", "releaseDate": "2025-03-04", "ow": True, "parent": "c4aiayaexpanse32b", "relation": "successor", "basis": "reported", "notes": "Language backbone believed to be Aya Expanse 32B ([unverified])."},
    "tinyayaglobal": {"displayName": "Tiny Aya", "releaseDate": "2026-02-17", "ow": True, "notes": "Small multilingual family (Global, Earth, Fire, Water regional variants all 2026-02-17); Global kept as representative."},
    "northminicode10": {"displayName": "North Mini Code", "releaseDate": "2026-06-09", "ow": True, "category": "code", "catbasis": "coding model (name + models.dev listing)"},
    "northsmalltranslate10": {"displayName": "North Small Translate", "releaseDate": "2026-09-09", "ow": True, "notes": "Open MoE translation model; 2026-09-10 in one secondary source."},
}

EXTRA = {
    "embed4": {"displayName": "Embed 4", "releaseDate": "2025-04-15", "sc": "background", "sources": ["https://cohere.com/blog/embed-4"], "ow": False, "notes": "Multimodal embedding model."},
    "embed5": {"displayName": "Embed 5", "releaseMonth": "2026-09", "releaseDate": None, "sc": "secondary", "sources": ["https://cohere.com/blog"], "ow": False, "notes": "Mentioned in a September-2026 news roundup; day not verified."},
}

SPECIES = {}
IGNORE = {"commandr7barabic", "tinyayaearth", "tinyayafire", "tinyayawater"}
EXCLUDED = ["Command R7B Arabic, Tiny Aya regional variants (Earth/Fire/Water), dated Command R/R+ snapshots, Rerank models."]
GAPS = ["Embed 5 day, Cohere Rerank 4 and North platform products not recorded.", "Aya Vision backbone, Command A Reasoning/Translate parent are reported-only."]
