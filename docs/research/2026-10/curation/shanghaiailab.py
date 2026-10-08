VENDOR = {"key": "shanghaiailab", "name": "Shanghai AI Laboratory (InternLM / Intern-S)", "nameZh": "上海人工智能实验室 书生", "country": "CN", "homepage": "https://internlm.intern-ai.org.cn", "officialModelListUrl": "https://huggingface.co/internlm", "changelogUrl": "https://github.com/InternLM/InternLM", "notes": "Dates recalled from the InternLM repo; Intern-S2 from the roster."}
GH = "https://github.com/InternLM/InternLM"
LINES = [{"family": "intern", "category": "llm", "chain": ["i1", "i2", "i25", "i3", "s1", "s2"]}]
EXTRA = {
    "i1": {"displayName": "InternLM", "releaseDate": "2023-06-07", "sc": "background", "sources": [GH], "ow": True},
    "i2": {"displayName": "InternLM2", "releaseDate": "2024-01-17", "sc": "background", "sources": [GH], "ow": True},
    "i25": {"displayName": "InternLM2.5", "releaseDate": "2024-07-03", "sc": "background", "sources": [GH], "ow": True},
    "i3": {"displayName": "InternLM3", "releaseDate": "2025-01-15", "sc": "background", "sources": [GH], "ow": True},
    "s1": {"displayName": "Intern-S1", "releaseDate": "2025-07-26", "sc": "background", "sources": ["https://huggingface.co/internlm/Intern-S1"], "ow": True, "tags": ["science"], "parentExternal": {"name": "Qwen3-235B-A22B", "vendor": "alibaba", "url": "https://huggingface.co/internlm/Intern-S1"}, "relation": "post-train", "basis": "reported", "notes": "Scientific multimodal model continued-pretrained from Qwen3-235B (recalled model card); released at WAIC 2025."},
    "s2": {"displayName": "Intern-S2", "releaseMonth": "2026-09", "releaseDate": None, "sc": "background", "sources": [GH], "ow": None, "notes": "Roster: 2026-09, category multimodal; unverified."},
}
SPECIES = {"intern-s2": "s2"}
IGNORE = set()
EXCLUDED = ["InternVL / InternLM-XComposer / Intern-S1-mini variants."]
GAPS = ["Intern-S2 unverified."]
