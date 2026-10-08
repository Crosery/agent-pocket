VENDOR = {"key": "elevenlabs", "name": "ElevenLabs", "nameZh": "ElevenLabs", "country": "US", "homepage": "https://elevenlabs.io", "officialModelListUrl": "https://elevenlabs.io/docs/overview/models", "changelogUrl": "https://elevenlabs.io/blog", "notes": "elevenlabs.io blog fetch failed; Wikipedia plus catalog hints used."}
W = "https://en.wikipedia.org/wiki/ElevenLabs"
LINES = [
    {"family": "eleven-tts", "category": "speech-tts", "chain": ["multilingualv2", "v3", "v4"]},
    {"family": "scribe", "category": "speech-asr", "chain": ["scribe"]},
    {"family": "eleven-music", "category": "music", "chain": ["music"]},
]
EXTRA = {
    "multilingualv2": {"displayName": "Eleven Multilingual v2", "releaseDate": "2023-08-22", "sc": "catalog", "releaseDateBasis": "catalog", "sources": ["https://models.dev/"], "ow": False, "notes": "DigitalOcean catalog date; roster says 2023-08."},
    "v3": {"displayName": "Eleven v3", "releaseDate": "2025-06-03", "sc": "secondary", "sources": [W], "ow": False, "notes": "Wikipedia cites a blog post dated 2025-06-03; Poe lists 2025-06-05. Eleven v3 Conversational followed Feb 2026."},
    "v4": {"displayName": "Eleven v4", "releaseMonth": "2026-09", "releaseDate": None, "sc": "background", "sources": ["https://elevenlabs.io/blog"], "ow": False, "notes": "Roster/prior research say 2026-09-28 (v4 / v4 Turbo); not verified here."},
    "scribe": {"displayName": "Scribe", "releaseMonth": "2025-02", "releaseDate": None, "sc": "secondary", "sources": [W], "ow": False, "notes": "Speech-to-text; Scribe v2 and v2 Realtime exist (undated here)."},
    "music": {"displayName": "Eleven Music", "releaseDate": "2025-08-05", "sc": "secondary", "sources": [W], "ow": False, "notes": "Wikipedia also says public availability in July 2025."},
}
SPECIES = {"eleven-v2": "multilingualv2", "eleven-v4": "v4"}
IGNORE = set()
EXCLUDED = ["Turbo/Flash v2.5, Sound Effects, Voice Isolator, Dubbing (products)."]
GAPS = ["Eleven v4 existence/date unverified; Multilingual v1 not recorded."]
