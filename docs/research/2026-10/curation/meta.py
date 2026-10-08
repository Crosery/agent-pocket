VENDOR = {
    "key": "meta",
    "name": "Meta",
    "nameZh": "Meta",
    "country": "US",
    "homepage": "https://ai.meta.com",
    "officialModelListUrl": "https://huggingface.co/meta-llama",
    "changelogUrl": "https://ai.meta.com/blog/",
    "notes": "Llama (open) was replaced by the closed Muse family from Meta Superintelligence Labs in April 2026; open weights returned with Muse Glimmer (2026-08-10).",
}
MUSE = "https://zapier.com/blog/llama-meta/"
GLIM = "https://www.cnbc.com/2026/08/10/meta-muse-glimmer-open-weight-ai.html"

LINES = [
    {"family": "llama", "category": "llm", "chain": ["llama1", "llama2", "llama3", "llama31", "llama32", "llama33", "llama4"], "tags": ["open-weights"]},
    {"family": "muse", "category": "llm", "chain": ["musespark10", "musespark11", "musespark12", "musespark13"]},
    {"family": "muse-glimmer", "category": "llm", "chain": ["museglimmer30b"], "tags": ["open-weights"]},
    {"family": "muse-image", "category": "image", "chain": ["museimage10"]},
    {"family": "muse-code", "category": "agent", "tags": ["coding"], "chain": ["musecode"]},
]

R = {
    "llama31": {"displayName": "Llama 3.1", "releaseDate": "2024-07-23", "sc": "secondary", "sources": ["https://en.wikipedia.org/wiki/Llama_(language_model)"], "ow": True, "notes": "8B/70B/405B."},
    "llama32": {"displayName": "Llama 3.2", "releaseDate": "2024-09-25", "sc": "secondary", "sources": ["https://en.wikipedia.org/wiki/Llama_(language_model)"], "ow": True, "notes": "1B/3B text, 11B/90B vision."},
    "llama33": {"displayName": "Llama 3.3", "releaseDate": "2024-12-07", "sc": "secondary", "sources": ["https://en.wikipedia.org/wiki/Llama_(language_model)"], "ow": True, "notes": "70B (8B listed by models.dev). Wikipedia: 2024-12-07; catalogs 2024-12-06."},
    "llama4": {"displayName": "Llama 4", "releaseDate": "2025-04-05", "sc": "secondary", "sources": ["https://en.wikipedia.org/wiki/Llama_(language_model)"], "ow": True, "notes": "Scout (109B/17B-active) and Maverick (400B/17B-active); Behemoth not released."},
    "musespark11": {"displayName": "Muse Spark 1.1", "releaseDate": "2026-07-16", "releaseDateBasis": "catalog", "notes": "OpenRouter 2026-07-16; models.dev shows 2026-04-08 (that is the original Muse Spark launch date)."},
    "musespark12": {"displayName": "Muse Spark 1.2", "releaseDate": "2026-08-05", "sc": "secondary", "sources": [MUSE], "notes": "Shipped with Muse Code (beta). Open weights promised 2026-08-10, unconfirmed as of early September."},
    "musespark13": {"displayName": "Muse Spark 1.3", "releaseDate": "2026-09-02", "notes": "Proprietary; a 'Contributor' data-sharing SKU exists (not recorded)."},
    "museglimmer30b": {"displayName": "Muse Glimmer", "releaseDate": "2026-08-10", "sc": "secondary", "sources": [GLIM], "ow": True, "tags": ["30b"], "notes": "30B multimodal open-weights (Apache 2.0), first open release since Llama 4; runs in ~24GB VRAM."},
}

EXTRA = {
    "llama1": {"displayName": "LLaMA", "releaseDate": "2023-02-24", "sc": "background", "sources": ["https://ai.meta.com/blog/large-language-model-llama-meta-ai/"], "ow": True, "notes": "Research-only weights; leaked days later."},
    "llama2": {"displayName": "Llama 2", "releaseDate": "2023-07-18", "sc": "background", "sources": ["https://ai.meta.com/blog/llama-2/"], "ow": True},
    "llama3": {"displayName": "Llama 3", "releaseDate": "2024-04-18", "sc": "background", "sources": ["https://ai.meta.com/blog/meta-llama-3/"], "ow": True},
    "musespark10": {
        "displayName": "Muse Spark",
        "releaseDate": "2026-04-08",
        "sc": "secondary",
        "sources": [MUSE, "https://thenewstack.io/meta-abandons-llama-spark/"],
        "ow": False,
        "parent": "llama4",
        "relation": "series-successor",
        "basis": "reported",
        "notes": "First Meta Superintelligence Labs model, built from scratch (not a Llama checkpoint) and closed; positioned as Llama's replacement.",
    },
    "museimage10": {"displayName": "Muse Image 1.0", "releaseDate": "2026-08-26", "sc": "catalog", "sources": ["https://models.dev/"], "ow": False, "catbasis": "models.dev: text,image->image", "notes": "models.dev only (~muse-image-1.0); no official page opened."},
    "musecode": {"displayName": "Muse Code", "releaseDate": "2026-08-05", "sc": "secondary", "sources": [MUSE], "ow": False, "catbasis": "coding agent", "notes": "Coding agent beta released with Muse Spark 1.2."},
}

SPECIES = {
    "llama-1": "llama1",
    "llama-3-1": "llama31",
    "llama-4": "llama4",
    "muse-spark": "musespark13",
}

IGNORE = {
    "llama3170binstruct", "llama318binstruct", "llamaguard38b", "llama3211bvisioninstruct", "llama321b", "llama321binstruct",
    "llama323b", "llama323binstruct", "llama3370binstruct", "llama338binstruct", "cerebrasllama4maverick17b128einstruct",
    "cerebrasllama4scout17b16einstruct", "groqllama4maverick17b128einstruct", "llama4maverick", "llama4maverick17binstruct",
    "llama4scout", "llama4scout17binstruct", "llamaguard412b", "musespark12contributor", "musespark13contributor",
}

EXCLUDED = ["Llama size variants (8B/70B/405B, Scout/Maverick), Llama Guard, Cerebras/Groq re-hosts, Muse Spark 'Contributor' SKUs."]

GAPS = ["Llama 2/3 and LLaMA dates are well-known history (not re-fetched). 'Meta Muse' agent and Moltbook roster items are covered in products.py."]


# roster product record
LINES.append({"family": 'meta-muse-app', "category": 'agent', "chain": ['metamuseapp']})
EXTRA['metamuseapp'] = {'displayName': 'Meta Muse (app)', 'releaseDate': '2026-09-08', 'sc': 'background', 'sources': ['https://www.meta.ai'], 'ow': False, 'catbasis': 'consumer personal-agent app (roster description)', 'notes': 'Product record for a roster entry; date from the roster, not verified (search budget exhausted). Personal-agent app built on Muse Spark; Muse Code (2026-08-05) is the coding sibling.'}
SPECIES['meta-muse'] = 'metamuseapp'
