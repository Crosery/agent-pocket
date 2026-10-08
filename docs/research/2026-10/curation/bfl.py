VENDOR = {"key": "bfl", "name": "Black Forest Labs", "nameZh": "Black Forest Labs", "country": "DE", "homepage": "https://bfl.ai", "officialModelListUrl": "https://docs.bfl.ai", "changelogUrl": "https://bfl.ai/blog", "notes": "bfl.ai blog fetch timed out; dates from the Wikipedia article and catalog hints."}
W = "https://en.wikipedia.org/wiki/Black_Forest_Labs"
LINES = [
    {"family": "flux", "category": "image", "chain": ["flux1", "flux11pro", "flux2"]},
    {"family": "flux-kontext", "category": "image", "chain": ["kontext"]},
    {"family": "flux-klein", "category": "image", "chain": ["klein"]},
    {"family": "flux-3", "category": "video", "chain": ["flux3"]},
    {"family": "flux-3", "category": "image", "chain": ["flux3image"]},
]
EXTRA = {
    "flux1": {"displayName": "FLUX.1", "releaseDate": "2024-08-01", "sc": "secondary", "sources": [W], "ow": True, "notes": "[pro] / [dev] / [schnell]; Wikipedia: August 2024; catalogs list 2024-08-01."},
    "flux11pro": {"displayName": "FLUX1.1 [pro]", "releaseDate": "2024-10-02", "sc": "secondary", "sources": [W], "ow": False},
    "kontext": {"displayName": "FLUX.1 Kontext", "releaseDate": "2025-05-29", "sc": "secondary", "sources": [W], "ow": True, "parent": "flux1", "relation": "successor", "basis": "reported", "notes": "In-context editing models (Pro/Max 2025-05-29, Dev June 2025); built on the FLUX.1 base (recalled)."},
    "flux2": {"displayName": "FLUX.2", "releaseDate": "2025-11-25", "sc": "secondary", "sources": [W], "ow": True, "parent": "flux11pro", "notes": "Dev / Flex / Pro announced 2025-11-25; Max 2025-12-16."},
    "klein": {"displayName": "FLUX.2 Klein", "releaseMonth": "2026-01", "releaseDate": None, "sc": "secondary", "sources": [W], "ow": True, "parent": "flux2", "relation": "distill", "basis": "inferred-series", "notes": "4B (Apache 2.0) and 9B (non-commercial) variants, January 2026 (catalogs 01-14/01-15). Relation to FLUX.2 not stated; shown as a size-distilled sibling."},
    "flux3": {"displayName": "FLUX 3", "releaseDate": "2026-07-23", "sc": "secondary", "sources": [W], "ow": False, "parent": "flux2", "relation": "series-successor", "basis": "inferred-series", "catbasis": "Wikipedia: text-to-video with native audio up to 20 s; described as a multimodal foundation model for images, video and audio. Roster category 'video' is therefore correct.", "notes": "Proprietary. Robotics variant FLUX3 x mimic is a video-action model. Not a post-train of FLUX.1 as the roster chain claims."},
    "flux3image": {"displayName": "FLUX 3 Image", "releaseDate": "2026-10-05", "sc": "catalog", "releaseDateBasis": "catalog", "sources": ["https://vercel.com/ai-gateway/models"], "ow": False, "parent": "flux3", "relation": "series-successor", "basis": "inferred-series", "catbasis": "Vercel AI Gateway catalog lists it as an image model", "notes": "Single catalog hint (Vercel, 2026-10-05); not verified against BFL."},
}
SPECIES = {"flux-1": "flux1", "flux-3": "flux3"}
IGNORE = set()
EXCLUDED = ["FLUX.1 Krea [dev] (2025-07-31, with Krea), FLUX.1 Tools (Fill/Depth/Canny/Redux 2024-11-21), Ultra/Raw modes, FLUX.2 Max/Flex tiers."]
GAPS = ["FLUX 3 Image date/availability unverified; bfl.ai blog not read."]
