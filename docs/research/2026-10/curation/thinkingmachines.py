VENDOR = {"key": "thinkingmachines", "name": "Thinking Machines Lab", "nameZh": "Thinking Machines Lab", "country": "US", "homepage": "https://thinkingmachines.ai", "officialModelListUrl": "https://thinkingmachines.ai", "changelogUrl": "https://thinkingmachines.ai/blog/", "notes": "Inkling is the lab's first released model family; dates are models.dev/OpenRouter listings."}
LINES = [
    {"family": "inkling", "category": "llm", "chain": ["inkling"]},
    {"family": "inkling", "category": "llm", "chain": ["inklingsmall"]},
]
R = {
    "inkling": {"displayName": "Inkling", "releaseDate": "2026-07-15", "ow": True, "catbasis": "multimodal MoE (975B total / 41B active), text output; OpenRouter description", "notes": "Open-weight; OpenRouter lists 2026-08-15."},
    "inklingsmall": {"displayName": "Inkling Small", "releaseDate": "2026-07-30", "ow": True, "catbasis": "multimodal MoE (276B total / 12B active)", "notes": "Smaller sibling of Inkling."},
}
EXTRA = {}
SPECIES = {"inkling": "inkling"}
IGNORE = set()
EXCLUDED = ["Tinker fine-tuning API (product, 2025-10)."]
GAPS = ["No thinkingmachines.ai page opened; roster category 'multimodal' mapped to llm (text output)."]
