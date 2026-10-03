#!/usr/bin/env python3
"""Canonical formatter for content/**/*.json (arrays of records one-per-line for readable diffs).

Usage: python3 tools/content_fmt.py [files...]   (default: every JSON under content/)
"""

import json
import pathlib
import sys


def fmt(v, ind=0):
    pad = "  " * ind
    if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
        return (
            "[\n"
            + ",\n".join(pad + "  " + json.dumps(x, ensure_ascii=False) for x in v)
            + "\n"
            + pad
            + "]"
        )
    if isinstance(v, dict) and any(
        isinstance(x, (dict, list)) and len(json.dumps(x)) > 100 for x in v.values()
    ):
        return (
            "{\n"
            + ",\n".join(
                pad + "  " + json.dumps(k, ensure_ascii=False) + ": " + fmt(x, ind + 1)
                for k, x in v.items()
            )
            + "\n"
            + pad
            + "}"
        )
    return json.dumps(v, ensure_ascii=False)


root = pathlib.Path(__file__).resolve().parent.parent / "content"
files = [pathlib.Path(p) for p in sys.argv[1:]] or sorted(root.rglob("*.json"))
for f in files:
    data = json.loads(f.read_text())
    f.write_text(fmt(data) + "\n")
print(f"formatted {len(files)} file(s)")
