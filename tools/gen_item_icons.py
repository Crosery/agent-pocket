#!/usr/bin/env python3
"""Item icons: every item in content/items.json -> 32x32 pixel-art icon public/assets/items/<itemId>.png.

Design units: one per non-chip item, plus one skill-chip design per content type; every chip item reuses the
design of its move's type. Units are packed (category order, then content order) into cols x rows icon SHEETS
rendered by the local generator on flat magenta. Each sheet's sidecar records its cells (row-major unit key + the
cell text it was prompted with). A unit uses the newest sheet whose cell text still matches its current text, so
editing an item's detail or a category template regenerates exactly the affected units.

Slicing: key the sheet -> refine the even grid at projection minima -> label alpha blobs -> assign blobs to cells by
centroid -> keep the cell's significant blobs -> square fit -> binary alpha -> palette -> dark outline -> verify.

Prompt text, sizes and thresholds: assets_src/prompts/items.json (+ items_details.json). Ids come from content.

Usage:
  python3 tools/gen_item_icons.py [all]       generate missing/stale sheets -> process -> manifest
  python3 tools/gen_item_icons.py plan        list units and the sheets that would be generated
  python3 tools/gen_item_icons.py generate    [--force ids] [--force-all] [--keep-stale] [--concurrency N]
  python3 tools/gen_item_icons.py process     [--prune]  slice sheets, write icons + report + contact sheets
  python3 tools/gen_item_icons.py check       every content item has a valid icon (exit 1 otherwise)
  python3 tools/gen_item_icons.py selftest    slicing/processing on a synthetic sheet
--force takes item ids or chip designs as chip:<typeId> (a chip item id selects its type's design).
"""

from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import math
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

import numpy as np
from assetlib import (
    RAW_DIR,
    ROOT,
    add_outline,
    alpha_bbox,
    binarize_alpha,
    chroma_key,
    clean_halo,
    components,
    content_json,
    dilate,
    estimate_key,
    fill_pinholes,
    hex_rgb,
    load_json,
    load_src,
    pipeline_cfg,
    quantize,
    remove_specks,
    save_png,
    to_image,
    write_json,
)
from gen_images import run_once
from PIL import Image, ImageDraw
from process_portrait import bbox_min_count, fit_sprite, robust_bbox

CFG_PATH = ROOT / "assets_src" / "prompts" / "items.json"
PLACEHOLDER = re.compile(r"\{([A-Za-z0-9_.]+)\}")
LOCK = threading.Lock()
Halo = tuple[tuple, float]  # (key colour, max distance) for clean_halo


def log(msg: str) -> None:
    with LOCK:
        print(msg, flush=True)


def load_cfg() -> dict:
    return load_json(CFG_PATH)


def at(data, path: str | None):
    for part in (path or "").split("."):
        if part:
            data = data[part]
    return data


def fill(tpl: str, ctx: dict) -> str:
    def rep(m: re.Match) -> str:
        k = m.group(1)
        if k not in ctx:
            raise KeyError(f"placeholder {{{k}}} has no value")
        return str(ctx[k])

    return PLACEHOLDER.sub(rep, tpl)


def words(ident: str) -> str:
    return re.sub(r"[-_]+", " ", ident).strip()


# ---------------------------------------------------------------------------
# Colour naming / matching (CIE Lab)
# ---------------------------------------------------------------------------


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    c = np.asarray(rgb, np.float64) / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    m = np.array(
        [[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]
    )
    xyz = (c @ m.T) / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack(
        [
            116 * f[..., 1] - 16,
            500 * (f[..., 0] - f[..., 1]),
            200 * (f[..., 1] - f[..., 2]),
        ],
        axis=-1,
    )


def color_name(hex_color: str, names: list[dict]) -> str:
    target = srgb_to_lab(np.array(hex_rgb(hex_color)))
    refs = srgb_to_lab(np.array([hex_rgb(n["hex"]) for n in names]))
    return names[int(np.linalg.norm(refs - target, axis=1).argmin())]["name"]


def tint_fraction(icon: np.ndarray, hex_color: str, vc: dict) -> float:
    """Share of opaque pixels whose colour is near the tint (lightness weighted down: shading is expected)."""
    opaque = icon[..., 3] >= 127.5
    if not opaque.any():
        return 0.0
    lab = srgb_to_lab(icon[..., :3][opaque])
    d = lab - srgb_to_lab(np.array(hex_rgb(hex_color)))
    d[:, 0] *= vc["tintLightnessWeight"]
    return float((np.linalg.norm(d, axis=1) < vc["tintDistance"]).mean())


# ---------------------------------------------------------------------------
# Units (one icon design each) from content
# ---------------------------------------------------------------------------


@dataclass
class Unit:
    key: str
    category: str
    text: str
    tint: str | None
    order: tuple
    items: list[str] = field(default_factory=list)


def build_units(cfg: dict) -> tuple[dict[str, Unit], dict[str, str], list[str]]:
    """-> (units by key, item id -> unit key, content problems)."""
    items = content_json(cfg["content"]["items"])
    moves = {m["id"]: m for m in content_json(cfg["content"]["moves"])}
    tc = cfg["content"]["types"]
    types = at(content_json(tc["file"]), tc.get("path"))
    details = load_json(ROOT / cfg["paths"]["details"])
    cc = cfg["chip"]
    ms = cc.get("motifSource")
    motifs = (
        at(load_json(ROOT / ms["file"]), ms.get("path"))
        if ms and (ROOT / ms["file"]).exists()
        else {}
    )
    style = {f"style.{k}": v for k, v in cfg["style"].items()}
    names = cfg["colorNames"]
    rank = {c: i for i, c in enumerate(cfg["sheet"]["categoryOrder"])}
    units: dict[str, Unit] = {}
    item_unit: dict[str, str] = {}
    problems: list[str] = []

    def describe(category: str, ctx: dict, detail: str, who: str) -> str:
        tpl = cfg["categories"].get(category, cfg["categoryFallback"])
        try:
            return fill(tpl, {**ctx, "detail": detail})
        except KeyError as e:
            problems.append(f"{who}: category template needs {e}; using fallback")
            return fill(cfg["categoryFallback"], {**ctx, "detail": detail})

    for i, t in enumerate(types):
        key = cc["unitPrefix"] + t["id"]
        ctx = {
            **style,
            "id": t["id"],
            "idWords": words(t["id"]),
            "nameZh": t["nameZh"],
            "color": t["color"],
            "colorName": color_name(t["color"], names),
        }
        motif = (
            details.get("chips", {}).get(t["id"])
            or motifs.get(t["id"])
            or fill(cc["motifFallback"], ctx)
        )
        detail = fill(cc["template"], {**ctx, "motif": motif})
        units[key] = Unit(
            key,
            cc["category"],
            describe(cc["category"], ctx, detail, key),
            t["color"],
            (rank.get(cc["category"], len(rank)), i),
        )

    for i, it in enumerate(items):
        eff = it.get("effect") or {}
        if eff.get("kind") == "chip":
            mv = moves.get(eff.get("move"))
            key = cc["unitPrefix"] + str(mv.get("type")) if mv else ""
            if key not in units:
                problems.append(
                    f"{it['id']}: chip move {eff.get('move')!r} has no known type"
                )
                continue
            units[key].items.append(it["id"])
            item_unit[it["id"]] = key
            continue
        ctx = {
            **style,
            "id": it["id"],
            "idWords": words(it["id"]),
            "nameZh": it["nameZh"],
            "description": it.get("description", ""),
            "category": it["category"],
            **{
                f"effect.{k}": v
                for k, v in eff.items()
                if isinstance(v, (str, int, float))
            },
        }
        tint = eff.get("color")
        if tint:
            ctx["color"] = tint
            ctx["colorName"] = color_name(tint, names)
        detail = fill(details["items"].get(it["id"]) or cfg["detailFallback"], ctx)
        key = it["id"]
        units[key] = Unit(
            key,
            it["category"],
            describe(it["category"], ctx, detail, key),
            tint,
            (rank.get(it["category"], len(rank)), i),
            [it["id"]],
        )
        item_unit[it["id"]] = key
    return units, item_unit, problems


# ---------------------------------------------------------------------------
# Sheets: existing (sidecars) and new (packing + prompt)
# ---------------------------------------------------------------------------


def raw_dir(cfg: dict):
    return RAW_DIR / cfg["paths"]["rawKind"]


def load_sheets(cfg: dict) -> list[dict]:
    out = []
    for meta_path in sorted(raw_dir(cfg).glob("*.json")):
        if meta_path.name.startswith("_"):
            continue
        meta = load_json(meta_path)
        sheet = meta.get("itemSheet")
        png = meta_path.with_suffix(".png")
        if sheet and png.exists():
            out.append(
                {
                    "id": meta["id"],
                    "png": png,
                    "generatedAt": meta.get("generatedAt", ""),
                    **sheet,
                }
            )
    return out


def candidates(unit: Unit, sheets: list[dict]) -> list[tuple[dict, int, bool]]:
    """(sheet, cell index, stale) newest first; cells prompted with the current text come before stale ones."""
    found = [
        (s, i, c["text"] != unit.text)
        for s in sheets
        for i, c in enumerate(s["cells"])
        if c["unit"] == unit.key
    ]
    found.sort(key=lambda t: (t[0]["generatedAt"], t[0]["id"]), reverse=True)
    found.sort(key=lambda t: t[2])
    return found


def grid_for(n: int, cfg: dict) -> tuple[int, int]:
    cols = min(cfg["sheet"]["cols"], n)
    return cols, math.ceil(n / cols)


def variant_for(cols: int, rows: int, cfg: dict) -> str:
    va = cfg["generator"]["variantByAspect"]
    return va["wide"] if cols > rows else va["tall"] if rows > cols else va["square"]


def chunks(pending: list[Unit], cfg: dict) -> list[list[Unit]]:
    """Separate categories get their own sheets; each group is split into the fewest, evenly filled sheets."""
    sc = cfg["sheet"]
    per = sc["cols"] * sc["rows"]
    groups = [[u for u in pending if u.category not in sc["separate"]]]
    groups += [[u for u in pending if u.category == c] for c in sc["separate"]]
    out = []
    for g in groups:
        n = math.ceil(len(g) / per)
        bounds = [round(i * len(g) / n) for i in range(n + 1)] if n else []
        out += [g[bounds[i] : bounds[i + 1]] for i in range(n)]
    return out


def pack(pending: list[Unit], cfg: dict) -> list[dict]:
    sc = cfg["sheet"]
    style = {f"style.{k}": v for k, v in cfg["style"].items()}
    jobs = []
    for chunk in chunks(pending, cfg):
        cols, rows = grid_for(len(chunk), cfg)
        cells = "\n".join(
            fill(
                sc["cell"],
                {"row": i // cols + 1, "col": i % cols + 1, "n": i + 1, "text": u.text},
            )
            for i, u in enumerate(chunk)
        )
        empty = (
            fill(sc["empty"], {"count": len(chunk)}) if len(chunk) < cols * rows else ""
        )
        prompt = fill(
            sc["prompt"],
            {
                **style,
                "count": len(chunk),
                "cols": cols,
                "rows": rows,
                "cells": cells,
                "empty": empty,
            },
        )
        jobs.append(
            {
                "id": "sheet-" + hashlib.sha1(prompt.encode()).hexdigest()[:10],
                "kind": cfg["paths"]["rawKind"],
                "prompt": prompt,
                "variant": variant_for(cols, rows, cfg),
                "quality": cfg["generator"]["quality"],
                "itemSheet": {
                    "cols": cols,
                    "rows": rows,
                    "cells": [{"unit": u.key, "text": u.text} for u in chunk],
                },
            }
        )
    return jobs


def resolve_ids(
    tokens: set[str], units: dict[str, Unit], item_unit: dict[str, str]
) -> set[str]:
    out = set()
    for t in tokens:
        if t in units:
            out.add(t)
        elif t in item_unit:
            out.add(item_unit[t])
        else:
            raise SystemExit(f"unknown item / unit id: {t}")
    return out


def pending_units(
    units, sheets, force: set[str], force_all: bool, keep_stale: bool
) -> list[Unit]:
    todo = []
    for u in units.values():
        cands = candidates(u, sheets)
        fresh = any(not stale for _, _, stale in cands)
        if force_all or u.key in force or not cands or (not fresh and not keep_stale):
            todo.append(u)
    return sorted(todo, key=lambda u: u.order)


def generate(cfg: dict, jobs: list[dict], concurrency: int) -> int:
    gen = pipeline_cfg()["generator"]
    fail_log = ROOT / cfg["paths"]["failures"]

    def one(job: dict) -> str | None:
        err = None
        for attempt in range(1 + gen["retries"]):
            t0 = time.time()
            try:
                path = run_once(job, gen)
                meta_path = raw_dir(cfg) / f"{job['id']}.json"
                meta = load_json(meta_path)
                meta["itemSheet"] = job["itemSheet"]
                write_json(meta_path, meta)
                log(
                    f"[ok]   {job['id']} ({len(job['itemSheet']['cells'])} cells) {time.time() - t0:.0f}s -> {path}"
                )
                return None
            except subprocess.TimeoutExpired:
                err = "local timeout; the generation may still be running remotely"
                break
            except Exception as e:  # noqa: BLE001 - logged and retried
                err = str(e)
                log(f"[fail] {job['id']} attempt {attempt + 1}: {err[:300]}")
        with LOCK:
            fail_log.parent.mkdir(parents=True, exist_ok=True)
            with fail_log.open("a") as f:
                rec = {
                    "id": job["id"],
                    "cells": [c["unit"] for c in job["itemSheet"]["cells"]],
                    "error": err,
                }
                f.write(
                    json.dumps(
                        {**rec, "at": time.strftime("%Y-%m-%dT%H:%M:%S")},
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        return err

    failed = 0
    workers = max(1, min(concurrency, gen["maxConcurrency"]))
    log(f"{len(jobs)} sheet(s) to generate, concurrency {workers}")
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for fut in as_completed([pool.submit(one, j) for j in jobs]):
            failed += fut.result() is not None
    return failed


# ---------------------------------------------------------------------------
# Slicing
# ---------------------------------------------------------------------------


def grid_bounds(profile: np.ndarray, n: int, snap: float) -> list[int]:
    """n+1 boundaries: each inner one at the profile minimum within snap cells of the even split (ties: nearest)."""
    size = len(profile)
    cell = size / n
    out = [0]
    for k in range(1, n):
        c = k * cell
        lo, hi = max(1, int(c - snap * cell)), min(size - 1, int(c + snap * cell) + 1)
        seg = profile[lo:hi]
        idx = np.nonzero(seg <= seg.min())[0] + lo
        out.append(int(idx[np.argmin(np.abs(idx - c))]))
    out.append(size)
    return out


@dataclass
class Cell:
    rect: tuple[int, int, int, int]
    crop: np.ndarray | None = None  # keyed RGBA restricted to the cell's own blobs
    items: int = 0  # blobs large enough to be a separate item
    overflow: bool = False


def is_cutout(img: np.ndarray, cc: dict) -> bool:
    """The generator sometimes returns a real transparent cut-out instead of the magenta background."""
    if img.shape[2] != 4:
        return False
    a = img[..., 3]
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    return bool((border < 128).mean() >= cc["borderTransparent"])


def key_sheet(img: np.ndarray, cfg: dict, pcfg: dict) -> tuple[np.ndarray, Halo]:
    """-> (keyed RGBA, halo cleanup spec). Cut-outs keep their own alpha with soft glows/auras cut away;
    magenta renders are chroma-keyed (soft key alpha is binarized later, so purple interiors survive)."""
    kc, cc = pcfg["chroma"], cfg["slice"]["cutout"]
    nominal = hex_rgb(kc["color"])
    if is_cutout(img, cc):
        keyed = img.copy()
        keyed[..., 3] = np.where(img[..., 3] >= cc["alphaCut"] * 255.0, 255.0, 0.0)
        return keyed, (nominal, cc["haloMaxDist"])
    key = tuple(estimate_key(img, nominal, kc["estimateMaxDist"]))
    return chroma_key(img, kc), (key, kc["haloMaxDist"])


def slice_sheet(
    png, cols: int, rows: int, cfg: dict, pcfg: dict
) -> tuple[list[Cell], Halo]:
    sc = cfg["slice"]
    keyed, halo = key_sheet(load_src(png), cfg, pcfg)
    mask = keyed[..., 3] >= 127.5
    H, W = mask.shape
    rb = grid_bounds(mask.sum(axis=1).astype(np.float64), rows, sc["gridSnap"])
    cb = [
        grid_bounds(
            mask[rb[r] : rb[r + 1]].sum(axis=0).astype(np.float64), cols, sc["gridSnap"]
        )
        for r in range(rows)
    ]
    cells = [
        Cell((cb[r][c], rb[r], cb[r][c + 1], rb[r + 1]))
        for r in range(rows)
        for c in range(cols)
    ]

    f = sc["labelDownsample"]
    h, w = H // f, W // f
    small = np.asarray(mask[: h * f, : w * f].reshape(h, f, w, f).any(axis=(1, 3)))
    labels, sizes = components(small)
    if not sizes:
        return cells, halo
    lab = labels.ravel()
    ok = lab >= 0
    yy, xx = np.divmod(np.arange(lab.size), w)
    cnt = np.bincount(lab[ok], minlength=len(sizes)).astype(np.float64)
    cy = (np.bincount(lab[ok], weights=yy[ok], minlength=len(sizes)) / cnt + 0.5) * f
    cx = (np.bincount(lab[ok], weights=xx[ok], minlength=len(sizes)) / cnt + 0.5) * f
    min_blob = max(1.0, sc["minBlobFraction"] * h * w)
    members: dict[int, list[int]] = {}
    for n, s in enumerate(sizes):
        if s < min_blob:
            continue
        r = min(rows - 1, max(0, bisect.bisect_right(rb, cy[n]) - 1))
        c = min(cols - 1, max(0, bisect.bisect_right(cb[r], cx[n]) - 1))
        members.setdefault(r * cols + c, []).append(n)

    for i, blobs in members.items():
        cell = cells[i]
        biggest = max(sizes[n] for n in blobs)
        keep = [n for n in blobs if sizes[n] >= sc["keepRatio"] * biggest]
        cell.items = sum(sizes[n] >= sc["itemRatio"] * biggest for n in blobs)
        keep_small = np.isin(labels, keep)
        keep_full = np.zeros_like(mask)
        keep_full[: h * f, : w * f] = np.repeat(
            np.repeat(keep_small, f, axis=0), f, axis=1
        )
        keep_full &= mask
        x0, y0, x1, y1 = cell.rect
        tx, ty = (
            sc["overflowTolerance"] * (x1 - x0),
            sc["overflowTolerance"] * (y1 - y0),
        )
        ex = (
            max(0, int(x0 - tx)),
            max(0, int(y0 - ty)),
            min(W, int(x1 + tx)),
            min(H, int(y1 + ty)),
        )
        ys, xs = np.nonzero(keep_full)
        cell.overflow = bool(
            xs.min() < ex[0]
            or ys.min() < ex[1]
            or xs.max() >= ex[2]
            or ys.max() >= ex[3]
        )
        crop = keyed[ex[1] : ex[3], ex[0] : ex[2]].copy()
        crop[..., 3] *= keep_full[ex[1] : ex[3], ex[0] : ex[2]]
        cell.crop = crop
    return cells, halo


# ---------------------------------------------------------------------------
# Icon
# ---------------------------------------------------------------------------


def make_icon(crop: np.ndarray, halo: Halo, cfg: dict, pcfg: dict) -> np.ndarray | None:
    pc = cfg["process"]
    bbox = robust_bbox(crop[..., 3], bbox_min_count(crop.shape[0], pcfg))
    if bbox is None:
        return None
    x0, y0, x1, y1 = bbox
    side = max(x1 - x0, y1 - y0)
    sx, sy = int((x0 + x1 - side) / 2), int((y0 + y1 - side) / 2)
    pad = max(0, -sx, -sy, sx + side - crop.shape[1], sy + side - crop.shape[0])
    if pad:
        crop = np.pad(crop, ((pad, pad), (pad, pad), (0, 0)))
        sx, sy = sx + pad, sy + pad
    inner = pc["size"] - 2 * pc["margin"] - (2 if pc["outline"] else 0)
    sprite = fit_sprite(
        crop,
        (sx, sy, sx + side, sy + side),
        inner,
        1.0,
        1.0,
        pc["resample"],
        anchor_bottom=False,
    )
    sprite = binarize_alpha(sprite)
    sprite = remove_specks(sprite, pc["minSpeck"])
    sprite = fill_pinholes(sprite, pc["pinhole"])
    sprite = clean_halo(sprite, halo[0], halo[1])
    if not (sprite[..., 3] >= 127.5).any():
        return None
    sprite = quantize(sprite, pc["palette"])
    out = np.zeros((pc["size"], pc["size"], 4), np.float32)
    o = (pc["size"] - inner) // 2
    out[o : o + inner, o : o + inner] = sprite
    if pc["outline"]:
        opaque = out[..., 3] >= 127.5
        edge = opaque & dilate(~opaque, 1)
        shade = out[..., :3][edge].mean(axis=0) * pc["outlineDarken"]
        shade *= min(1.0, pc["outlineMaxChannel"] / max(1.0, float(shade.max())))
        out = add_outline(out, tuple(np.round(shade)))
    return out


def verify_icon(
    icon: np.ndarray | None, unit: Unit, cell: Cell | None, cfg: dict
) -> tuple[list[str], bool]:
    """-> (flags, usable). Unusable = empty / too small (try an older sheet)."""
    vc = cfg["verify"]
    if icon is None:
        return ["empty"], False
    flags = []
    opaque = icon[..., 3] >= 127.5
    bb = alpha_bbox(icon)
    side = max(bb[2] - bb[0], bb[3] - bb[1]) if bb else 0
    if opaque.sum() < vc["minOpaque"]:
        flags.append("small")
    if side < vc["minSide"]:
        flags.append("tiny")
    if len(np.unique(icon[..., :3][opaque], axis=0)) < vc["minColors"]:
        flags.append("flat")
    if unit.tint:
        frac = tint_fraction(icon, unit.tint, vc)
        if frac < vc["tintMinFraction"]:
            flags.append(f"tint{frac:.2f}")
    if cell and cell.overflow:
        flags.append("overflow")
    if cell and cell.items > 1:
        flags.append(f"multi{cell.items}")
    return flags, not ({"small", "tiny"} & set(flags))


def icon_delta_e(a: np.ndarray, b: np.ndarray, miss: float) -> float:
    """Mean Lab distance over the union of both silhouettes (pixels opaque in only one count as `miss`)."""
    oa, ob = a[..., 3] >= 127.5, b[..., 3] >= 127.5
    union = oa | ob
    if not union.any():
        return 0.0
    de = np.linalg.norm(
        srgb_to_lab(a[..., :3][union]) - srgb_to_lab(b[..., :3][union]), axis=1
    )
    return float(np.where((oa & ob)[union], de, miss).mean())


def out_file(cfg: dict, item_id: str):
    return ROOT / fill(cfg["paths"]["out"], {"id": item_id})


def process(cfg: dict, prune: bool) -> int:
    pcfg = pipeline_cfg()
    units, item_unit, problems = build_units(cfg)
    sheets = load_sheets(cfg)
    sliced: dict[str, tuple[list[Cell], Halo]] = {}
    report: dict = {"units": {}, "unusedCells": [], "problems": problems}
    icons: dict[str, np.ndarray] = {}
    crops: dict[str, np.ndarray] = {}
    used: set[tuple[str, int]] = set()
    missing = []
    for u in sorted(units.values(), key=lambda u: u.order):
        chosen = None
        for sheet, idx, stale in candidates(u, sheets):
            if sheet["id"] not in sliced:
                sliced[sheet["id"]] = slice_sheet(
                    sheet["png"], sheet["cols"], sheet["rows"], cfg, pcfg
                )
            cells, halo = sliced[sheet["id"]]
            cell = cells[idx]
            icon = (
                make_icon(cell.crop, halo, cfg, pcfg) if cell.crop is not None else None
            )
            flags, usable = verify_icon(icon, u, cell, cfg)
            if stale:
                flags.append("stale")
            if usable and icon is not None and cell.crop is not None:
                chosen = (sheet, idx, icon, cell.crop, flags)
                break
            log(f"[skip] {u.key}: {sheet['id']}#{idx} unusable ({','.join(flags)})")
        if chosen is None:
            if u.items:
                missing.append(u.key)
            report["units"][u.key] = {"items": u.items, "flags": ["missing"]}
            continue
        sheet, idx, icon, crop, flags = chosen
        used.add((sheet["id"], idx))
        icons[u.key], crops[u.key] = icon, crop
        report["units"][u.key] = {
            "items": u.items,
            "sheet": sheet["id"],
            "cell": idx,
            "flags": flags,
        }

    keys = [k for k in icons if units[k].category != cfg["chip"]["category"]]
    for i, a in enumerate(keys):
        for b in keys[i + 1 :]:
            de = icon_delta_e(icons[a], icons[b], cfg["verify"]["duplicateMissDeltaE"])
            if de < cfg["verify"]["duplicateMaxDeltaE"]:
                report["units"][a]["flags"].append(f"dup:{b}")
                report["units"][b]["flags"].append(f"dup:{a}")

    for sid, (cells, _) in sliced.items():
        for i, c in enumerate(cells):
            if c.crop is not None and (sid, i) not in used:
                report["unusedCells"].append(f"{sid}#{i}")

    written = 0
    for item_id, ukey in item_unit.items():
        if ukey in icons:
            save_png(to_image(icons[ukey]), out_file(cfg, item_id))
            written += 1
    out_dir = out_file(cfg, "x").parent
    orphans = sorted(p.name for p in out_dir.glob("*.png") if p.stem not in item_unit)
    if prune:
        for name in orphans:
            (out_dir / name).unlink()
    report["orphans"] = [] if prune else orphans
    write_json(ROOT / cfg["paths"]["report"], report)
    pages = contact_sheets(cfg, units, item_unit, icons, crops, report)

    flagged = {k: v["flags"] for k, v in report["units"].items() if v["flags"]}
    for k, fl in flagged.items():
        log(f"[flag] {k}: {', '.join(fl)}")
    for p in problems:
        log(f"[content] {p}")
    log(
        f"{written}/{len(item_unit)} item icons written from {len(icons)} designs; {len(flagged)} flagged, "
        f"{len(missing)} missing, {len(report['unusedCells'])} unused cells, {len(orphans)} orphan file(s)"
        + (" pruned" if prune and orphans else "")
    )
    for p in pages:
        log(f"contact sheet: {p.relative_to(ROOT)}")
    return 1 if missing or problems else 0


# ---------------------------------------------------------------------------
# Contact sheets (raw cell | icon, labelled with the item id and flags)
# ---------------------------------------------------------------------------


def _on_checker(rgba: np.ndarray, colors: list[str], cell: int) -> Image.Image:
    h, w = rgba.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    a, b = (np.array(hex_rgb(c), np.float32) for c in colors)
    bg = np.where((((yy // cell) + (xx // cell)) % 2 == 0)[..., None], a, b)
    al = rgba[..., 3:4] / 255.0
    return Image.fromarray(
        np.clip(rgba[..., :3] * al + bg * (1 - al), 0, 255).astype(np.uint8), "RGB"
    )


def contact_sheets(cfg, units, item_unit, icons, crops, report) -> list:
    cs = cfg["contactSheet"]
    size = cfg["process"]["size"]
    big = size * cs["scale"]
    gap, lh = cs["gap"], cs["lineHeight"]
    cw, ch = cs["thumb"] + big + 2 * gap, max(cs["thumb"], big) + 2 * lh + gap
    entries = [(iid, ukey) for iid, ukey in item_unit.items()]
    entries.sort(key=lambda e: (units[e[1]].order, e[0]))
    pages = []
    for p, s in enumerate(range(0, len(entries), cs["perPage"]), start=1):
        chunk = entries[s : s + cs["perPage"]]
        cols = min(cs["cols"], len(chunk))
        rows = math.ceil(len(chunk) / cols)
        sheet = Image.new(
            "RGB", (cols * cw + gap, rows * ch + gap), hex_rgb(cs["background"])
        )
        draw = ImageDraw.Draw(sheet)
        for i, (iid, ukey) in enumerate(chunk):
            x, y = gap + (i % cols) * cw, gap + (i // cols) * ch
            if ukey in crops:
                th = _on_checker(crops[ukey], cs["checker"], cs["checkerCell"] * 2)
                th.thumbnail((cs["thumb"], cs["thumb"]), Image.Resampling.LANCZOS)
                sheet.paste(th, (x, y))
                ic = _on_checker(icons[ukey], cs["checker"], cs["checkerCell"])
                sheet.paste(
                    ic.resize((big, big), Image.Resampling.NEAREST),
                    (x + cs["thumb"] + gap, y),
                )
            flags = report["units"].get(ukey, {}).get("flags", [])
            ty = y + max(cs["thumb"], big) + gap // 2
            draw.text((x, ty), iid[: cs["labelChars"]], fill=hex_rgb(cs["label"]))
            if flags:
                draw.text(
                    (x, ty + lh),
                    ",".join(flags)[: cs["labelChars"] + 8],
                    fill=hex_rgb(cs["warn"]),
                )
        path = ROOT / fill(cfg["paths"]["contact"], {"page": p})
        save_png(sheet, path)
        pages.append(path)
    return pages


# ---------------------------------------------------------------------------
# Check / CLI
# ---------------------------------------------------------------------------


def check(cfg: dict) -> int:
    _, item_unit, problems = build_units(cfg)
    pc, vc = cfg["process"], cfg["verify"]
    bad = list(problems)
    for item_id in item_unit:
        path = out_file(cfg, item_id)
        if not path.exists():
            bad.append(f"{item_id}: missing {path.relative_to(ROOT)}")
            continue
        im = Image.open(path)
        if im.mode != "RGBA" or im.size != (pc["size"], pc["size"]):
            bad.append(f"{item_id}: {im.mode} {im.size}")
            continue
        a = np.asarray(im)[..., 3]
        if not np.isin(a, (0, 255)).all():
            bad.append(f"{item_id}: non-binary alpha")
        if (a == 255).sum() < vc["minOpaque"]:
            bad.append(f"{item_id}: only {(a == 255).sum()} opaque pixels")
    for b in bad:
        print(f"[bad] {b}")
    print(f"{len(item_unit)} items checked, {len(bad)} problem(s)")
    return 1 if bad else 0


def manifest() -> int:
    return subprocess.run(
        [sys.executable, str(ROOT / "tools" / "build_manifest.py")], check=False
    ).returncode


def selftest(cfg: dict) -> int:
    """Synthetic sheets -> slice -> icons. Outlined shapes (one purple, near the magenta key) with detached
    sparkles, jittered, 3 empty cells; rendered once on magenta and once as an RGBA cut-out whose first shape
    sits on a semi-transparent glow that must not survive."""
    import tempfile

    pcfg = pipeline_cfg()
    cols, rows, cell = 4, 4, 256
    rng = np.random.default_rng(7)
    magenta = hex_rgb(pcfg["chroma"]["color"])
    glow_rgb = (255, 240, 120)
    shapes = Image.new("RGBA", (cols * cell, rows * cell), (0, 0, 0, 0))
    d = ImageDraw.Draw(shapes)
    want: dict[int, tuple[int, ...]] = {}
    for i in range(cols * rows - 3):
        r, c = divmod(i, cols)
        color = (
            (184, 107, 255)
            if i == 5
            else tuple(int(v) for v in rng.integers((30, 140, 30), (230, 240, 230)))
        )
        jx, jy = (int(v) for v in rng.integers(-24, 25, 2))
        x0, y0 = c * cell + 50 + jx, r * cell + 50 + jy
        box = (x0, y0, x0 + 150 - 40 * (i % 2), y0 + 150)
        (d.ellipse if i % 3 else d.rectangle)(
            box, fill=color + (255,), outline=(24, 20, 32, 255), width=6
        )
        d.rectangle((box[2] + 6, y0, box[2] + 12, y0 + 6), fill=(255, 255, 200, 255))
        want[i] = color
    glow = Image.new("RGBA", shapes.size, (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((20, 20, 236, 236), fill=glow_rgb + (150,))
    cutout = Image.alpha_composite(glow, shapes)
    on_key = Image.alpha_composite(
        Image.new("RGBA", shapes.size, magenta + (255,)), shapes
    ).convert("RGB")
    errors = []
    for name, img in (("magenta", on_key), ("cutout", cutout)):
        with tempfile.TemporaryDirectory() as tmp:
            path = f"{tmp}/sheet.png"
            img.save(path)
            cells, halo = slice_sheet(path, cols, rows, cfg, pcfg)
        for i, cl in enumerate(cells):
            if i not in want:
                if cl.crop is not None:
                    errors.append(f"{name} cell {i}: expected empty")
                continue
            icon = make_icon(cl.crop, halo, cfg, pcfg) if cl.crop is not None else None
            if icon is None:
                errors.append(f"{name} cell {i}: no icon")
                continue
            unit = Unit(
                str(i), "test", "", "#" + "".join(f"{v:02x}" for v in want[i]), ()
            )
            flags, usable = verify_icon(icon, unit, cl, cfg)
            if (
                not usable
                or "overflow" in flags
                or any(f.startswith(("multi", "tint")) for f in flags)
            ):
                errors.append(f"{name} cell {i}: {flags}")
            if icon.shape[:2] != (cfg["process"]["size"],) * 2:
                errors.append(f"{name} cell {i}: size {icon.shape}")
        first = (
            make_icon(cells[0].crop, halo, cfg, pcfg)
            if cells[0].crop is not None
            else None
        )
        glow_hex = "#" + "".join(f"{v:02x}" for v in glow_rgb)
        if first is not None and tint_fraction(first, glow_hex, cfg["verify"]) > 0.02:
            errors.append(f"{name}: semi-transparent glow survived")
    for e in errors:
        print(f"[selftest] {e}")
    print(f"selftest: {len(want)} shapes x 2 sheets, {len(errors)} error(s)")
    return 1 if errors else 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "cmd",
        nargs="?",
        default="all",
        choices=["all", "plan", "generate", "process", "check", "selftest"],
    )
    ap.add_argument(
        "--force",
        default="",
        help="comma list of item ids / chip:<typeId> to regenerate",
    )
    ap.add_argument("--force-all", action="store_true")
    ap.add_argument(
        "--keep-stale",
        action="store_true",
        help="do not regenerate units whose prompt text changed",
    )
    ap.add_argument(
        "--concurrency", type=int, default=pipeline_cfg()["generator"]["concurrency"]
    )
    ap.add_argument(
        "--prune",
        action="store_true",
        help="delete icons of items no longer in content",
    )
    a = ap.parse_args()
    cfg = load_cfg()
    if a.cmd == "check":
        return check(cfg)
    if a.cmd == "selftest":
        return selftest(cfg)
    if a.cmd == "process":
        return process(cfg, a.prune)
    units, item_unit, problems = build_units(cfg)
    for p in problems:
        log(f"[content] {p}")
    force = resolve_ids(
        {t.strip() for t in a.force.split(",") if t.strip()}, units, item_unit
    )
    jobs = pack(
        pending_units(units, load_sheets(cfg), force, a.force_all, a.keep_stale), cfg
    )
    if a.cmd == "plan":
        print(
            f"{len(units)} designs for {len(item_unit)} items; {len(jobs)} sheet(s) to generate"
        )
        for j in jobs:
            s = j["itemSheet"]
            print(
                f"\n{j['id']} {s['cols']}x{s['rows']} {j['variant']}: "
                + ", ".join(c["unit"] for c in s["cells"])
            )
        if jobs:
            print("\nfirst prompt:\n" + jobs[0]["prompt"])
        return 0
    failed = generate(cfg, jobs, a.concurrency) if jobs else 0
    if a.cmd == "generate":
        return 1 if failed else 0
    rc = process(cfg, a.prune)
    return manifest() or rc or (1 if failed else 0)


if __name__ == "__main__":
    sys.exit(main())
