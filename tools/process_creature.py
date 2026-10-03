#!/usr/bin/env python3
"""Creature battle sprite (AI render on magenta) -> size*size RGBA true-pixel-art sprite.

Key -> drop detached islands (floating icons / bubbles) -> robust subject bbox (stray specks outside it dropped) -> source pixel grid + phase estimate and medoid
sampling at native resolution (pixelize.py). When the native sprite does not fit the canvas, or is implausibly
small (bad grid estimate / low confidence), the subject is instead medoid-sampled at the cell size that fits
it, feet anchored on a pixel boundary. Then: binary alpha -> speck / pinhole / key-halo cleanup -> crop ->
feet on the bottom margin, horizontally centred on the torso -> 1px dark outline cleanup (light silhouette
pixels become a dark shade of themselves) -> palette.

Canvas size: content/config.json sprites.creatureSize; every other number: assets_src/pipeline.json `creature`.
Usage: python3 tools/process_creature.py raw.png out.png
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from assetlib import (
    alpha_bbox,
    apply_palette,
    binarize_alpha,
    build_palette,
    chroma_key,
    clean_halo,
    components,
    content_json,
    dilate,
    estimate_key,
    fill_pinholes,
    hex_rgb,
    load_src,
    medoid_resample,
    pipeline_cfg,
    remove_specks,
    save_png,
    to_image,
)
from pixelize import pixelize
from process_portrait import bbox_min_count, robust_bbox
from process_sheet import torso_center

LUMA = np.array([0.299, 0.587, 0.114], np.float32)


class CreatureError(Exception):
    pass


def isolate(keyed: np.ndarray, bbox, pad: int) -> np.ndarray:
    """Transparent everywhere outside bbox expanded by pad px (drops stray specks far from the subject)."""
    x0, y0, x1, y1 = bbox
    out = keyed.copy()
    keep = np.zeros(out.shape[:2], bool)
    keep[max(0, y0 - pad) : y1 + pad, max(0, x0 - pad) : x1 + pad] = True
    out[~keep, 3] = 0
    return out


def drop_detached(keyed: np.ndarray, dcfg: dict) -> tuple[np.ndarray, int]:
    """Clear opaque islands smaller than keepRatio x the largest one (floating icons, bubbles, letters, sparkles
    read as noise at sprite size). Islands are found on a `pool` px max-pooled mask so hair strands, hands and
    held props a few px apart stay attached to the body. Returns (keyed, removed island count)."""
    f = dcfg["pool"]
    mask = keyed[..., 3] >= 127.5
    h, w = mask.shape
    hp, wp = -(-h // f) * f, -(-w // f) * f
    pooled = np.zeros((hp, wp), bool)
    pooled[:h, :w] = mask
    pooled = pooled.reshape(hp // f, f, wp // f, f).any(axis=(1, 3))
    labels, sizes = components(pooled)
    if len(sizes) < 2:
        return keyed, 0
    small = np.array([sz < dcfg["keepRatio"] * max(sizes) for sz in sizes])
    drop = small[np.maximum(labels, 0)] & (labels >= 0)
    drop = np.repeat(np.repeat(drop, f, axis=0), f, axis=1)[:h, :w]
    out = keyed.copy()
    out[drop & mask, 3] = 0
    return out, int(small.sum())


def sample(
    keyed: np.ndarray, bbox, inner: tuple[int, int], cfg: dict, sid: str = ""
) -> tuple[np.ndarray, dict]:
    """Native-grid sample when it fits the inner box, else a fitted medoid resample (feet anchored).
    `minFillById` raises minFill for ids whose native grid is coarse (sprite too small in frame)."""
    cc = cfg["creature"]
    min_fill = cc.get("minFillById", {}).get(sid, cc["minFill"])
    x0, y0, x1, y1 = bbox
    bw, bh = x1 - x0, y1 - y0
    native, info = pixelize(keyed, cfg, min_speck=cc["minSpeck"], pinhole=cc["pinhole"])
    nb = alpha_bbox(native) or (0, 0, 0, 0)  # after speck removal
    fill = max((nb[2] - nb[0]) / inner[0], (nb[3] - nb[1]) / inner[1])
    info = {
        "grid": info["grid"],
        "confidence": info["confidence"],
        "nativeFill": round(fill, 3),
    }
    if info["confidence"] >= cc["minConfidence"] and min_fill <= fill <= 1.0:
        return native, {**info, "mode": "native"}
    s = max(bw / (inner[0] * cc["fill"]), bh / (inner[1] * cc["fill"]))
    w, h = math.ceil(bw / s), math.ceil(bh / s)
    ox, oy = (x0 + x1) / 2 - w * s / 2, y1 - h * s
    out = binarize_alpha(medoid_resample(keyed, s, s, ox, oy, w, h))
    out = fill_pinholes(remove_specks(out, cc["minSpeck"]), cc["pinhole"])
    return out, {**info, "mode": "fitted", "cell": round(s, 3)}


def outline_cleanup(rgba: np.ndarray, ocfg: dict) -> tuple[np.ndarray, int]:
    """Silhouette pixels lighter than maxLuma become a dark shade of themselves -> closed 1px dark outline."""
    opaque = rgba[..., 3] >= 127.5
    edge = opaque & dilate(~opaque, 1)
    light = edge & ((rgba[..., :3] @ LUMA) > ocfg["maxLuma"])
    out = rgba.copy()
    out[light, :3] *= ocfg["darken"]
    return out, int(light.sum())


def process_creature(src: str, dst: str) -> dict:
    cfg = pipeline_cfg()
    cc = cfg["creature"]
    size = content_json("content/config.json")["sprites"]["creatureSize"]
    inner = (size - 2 * cc["sideMargin"], size - cc["topMargin"] - cc["bottomMargin"])

    img = load_src(src)
    key = tuple(
        estimate_key(
            img, hex_rgb(cfg["chroma"]["color"]), cfg["chroma"]["estimateMaxDist"]
        )
    )
    keyed = chroma_key(img, cfg["chroma"])
    keyed, detached = drop_detached(keyed, cc["detached"])
    bbox = robust_bbox(keyed[..., 3], bbox_min_count(img.shape[0], cfg))
    if bbox is None:
        raise CreatureError("nothing left after keying")
    keyed = isolate(keyed, bbox, cc["bboxPad"])
    sprite, info = sample(keyed, bbox, inner, cfg, Path(dst).stem)
    sprite = remove_specks(sprite, cc["minSpeck"], cc["speckRatio"])
    sprite = clean_halo(sprite, key, cfg["chroma"]["haloMaxDist"])

    ys, xs = np.nonzero(sprite[..., 3] >= 127.5)
    if len(xs) == 0:
        raise CreatureError("empty sprite after cleanup")
    sprite = sprite[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    warnings = []
    if sprite.shape[0] > inner[1] or sprite.shape[1] > inner[0]:
        warnings.append(
            f"sprite {sprite.shape[1]}x{sprite.shape[0]} exceeds {inner}; clipped"
        )
        sprite = sprite[-inner[1] :, : inner[0]]
    fh, fw = sprite.shape[:2]
    dx = round(size / 2 - torso_center(sprite, cc["torsoBand"]))
    dx = min(max(dx, cc["sideMargin"]), size - cc["sideMargin"] - fw)
    dy = size - cc["bottomMargin"] - fh
    canvas = np.zeros((size, size, 4), np.float32)
    canvas[dy : dy + fh, dx : dx + fw] = sprite

    canvas, darkened = outline_cleanup(canvas, cc["outline"])
    pal = build_palette([canvas], cc["palette"])
    canvas = apply_palette(canvas, pal)
    opaque = canvas[..., 3] >= 127.5
    key_like = opaque & (
        np.linalg.norm(canvas[..., :3] - np.array(key, np.float32), axis=2)
        < cc["keyLikeDist"]
    )
    save_png(to_image(canvas), dst)
    return {
        **info,
        "bbox": list(bbox),
        "sprite": [fw, fh],
        "colors": len(pal),
        "outlineDarkened": darkened,
        "detachedDropped": detached,
        "keyLikePixels": int(key_like.sum()),
        "warnings": warnings,
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("src")
    ap.add_argument("dst")
    a = ap.parse_args()
    try:
        print(json.dumps(process_creature(a.src, a.dst), ensure_ascii=False))
    except CreatureError as e:
        print(f"FAILED {a.src}: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
