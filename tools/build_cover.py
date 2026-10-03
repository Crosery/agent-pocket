#!/usr/bin/env python3
"""Title cover (key art) candidates with the AI-girl cast.

Prompt data: assets_src/prompts/cover.json (refs, per-girl identity lines, shared snippets, concepts).
Numbers: assets_src/pipeline.json `cover` (reference-board grid, job list path, pixel output dir, layered preview).

  jobs     build the reference images (cast identity board from the approved chibi PNGs, frozen copy of the
           current cover as style reference) and write the job list (gen_images.py format, kind `cover`,
           one job per concept roll, renders in assets_src/raw/cover/<id>.png)
  pixel    run the title-art backdrop processing (process_ui.backdrop) on every render -> `cover.pixelDir`
  layered  key the magenta character layers and composite them over the plate (layered-approach preview)
  fixjobs  targeted repaints of the chosen cover (`cover.fix`): per patch an upscaled crop + a reference board,
           plus a top-extension canvas -> `cover.fix.jobs` (kind `cover_fix`, renders in assets_src/raw/cover_fix/)
  finish   blend the changed pixels of each patch render back into the cover, prepend the aligned top extension,
           apply the light grades -> `cover.fix.out` (raw) and `cover.fix.pixelOut` (backdrop-processed)

Usage:
  python3 tools/build_cover.py jobs
  python3 tools/gen_images.py --backend aigw --jobs assets_src/prompts/cover_jobs.json [--only cover_a_r1]
  python3 tools/build_cover.py pixel [--only id1,id2]
  python3 tools/build_cover.py layered
  python3 tools/build_cover.py fixjobs
  python3 tools/gen_images.py --backend aigw --jobs assets_src/prompts/cover_fix_jobs.json
  python3 tools/build_cover.py finish
"""

from __future__ import annotations

import argparse
import pathlib
import shutil
import sys

import numpy as np
from assetlib import (
    RAW_DIR,
    ROOT,
    binarize_alpha,
    chroma_key,
    clean_halo,
    dilate,
    estimate_key,
    hex_rgb,
    load_json,
    load_rgb,
    load_src,
    pipeline_cfg,
    save_png,
    to_image,
    write_json,
)
from build_jobs import fill
from PIL import Image, ImageFilter
from process_portrait import bbox_min_count, robust_bbox
from process_ui import process_backdrop

COVER_PATH = ROOT / "assets_src" / "prompts" / "cover.json"
KIND = "cover"


def cast_board(cover: dict, cfg: dict) -> pathlib.Path:
    refs, bc = cover["refs"], cfg["board"]
    order = refs["castOrder"]
    cols, cell = bc["cols"], bc["cell"]
    rows = -(-len(order) // cols)
    board = Image.new("RGB", (cols * cell, rows * cell), bc["background"])
    for i, gid in enumerate(order):
        im = chibi(cover, gid)
        s = bc["fill"] * cell / max(im.width, im.height)
        im = im.resize(
            (round(im.width * s), round(im.height * s)), Image.Resampling.LANCZOS
        )
        x = (i % cols) * cell + (cell - im.width) // 2
        y = (i // cols) * cell + (cell - im.height) // 2
        board.paste(im, (x, y), im)
    out = ROOT / refs["castBoard"]
    out.parent.mkdir(parents=True, exist_ok=True)
    board.save(out)
    return out


def chibi(cover: dict, gid: str) -> Image.Image:
    refs = cover["refs"]
    path = pathlib.Path(refs["castDir"]).expanduser() / fill(
        refs["castFile"], {"id": gid}
    )
    im = Image.open(path).convert("RGBA")
    box = im.getchannel("A").getbbox()
    return im.crop(box) if box else im


def draft(cover: dict, concept: dict) -> str:
    """Composition draft: the approved chibis pasted over the background plate.
    concept.draft = [[girl, centreX, feetY, height], ...] as fractions of the frame, back to front."""
    refs = cover["refs"]
    canvas = Image.open(ROOT / refs["plate"]).convert("RGBA")
    W, H = canvas.size
    for gid, cx, feet, h in concept["draft"]:
        im = chibi(cover, gid)
        s = h * H / im.height
        im = im.resize(
            (round(im.width * s), round(im.height * s)), Image.Resampling.LANCZOS
        )
        canvas.alpha_composite(
            im, (round(cx * W - im.width / 2), round(feet * H) - im.height)
        )
    rel = fill(refs["draftOut"], {"id": concept["id"]})
    save_png(canvas.convert("RGB"), ROOT / rel)
    return rel


def build_jobs(cover: dict, cfg: dict) -> list[dict]:
    refs = cover["refs"]
    cast_board(cover, cfg)
    style = ROOT / refs["style"]
    if (
        not style.exists()
    ):  # frozen once, so later title.png replacements do not change the reference
        style.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / refs["styleSource"], style)
    snippets = {f"style.{k}": v for k, v in cover["style"].items()}
    jobs = []
    for c in cover["concepts"]:
        if "draft" in c:
            refs = {**refs, "draft": draft(cover, c)}
        cast = c.get("cast", refs["castOrder"])
        values = {**snippets, "castLines": "; ".join(cover["girls"][g] for g in cast)}
        prompt = " ".join(fill(c["prompt"], values).split())
        for r in range(1, c["rolls"] + 1):
            jobs.append(
                {
                    "id": f"cover_{c['id']}_r{r}",
                    "kind": KIND,
                    "prompt": prompt,
                    "variant": c["variant"],
                    "quality": c.get("quality", "high"),
                    "images": [refs[k] for k in c["images"]],
                    "meta": {"concept": c["id"], "name": c["name"], "roll": r},
                }
            )
    write_json(ROOT / cfg["jobs"], jobs)
    return jobs


def pixel(cfg: dict, only: set[str]) -> None:
    out_dir = ROOT / cfg["pixelDir"]
    for src in sorted((RAW_DIR / KIND).glob("*.png")):
        if only and src.stem not in only:
            continue
        if any(src.stem.startswith(p) for p in _layer_ids(cfg)):
            continue  # magenta character layers are not backdrops
        dst = out_dir / src.name
        if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime and not only:
            continue
        process_backdrop(str(src), str(dst), cfg["backdrop"])
        print(f"[pixel] {dst.relative_to(ROOT)}")


def _layer_ids(cfg: dict) -> list[str]:
    return [f"cover_{l['id']}_" for l in cfg["layered"]["layers"]]


def keyed_layer(path: pathlib.Path, cfg: dict) -> Image.Image:
    chroma = cfg["chroma"]
    src = load_src(path)
    key = tuple(estimate_key(src, hex_rgb(chroma["color"]), chroma["estimateMaxDist"]))
    rgba = binarize_alpha(chroma_key(src, chroma))
    rgba = clean_halo(rgba, key, chroma["haloMaxDist"])
    box = robust_bbox(rgba[..., 3], bbox_min_count(rgba.shape[0], cfg))
    img = to_image(rgba)
    return img.crop(box) if box else img


def layered(cfg: dict, roll: int) -> pathlib.Path:
    """Layers are scaled to fit `width` x `height` (fractions of the plate) and pinned to their outer edge
    and the bottom, so their ledges run out of the frame corner."""
    full = pipeline_cfg()
    lc = cfg["layered"]
    plate = Image.open(RAW_DIR / KIND / f"cover_{lc['plate']}_r{roll}.png").convert(
        "RGBA"
    )
    W, H = plate.size
    layer_dir = RAW_DIR / KIND / "layers"
    for l in lc["layers"]:
        img = keyed_layer(RAW_DIR / KIND / f"cover_{l['id']}_r{roll}.png", full)
        save_png(img, layer_dir / f"cover_{l['id']}_r{roll}.png")
        s = min(l["width"] * W / img.width, l["height"] * H / img.height)
        img = img.resize(
            (round(img.width * s), round(img.height * s)), Image.Resampling.LANCZOS
        )
        alpha = np.asarray(img.getchannel("A")) >= 128
        img.putalpha(Image.fromarray(np.where(alpha, 255, 0).astype(np.uint8), "L"))
        x = round(l["x"] * W) - (img.width if l["anchor"] == "right" else 0)
        plate.alpha_composite(img, (x, round(l["bottom"] * H) - img.height))
    out = RAW_DIR / KIND / f"{lc['out']}_r{roll}.png"
    save_png(plate.convert("RGB"), out)
    return out


def _ref_crop(spec: dict, bg: str) -> Image.Image:
    im = Image.open(
        pathlib.Path(spec["src"]).expanduser()
        if spec["src"].startswith("~")
        else ROOT / spec["src"]
    )
    im = im.convert("RGBA").crop(tuple(spec["box"]))
    out = Image.new("RGBA", im.size, bg)
    out.alpha_composite(im)
    return out.convert("RGB")


def ref_board(names: list[str], fx: dict) -> Image.Image:
    """Reference crops side by side at a common height (the two-panel board method)."""
    h, gap = fx["boardHeight"], fx["boardGap"]
    crops = []
    for n in names:
        im = _ref_crop(fx["refs"][n], fx["boardBackground"])
        crops.append(
            im.resize((round(im.width * h / im.height), h), Image.Resampling.LANCZOS)
        )
    board = Image.new(
        "RGB",
        (sum(c.width for c in crops) + gap * (len(crops) - 1), h),
        fx["boardBackground"],
    )
    x = 0
    for c in crops:
        board.paste(c, (x, 0))
        x += c.width + gap
    return board


def fix_jobs(cover: dict, cfg: dict) -> list[dict]:
    fx, words = cfg["fix"], cover["fix"]
    base = Image.open(ROOT / fx["base"]).convert("RGB")
    ref_dir = ROOT / fx["refDir"]
    size = fx["inputSize"]
    jobs = []
    for p in fx["patches"]:
        crop = base.crop(tuple(p["box"])).resize((size, size), Image.Resampling.LANCZOS)
        save_png(crop, ref_dir / f"{p['id']}_in.png")
        save_png(ref_board(p["refs"], fx), ref_dir / f"{p['id']}_ref.png")
        jobs.append(
            _fix_job(
                fx,
                p["id"],
                words["patchNote"] + " " + words["patches"][p["id"]],
                "square",
                [f"{p['id']}_in.png", f"{p['id']}_ref.png"],
            )
        )
    ext = fx["extend"]
    canvas = Image.new("RGB", base.size, ext["fill"])
    canvas.paste(
        base.crop((0, 0, base.width, base.height - ext["rows"])), (0, ext["rows"])
    )
    save_png(canvas, ref_dir / f"{ext['id']}_in.png")
    jobs.append(
        _fix_job(fx, ext["id"], words["extend"], "landscape", [f"{ext['id']}_in.png"])
    )
    write_json(ROOT / fx["jobs"], jobs)
    return jobs


def _fix_job(fx: dict, pid: str, prompt: str, variant: str, images: list[str]) -> dict:
    return {
        "id": f"cover_{pid}",
        "kind": fx["kind"],
        "prompt": " ".join(prompt.split()),
        "variant": variant,
        "quality": "high",
        "images": [f"{fx['refDir']}/{n}" for n in images],
    }


def ellipse_mask(
    shape: tuple[int, int], ellipses: list[list[float]], ox: float = 0, oy: float = 0
) -> np.ndarray:
    yy, xx = np.mgrid[0 : shape[0], 0 : shape[1]]
    m = np.zeros(shape, bool)
    for cx, cy, rx, ry in ellipses:
        m |= ((xx + ox - cx) / rx) ** 2 + ((yy + oy - cy) / ry) ** 2 <= 1
    return m


def align(
    src: Image.Image, target: np.ndarray, weight: np.ndarray, ac: dict
) -> np.ndarray:
    """Scale/shift `src` onto `target` (same size) minimising the weighted squared error; returns the warped
    RGB float array (pixels with no source fall back to target)."""
    H, W = target.shape[:2]
    lum_t = target @ np.array([0.299, 0.587, 0.114], np.float32)
    r = ac["search"]
    ys, xs = np.nonzero(weight)
    by0, by1, bx0, bx1 = (
        ys.min(),
        ys.max() + 1,
        xs.min(),
        xs.max() + 1,
    )  # only score where the weight is set
    best_err, best = np.inf, (1.0, 0, 0)
    for s in ac["scales"]:
        im = np.asarray(
            src.resize((round(W * s), round(H * s)), Image.Resampling.LANCZOS),
            np.float32,
        )
        ox, oy = (im.shape[1] - W) / 2, (im.shape[0] - H) / 2  # scale about the centre
        lum = im @ np.array([0.299, 0.587, 0.114], np.float32)
        pad = np.pad(lum, r + 2, mode="edge")
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                y0, x0 = round(oy) - dy + r + 2, round(ox) - dx + r + 2
                if y0 < 0 or x0 < 0 or y0 + H > pad.shape[0] or x0 + W > pad.shape[1]:
                    continue
                win = pad[y0 + by0 : y0 + by1, x0 + bx0 : x0 + bx1]
                err = float(
                    (
                        ((win - lum_t[by0:by1, bx0:bx1]) ** 2)
                        * weight[by0:by1, bx0:bx1]
                    ).sum()
                )
                if err < best_err:
                    best_err, best = err, (s, round(ox) - dx, round(oy) - dy)
    s, sx, sy = best
    im = np.asarray(
        src.resize((round(W * s), round(H * s)), Image.Resampling.LANCZOS), np.float32
    )
    out = target.copy()
    ys0, xs0 = max(0, sy), max(0, sx)
    ys1, xs1 = min(im.shape[0], sy + H), min(im.shape[1], sx + W)
    out[ys0 - sy : ys1 - sy, xs0 - sx : xs1 - sx] = im[ys0:ys1, xs0:xs1]
    print(
        f"  align scale {s} shift ({-sx + round((im.shape[1] - W) / 2)}, {-sy + round((im.shape[0] - H) / 2)})"
    )
    return out


def feather(mask: np.ndarray, radius: float) -> np.ndarray:
    im = Image.fromarray((mask * 255).astype(np.uint8), "L").filter(
        ImageFilter.GaussianBlur(radius)
    )
    return np.asarray(im, np.float32)[..., None] / 255.0


def apply_patch(img: np.ndarray, base: np.ndarray, p: dict, fx: dict) -> None:
    x0, y0, x1, y1 = p["box"]
    orig = base[y0:y1, x0:x1]
    zone = ellipse_mask(orig.shape[:2], p["zone"], x0, y0)
    render = Image.open(RAW_DIR / fx["kind"] / f"cover_{p['id']}.png").convert("RGB")
    render = render.resize((x1 - x0, y1 - y0), Image.Resampling.LANCZOS)
    warped = align(
        render, orig, (~dilate(zone, p["grow"] * 4)).astype(np.float32), fx["align"]
    )
    changed = (np.abs(warped - orig).max(axis=2) > p["diff"]) & zone
    if changed.sum() < fx["align"]["minArea"]:
        print(f"  {p['id']}: no change inside the zone, skipped")
        return
    mask = dilate(changed, p["grow"]) & zone
    ring = dilate(mask, p["grow"] * 2) & ~mask
    warped += (
        orig[ring].mean(axis=0) - warped[ring].mean(axis=0)
    ) * 0.5  # meet the surrounding tone halfway
    a = feather(mask, p["feather"])
    img[y0:y1, x0:x1] = orig * (1 - a) + warped * a
    print(f"  {p['id']}: {int(mask.sum())} px replaced")


def extend_top(img: np.ndarray, fx: dict) -> np.ndarray:
    ext = fx["extend"]
    rows, seam = ext["rows"], ext["seam"]
    render = Image.open(RAW_DIR / fx["kind"] / f"cover_{ext['id']}.png").convert("RGB")
    H, W = img.shape[:2]
    render = render.resize((W, H), Image.Resampling.LANCZOS)
    # The render shows original rows [0, H - rows) at [rows, H): align on the band just under the new sky.
    target = np.zeros((H, W, 3), np.float32)
    target[rows:] = img[: H - rows]
    weight = np.zeros((H, W), np.float32)
    weight[rows + seam : rows + ext["compareRows"]] = 1
    warped = align(render, target, weight, fx["align"])
    out = np.concatenate([warped[:rows], img], axis=0)
    ramp = np.clip((np.arange(seam, dtype=np.float32) + 0.5) / seam, 0, 1)[
        :, None, None
    ]
    out[rows : rows + seam] = (
        warped[rows : rows + seam] * (1 - ramp) + img[:seam] * ramp
    )
    return out


def light(img: np.ndarray, g: dict) -> None:
    """Soft local grade inside a gaussian ellipse (centre/radii in image px): `strength` = screen-blended warm
    light, `saturation` / `contrast` = multipliers at the centre (1 = unchanged)."""
    H, W = img.shape[:2]
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    cx, cy, rx, ry = g["ellipse"]
    k = np.exp(-(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2))[..., None]
    lum = (img @ np.array([0.299, 0.587, 0.114], np.float32))[..., None]
    sat = lum + (img - lum) * (1 + (g.get("saturation", 1) - 1) * k)
    mid = float(lum.mean())
    graded = mid + (sat - mid) * (1 + (g.get("contrast", 1) - 1) * k)
    tint = np.array(hex_rgb(g["color"]), np.float32)
    screen = 255 - (255 - graded) * (255 - tint) / 255
    a = k * g.get("strength", 0)
    img[:] = np.clip(graded * (1 - a) + screen * a, 0, 255)


def finish(cfg: dict) -> pathlib.Path:
    fx = cfg["fix"]
    base = load_rgb(ROOT / fx["base"])
    img = base.copy()
    for p in fx["patches"]:
        apply_patch(img, base, p, fx)
    for g in fx["grades"]:
        light(img, g)
    if fx.get("extend"):
        img = extend_top(img, fx)
    out = ROOT / fx["out"]
    save_png(to_image(img), out)
    process_backdrop(str(out), str(ROOT / fx["pixelOut"]), fx["backdrop"])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("cmd", choices=["jobs", "pixel", "layered", "fixjobs", "finish"])
    ap.add_argument("--only", default="")
    ap.add_argument("--roll", type=int, default=1)
    a = ap.parse_args()
    cfg = pipeline_cfg()["cover"]
    if a.cmd == "jobs":
        jobs = build_jobs(load_json(COVER_PATH), cfg)
        print(f"{len(jobs)} cover jobs -> {cfg['jobs']}")
    elif a.cmd == "pixel":
        pixel(cfg, {x for x in a.only.split(",") if x})
    elif a.cmd == "fixjobs":
        jobs = fix_jobs(load_json(COVER_PATH), cfg)
        print(f"{len(jobs)} cover fix jobs -> {cfg['fix']['jobs']}")
    elif a.cmd == "finish":
        print(finish(cfg).relative_to(ROOT))
    else:
        print(layered(cfg, a.roll).relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
