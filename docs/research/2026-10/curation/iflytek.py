VENDOR = {"key": "iflytek", "name": "iFlytek (Spark)", "nameZh": "科大讯飞 星火", "country": "CN", "homepage": "https://xinghuo.xfyun.cn", "officialModelListUrl": "https://www.xfyun.cn/doc/spark/Web.html", "changelogUrl": "https://www.xfyun.cn", "notes": "Wikipedia iFlytek covers V1.0 to X1 only; X1.5, X2 and X2.5 are not verified."}
W = "https://en.wikipedia.org/wiki/IFlytek"
LINES = [{"family": "spark", "category": "llm", "chain": ["v10", "v20", "v30", "v35", "v40", "x1", "x25"]}]
EXTRA = {
    "v10": {"displayName": "Spark V1.0", "releaseDate": "2023-05-06", "sc": "secondary", "sources": [W], "ow": False, "notes": "Unveiled 2023-05-06; public in September 2023."},
    "v20": {"displayName": "Spark V2.0", "releaseMonth": "2023-08", "releaseDate": None, "sc": "secondary", "sources": [W], "ow": False},
    "v30": {"displayName": "Spark V3.0", "releaseMonth": "2023-10", "releaseDate": None, "sc": "secondary", "sources": [W], "ow": False},
    "v35": {"displayName": "Spark V3.5", "releaseMonth": "2024-01", "releaseDate": None, "sc": "secondary", "sources": [W], "ow": False},
    "v40": {"displayName": "Spark V4.0", "releaseDate": "2024-06-27", "sc": "secondary", "sources": [W], "ow": False, "notes": "Wikipedia conflicts: June 2024 (TechNode 06-28) vs 2024-08-15. Roster uses 06-27."},
    "x1": {"displayName": "Spark X1", "releaseMonth": "2025-04", "releaseDate": None, "sc": "secondary", "sources": [W], "ow": False, "category": "reasoning", "catbasis": "deep-reasoning model trained on Huawei Ascend (Wikipedia)", "notes": "Wikipedia: April 2025; an earlier January 2025 announcement is recalled (unverified)."},
    "x25": {"displayName": "Spark X2.5", "releaseMonth": "2026-09", "releaseDate": None, "sc": "background", "sources": [W], "ow": False, "notes": "Roster says 2026-09-07; not verified. X1.5/X2 may exist between X1 and X2.5 (not verified), so the parent link is series-inferred and may skip versions."},
}
SPECIES = {"spark-v4": "v40", "spark-x2-5": "x25"}
IGNORE = set()
EXCLUDED = ["SparkGen (video tool), Spark Lite/Max API tiers."]
GAPS = ["X1.5, X2, X2.5 unverified."]
