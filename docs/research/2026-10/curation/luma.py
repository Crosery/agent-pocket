VENDOR = {"key": "luma", "name": "Luma AI", "nameZh": "Luma AI", "country": "US", "homepage": "https://lumalabs.ai", "officialModelListUrl": "https://lumalabs.ai/ray", "changelogUrl": "https://lumalabs.ai/news", "notes": "Only Dream Machine is dated by Wikipedia; Ray2/Ray3 dates recalled and cross-checked with roster."}
W = "https://en.wikipedia.org/wiki/Luma_AI"
LINES = [{"family": "luma-ray", "category": "video", "chain": ["dreammachine", "ray2", "ray3"]}]
EXTRA = {
    "dreammachine": {"displayName": "Luma Dream Machine (Ray1)", "releaseDate": "2024-06-12", "sc": "secondary", "sources": [W], "ow": False},
    "ray2": {"displayName": "Luma Ray2", "releaseDate": "2025-01-15", "sc": "background", "sources": ["https://lumalabs.ai/ray"], "ow": False, "notes": "Announced Jan 2025 (recalled); Poe lists 2025-02-20."},
    "ray3": {"displayName": "Luma Ray3", "releaseDate": "2025-09-18", "sc": "background", "sources": ["https://lumalabs.ai/ray"], "ow": False, "notes": "Date from roster (matches recall). Prior research also mentions a Ray3.2; existence not verified."},
}
SPECIES = {"luma-ray3": "ray3"}
IGNORE = set()
EXCLUDED = ["Photon image model, Genie 3D, Luma Agents (September 2026 product)."]
GAPS = ["Ray3.x successors after 2025-09 not verified."]
