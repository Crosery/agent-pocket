"""Shared helpers for the 2D asset pipeline (paths, JSON config, pixel-art image ops).

All tunables come from assets_src/pipeline.json; prompt data from assets_src/prompts/*.json;
id lists from content/*.json. Nothing here knows about specific assets.
"""

from __future__ import annotations

import json
import pathlib
from collections import deque

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
PIPELINE_PATH = ROOT / "assets_src" / "pipeline.json"
PIPELINE_LOCAL_PATH = ROOT / "assets_src" / "pipeline.local.json"
TEMPLATES_PATH = ROOT / "assets_src" / "prompts" / "templates.json"
DETAILS_PATH = ROOT / "assets_src" / "prompts" / "details.json"
JOBS_PATH = ROOT / "assets_src" / "prompts" / "jobs.json"
RAW_DIR = ROOT / "assets_src" / "raw"


def load_json(path: pathlib.Path | str):
    return json.loads(pathlib.Path(path).read_text())


def write_json(path: pathlib.Path | str, data, indent: int | None = 2) -> None:
    p = pathlib.Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=indent) + "\n")


def _merge(base: dict, over: dict) -> dict:
    for k, v in over.items():
        base[k] = _merge(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return base


def pipeline_cfg() -> dict:
    """pipeline.json deep-merged with the untracked machine-local override (gateway URL, secrets path)."""
    cfg = load_json(PIPELINE_PATH)
    if PIPELINE_LOCAL_PATH.exists():
        cfg = _merge(cfg, load_json(PIPELINE_LOCAL_PATH))
    return cfg


def content_json(rel: str):
    return load_json(ROOT / rel)


def load_jobs(path: pathlib.Path | str = JOBS_PATH) -> list[dict]:
    return load_json(path)


def raw_path(job: dict) -> pathlib.Path:
    return RAW_DIR / job["kind"] / f"{job['id']}.png"


def out_path(job: dict) -> pathlib.Path:
    return ROOT / job["out"]


def hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


# ---------------------------------------------------------------------------
# Image I/O
# ---------------------------------------------------------------------------


def load_rgb(path: pathlib.Path | str) -> np.ndarray:
    """RGB float array; any alpha channel is ignored (textures/backdrops)."""
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)


def load_src(path: pathlib.Path | str) -> np.ndarray:
    """RGB or RGBA float array. The generator sometimes returns a real cut-out (RGBA) instead of magenta."""
    im = Image.open(path)
    mode = (
        "RGBA"
        if im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info
        else "RGB"
    )
    return np.asarray(im.convert(mode), dtype=np.float32)


def to_image(rgba: np.ndarray) -> Image.Image:
    arr = np.clip(np.rint(rgba), 0, 255).astype(np.uint8)
    return Image.fromarray(arr, "RGBA" if arr.shape[2] == 4 else "RGB")


def save_png(img: Image.Image, path: pathlib.Path | str) -> None:
    p = pathlib.Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    img.save(p, optimize=True)


# ---------------------------------------------------------------------------
# Chroma key
# ---------------------------------------------------------------------------


def estimate_key(
    rgb: np.ndarray, nominal: tuple[int, int, int], max_dist: float
) -> np.ndarray:
    """Actual background colour = median of border pixels close to the nominal key colour."""
    rgb = rgb[..., :3]
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    d = np.linalg.norm(border - np.array(nominal, np.float32), axis=1)
    near = border[d < max_dist]
    return np.median(near, axis=0) if len(near) >= 16 else np.array(nominal, np.float32)


def chroma_key(src: np.ndarray, kcfg: dict) -> np.ndarray:
    """RGB/RGBA float array -> RGBA float array (alpha 0..255, soft) with magenta despill on edges.

    A source that already carries real transparency keeps it (min of both alphas).
    """
    rgb = src[..., :3]
    key = estimate_key(rgb, hex_rgb(kcfg["color"]), kcfg["estimateMaxDist"])
    dist = np.linalg.norm(rgb - key, axis=2)
    lo, hi = kcfg["transparentBelow"], kcfg["opaqueAbove"]
    alpha = np.clip((dist - lo) / (hi - lo), 0.0, 1.0)
    if (
        src.shape[2] == 4
        and (src[..., 3] < 128).mean() > kcfg["sourceAlphaMinFraction"]
    ):
        alpha = np.minimum(alpha, src[..., 3] / 255.0)
    # Peel the anti-aliased key/subject blend band off the silhouette (judged on the un-despilled colour,
    # otherwise despill turns it into a light rim around outline-less subjects).
    for _ in range(kcfg["haloErode"]):
        bg = alpha < 0.5
        alpha[dilate(bg, 1) & ~bg & (dist < kcfg["haloMaxDist"])] = 0.0
    out = np.concatenate([rgb.copy(), (alpha * 255.0)[..., None]], axis=2)
    # Despill only near the background so legitimately purple/pink interiors keep their colour.
    edge = dilate(alpha < 0.5, kcfg["despillRadius"]) & (alpha > 0)
    r, g, b = out[..., 0], out[..., 1], out[..., 2]
    spill = np.clip(np.minimum(r, b) - g, 0, None) * kcfg["despillStrength"]
    r[edge] -= spill[edge]
    b[edge] -= spill[edge]
    return out


def dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(max(0, int(radius))):
        m = out.copy()
        m[1:] |= out[:-1]
        m[:-1] |= out[1:]
        m[:, 1:] |= out[:, :-1]
        m[:, :-1] |= out[:, 1:]
        out = m
    return out


def binarize_alpha(rgba: np.ndarray, threshold: float = 127.5) -> np.ndarray:
    out = rgba.copy()
    a = out[..., 3] >= threshold
    out[..., 3] = np.where(a, 255.0, 0.0)
    out[..., :3][~a] = 0.0
    return out


def alpha_bbox(rgba: np.ndarray, threshold: float = 127.5):
    """(x0, y0, x1, y1) exclusive bbox of opaque pixels, or None."""
    ys, xs = np.nonzero(rgba[..., 3] >= threshold)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


# ---------------------------------------------------------------------------
# Pixel grid estimation and resampling
# ---------------------------------------------------------------------------


def _edge_profile(rgb: np.ndarray, axis: int) -> np.ndarray:
    d = np.abs(np.diff(rgb, axis=axis)).sum(axis=2)
    return d.sum(axis=1 - axis) if axis == 1 else d.sum(axis=1)


def estimate_grid(rgb: np.ndarray, gmin: float, gmax: float, step: float = 0.02):
    """Estimate the AI image's pixel-art cell size and phase from colour-edge periodicity.

    Edges of a pixel grid of size g sit at phase + k*g. Their spectrum peaks at 1/g and its
    harmonics (g/2, g/3 ...), so the fundamental is the LARGEST period whose peak is close to the max.
    Returns (g, phase_x, phase_y, confidence).
    """
    px = _edge_profile(rgb, 1)  # differences along x -> profile over x
    py = _edge_profile(rgb, 0)
    periods = np.arange(gmin, gmax + 1e-9, step)
    scores = np.zeros(len(periods))
    for prof in (px, py):
        prof = prof - prof.mean()
        x = np.arange(len(prof)) + 0.5
        ph = np.exp(-2j * np.pi * x[None, :] / periods[:, None])
        scores += np.abs(ph @ prof) / (np.abs(prof).sum() + 1e-6)
    best = scores.max()
    cand = np.nonzero(scores >= 0.8 * best)[0]
    # choose the largest period among near-max peaks (local maxima only)
    peaks = [
        i
        for i in cand
        if (i == 0 or scores[i] >= scores[i - 1])
        and (i == len(scores) - 1 or scores[i] >= scores[i + 1])
    ]
    i = max(peaks) if peaks else int(scores.argmax())
    g = float(periods[i])

    def phase(prof):
        x = np.arange(len(prof)) + 0.5
        s = (prof - prof.mean()) @ np.exp(-2j * np.pi * x / g)
        return (-np.angle(s) / (2 * np.pi) * g) % g

    conf = float(scores[i] / 2.0)
    return g, float(phase(px)), float(phase(py)), conf


def medoid_resample(
    rgba: np.ndarray,
    gx: float,
    gy: float,
    ox: float,
    oy: float,
    w: int,
    h: int,
    spread: float = 0.25,
) -> np.ndarray:
    """Sample a w*h grid of cells (size gx*gy, origin ox,oy) picking each cell's medoid of 9 interior taps.

    The medoid is an actual source colour, so outlines stay crisp and no new blended colours appear.
    """
    H, W = rgba.shape[:2]
    cx = ox + (np.arange(w) + 0.5) * gx
    cy = oy + (np.arange(h) + 0.5) * gy
    taps = []
    for dy in (-spread, 0.0, spread):
        for dx in (-spread, 0.0, spread):
            xs = np.clip(np.floor(cx + dx * gx).astype(int), 0, W - 1)
            ys = np.clip(np.floor(cy + dy * gy).astype(int), 0, H - 1)
            taps.append(rgba[ys[:, None], xs[None, :]])
    s = np.stack(taps)  # (9, h, w, C)
    wts = np.array([1, 1, 1, 3][: s.shape[3]], np.float32)  # alpha differences dominate
    cost = np.zeros(s.shape[:3], np.float32)
    for i in range(len(taps)):
        cost[i] = (np.abs(s - s[i][None]) * wts).sum(axis=(0, 3))
    cost[4] -= 1e-3  # prefer the centre tap on ties
    pick = cost.argmin(axis=0)
    return np.take_along_axis(s, pick[None, ..., None], axis=0)[0]


def box_resample(rgba: np.ndarray, w: int, h: int) -> np.ndarray:
    """Area-average resample with premultiplied alpha (no dark/magenta fringes)."""
    a = rgba[..., 3:4] / 255.0
    pre = np.concatenate([rgba[..., :3] * a, rgba[..., 3:4]], axis=2)
    chans = [
        np.asarray(
            Image.fromarray(pre[..., c].astype(np.float32), "F").resize(
                (w, h), Image.Resampling.BOX
            )
        )
        for c in range(4)
    ]
    out = np.stack(chans, axis=2)
    aa = np.clip(out[..., 3:4] / 255.0, 1e-6, None)
    out[..., :3] = np.where(out[..., 3:4] > 0, out[..., :3] / aa, 0)
    return np.clip(out, 0, 255)


def nearest_resize(rgba: np.ndarray, w: int, h: int) -> np.ndarray:
    H, W = rgba.shape[:2]
    ys = np.clip(((np.arange(h) + 0.5) * H / h).astype(int), 0, H - 1)
    xs = np.clip(((np.arange(w) + 0.5) * W / w).astype(int), 0, W - 1)
    return rgba[ys[:, None], xs[None, :]]


# ---------------------------------------------------------------------------
# Palette
# ---------------------------------------------------------------------------


def build_palette(rgba_list: list[np.ndarray], colors: int) -> np.ndarray:
    pix = [
        r[..., :3][r[..., 3] >= 127.5] if r.shape[2] == 4 else r[..., :3].reshape(-1, 3)
        for r in rgba_list
    ]
    pix = np.concatenate([p.reshape(-1, 3) for p in pix])
    if len(pix) == 0:
        return np.zeros((1, 3), np.float32)
    strip = Image.fromarray(
        np.clip(pix, 0, 255).astype(np.uint8).reshape(1, -1, 3), "RGB"
    )
    q = strip.quantize(
        colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
    )
    pal = np.array((q.getpalette() or [])[: 3 * colors], np.float32).reshape(-1, 3)
    used = np.unique(np.asarray(q))
    return pal[used]


def apply_palette(rgba: np.ndarray, pal: np.ndarray) -> np.ndarray:
    out = rgba.copy()
    flat = out[..., :3].reshape(-1, 3)
    idx = np.empty(len(flat), np.int64)
    for s in range(0, len(flat), 65536):
        chunk = flat[s : s + 65536]
        idx[s : s + 65536] = (
            ((chunk[:, None, :] - pal[None, :, :]) ** 2).sum(axis=2).argmin(axis=1)
        )
    out[..., :3] = pal[idx].reshape(out.shape[:2] + (3,))
    if out.shape[2] == 4:
        out[..., :3][out[..., 3] < 127.5] = 0
    return out


def quantize(rgba: np.ndarray, colors: int) -> np.ndarray:
    return apply_palette(rgba, build_palette([rgba], colors))


# ---------------------------------------------------------------------------
# Connected components (small native-resolution images only)
# ---------------------------------------------------------------------------


def components(mask: np.ndarray) -> tuple[np.ndarray, list[int]]:
    """4-connected labelling. Returns (labels with -1 for background, sizes per label)."""
    h, w = mask.shape
    labels = np.full((h, w), -1, np.int32)
    sizes: list[int] = []
    m = mask.tolist()
    lab = labels.tolist()
    for y in range(h):
        for x in range(w):
            if not m[y][x] or lab[y][x] >= 0:
                continue
            n = len(sizes)
            q = deque([(y, x)])
            lab[y][x] = n
            cnt = 0
            while q:
                cy, cx = q.popleft()
                cnt += 1
                for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                    if 0 <= ny < h and 0 <= nx < w and m[ny][nx] and lab[ny][nx] < 0:
                        lab[ny][nx] = n
                        q.append((ny, nx))
            sizes.append(cnt)
    return np.array(lab, np.int32), sizes


def remove_specks(
    rgba: np.ndarray, min_size: int, keep_largest_ratio: float = 0.0
) -> np.ndarray:
    """Drop opaque islands smaller than min_size (or than keep_largest_ratio * largest island)."""
    mask = rgba[..., 3] >= 127.5
    labels, sizes = components(mask)
    if not sizes:
        return rgba
    limit = max(min_size, keep_largest_ratio * max(sizes))
    small = np.array([s < limit for s in sizes])
    kill = mask & small[np.maximum(labels, 0)]
    out = rgba.copy()
    out[kill] = 0
    return out


def fill_pinholes(rgba: np.ndarray, max_size: int) -> np.ndarray:
    """Fill enclosed transparent holes up to max_size pixels with the median of their opaque neighbours."""
    if max_size <= 0:
        return rgba
    holes = rgba[..., 3] < 127.5
    labels, sizes = components(holes)
    border = set(
        np.unique(
            np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
        ).tolist()
    )
    out = rgba.copy()
    for n, s in enumerate(sizes):
        if s > max_size or n in border:
            continue
        ys, xs = np.nonzero(labels == n)
        ring = dilate(labels == n, 1) & ~holes
        cols = rgba[ring][:, :3]
        if len(cols):
            out[ys, xs, :3] = np.median(cols, axis=0)
            out[ys, xs, 3] = 255
    return out


def clean_halo(
    rgba: np.ndarray, key: tuple[int, int, int], max_dist: float
) -> np.ndarray:
    """Make silhouette-edge pixels that are still close to the key colour transparent."""
    opaque = rgba[..., 3] >= 127.5
    edge = opaque & dilate(~opaque, 1)
    d = np.linalg.norm(rgba[..., :3] - np.array(key, np.float32), axis=2)
    out = rgba.copy()
    out[edge & (d < max_dist)] = 0
    return out


def add_outline(rgba: np.ndarray, color: tuple[float, float, float]) -> np.ndarray:
    """Add a 1px outline (4-neighbourhood) of `color` around the opaque silhouette."""
    opaque = rgba[..., 3] >= 127.5
    ring = dilate(opaque, 1) & ~opaque
    out = rgba.copy()
    out[ring, :3] = color
    out[ring, 3] = 255
    return out


def checkerboard(w: int, h: int, cell: int = 8) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    c = ((yy // cell + xx // cell) % 2).astype(np.float32)
    v = 200 + 40 * c
    return np.stack([v, v, v], axis=2)


def composite(rgba: np.ndarray, bg: np.ndarray) -> np.ndarray:
    a = rgba[..., 3:4] / 255.0
    return rgba[..., :3] * a + bg * (1 - a)
