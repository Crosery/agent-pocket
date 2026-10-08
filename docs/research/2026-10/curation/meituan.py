VENDOR = {"key": "meituan", "name": "Meituan (LongCat)", "nameZh": "美团 LongCat", "country": "CN", "homepage": "https://longcat.chat", "officialModelListUrl": "https://huggingface.co/meituan-longcat", "changelogUrl": "https://longcat.chat", "notes": "LongCat 2.0 / 2.5 dates are catalog listing dates."}
LINES = [{"family": "longcat", "category": "llm", "chain": ["longcatflash", "longcat20", "longcat25preview"]}]
R = {
    "longcat20": {"displayName": "LongCat 2.0", "releaseDate": "2026-06-30", "ow": False, "notes": "1.6T-A48B MoE (OpenRouter); models.dev 06-30, OpenRouter 07-20."},
    "longcat25preview": {"displayName": "LongCat 2.5 Preview", "releaseDate": "2026-09-25", "ow": False, "status": "preview", "catbasis": "roster says multimodal; catalog modality is text->text (unverified)"},
}
EXTRA = {
    "longcatflash": {"displayName": "LongCat-Flash-Chat", "releaseDate": None, "sc": "background", "sources": ["https://huggingface.co/meituan-longcat/LongCat-Flash-Chat"], "ow": True, "notes": "560B-A27B open MoE; released around 2025-08-30 / 2025-09-01 (roster 09-01); day not verified."},
}
SPECIES = {"longcat-flash": "longcatflash", "longcat-2-5": "longcat25preview"}
IGNORE = set()
EXCLUDED = ["LongCat-Flash-Thinking / Omni / Video variants (not recorded)."]
GAPS = ["LongCat-Flash day; 2.5 Preview modality; whether 2.0 is post-trained from Flash (not stated)."]
