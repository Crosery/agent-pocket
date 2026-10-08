VENDOR = {"key": "huawei", "name": "Huawei (Pangu)", "nameZh": "华为 盘古", "country": "CN", "homepage": "https://www.huaweicloud.com/product/pangu.html", "officialModelListUrl": "https://gitcode.com/ascend-tribe", "changelogUrl": "https://www.huawei.com", "notes": "Wikipedia 'Huawei Pangu' page 404; dates recalled or from roster."}
LINES = [
    {"family": "pangu", "category": "llm", "chain": ["p3", "p5", "p55"]},
    {"family": "openpangu", "category": "llm", "chain": ["op", "op2pro"]},
]
EXTRA = {
    "p3": {"displayName": "Pangu 3.0", "releaseDate": "2023-07-07", "sc": "background", "sources": ["https://www.huaweicloud.com/product/pangu.html"], "ow": False, "notes": "HDC 2023 (recalled)."},
    "p5": {"displayName": "Pangu 5.0", "releaseDate": "2024-06-21", "sc": "background", "sources": ["https://www.huaweicloud.com/product/pangu.html"], "ow": False, "notes": "HDC 2024 (recalled)."},
    "p55": {"displayName": "Pangu 5.5", "releaseDate": "2025-06-20", "sc": "background", "sources": ["https://www.huaweicloud.com/product/pangu.html"], "ow": False, "notes": "HDC 2025; date from the roster."},
    "op": {"displayName": "openPangu", "releaseDate": "2025-06-30", "sc": "background", "sources": ["https://gitcode.com/ascend-tribe"], "ow": True, "notes": "Open-weights Pangu models (Embedded-7B and Pro-MoE-72B) released around 2025-06-30 (recalled)."},
    "op2pro": {"displayName": "openPangu 2.0 Pro", "releaseMonth": "2026-07", "releaseDate": None, "sc": "background", "sources": ["https://gitcode.com/ascend-tribe"], "ow": True, "notes": "Roster says 2026-07-31; not verified."},
}
SPECIES = {"pangu": "p55", "openpangu": "op2pro"}
IGNORE = set()
EXCLUDED = []
GAPS = ["Whole vendor from recall/roster; relation between Pangu 5.5 and openPangu not stated (roster calls it post-training; unverified)."]
