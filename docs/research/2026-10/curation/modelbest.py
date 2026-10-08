VENDOR = {"key": "modelbest", "name": "ModelBest (MiniCPM)", "nameZh": "面壁智能 MiniCPM", "country": "CN", "homepage": "https://modelbest.cn", "officialModelListUrl": "https://huggingface.co/openbmb", "changelogUrl": "https://github.com/OpenBMB/MiniCPM", "notes": "Early MiniCPM dates recalled from the OpenBMB repo."}
GH = "https://github.com/OpenBMB/MiniCPM"
LINES = [{"family": "minicpm", "category": "llm", "chain": ["minicpm2b", "minicpm3", "minicpm4", "minicpm52b"]}]
R = {"minicpm52b": {"displayName": "MiniCPM5-2B", "releaseDate": "2026-09-06", "ow": True, "notes": "models.dev 2026-09-06; roster says 09-07."}}
EXTRA = {
    "minicpm2b": {"displayName": "MiniCPM-2B", "releaseDate": "2024-02-01", "sc": "background", "sources": [GH], "ow": True},
    "minicpm3": {"displayName": "MiniCPM3-4B", "releaseDate": "2024-09-05", "sc": "background", "sources": [GH], "ow": True},
    "minicpm4": {"displayName": "MiniCPM4", "releaseDate": "2025-06-06", "sc": "background", "sources": [GH], "ow": True},
}
SPECIES = {"minicpm": "minicpm52b"}
IGNORE = set()
EXCLUDED = ["MiniCPM-V / MiniCPM-o multimodal lines (not recorded)."]
GAPS = ["MiniCPM 1/3/4 dates recalled, not re-opened; MiniCPM-V/o lineage not covered."]
