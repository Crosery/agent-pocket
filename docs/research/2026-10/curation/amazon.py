VENDOR = {
    "key": "amazon",
    "name": "Amazon (AWS Nova)",
    "nameZh": "亚马逊 AWS Nova",
    "country": "US",
    "homepage": "https://aws.amazon.com/ai/generative-ai/nova/",
    "officialModelListUrl": "https://docs.aws.amazon.com/nova/latest/nova2-userguide/what-is-nova-2.html",
    "changelogUrl": "https://docs.aws.amazon.com/nova/latest/nova2-userguide/release-notes.html",
    "notes": "Amazon reportedly wound down Nova Premier/Omni/Reel/Canvas in July 2026 and is working on a single new flagship for re:Invent 2026 (reported, 2026-07-28).",
}
N2 = "https://docs.aws.amazon.com/nova/latest/nova2-userguide/release-notes.html"
N25 = "https://aws.amazon.com/about-aws/whats-new/2026/10/amazon-nova-2.5-Sonic/"
LAUNCH = "https://www.aboutamazon.com/news/aws/aws-agentic-ai-amazon-bedrock-nova-models"
WIND = "https://postcutoff.com/e/2026-07-28-amazon-nova-wind-down-frontier-model-research/"

LINES = [
    {"family": "nova-pro", "category": "llm", "chain": ["novapro", "nova2prov1"]},
    {"family": "nova-lite", "category": "llm", "chain": ["novalite", "nova2lite"]},
    {"family": "nova-micro", "category": "llm", "chain": ["novamicro"]},
    {"family": "nova-premier", "category": "llm", "chain": ["novapremier"]},
    {"family": "nova-sonic", "category": "speech-tts", "chain": ["novasonic", "nova2sonic", "nova25sonic"]},
    {"family": "nova-creative", "category": "image", "chain": ["novacanvas"]},
    {"family": "nova-creative", "category": "video", "chain": ["novareel"]},
    {"family": "nova-act", "category": "agent", "chain": ["novaact"]},
    {"family": "kiro", "category": "agent", "chain": ["kiro"]},
]

R = {
    "novapro": {"displayName": "Nova Pro", "releaseDate": "2024-12-03", "ow": False, "sc": "background", "releaseDateBasis": "background", "sources": [LAUNCH], "notes": "Nova 1 family (Micro/Lite/Pro/Canvas/Reel) announced at re:Invent 2024-12-03."},
    "novalite": {"displayName": "Nova Lite", "releaseDate": "2024-12-03", "ow": False},
    "novamicro": {"displayName": "Nova Micro", "releaseDate": "2024-12-03", "ow": False},
    "novapremier": {"displayName": "Nova Premier", "releaseDate": "2025-04-30", "ow": False, "status": "deprecated", "sources": [WIND], "sc": "secondary", "notes": "Legacy since 2026-03-13, end-of-life 2026-09-14; wind-down reported 2026-07-28. Also a teacher for distilling Pro/Lite/Micro."},
    "nova2lite": {"displayName": "Nova 2 Lite", "releaseDate": "2025-12-02", "ow": False, "sc": "official", "releaseDateBasis": "official", "sources": [N2, LAUNCH]},
    "nova2prov1": {"displayName": "Nova 2 Pro", "releaseDate": "2025-12-02", "ow": False, "status": "preview", "relation": "successor", "basis": "reported", "sc": "official", "releaseDateBasis": "official", "sources": [N2, LAUNCH], "notes": "Announced as preview with the Nova 2 family at re:Invent (catalog lists 12-03); linked to Nova Forge early access."},
}

EXTRA = {
    "novasonic": {"displayName": "Nova Sonic", "releaseDate": "2025-04-08", "sc": "background", "sources": ["https://aws.amazon.com/blogs/aws/introducing-amazon-nova-sonic-human-like-voice-conversations-for-generative-ai-applications/"], "ow": False, "status": "deprecated", "catbasis": "speech-to-speech model (speech in/out)", "notes": "Legacy 2026-03-13, EOL 2026-09-14."},
    "nova2sonic": {"displayName": "Nova 2 Sonic", "releaseDate": "2025-12-02", "sc": "official", "sources": ["https://aws.amazon.com/blogs/aws/introducing-amazon-nova-2-sonic-next-generation-speech-to-speech-model-for-conversational-ai/", N2], "ow": False, "catbasis": "speech-to-speech model"},
    "nova25sonic": {"displayName": "Nova 2.5 Sonic", "releaseDate": "2026-10-05", "sc": "official", "releaseDateBasis": "official", "sources": [N25], "ow": False, "catbasis": "speech-to-speech model", "notes": "GA announcement; better reasoning, instruction following and tool-calling."},
    "novacanvas": {"displayName": "Nova Canvas", "releaseDate": "2024-12-03", "sc": "background", "sources": [LAUNCH, WIND], "ow": False, "status": "deprecated", "catbasis": "text-to-image model", "notes": "Wind-down reported 2026-07-28."},
    "novareel": {"displayName": "Nova Reel", "releaseDate": "2024-12-03", "sc": "background", "sources": [LAUNCH, WIND], "ow": False, "status": "deprecated", "catbasis": "text/image-to-video model", "notes": "Reel 1.1 added Apr 2025; wind-down reported 2026-07-28."},
    "novaact": {
        "displayName": "Nova Act",
        "releaseDate": "2025-03-31",
        "sc": "secondary",
        "sources": [LAUNCH],
        "ow": False,
        "catbasis": "browser-agent service/model",
        "parentExternal": {"name": "Nova 2 Lite (custom browser-control version)", "vendor": "amazon", "url": LAUNCH},
        "relation": "post-train",
        "basis": "reported",
        "notes": "Research preview 2025-03-31, GA at re:Invent 2025-12-02; the GA agent runs on a custom Nova 2 Lite.",
    },
    "kiro": {"displayName": "Kiro", "releaseDate": "2025-07-14", "sc": "background", "sources": ["https://kiro.dev"], "ow": False, "catbasis": "agentic IDE (product)", "notes": "Roster lists it as code; it is an agentic IDE product, GA 2025-11-17 (recalled)."},
}

SPECIES = {"kiro": "kiro"}
IGNORE = {"novalitev1", "novamicrov1", "novaprov1", "novapremierv1", "nova2litev1"}
EXCLUDED = ["Duplicate OpenRouter ':1.0' entries, Titan models, Nova Omni (wound down), Q Developer."]
GAPS = ["Nova 2 Omni / Nova 2 Pro GA status not confirmed; next Amazon flagship expected at re:Invent 2026."]
