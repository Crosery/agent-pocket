#!/usr/bin/env python3
"""Turn an AI "pixel art" render into true pixel art.

Pipeline: chroma-key magenta (distance ramp + edge despill) -> bbox -> estimate the source pixel-grid size
and phase -> medoid-sample each grid cell at its centre (native resolution) -> binary alpha -> speck /
pinhole / halo cleanup -> optional palette reduction.

Usage: python3 tools/pixelize.py in.png out.png [--no-key] [--grid G] [--palette N] [--scale K] [--no-crop]
"""

from __future__ import annotations

import argparse
import math
import sys

import numpy as np
from assetlib import (
    alpha_bbox,
    binarize_alpha,
    chroma_key,
    clean_halo,
    estimate_grid,
    estimate_key,
    fill_pinholes,
    hex_rgb,
    load_src,
    medoid_resample,
    nearest_resize,
    pipeline_cfg,
    quantize,
    remove_specks,
    save_png,
    to_image,
)


def key_image(rgb: np.ndarray, cfg: dict) -> np.ndarray:
    return chroma_key(rgb, cfg["chroma"])


def grid_of(
    rgba: np.ndarray, cfg: dict, bbox=None
) -> tuple[float, float, float, float]:
    """(g, phase_x, phase_y, confidence) measured inside bbox (absolute phases)."""
    x0, y0, x1, y1 = bbox or (0, 0, rgba.shape[1], rgba.shape[0])
    region = rgba[y0:y1, x0:x1]
    a = region[..., 3:4] / 255.0
    rgb = region[..., :3] * a  # transparent areas contribute no edges
    g, px, py, conf = estimate_grid(rgb, cfg["grid"]["min"], cfg["grid"]["max"])
    return g, (px + x0) % g, (py + y0) % g, conf


def pixelize(
    rgba: np.ndarray,
    cfg: dict,
    grid: float | None = None,
    crop: bool = True,
    min_speck: int = 4,
    pinhole: int = 2,
) -> tuple[np.ndarray, dict]:
    bbox = alpha_bbox(rgba) or (0, 0, rgba.shape[1], rgba.shape[0])
    if grid:
        g, ox, oy, conf = grid, 0.0, 0.0, 1.0
    else:
        g, ox, oy, conf = grid_of(rgba, cfg, bbox)
    if crop:
        x0, y0, x1, y1 = bbox
        ox = x0 - ((x0 - ox) % g)
        oy = y0 - ((y0 - oy) % g)
        w, h = math.ceil((x1 - ox) / g), math.ceil((y1 - oy) / g)
    else:
        ox, oy = ox % g - g, oy % g - g
        w, h = math.ceil((rgba.shape[1] - ox) / g), math.ceil((rgba.shape[0] - oy) / g)
    native = binarize_alpha(medoid_resample(rgba, g, g, ox, oy, w, h))
    native = remove_specks(native, min_speck)
    native = fill_pinholes(native, pinhole)
    return native, {"grid": round(g, 3), "confidence": round(conf, 3), "size": [w, h]}


def main() -> int:
    cfg = pipeline_cfg()
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument(
        "--no-key", action="store_true", help="source has no magenta background"
    )
    ap.add_argument("--grid", type=float, default=None, help="force source pixel size")
    ap.add_argument("--palette", type=int, default=0)
    ap.add_argument(
        "--scale", type=int, default=1, help="nearest upscale of the result"
    )
    ap.add_argument("--no-crop", action="store_true")
    a = ap.parse_args()
    rgb = load_src(a.src)
    if a.no_key:
        rgba = np.concatenate(
            [rgb[..., :3], np.full(rgb.shape[:2] + (1,), 255.0, np.float32)], axis=2
        )
    else:
        rgba = key_image(rgb, cfg)
    native, info = pixelize(rgba, cfg, a.grid, crop=not a.no_crop)
    if not a.no_key:
        key = estimate_key(
            rgb, hex_rgb(cfg["chroma"]["color"]), cfg["chroma"]["estimateMaxDist"]
        )
        native = clean_halo(native, tuple(key), cfg["chroma"]["haloMaxDist"])
    if a.palette:
        native = quantize(native, a.palette)
    if a.scale > 1:
        native = nearest_resize(
            native, native.shape[1] * a.scale, native.shape[0] * a.scale
        )
    save_png(to_image(native), a.dst)
    print(
        f"{a.src} -> {a.dst} grid={info['grid']} conf={info['confidence']} native={info['size']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
