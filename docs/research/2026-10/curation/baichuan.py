VENDOR = {"key": "baichuan", "name": "Baichuan AI", "nameZh": "百川智能", "country": "CN", "homepage": "https://www.baichuan-ai.com", "officialModelListUrl": "https://platform.baichuan-ai.com/docs", "changelogUrl": "https://www.baichuan-ai.com", "notes": "Wikipedia gives only month-level dates for Baichuan 1-4; the company shifted to healthcare AI in March 2025."}
W = "https://en.wikipedia.org/wiki/Baichuan"
LINES = [
    {"family": "baichuan", "category": "llm", "chain": ["b1", "b2", "b3", "b4"]},
    {"family": "baichuan-m", "category": "llm", "chain": ["m1", "m2", "m3"]},
]
EXTRA = {
    "b1": {"displayName": "Baichuan-7B", "releaseMonth": "2023-06", "releaseDate": None, "sc": "secondary", "sources": [W], "ow": True, "notes": "Wikipedia: 'Baichuan1', June 2023."},
    "b2": {"displayName": "Baichuan 2", "releaseDate": "2023-09-06", "sc": "background", "sources": [W], "ow": True, "notes": "Open 7B/13B on 2023-09-06 (roster); Wikipedia says November 2023 (192K context version)."},
    "b3": {"displayName": "Baichuan 3", "releaseMonth": "2024-01", "releaseDate": None, "sc": "secondary", "sources": [W], "ow": False, "notes": "Reported as >1T parameters."},
    "b4": {"displayName": "Baichuan 4", "releaseMonth": "2024-05", "releaseDate": None, "sc": "secondary", "sources": [W], "ow": False},
    "m1": {"displayName": "Baichuan-M1", "releaseDate": "2025-01-23", "sc": "background", "sources": ["https://huggingface.co/baichuan-inc"], "ow": True, "catbasis": "medical LLM (company healthcare pivot)", "notes": "Recalled, not verified."},
    "m2": {"displayName": "Baichuan-M2", "releaseDate": "2025-08-11", "sc": "background", "sources": ["https://huggingface.co/baichuan-inc"], "ow": True, "parentExternal": {"name": "Qwen2.5-32B", "vendor": "alibaba", "url": "https://huggingface.co/baichuan-inc"}, "relation": "post-train", "basis": "reported", "notes": "Medical post-train of Qwen2.5-32B (recalled model card; [unverified])."},
    "m3": {"displayName": "Baichuan-M3", "releaseMonth": "2026-01", "releaseDate": None, "sc": "background", "sources": ["https://huggingface.co/baichuan-inc"], "ow": None, "notes": "Roster/prior research: 2026-01; not verified."},
}
SPECIES = {"baichuan-2": "b2", "baichuan-m3": "m3"}
IGNORE = set()
EXCLUDED = []
GAPS = ["M-line facts recalled. Roster chain baichuan-2 -> baichuan-m3 mixes the general line with the separate medical M line."]
