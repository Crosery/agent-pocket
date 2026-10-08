VENDOR = {"key": "inception", "name": "Inception Labs (Mercury)", "nameZh": "Inception Labs Mercury", "country": "US", "homepage": "https://www.inceptionlabs.ai", "officialModelListUrl": "https://docs.inceptionlabs.ai", "changelogUrl": "https://www.inceptionlabs.ai/blog", "notes": "Diffusion LLM (dLLM) line."}
LINES = [
    {"family": "mercury", "category": "reasoning", "chain": ["mercury2", "mercury25"]},
    {"family": "mercury-edit", "category": "code", "chain": ["mercuryedit2"]},
]
R = {
    "mercury2": {"displayName": "Mercury 2", "releaseDate": "2026-02-24", "ow": False, "catbasis": "OpenRouter: first reasoning diffusion LLM", "notes": "OpenRouter 03-04."},
    "mercury25": {"displayName": "Mercury 2.5", "releaseDate": "2026-09-08", "ow": False, "catbasis": "OpenRouter: latest diffusion reasoning LLM"},
    "mercuryedit2": {"displayName": "Mercury Edit 2", "releaseDate": "2026-03-30", "ow": False, "catbasis": "code-edit model (name; unverified)"},
}
EXTRA = {}
SPECIES = {}
IGNORE = set()
EXCLUDED = []
GAPS = ["Mercury 1 / Mercury Coder (2025) not recorded."]
