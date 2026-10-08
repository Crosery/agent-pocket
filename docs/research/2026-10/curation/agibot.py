VENDOR = {"key": "agibot", "name": "AgiBot", "nameZh": "智元机器人", "country": "CN", "homepage": "https://www.zhiyuan-robot.com", "officialModelListUrl": "https://www.zhiyuan-robot.com", "changelogUrl": "https://www.zhiyuan-robot.com", "notes": "Unverified beyond the roster/prior research."}
LINES = [{"family": "agibot-platform", "category": "agent", "tags": ["embodied"], "chain": ["agibot"]}, {"family": "agibot-go", "category": "agent", "tags": ["embodied"], "chain": ["go1"]}]
EXTRA = {
    "agibot": {"displayName": "AgiBot (humanoid platform)", "releaseMonth": "2023-08", "releaseDate": None, "sc": "background", "sources": ["https://www.zhiyuan-robot.com"], "ow": False, "catbasis": "humanoid robot company/platform", "notes": "Roster date 2023-08 is the company founding."},
    "go1": {"displayName": "AgiBot GO-1", "releaseMonth": "2025-03", "releaseDate": None, "sc": "background", "sources": ["https://www.zhiyuan-robot.com"], "ow": True, "catbasis": "embodied foundation model (Genie Operator-1)", "notes": "Recalled March 2025; prior research says 2025-09-19 (conflict, unverified)."},
}
SPECIES = {"agibot": "agibot"}
IGNORE = set()
EXCLUDED = []
GAPS = ["GO-1 date conflict."]
