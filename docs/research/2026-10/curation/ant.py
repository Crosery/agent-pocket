VENDOR = {"key": "ant", "name": "Ant Group (inclusionAI / Ling)", "nameZh": "蚂蚁集团 百灵 Ling", "country": "CN", "homepage": "https://github.com/inclusionAI", "officialModelListUrl": "https://huggingface.co/inclusionAI", "changelogUrl": "https://github.com/inclusionAI", "notes": "Dates are models.dev/OpenRouter listings; derivative relations come from OpenRouter descriptions."}
HF = "https://huggingface.co/inclusionAI"
LINES = [
    {"family": "ling", "category": "llm", "chain": ["ling1t"]},
    {"family": "ring", "category": "reasoning", "chain": ["ring1t"]},
    {"family": "ling-flash", "category": "llm", "chain": ["ling30flash", "ling31flash"]},
]
R = {
    "ling1t": {"displayName": "Ling-1T", "releaseMonth": "2025-10", "releaseDate": None, "ow": True},
    "ring1t": {"displayName": "Ring-1T", "releaseMonth": "2025-10", "releaseDate": None, "ow": True, "parent": "ling1t", "relation": "post-train", "basis": "reported", "catbasis": "reasoning (Ring) variant of Ling-1T", "notes": "Thinking-series sibling built on the Ling-1T base (recalled from model card; [unverified])."},
    "ling30flash": {"displayName": "Ling 3.0 Flash", "releaseDate": "2026-07-23", "ow": None, "notes": "124B-A5.1B MoE (OpenRouter)."},
    "ling31flash": {"displayName": "Ling 3.1 Flash", "releaseDate": "2026-09-29", "ow": None, "notes": "Hybrid-reasoning MoE (OpenRouter: 25B active of 560B total); models.dev 09-29, OpenRouter 10-02."},
    "ling30flashfin": {"displayName": "Ling 3.0 Flash Fin", "releaseDate": "2026-08-27", "ow": None, "parent": "ling30flash", "relation": "post-train", "basis": "reported", "family": "ling-flash", "category": "llm", "notes": "Finance-specialised, built on Ling 3.0 Flash (OpenRouter description)."},
    "ling30flashsante": {"displayName": "Ling 3.0 Flash Sante", "releaseDate": "2026-09-04", "ow": None, "parent": "ling30flash", "relation": "post-train", "basis": "reported", "family": "ling-flash", "category": "llm", "notes": "Health/medicine-specialised, built on Ling 3.0 Flash (OpenRouter description)."},
    "ling30flashvl": {"displayName": "Ling 3.0 Flash VL", "releaseDate": "2026-09-10", "ow": None, "parent": "ling30flash", "relation": "successor", "basis": "reported", "family": "ling-flash-vl", "category": "vision-language", "notes": "Adds native visual perception to Ling 3.0 Flash (OpenRouter description)."},
}
EXTRA = {
    "ring26": {"displayName": "Ring-2.6-1T", "releaseDate": None, "sc": "background", "sources": [HF], "ow": True, "category": "reasoning", "catbasis": "Ring thinking series (roster name)", "notes": "Named in the roster (BaiLing 2026-07-27); intermediate Ring 2.x versions and the exact date not verified."},
}
SPECIES = {"bailing": "ling30flash"}
IGNORE = set()
EXCLUDED = ["A-Fu / AQ health app (product), Ming-omni and Ling-mini lines."]
GAPS = ["Ling 2.0/2.5 and Ring 2.x intermediates not recorded; roster 'bailing' covers Ling-3.0-flash and Ring-2.6-1T; Ring-2.6-1T has no date."]


# roster product record
LINES.append({"family": 'ant-afu', "category": 'agent', "chain": ['afu']})
EXTRA['afu'] = {'displayName': 'Ant A-Fu (AQ)', 'releaseDate': '', 'sc': 'background', 'sources': ['https://www.antgroup.com'], 'ow': False, 'catbasis': 'AI health assistant app (roster description)', 'notes': 'Product record for a roster entry; date from the roster, not verified (search budget exhausted). AI health assistant, formerly AQ.', 'releaseMonth': '2025-06'}
SPECIES['ant-afu'] = 'afu'
