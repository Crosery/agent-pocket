#!/usr/bin/env python3
"""UI art: type emblem icons, painted backdrops (battle backgrounds / title key art) and the logo.

icon:     keyed emblem -> square fit into size*size -> binary alpha -> palette -> 1px outline in a dark shade
          of the type colour (job meta `color`) or the darkest palette colour.
backdrop: cover-crop to width:height -> medoid downsample by `pixel` -> palette -> nearest upscale (opaque).
logo:     keyed -> bbox -> fit inside maxWidth*maxHeight -> pixel snap -> binary alpha -> palette.
Parameters in assets_src/pipeline.json `icon` / `backdrop` / `logo`.

Usage: python3 tools/process_ui.py {icon|backdrop|logo} raw.png out.png [--color #rrggbb]
"""

from __future__ import annotations

import argparse
import json
import math
import sys

import numpy as np
from assetlib import (
    add_outline,
    alpha_bbox,
    apply_palette,
    binarize_alpha,
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
from process_portrait import bbox_min_count, fit_sprite, robust_bbox


def _keyed(src: str, cfg: dict) -> tuple[np.ndarray, tuple]:
    img = load_src(src)
    key = tuple(
        estimate_key(
            img, hex_rgb(cfg["chroma"]["color"]), cfg["chroma"]["estimateMaxDist"]
        )
    )
    return chroma_key(img, cfg["chroma"]), key


def process_icon(src: str, dst: str, color: str | None = None) -> dict:
    cfg = pipeline_cfg()
    ic = cfg["icon"]
    keyed, key = _keyed(src, cfg)
    bbox = robust_bbox(keyed[..., 3], bbox_min_count(keyed.shape[0], cfg))
    if bbox is None:
        raise ValueError("icon: nothing left after keying")
    x0, y0, x1, y1 = bbox
    side = max(x1 - x0, y1 - y0)  # square bbox keeps the emblem's aspect
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    sq = (
        int(cx - side / 2),
        int(cy - side / 2),
        int(cx - side / 2) + side,
        int(cy - side / 2) + side,
    )
    pad = max(0, -min(sq))
    if pad:
        keyed = np.pad(keyed, ((pad, pad), (pad, pad), (0, 0)))
        sq = tuple(v + pad for v in sq)
    inner = ic["size"] - 2 * ic["margin"] - (2 if ic["outline"] else 0)
    sprite = fit_sprite(keyed, sq, inner, 1.0, 1.0, "box", anchor_bottom=False)
    sprite = binarize_alpha(sprite)
    sprite = remove_specks(sprite, ic["minSpeck"])
    sprite = clean_halo(sprite, key, cfg["chroma"]["haloMaxDist"])
    pal = build_palette([sprite], ic["palette"])
    sprite = apply_palette(sprite, pal)
    out = np.zeros((ic["size"], ic["size"], 4), np.float32)
    o = (ic["size"] - inner) // 2
    out[o : o + inner, o : o + inner] = sprite
    if ic["outline"]:
        base = (
            np.array(hex_rgb(color), np.float32)
            if color
            else pal[np.argmin(pal.sum(axis=1))]
        )
        out = add_outline(out, tuple(base * ic["outlineDarken"]))
    save_png(to_image(out), dst)
    return {"size": ic["size"], "colors": len(pal)}


def process_backdrop(src: str, dst: str, bc: dict | None = None) -> dict:
    """bc defaults to pipeline.json `backdrop`; `palette` 0 keeps every colour (medoid pixel snap only);
    `keepSize` keeps the source size instead of `width` x `height`."""
    bc = bc or pipeline_cfg()["backdrop"]
    rgb = load_rgb(src)
    H, W = rgb.shape[:2]
    tw, th = (W, H) if bc.get("keepSize") else (bc["width"], bc["height"])
    s = max(tw / W, th / H)  # cover
    cw, ch = tw / s, th / s
    ox, oy = (W - cw) / 2, (H - ch) / 2
    nw, nh = math.ceil(tw / bc["pixel"]), math.ceil(th / bc["pixel"])
    rgba = np.concatenate([rgb, np.full((H, W, 1), 255.0, np.float32)], axis=2)
    small = medoid_resample(rgba, cw / nw, ch / nh, ox, oy, nw, nh)
    if bc["palette"]:
        small = apply_palette(small, build_palette([small], bc["palette"]))
    out = nearest_resize(small, tw, th)
    save_png(to_image(out[..., :3]), dst)
    return {"size": [tw, th], "native": [nw, nh]}


def process_logo(src: str, dst: str) -> dict:
    cfg = pipeline_cfg()
    lc = cfg["logo"]
    keyed, key = _keyed(src, cfg)
    bbox = robust_bbox(keyed[..., 3], bbox_min_count(keyed.shape[0], cfg))
    if bbox is None:
        raise ValueError("logo: nothing left after keying")
    x0, y0, x1, y1 = bbox
    s = min(lc["maxWidth"] / (x1 - x0), lc["maxHeight"] / (y1 - y0), 1.0)
    w, h = round((x1 - x0) * s), round((y1 - y0) * s)
    nw, nh = math.ceil(w / lc["pixel"]), math.ceil(h / lc["pixel"])
    small = binarize_alpha(
        medoid_resample(keyed, (x1 - x0) / nw, (y1 - y0) / nh, x0, y0, nw, nh)
    )
    small = remove_specks(small, lc["minSpeck"], lc["speckRatio"])
    small = clean_halo(small, key, cfg["chroma"]["haloMaxDist"])
    small = apply_palette(small, build_palette([small], lc["palette"]))
    out = nearest_resize(small, nw * lc["pixel"], nh * lc["pixel"])
    bb = alpha_bbox(out)
    if bb:
        out = out[bb[1] : bb[3], bb[0] : bb[2]]
    save_png(to_image(out), dst)
    return {"size": [out.shape[1], out.shape[0]]}


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("mode", choices=["icon", "backdrop", "logo"])
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--color", default=None)
    a = ap.parse_args()
    if a.mode == "icon":
        rep = process_icon(a.src, a.dst, a.color)
    elif a.mode == "backdrop":
        rep = process_backdrop(a.src, a.dst)
    else:
        rep = process_logo(a.src, a.dst)
    print(json.dumps(rep))
    return 0


if __name__ == "__main__":
    sys.exit(main())
