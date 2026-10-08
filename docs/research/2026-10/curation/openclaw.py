VENDOR = {"key": "openclaw", "name": "OpenClaw (Peter Steinberger / OpenClaw Foundation)", "nameZh": "OpenClaw", "country": "AT", "homepage": "https://openclaw.ai", "officialModelListUrl": "https://github.com/openclaw/openclaw", "changelogUrl": "https://github.com/openclaw/openclaw/releases", "notes": "Steinberger joined OpenAI 2026-02-14 and announced the OpenClaw Foundation; OpenClaw 2.0 shipped 2026-08-30 (Wikipedia)."}
W = "https://en.wikipedia.org/wiki/OpenClaw"
LINES = [{"family": "openclaw", "category": "agent", "chain": ["warelay", "clawdis", "clawdbot", "moltbot", "openclaw", "openclaw2"]}]
def e(name, date, notes="", **kw):
    d = {"displayName": name, "releaseDate": date, "sc": "secondary", "sources": [W], "ow": True, "relation": "successor", "basis": "reported", "catbasis": "open-source personal AI agent", "notes": notes}
    d.update(kw)
    return d
EXTRA = {
    "warelay": e("Warelay", "2025-11-24", "Original project name; the roster's 'Clawdbot 2025-11-24' is actually this date.", relation=None, basis=None),
    "clawdis": e("CLAWDIS", "2025-12-03", "Rename of the same codebase."),
    "clawdbot": e("Clawdbot", "2026-01-02", "Rename; Anthropic trademark complaint led to the next rename."),
    "moltbot": e("Moltbot", "2026-01-27", "Rename after trademark complaint."),
    "openclaw": e("OpenClaw", "2026-01-30", "Final rename; about 247k GitHub stars by 2026-03-02."),
    "openclaw2": e("OpenClaw 2.0", "2026-08-30", "Released by the OpenClaw Foundation."),
}
SPECIES = {"clawdbot": "clawdbot", "moltbot": "moltbot", "openclaw": "openclaw"}
IGNORE = set()
EXCLUDED = ["Moltbook (agent social network by Matt Schlicht), MoltMatch."]
GAPS = []
