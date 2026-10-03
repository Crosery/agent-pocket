#!/usr/bin/env python3
"""Walk-cycle rows from MiniMax H3 image-to-video renders (xiaochui-video MCP).

  prep <id>    for every sheet row: the row's idle frame (frame 0 of public/assets/characters/<id>.png), padded
               by `pad` px and NEAREST-scaled by `scale` onto the key colour -> <rawDir>/<id>/<dir>.png, plus
               <dir>.json with the filled prompt (assets_src/prompts/templates.json `walkVideo`) and the task
               parameters. The image is both first and last frame so the clip loops on the idle pose. Existing
               seed images are kept (a downloaded clip belongs to its seed) unless --force; the .json is always
               refreshed from the current template. `prompt` is for firstFrame = lastFrame; a rejected clip is
               resubmitted with `promptFirstFrame` and only the first frame (no loop constraint: H3 tends to
               morph the background while steering back to an identical last frame).
  frames <id>  for every <rawDir>/<id>/<dir>.mp4: every video frame keyed and medoid-sampled back onto the
               sheet pixel grid -> <dir>_frames.png (one cell per video frame, for QA)
  cycle <id> <out.png>  the 4-frame rows picked from the videos, one row per video (QA preview)

Submitting the tasks and downloading <dir>.mp4 is done through the MCP tools (create_asset_upload ->
complete_asset_upload -> create_video_task -> get_video_result). Numbers: assets_src/pipeline.json `walkVideo`.

Picking one stride cycle (`cycle`): the clip's body bob gives the phase. The head top (full video resolution, first
row with >= `topMinPx` opaque px) is lowest on a contact and highest while the legs pass. Frames outside the
first/last `edgeFrames` are split at the bob's mid level into contact/passing runs; each run's extreme frame (middle
one on a plateau) represents it. Frames with more than `maxStray` px beyond the seed's silhouette grown by `reach`
px (the clip drew a floor, shadow or prop, or its background drifted off the key colour) or whose head top is more
than `maxBob` px off the seed's are unusable; runs cut by the window or by unusable frames are dropped. Of every
consecutive passing-contact-passing-contact quadruple whose contacts differ by >= `minAlternate` px in the bottom
`legFrac` (different feet forward) the one whose heads differ least from the seed wins and becomes [legs together,
contact A, legs together, contact B]. Each frame keeps the video's body, arms and legs; the head (everything above
the seed's narrowest row within `neckBand` of its height) is the seed's own head raised by the frame's bob
(0..`maxLift` px), so faces never flicker. Frames are aligned to the seed (+-`maxShift` px, head band), put on the
seed's baseline, mapped to the seed's colours and speck-cleaned.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import tempfile

import numpy as np
from assetlib import (
    ROOT,
    TEMPLATES_PATH,
    binarize_alpha,
    chroma_key,
    content_json,
    dilate,
    hex_rgb,
    load_json,
    load_rgb,
    load_src,
    medoid_resample,
    pipeline_cfg,
    remove_specks,
    save_png,
    to_image,
    write_json,
)

FRAMES = 4


def _cfg() -> tuple[dict, dict, dict]:
    cfg = pipeline_cfg()
    return cfg, cfg["walkVideo"], content_json("content/config.json")["sprites"]


def _dir_of(sheet_id: str) -> pathlib.Path:
    return ROOT / _cfg()[1]["rawDir"] / sheet_id


def prep(sheet_id: str, force: bool = False) -> list[dict]:
    _, wv, sprites = _cfg()
    cell = sprites["sheetCell"]
    tpl = load_json(TEMPLATES_PATH)["walkVideo"]
    sheet = load_src(ROOT / "public" / "assets" / "characters" / f"{sheet_id}.png")
    out_dir = _dir_of(sheet_id)
    pad, scale = wv["pad"], wv["scale"]
    side = (cell + 2 * pad) * scale
    jobs = []
    for d, r in sorted(sprites["sheetRows"].items(), key=lambda kv: kv[1]):
        idle = sheet[r * cell : (r + 1) * cell, :cell]
        canvas = np.zeros((cell + 2 * pad, cell + 2 * pad, 3), np.float32)
        canvas[:] = hex_rgb(wv["background"])
        op = idle[..., 3] >= 127.5
        canvas[pad : pad + cell, pad : pad + cell][op] = idle[..., :3][op]
        big = np.repeat(np.repeat(canvas, scale, axis=0), scale, axis=1)
        img = out_dir / f"{d}.png"
        if force or not img.exists():
            save_png(to_image(big), img)
        task = dict(wv["task"])
        fill = {"{facing}": tpl["facing"][d], "{endSec}": f"{task['duration']:.2f}"}
        prompts = {}
        for key in ("prompt", "promptFirstFrame"):
            prompts[key] = tpl[key]
            for k, v in fill.items():
                prompts[key] = prompts[key].replace(k, v)
        job = {
            "id": sheet_id,
            "dir": d,
            "image": str(img.relative_to(ROOT)),
            "size": side,
            **prompts,
            "task": task,
        }
        write_json(out_dir / f"{d}.json", job)
        jobs.append(job)
    return jobs


def seed(sheet_id: str, d: str) -> np.ndarray:
    """The exact cell `prep` sent as first/last frame, read back from <dir>.png."""
    _, wv, sprites = _cfg()
    cell, pad, scale = sprites["sheetCell"], wv["pad"], wv["scale"]
    big = load_rgb(_dir_of(sheet_id) / f"{d}.png")
    small = big[scale // 2 :: scale, scale // 2 :: scale][
        pad : pad + cell, pad : pad + cell
    ]
    out = np.zeros((cell, cell, 4), np.float32)
    op = np.abs(small - np.array(hex_rgb(wv["background"]), np.float32)).sum(-1) > 0
    out[op, :3] = small[op]
    out[op, 3] = 255
    return out


def video_frames(video: pathlib.Path) -> list[np.ndarray]:
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-i", str(video), f"{tmp}/%04d.png"],
            check=True,
        )
        return [load_rgb(p) for p in sorted(pathlib.Path(tmp).glob("*.png"))]


def to_cell(rgb: np.ndarray) -> tuple[np.ndarray, float]:
    """One video frame -> (sheet cell keyed and sampled on the sheet pixel grid, head top row in sheet px)."""
    cfg, wv, sprites = _cfg()
    cell, pad = sprites["sheetCell"], wv["pad"]
    g = rgb.shape[0] / (cell + 2 * pad)
    keyed = chroma_key(rgb, cfg["chroma"])
    rows = np.nonzero((keyed[..., 3] >= 127.5).sum(axis=1) >= wv["cycle"]["topMinPx"])[
        0
    ]
    small = binarize_alpha(
        medoid_resample(keyed, g, g, 0.0, 0.0, cell + 2 * pad, cell + 2 * pad)
    )
    return small[pad : pad + cell, pad : pad + cell], float(rows.min()) / g if len(
        rows
    ) else 0.0


def _opaque(f: np.ndarray) -> np.ndarray:
    return f[..., 3] >= 127.5


def _extent(op: np.ndarray) -> tuple[int, int]:
    ys = np.nonzero(op.any(axis=1))[0]
    return int(ys.min()), int(ys.max())


def _shift(f: np.ndarray, dy: int, dx: int) -> np.ndarray:
    out = np.zeros_like(f)
    h, w = f.shape[:2]
    out[max(dy, 0) : h + min(dy, 0), max(dx, 0) : w + min(dx, 0)] = f[
        max(-dy, 0) : h - max(dy, 0), max(-dx, 0) : w - max(dx, 0)
    ]
    return out


def _head_diff(a: np.ndarray, b: np.ndarray, rows: slice) -> int:
    oa, ob = _opaque(a[rows]), _opaque(b[rows])
    col = np.abs(a[rows][..., :3] - b[rows][..., :3]).sum(-1) > 3 * 32
    return int((oa ^ ob).sum() + (oa & ob & col).sum())


def _align(
    f: np.ndarray, ref: np.ndarray, head: slice, max_shift: int
) -> tuple[int, int, int]:
    """(dy, dx, diff): the shift of f that best matches ref's head band."""
    best = None
    for dy in range(-max_shift, max_shift + 1):
        for dx in range(-max_shift, max_shift + 1):
            d = _head_diff(_shift(f, dy, dx), ref, head)
            if best is None or (d, abs(dy) + abs(dx)) < (
                best[2],
                abs(best[0]) + abs(best[1]),
            ):
                best = (dy, dx, d)
    assert best is not None
    return best


def _runs(
    bob: list[float], clean: list[bool], lo: int, hi: int
) -> list[list[tuple[bool, int]]]:
    """Complete bob runs inside [lo, hi) as (is contact, representative frame), one list per stretch of clean frames
    split at the stretch's mid bob level (a run touching the window edge or an unusable frame is cut, so it is
    dropped)."""
    stretches: list[list[int]] = [[]]
    for t in range(lo, hi):
        if clean[t]:
            stretches[-1].append(t)
        elif stretches[-1]:
            stretches.append([])
    out = []
    for ts_all in stretches:
        if not ts_all:
            continue
        mid = (max(bob[t] for t in ts_all) + min(bob[t] for t in ts_all)) / 2
        runs: list[tuple[bool, list[int]]] = []
        for t in ts_all:
            low = bob[t] > mid  # larger row = head lower = contact
            if runs and runs[-1][0] == low:
                runs[-1][1].append(t)
            else:
                runs.append((low, [t]))
        reps = []
        for low, ts in runs[1:-1]:
            ext = (max if low else min)(bob[t] for t in ts)
            at = [t for t in ts if bob[t] == ext]
            reps.append((low, at[len(at) // 2]))
        if reps:
            out.append(reps)
    return out


def _compose(
    f: np.ndarray, ref: np.ndarray, neck: int, dy: int, palette: np.ndarray
) -> np.ndarray:
    """Video body below the neck, ref's head raised by dy above it, on ref's colours."""
    out = f.copy()
    rows = neck - dy
    out[: max(rows, 0)] = 0
    src = np.arange(max(rows, 0)) + dy
    ok = src >= 0
    out[: max(rows, 0)][ok] = ref[src[ok]]
    op = _opaque(out)
    idx = ((out[..., :3][op][:, None, :] - palette[None]) ** 2).sum(-1).argmin(axis=1)
    out[op, :3] = palette[idx]
    out[~op] = 0
    return out


def cycle(
    cells: list[np.ndarray], bob: list[float], ref: np.ndarray, cfg: dict, scfg: dict
) -> tuple[list[np.ndarray], dict]:
    """4-frame walk row from one clip's cells (see module doc); bob[0] is the seed frame.

    Raises ValueError when the clip does not start on the seed (more than `seedMaxDiff` px differ) or holds no
    full cycle."""
    c = cfg["cycle"]
    start = _head_diff(cells[0], ref, slice(None))
    if start > c["seedMaxDiff"]:
        raise ValueError(f"clip does not start on its seed ({start} px differ)")
    op = _opaque(ref)
    top, foot = _extent(op)
    h = foot - top + 1
    band = range(top + round(c["neckBand"][0] * h), top + round(c["neckBand"][1] * h))
    neck = min(band, key=lambda y: (int(op[y].sum()), y))
    head = slice(0, neck)
    legs = slice(foot + 1 - round(c["legFrac"] * h), foot + 1)
    palette = np.unique(ref[..., :3][op], axis=0)
    # frames where the clip grew a floor, shadow or prop or lost the key colour: too many pixels beyond the seed's
    # silhouette
    near = dilate(op, c["reach"])
    clean = [
        int((_opaque(f) & ~near).sum()) <= c["maxStray"]
        and abs(b - bob[0]) <= c["maxBob"]
        for f, b in zip(cells, bob, strict=True)
    ]
    stretches = _runs(bob, clean, c["edgeFrames"], len(bob) - c["edgeFrames"])

    def prepared(t: int) -> tuple[np.ndarray, int]:
        _, dx, _ = _align(cells[t], ref, head, c["maxShift"])
        f = _shift(cells[t], 0, dx)
        f = _shift(f, foot - _extent(_opaque(f))[1], 0)
        return f, _align(f, ref, head, c["maxShift"])[2]

    best = None
    quads = [
        runs[i : i + FRAMES]
        for runs in stretches
        for i in range(len(runs) - FRAMES + 1)
    ]
    for quad in quads:
        if [low for low, _ in quad] != [False, True, False, True]:
            continue
        ts = [t for _, t in quad]
        # the two contacts must put different feet forward (some clips only step with one leg)
        if _head_diff(prepared(ts[1])[0], prepared(ts[3])[0], legs) < c["minAlternate"]:
            continue
        score = sum(prepared(t)[1] for t in ts)
        if best is None or score < best[0]:
            best = (score, ts)
    if best is None:
        raise ValueError(
            f"no clean alternating stride cycle in the clip ({sum(clean)}/{len(cells)} clean frames, runs: {stretches})"
        )
    row = []
    lifts = []
    for t in best[1]:
        f, _ = prepared(t)
        # the head top tracks the bob even when the video redraws the head a little larger or turned
        lift = min(max(round(bob[0] - bob[t]), 0), c["maxLift"])
        g = _compose(f, ref, neck, lift, palette)
        g = binarize_alpha(remove_specks(g, scfg["minSpeck"], scfg["speckRatio"]))
        # a dropped speck may have been the lowest pixel
        g = _shift(g, foot - _extent(_opaque(g))[1], 0)
        row.append(g)
        lifts.append(lift)
    return row, {"frames": best[1], "headDiff": best[0], "lift": lifts}


def clip_cells(video: pathlib.Path) -> tuple[list[np.ndarray], list[float]]:
    pairs = [to_cell(f) for f in video_frames(video)]
    return [p[0] for p in pairs], [p[1] for p in pairs]


def rows(sheet_id: str) -> dict[str, tuple[list[np.ndarray] | None, dict]]:
    """{direction: (4 cells or None, report)} for every direction with a downloaded clip."""
    cfg, wv, _ = _cfg()
    out: dict[str, tuple[list[np.ndarray] | None, dict]] = {}
    for video in sorted(_dir_of(sheet_id).glob("*.mp4")):
        try:
            cells, bob = clip_cells(video)
            out[video.stem] = cycle(
                cells, bob, seed(sheet_id, video.stem), wv, cfg["sheet"]
            )
        except (ValueError, OSError, subprocess.CalledProcessError) as e:
            out[video.stem] = None, {"fallback": str(e)}
    return out


def apply(
    sheet_id: str, frames: list[list[np.ndarray]], sheet_rows: dict[str, int]
) -> tuple[list[list[np.ndarray]], dict]:
    """Takes every row from its clip when ALL rows have a usable one; otherwise the sheet keeps its synthesized
    cycle (a sheet never mixes the two styles)."""
    if not sheet_id or not _dir_of(sheet_id).is_dir():
        return frames, {}
    got = rows(sheet_id)
    rep = {"used": False, "rows": {d: r for d, (_, r) in got.items()}}
    picked = {d: got[d][0] for d in sheet_rows if d in got}
    usable = {d: cells for d, cells in picked.items() if cells is not None}
    if len(usable) < len(sheet_rows):
        return frames, rep
    out = list(frames)
    for d, r in sheet_rows.items():
        out[r] = usable[d]
    return out, {**rep, "used": True}


def frames(sheet_id: str) -> dict:
    out_dir = _dir_of(sheet_id)
    cell = _cfg()[2]["sheetCell"]
    rep = {}
    for video in sorted(out_dir.glob("*.mp4")):
        cells, _ = clip_cells(video)
        strip = np.zeros((cell, cell * len(cells), 4), np.float32)
        for i, c in enumerate(cells):
            strip[:, i * cell : (i + 1) * cell] = c
        save_png(to_image(strip), out_dir / f"{video.stem}_frames.png")
        rep[video.stem] = len(cells)
    return rep


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("cmd", choices=["prep", "frames", "cycle"])
    ap.add_argument("id")
    ap.add_argument("out", nargs="?")
    ap.add_argument(
        "--force", action="store_true", help="prep: overwrite existing seeds"
    )
    a = ap.parse_args()
    if a.cmd == "prep":
        print(
            json.dumps(
                [
                    {k: j[k] for k in ("dir", "image", "size")}
                    for j in prep(a.id, a.force)
                ]
            )
        )
    elif a.cmd == "frames":
        print(json.dumps(frames(a.id)))
    else:
        if not a.out:
            ap.error("cycle needs an output png")
        cell = _cfg()[2]["sheetCell"]
        got = rows(a.id)
        sheet = np.zeros((cell * len(got), cell * FRAMES, 4), np.float32)
        for r, (cells, _) in enumerate(got.values()):
            for c, f in enumerate(cells or []):
                sheet[r * cell : (r + 1) * cell, c * cell : (c + 1) * cell] = f
        save_png(to_image(sheet), a.out)
        print(json.dumps({d: rep for d, (_, rep) in got.items()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
