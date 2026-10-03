#!/usr/bin/env python3
"""Subset the pixel font to the characters the game can show (SIL OFL allows modified versions;
Fusion Pixel declares no Reserved Font Name). Source = assets_src/fonts backup, output overwrites the shipped file.

Char set: ranges + GB2312 level-1 hanzi (common ~3750) + every char in repo text files (see subset_font.json).
Usage: python3 tools/subset_font.py
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "tools" / "subset_font.json").read_text())


def gb2312_level1(rows: list[int]) -> set[str]:
    out = set()
    for r in range(rows[0], rows[1] + 1):
        for c in range(0xA1, 0xFF):
            try:
                out.add(bytes([0xA0 + r, c]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return out


def scan_text() -> set[str]:
    chars: set[str] = set()
    sfx = tuple(CFG["scan"]["suffixes"])
    for root in CFG["scan"]["roots"]:
        p = ROOT / root
        files = [p] if p.is_file() else p.rglob("*") if p.is_dir() else []
        for f in files:
            if f.is_file() and f.suffix in sfx and "node_modules" not in f.parts:
                chars.update(f.read_text(encoding="utf-8", errors="ignore"))
    return chars


def main() -> int:
    chars = scan_text() | gb2312_level1(CFG["gb2312_level1_rows"])
    for lo, hi in CFG["ranges"]:
        chars.update(chr(c) for c in range(lo, hi + 1))
    chars = {c for c in chars if c.isprintable() or c == " "}
    src, out = ROOT / CFG["source"], ROOT / CFG["output"]
    txt = ROOT / "assets_src" / "tmp" / "subset_chars.txt"
    txt.parent.mkdir(parents=True, exist_ok=True)
    txt.write_text("".join(sorted(chars)), encoding="utf-8")
    subprocess.run(
        ["pyftsubset", str(src), f"--text-file={txt}", "--flavor=woff2", "--layout-features=*",
         "--no-hinting", "--notdef-outline", f"--output-file={out}"],
        check=True,
    )
    print(f"{len(chars)} chars requested; {src.stat().st_size} -> {out.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
