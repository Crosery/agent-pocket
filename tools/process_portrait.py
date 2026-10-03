#!/usr/bin/env python3
"""Portrait bust (AI render on magenta) -> out*out RGBA pixel bust.

Key -> robust bbox -> fit into a work*work canvas (bottom-aligned, centred) -> downsample -> binary alpha
-> palette -> cleanup -> nearest upscale to out*out. Sizes/palette in assets_src/pipeline.json `portrait`.
Usage: python3 tools/process_portrait.py raw.png out.png
"""

from __future__ import annotations

import argparse
import json
import math
import sys

import numpy as np
from assetlib import (
    binarize_alpha,
    box_resample,
    chroma_key,
    clean_halo,
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


def bbox_min_count(height: int, cfg: dict) -> int:
    """Rows/cols with fewer opaque pixels than this are treated as stray specks when measuring a bbox."""
    bc = cfg["chroma"]["bboxMinCount"]
    return max(bc["min"], round(height * bc["fraction"]))


def robust_bbox(alpha: np.ndarray, min_count: int) -> tuple[int, int, int, int] | None:
    """Bbox over rows/cols holding at least min_count opaque pixels (ignores stray specks)."""
    m = alpha >= 127.5
    rows = np.nonzero(m.sum(axis=1) >= min_count)[0]
    cols = np.nonzero(m.sum(axis=0) >= min_count)[0]
    if len(rows) == 0 or len(cols) == 0:
        return None
    return int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1


def fit_sprite(
    keyed: np.ndarray,
    bbox,
    work: int,
    fill_w: float,
    fill_h: float,
    resample: str,
    anchor_bottom: bool,
) -> np.ndarray:
    x0, y0, x1, y1 = bbox
    bw, bh = x1 - x0, y1 - y0
    s = min(work * fill_w / bw, work * fill_h / bh)
    w, h = max(1, round(bw * s)), max(1, round(bh * s))
    if resample == "medoid":
        g = 1 / s
        part = medoid_resample(keyed, g, g, x0, y1 - h * g, w, h)
    else:
        part = box_resample(keyed[y0:y1, x0:x1], w, h)
    canvas = np.zeros((work, work, 4), np.float32)
    dx = (work - w) // 2
    dy = work - h if anchor_bottom else (work - h) // 2
    canvas[dy : dy + h, dx : dx + w] = part
    return canvas


def process_portrait(src: str, dst: str) -> dict:
    cfg = pipeline_cfg()
    pc = cfg["portrait"]
    img = load_src(src)
    keyed = chroma_key(img, cfg["chroma"])
    bbox = robust_bbox(keyed[..., 3], bbox_min_count(img.shape[0], cfg))
    if bbox is None:
        raise ValueError("portrait: nothing left after keying")
    touches_bottom = bbox[3] >= img.shape[0] - math.ceil(
        img.shape[0] * pc["bottomTouchFraction"]
    )
    work = fit_sprite(
        keyed,
        bbox,
        pc["work"],
        pc["fillWidth"],
        pc["fillHeight"],
        pc["resample"],
        anchor_bottom=True,
    )
    work = binarize_alpha(work)
    work = remove_specks(work, pc["minSpeck"], pc["speckRatio"])
    work = fill_pinholes(work, pc["pinhole"])
    key = tuple(
        estimate_key(
            img, hex_rgb(cfg["chroma"]["color"]), cfg["chroma"]["estimateMaxDist"]
        )
    )
    work = clean_halo(work, key, cfg["chroma"]["haloMaxDist"])
    work = quantize(work, pc["palette"])
    out = nearest_resize(work, pc["out"], pc["out"])
    save_png(to_image(out), dst)
    return {"bbox": list(bbox), "bustCutAtBottom": bool(touches_bottom)}


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("src")
    ap.add_argument("dst")
    a = ap.parse_args()
    print(json.dumps(process_portrait(a.src, a.dst)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
