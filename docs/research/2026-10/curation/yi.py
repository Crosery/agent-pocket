VENDOR = {"key": "yi", "name": "01.AI", "nameZh": "零一万物", "country": "CN", "homepage": "https://www.lingyiwanwu.com", "officialModelListUrl": "https://huggingface.co/01-ai", "changelogUrl": "https://github.com/01-ai/Yi", "notes": "01.AI pivoted away from frontier pre-training in early 2025; line is historical."}
GH = "https://github.com/01-ai/Yi"
LINES = [{"family": "yi", "category": "llm", "chain": ["yi", "yi15", "yilightning"]}]
EXTRA = {
    "yi": {"displayName": "Yi-34B", "releaseDate": "2023-11-02", "sc": "background", "sources": [GH], "ow": True, "status": "superseded"},
    "yi15": {"displayName": "Yi-1.5", "releaseDate": "2024-05-13", "sc": "background", "sources": [GH], "ow": True, "relation": "post-train", "basis": "reported", "status": "superseded", "notes": "Continued pre-training of Yi (prior research)."},
    "yilightning": {"displayName": "Yi-Lightning", "releaseDate": "2024-10-16", "sc": "background", "sources": [GH], "ow": False, "status": "superseded"},
}
SPECIES = {}
IGNORE = set()
EXCLUDED = ["Yi-Coder, Yi-VL."]
GAPS = ["Recalled dates, unverified."]
