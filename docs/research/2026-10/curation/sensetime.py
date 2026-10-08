VENDOR = {"key": "sensetime", "name": "SenseTime (SenseNova)", "nameZh": "商汤日日新 SenseNova", "country": "CN", "homepage": "https://www.sensetime.com", "officialModelListUrl": "https://platform.sensenova.cn", "changelogUrl": "https://www.sensetime.com/en/news", "notes": "Only the Flash-Lite line is in the catalogs; earlier SenseNova generations not recorded."}
LINES = [{"family": "sensenova-flash-lite", "category": "vision-language", "chain": ["sensenova67flashlite", "sensenova68flashlite"]}]
R = {"sensenova68flashlite": {"displayName": "SenseNova 6.8 Flash-Lite", "releaseDate": "2026-08-11", "ow": False, "catbasis": "SenseNova multimodal series (roster); models.dev modality text->text (unverified)", "notes": "Newer than the roster's 6.7."}}
EXTRA = {"sensenova67flashlite": {"displayName": "SenseNova 6.7 Flash-Lite", "releaseDate": "2026-05-08", "sc": "background", "sources": ["https://www.sensetime.com"], "ow": False, "catbasis": "SenseNova multimodal series", "notes": "Date from the roster only; not verified."}}
SPECIES = {"sensenova": "sensenova67flashlite"}
IGNORE = set()
EXCLUDED = []
GAPS = ["SenseNova 5.x / 6.0 / 6.5 not recorded; 6.7 existence and date unverified."]
