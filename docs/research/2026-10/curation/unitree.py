VENDOR = {"key": "unitree", "name": "Unitree Robotics", "nameZh": "宇树科技", "country": "CN", "homepage": "https://www.unitree.com", "officialModelListUrl": "https://www.unitree.com/products", "changelogUrl": "https://www.unitree.com", "notes": "Hardware, not models."}
W = "https://en.wikipedia.org/wiki/Unitree_Robotics"
LINES = [{"family": "unitree-humanoid", "category": "agent", "tags": ["embodied"], "chain": ["h1", "g1", "h2"]}, {"family": "unitree-gd01", "category": "agent", "tags": ["embodied"], "chain": ["gd01"]}]
EXTRA = {
    "h1": {"displayName": "Unitree H1", "releaseMonth": "2023-08", "releaseDate": None, "sc": "secondary", "sources": [W], "ow": False, "catbasis": "humanoid robot hardware", "notes": "Wikipedia lists 2023 (showcase video April 2024)."},
    "g1": {"displayName": "Unitree G1", "releaseMonth": "2024-05", "releaseDate": None, "sc": "secondary", "sources": [W], "ow": False, "catbasis": "humanoid robot hardware", "notes": "Wikipedia: August 2024 at ~US$16k (price/ship); roster: 2024-05."},
    "h2": {"displayName": "Unitree H2", "releaseMonth": "2025", "releaseDate": None, "sc": "secondary", "sources": [W], "ow": False, "catbasis": "humanoid robot hardware", "notes": "Wikipedia: 2025."},
    "gd01": {"displayName": "Unitree GD01", "releaseDate": "2026-05-12", "sc": "background", "sources": [W], "ow": False, "catbasis": "manned mecha (hardware)", "notes": "Roster only; not in Wikipedia."},
}
SPECIES = {"unitree": "g1", "unitree-gd01": "gd01"}
IGNORE = set()
EXCLUDED = ["Quadrupeds (Go1/Go2/B2/A2/As2), R1, 'Superman' demo (2026-08)."]
GAPS = ["GD01 date unverified. Roster chain unitree -> unitree-gd01 is not a lineage (different product)."]
