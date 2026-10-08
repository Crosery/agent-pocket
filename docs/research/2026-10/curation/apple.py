VENDOR = {"key": "apple", "name": "Apple", "nameZh": "苹果", "country": "US", "homepage": "https://machinelearning.apple.com", "officialModelListUrl": "https://machinelearning.apple.com/research/introducing-apple-foundation-models", "changelogUrl": "https://machinelearning.apple.com/", "notes": "Dates and AFM 3 claims from the Wikipedia 'Apple Intelligence' article; Apple's own pages not opened."}
W = "https://en.wikipedia.org/wiki/Apple_Intelligence"
LINES = [{"family": "afm", "category": "llm", "chain": ["afm1", "afm2", "afm3"]}]
EXTRA = {
    "afm1": {"displayName": "Apple Foundation Models (AFM 1)", "releaseDate": "2024-06-10", "sc": "secondary", "sources": [W], "ow": False, "notes": "Announced at WWDC 2024-06-10; dev betas 2024-07-29, launch 2024-10-28. On-device + server model with adapters."},
    "afm2": {"displayName": "Apple Foundation Models (AFM 2)", "releaseDate": "2025-06-09", "sc": "secondary", "sources": [W], "ow": False, "notes": "WWDC 2025; Foundation Models API for third-party apps."},
    "afm3": {"displayName": "Apple Foundation Models 3 (AFM 3)", "releaseDate": "2026-06-08", "sc": "secondary", "sources": [W], "ow": False, "notes": "WWDC 2026; five models (Core 3B on-device, Core Advanced 20B, Cloud, Cloud Pro on NVIDIA GPUs in Google Cloud, image model). Per Apple: trained on proprietary data with RL and refined with outputs from Gemini frontier models; Siri 'built with Google Gemini technology'. Not a Gemini model itself, so the roster label 'Gemini-backed' overstates."},
}
SPECIES = {"apple-afm": "afm3"}
IGNORE = set()
EXCLUDED = ["Apple Intelligence / Siri as products, OpenELM, FastVLM, MLX."]
GAPS = ["AFM 3 / Gemini relationship rests on one Wikipedia summary; Apple blog not opened."]
