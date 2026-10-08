VENDOR = {"key": "perplexity", "name": "Perplexity", "nameZh": "Perplexity", "country": "US", "homepage": "https://www.perplexity.ai", "officialModelListUrl": "https://docs.perplexity.ai/guides/models", "changelogUrl": "https://docs.perplexity.ai/changelog/changelog", "notes": "Products (answer engine, Comet, Computer) are agent-category product records; Sonar are API models."}
WIKI = "https://en.wikipedia.org/wiki/Perplexity_AI"

LINES = [
    {"family": "perplexity-product", "category": "agent", "chain": ["perplexity", "comet", "computer"]},
    {"family": "sonar", "category": "llm", "chain": ["sonar", "sonarpro", "sonarprosearch"]},
    {"family": "sonar", "category": "reasoning", "chain": ["sonarreasoningpro"]},
    {"family": "sonar", "category": "agent", "chain": ["sonardeepresearch"]},
    {"family": "r1-1776", "category": "reasoning", "chain": ["r11776"]},
]

R = {
    "sonar": {"displayName": "Sonar", "releaseDate": "2025-01-21", "sc": "background", "releaseDateBasis": "background", "sources": [WIKI], "ow": False, "parentExternal": {"name": "Llama 3.3 70B", "vendor": "meta", "url": WIKI}, "relation": "post-train", "basis": "reported", "notes": "Search-grounded model built on Llama 3.3 (Wikipedia; blog dated 2025-02-12). API launch day recalled 2025-01-21; OpenRouter lists 2025-01-27."},
    "sonarpro": {"displayName": "Sonar Pro", "releaseDate": "2025-01-21", "sc": "background", "releaseDateBasis": "background", "sources": ["https://docs.perplexity.ai/guides/models"], "ow": False, "notes": "Launched with Sonar (recalled); OpenRouter lists 2025-03-07."},
    "sonarprosearch": {"displayName": "Sonar Pro Search", "releaseDate": "2025-10-30", "ow": False, "notes": "OpenRouter-exclusive agentic search mode; listing date."},
    "sonarreasoningpro": {"displayName": "Sonar Reasoning Pro", "releaseDate": "2025-03-07", "ow": False, "parentExternal": {"name": "DeepSeek R1", "vendor": "deepseek", "url": "https://openrouter.ai/perplexity/sonar-reasoning-pro"}, "relation": "post-train", "basis": "reported", "notes": "OpenRouter: 'powered by DeepSeek R1'."},
    "sonardeepresearch": {"displayName": "Sonar Deep Research", "releaseDate": "2025-02-14", "sc": "background", "releaseDateBasis": "background", "sources": ["https://openrouter.ai/perplexity/sonar-deep-research"], "ow": False, "catbasis": "multi-step research agent model (OpenRouter description)", "notes": "Date recalled; OpenRouter lists 2025-03-07."},
}

EXTRA = {
    "perplexity": {"displayName": "Perplexity (answer engine)", "releaseDate": "2022-12-07", "sc": "secondary", "sources": [WIKI], "ow": False, "catbasis": "AI answer engine product", "notes": "Roster category 'search' has no lineage equivalent; recorded as an agent product."},
    "comet": {"displayName": "Perplexity Comet", "releaseDate": "2025-07-09", "sc": "secondary", "sources": [WIKI], "ow": False, "catbasis": "agentic browser product", "notes": "Wikipedia: July 2025 (limited), free download Oct 2025; day from roster."},
    "computer": {"displayName": "Perplexity Computer", "releaseDate": "2026-02-25", "sc": "secondary", "sources": [WIKI], "ow": False, "catbasis": "multi-model AI agent product", "notes": "Wikipedia: February 2026; day from roster; local 'Personal Computer' April 2026."},
    "r11776": {"displayName": "R1 1776", "releaseDate": "2025-02-18", "sc": "secondary", "sources": [WIKI], "ow": True, "parentExternal": {"name": "DeepSeek R1", "vendor": "deepseek", "url": WIKI}, "relation": "post-train", "basis": "reported", "notes": "Post-trained DeepSeek R1 (Wikipedia). Day recalled."},
}
SPECIES = {"perplexity": "perplexity", "perplexity-comet": "comet", "perplexity-computer": "computer"}
IGNORE = set()
EXCLUDED = ["Sonar 2 (listed on Wikipedia without a date), Sonar Reasoning (non-Pro)."]
GAPS = ["Sonar API launch days recalled; Sonar 2 not verified."]
