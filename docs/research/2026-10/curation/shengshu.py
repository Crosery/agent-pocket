VENDOR = {"key": "shengshu", "name": "ShengShu Technology (Vidu)", "nameZh": "生数科技 Vidu", "country": "CN", "homepage": "https://www.vidu.com", "officialModelListUrl": "https://platform.vidu.com", "changelogUrl": "https://www.vidu.com", "notes": "Wikipedia page 404; dates recalled or from roster/prior research."}
LINES = [{"family": "vidu", "category": "video", "chain": ["vidu1", "vidu20", "viduq1", "viduq2", "viduq3"]}]
def e(name, date=None, month=None, notes=""):
    d = {"displayName": name, "releaseDate": date, "sc": "background", "sources": ["https://www.vidu.com"], "ow": False, "notes": notes}
    if month:
        d["releaseMonth"] = month
    return d
EXTRA = {
    "vidu1": e("Vidu 1.0", "2024-07-30", notes="Public release date from the roster."),
    "vidu20": e("Vidu 2.0", None, notes="Existence from prior research; date unverified."),
    "viduq1": e("Vidu Q1", None, notes="Existence from prior research; date unverified."),
    "viduq2": e("Vidu Q2", None, notes="Existence from prior research; date unverified."),
    "viduq3": e("Vidu Q3", "2026-01-30", notes="Date from the roster/prior research; not verified."),
}
SPECIES = {"vidu": "vidu1", "vidu-q3": "viduq3"}
IGNORE = set()
EXCLUDED = ["Vidu S1/S2 (spatial), Q1/Q2 Image variants."]
GAPS = ["Vidu 1.5/2.0/Q1/Q2 dates unknown; whole vendor unverified beyond the roster."]
