#!/usr/bin/env python3
"""Read-only QA for connected, complete-body walk loops and separate grounded idles."""

from __future__ import annotations

import argparse
import json
import pathlib

import numpy as np
from PIL import Image, ImageDraw

from assetlib import ROOT, content_json, load_src, pipeline_cfg, save_png, write_json
from walk_video import _extent, _head_diff, _islands, _opaque, _shift, detached_pixels


def audit(path: pathlib.Path, require_atlas: bool = False) -> dict:
    sprites = content_json("content/config.json")["sprites"]
    cell = sprites["sheetCell"]
    cfg = pipeline_cfg()
    baseline = cell - 1 - cfg["sheet"]["bottomMargin"]
    joint_frac = cfg["walkVideo"]["cycle"]["legFrac"]
    a = load_src(path)
    errors, warnings, rows = [], [], []
    frames = a.shape[1] // cell
    atlas = frames == sprites["sheetWalkFrames"] + 1
    if a.shape[0] != cell * len(sprites["sheetRows"]) or a.shape[1] % cell or frames not in (sprites["sheetFrames"], sprites["sheetWalkFrames"] + 1):
        return {"id": path.stem, "errors": ["invalid dimensions or alpha"], "rows": []}
    if not atlas:
        (errors if require_atlas else warnings).append("legacy four-frame sheet: complete-body motion not verified")
    if not set(np.unique(a[..., 3])).issubset({0, 255}):
        errors.append("non-binary alpha")
    for direction, r in sorted(sprites["sheetRows"].items(), key=lambda item: item[1]):
        row = [a[r * cell : (r + 1) * cell, c * cell : (c + 1) * cell] for c in range(frames)]
        ref = row[0]
        if not _opaque(ref).any():
            errors.append(f"{direction}: empty idle")
            continue
        top, foot = _extent(_opaque(ref))
        joint = foot + 1 - round(joint_frac * (foot - top + 1))
        neck = top + round(cfg["walkVideo"]["cycle"]["neckBand"][0] * (foot - top + 1))
        feet, islands = [], []
        for c, f in enumerate(row):
            op = _opaque(f)
            if not op.any():
                errors.append(f"{direction}/{c}: empty frame")
                continue
            _, low = _extent(op)
            feet.append(low)
            if low != baseline:
                errors.append(f"{direction}/{c}: baseline {low} != {baseline}")
            _, sizes = _islands(f)
            islands.append(sorted(sizes, reverse=True))
            for y in range(top, foot):
                if not op[y].any() and op[:y].any() and op[y + 1 :].any():
                    errors.append(f"{direction}/{c}: detached upper body at row {y}")
            detached = detached_pixels(f, ref)
            if atlas and detached > cfg["walkVideo"]["atlas"]["maxDetached"]:
                errors.append(f"{direction}/{c}: {detached} detached pixels")
        walk = row[1:] if atlas else row
        unique = len({f.tobytes() for f in walk})
        body_motion = max(
            min(_head_diff(_shift(f, dy, 0), walk[0], slice(neck, joint)) for dy in range(-2, 3))
            for f in walk[1:]
        )
        changes = [_head_diff(walk[i], walk[(i + 1) % len(walk)], slice(None)) for i in range(len(walk))]
        seam = changes[-1] / max(float(np.mean(changes)), 1)
        if atlas:
            if unique < cfg["walkVideo"]["atlas"]["minUnique"]:
                errors.append(f"{direction}: only {unique} unique walk poses")
            if body_motion < cfg["walkVideo"]["atlas"]["minBodyMotion"]:
                errors.append(f"{direction}: frozen body/arms ({body_motion} changing pixels)")
            if seam > cfg["walkVideo"]["atlas"]["maxSeamRatio"]:
                errors.append(f"{direction}: loop seam ratio {seam:.2f}")
        rows.append({"direction": direction, "feet": feet, "uniqueWalkPoses": unique, "bodyMotionPixels": body_motion, "seamRatio": round(seam, 3), "islands": islands})
    return {"id": path.stem, "atlas": atlas, "errors": errors, "warnings": warnings, "rows": rows}


def preview(paths: list[pathlib.Path], out: pathlib.Path, cycles: bool) -> None:
    cell = content_json("content/config.json")["sprites"]["sheetCell"]
    scale, cols = 2, 3
    with Image.open(paths[0]) as source:
        frame_cols = source.width // cell
    tile_w, tile_h = cell * (frame_cols if cycles else 4), cell * (4 if cycles else 1)
    label_h, pad = 14, 8
    w, h = cols * (tile_w + pad), ((len(paths) + cols - 1) // cols) * (tile_h + label_h + pad)
    board = Image.new("RGB", (w, h), "#182234")
    draw = ImageDraw.Draw(board)
    for i, path in enumerate(paths):
        x, y = (i % cols) * (tile_w + pad), (i // cols) * (tile_h + label_h + pad)
        draw.text((x + 4, y + 2), path.stem, fill="#f3dca0")
        with Image.open(path) as source:
            src = source.convert("RGBA")
        if cycles:
            board.paste(src, (x, y + label_h), src)
        else:
            for r in range(4):
                f = src.crop((0, r * cell, cell, (r + 1) * cell))
                board.paste(f, (x + r * cell, y + label_h), f)
        draw.line((x, y + label_h + tile_h - 2, x + tile_w, y + label_h + tile_h - 2), fill="#526077")
    save_png(board.resize((w * scale, h * scale), Image.Resampling.NEAREST), out)


def animation(paths: list[pathlib.Path], out: pathlib.Path) -> None:
    cell = content_json("content/config.json")["sprites"]["sheetCell"]
    label_h, pad, cols, scale = 14, 8, 3, 3
    tile_w = cell * 4
    tile_h = cell + label_h + pad
    size = (cols * (tile_w + pad), ((len(paths) + cols - 1) // cols) * tile_h)
    sources = []
    for path in paths:
        with Image.open(path) as source:
            sources.append((path.stem, source.convert("RGBA")))
    boards = []
    for phase in range(8):
        board = Image.new("RGB", size, "#182234")
        draw = ImageDraw.Draw(board)
        for i, (sheet_id, source) in enumerate(sources):
            x, y = (i % cols) * (tile_w + pad), (i // cols) * tile_h
            draw.text((x + 4, y + 2), sheet_id, fill="#f3dca0")
            count = source.width // cell
            frame = 1 + phase if count == 9 else phase % count
            for r in range(4):
                f = source.crop((frame * cell, r * cell, (frame + 1) * cell, (r + 1) * cell))
                board.paste(f, (x + r * cell, y + label_h), f)
        boards.append(board.resize((size[0] * scale, size[1] * scale), Image.Resampling.NEAREST))
    out.parent.mkdir(parents=True, exist_ok=True)
    boards[0].save(out, save_all=True, append_images=boards[1:], duration=125, loop=0)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("directory", nargs="?", type=pathlib.Path, default=ROOT / "public/assets/characters")
    ap.add_argument("--report", type=pathlib.Path)
    ap.add_argument("--preview", type=pathlib.Path)
    ap.add_argument("--playable-cycles", type=pathlib.Path)
    ap.add_argument("--only", help="comma-separated character ids")
    ap.add_argument("--animation", type=pathlib.Path, help="four-direction chronological loop GIF")
    ap.add_argument("--require-atlas", action="store_true")
    args = ap.parse_args()
    paths = sorted(args.directory.glob("*.png"))
    if args.only:
        ids = set(args.only.split(","))
        paths = [p for p in paths if p.stem in ids]
    reports = [audit(p, args.require_atlas) for p in paths]
    result = {
        "sheets": len(paths),
        "directions": sum(len(r["rows"]) for r in reports),
        "frames": sum(len(row["feet"]) for r in reports for row in r["rows"]),
        "failedSheets": sum(bool(r["errors"]) for r in reports),
        "reports": reports,
    }
    if args.report:
        write_json(args.report, result)
    if args.preview:
        preview(paths, args.preview, False)
    if args.playable_cycles:
        playable = {c["id"] for c in content_json("content/characters.json") if c.get("playable")}
        preview([p for p in paths if p.stem in playable], args.playable_cycles, True)
    if args.animation and paths:
        animation(paths, args.animation)
    print(json.dumps({k: v for k, v in result.items() if k != "reports"}))
    for r in reports:
        if r["errors"]:
            print(f'{r["id"]}: {"; ".join(r["errors"])}')
    return int(not paths or bool(result["failedSheets"]))


if __name__ == "__main__":
    raise SystemExit(main())
