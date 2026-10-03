#!/usr/bin/env python3
"""Terrain textures and grass tufts.

texture: centre crop -> resample to work size -> two-pass half-offset blend (x then y) so the tile wraps
         seamlessly -> downsample to the final size -> quantize to the palette of the un-blended tile.
tuft:    magenta-keyed sprite -> bbox -> fit into size*size, bottom-aligned -> binary alpha -> palette.
Sizes/palette/crop in assets_src/pipeline.json `texture` / `tuft` (`texture.sizes` overrides per key).

Usage: python3 tools/process_texture.py raw.png out.png [--tuft] [--key KEY] [--preview preview.png]
"""

from __future__ import annotations

import argparse
import json
import sys

import numpy as np
from assetlib import (
    apply_palette,
    binarize_alpha,
    box_resample,
    build_palette,
    chroma_key,
    clean_halo,
    estimate_key,
    hex_rgb,
    load_rgb,
    load_src,
    medoid_resample,
    nearest_resize,
    pipeline_cfg,
    remove_specks,
    save_png,
    to_image,
)
from PIL import Image
from process_portrait import bbox_min_count, fit_sprite, robust_bbox


def _ramp(n: int, band: float) -> np.ndarray:
    """1 in the tile interior, falling smoothly to 0 at the wrap border over `band` pixels."""
    d = np.minimum(np.arange(n) + 0.5, n - (np.arange(n) + 0.5))
    t = np.clip(d / max(band, 1e-6), 0, 1)
    return t * t * (3 - 2 * t)


def make_seamless(tile: np.ndarray, blend: float) -> np.ndarray:
    h, w = tile.shape[:2]
    wx = _ramp(w, blend * w)[None, :, None]
    t1 = wx * tile + (1 - wx) * np.roll(tile, w // 2, axis=1)
    wy = _ramp(h, blend * h)[:, None, None]
    return wy * t1 + (1 - wy) * np.roll(t1, h // 2, axis=0)


def seam_error(tile: np.ndarray) -> float:
    """Mean colour jump across the wrap seams relative to the mean jump inside the tile (≈1 == seamless)."""
    inner = (
        np.abs(np.diff(tile, axis=1)).mean() + np.abs(np.diff(tile, axis=0)).mean()
    ) / 2
    wrap = (
        np.abs(tile[:, 0] - tile[:, -1]).mean() + np.abs(tile[0] - tile[-1]).mean()
    ) / 2
    return float(wrap / max(inner, 1e-6))


def axis_period(
    rgb: np.ndarray, axis: int, pmin: float, pmax: float
) -> tuple[float, float]:
    """Dominant structural period along an axis (tile grout, planks, bricks) and its strength.

    Same spectral idea as assetlib.estimate_grid but on a coarse scale: the fundamental is the largest
    period among near-max peaks. Organic textures (grass, sand) score low.
    """
    d = np.abs(np.diff(rgb, axis=axis)).sum(axis=2)
    prof = d.sum(axis=0) if axis == 1 else d.sum(axis=1)
    prof = prof - prof.mean()
    periods = np.arange(pmin, pmax, 0.5)
    x = np.arange(len(prof)) + 0.5
    sc = np.abs(np.exp(-2j * np.pi * x[None, :] / periods[:, None]) @ prof) / (
        np.abs(prof).sum() + 1e-6
    )
    peaks = [
        i
        for i in range(len(sc))
        if sc[i] >= 0.8 * sc.max()
        and (i == 0 or sc[i] >= sc[i - 1])
        and (i == len(sc) - 1 or sc[i] >= sc[i + 1])
    ]
    i = max(peaks) if peaks else int(sc.argmax())
    return float(periods[i]), float(sc[i])


def _small(crop: np.ndarray, size: int) -> np.ndarray:
    return np.stack(
        [
            np.asarray(
                Image.fromarray(crop[..., c], "F").resize(
                    (size, size), Image.Resampling.BOX
                )
            )
            for c in range(3)
        ],
        axis=2,
    )


def best_crop(
    rgb: np.ndarray, sw: int, sh: int, size: int, steps: int
) -> tuple[int, int, float]:
    """Crop origin whose downsampled tile already wraps best."""
    H, W = rgb.shape[:2]
    best = (0, 0, float("inf"))
    for y in np.linspace(0, H - sh, steps).astype(int):
        for x in np.linspace(0, W - sw, steps).astype(int):
            err = seam_error(_small(rgb[y : y + sh, x : x + sw], size))
            if err < best[2]:
                best = (int(x), int(y), err)
    return best


def process_texture(src: str, dst: str, key: str = "", kind: str = "") -> dict:
    tc = pipeline_cfg()["texture"]
    pc = tc["period"]
    size = tc["sizes"].get(key, tc["size"])
    work = size * tc["workScale"]
    rgb = load_rgb(src)
    H, W = rgb.shape[:2]
    crop_frac = tc["cropByKey"].get(key, tc["cropByKind"].get(kind, tc["crop"]))
    side = int(min(H, W) * crop_frac)
    # Structured textures: crop a whole number of periods so the pattern wraps by construction.
    dims = []
    periods = []
    for axis, n in ((1, W), (0, H)):
        per, score = axis_period(rgb, axis, n * pc["min"], n * pc["max"])
        periodic = score >= pc["minScore"]
        dims.append(round(max(1, round(side / per)) * per) if periodic else side)
        periods.append(round(per, 1) if periodic else None)
    sw, sh = dims
    m = int(min(H, W) * tc["searchMargin"])
    x0, y0, before = best_crop(
        rgb[m : H - m, m : W - m], sw, sh, size, tc["searchSteps"]
    )
    x0, y0 = x0 + m, y0 + m
    crop = np.concatenate(
        [rgb[y0 : y0 + sh, x0 : x0 + sw], np.full((sh, sw, 1), 255.0, np.float32)],
        axis=2,
    )
    big = box_resample(crop, work, work)
    pal = build_palette([box_resample(big, size, size)], tc["palette"])
    blend = tc["seamBlendByKey"].get(key, tc["seamBlend"])
    blended = blend > 0 and before > tc["seamOk"]
    seamless = make_seamless(big, blend) if blended else big
    small = (
        box_resample(seamless, size, size)
        if tc["resample"] == "box"
        else medoid_resample(
            seamless, tc["workScale"], tc["workScale"], 0, 0, size, size
        )
    )
    tile = apply_palette(small, pal)
    tile[..., 3] = 255
    save_png(to_image(tile[..., :3]), dst)
    return {
        "size": size,
        "crop": [x0, y0, sw, sh],
        "period": periods,
        "blended": blended,
        "seamBefore": round(before, 2),
        "seamAfter": round(seam_error(tile[..., :3]), 2),
        "colors": len(pal),
    }


def process_tuft(src: str, dst: str) -> dict:
    cfg = pipeline_cfg()
    fc = cfg["tuft"]
    img = load_src(src)
    keyed = chroma_key(img, cfg["chroma"])
    bbox = robust_bbox(keyed[..., 3], bbox_min_count(img.shape[0], cfg))
    if bbox is None:
        raise ValueError("tuft: nothing left after keying")
    inner = fc["size"] - 2 * fc["margin"]
    sprite = fit_sprite(
        keyed, bbox, inner, 1.0, 1.0, fc["resample"], anchor_bottom=True
    )
    sprite = binarize_alpha(sprite)
    sprite = remove_specks(sprite, fc["minSpeck"])
    key = tuple(
        estimate_key(
            img, hex_rgb(cfg["chroma"]["color"]), cfg["chroma"]["estimateMaxDist"]
        )
    )
    sprite = clean_halo(sprite, key, cfg["chroma"]["haloMaxDist"])
    sprite = apply_palette(sprite, build_palette([sprite], fc["palette"]))
    out = np.zeros((fc["size"], fc["size"], 4), np.float32)
    out[fc["margin"] : fc["margin"] + inner, fc["margin"] : fc["margin"] + inner] = (
        sprite
    )
    # tufts stand on the ground: move the sprite down so its base touches the bottom row
    rows = np.nonzero((out[..., 3] >= 127.5).any(axis=1))[0]
    if len(rows):
        out = np.roll(out, fc["size"] - 1 - rows[-1], axis=0)
    save_png(to_image(out), dst)
    return {"size": fc["size"], "bbox": list(bbox)}


def tile_preview(tile_path: str, dst: str, repeat: int, scale: int) -> None:
    t = np.asarray(Image.open(tile_path).convert("RGB"), np.float32)
    big = np.tile(t, (repeat, repeat, 1))
    save_png(
        to_image(nearest_resize(big, big.shape[1] * scale, big.shape[0] * scale)), dst
    )


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--tuft", action="store_true")
    ap.add_argument("--key", default="")
    ap.add_argument("--kind", default="")
    ap.add_argument("--preview", default=None)
    a = ap.parse_args()
    rep = (
        process_tuft(a.src, a.dst)
        if a.tuft
        else process_texture(a.src, a.dst, a.key, a.kind)
    )
    if a.preview and not a.tuft:
        tile_preview(a.dst, a.preview, pipeline_cfg()["texture"]["previewRepeat"], 4)
    print(json.dumps(rep))
    return 0


if __name__ == "__main__":
    sys.exit(main())
