#!/usr/bin/env python3
"""Complete-body walk atlases from H3 clips: separate idle + eight chronological walk poses.

prep <id>: padded nearest-scaled directional seeds and filled prompts.
frames <id>: keyed native-resolution contact strips.
cycle <id> <out.png>: an atlas, only when all four directions pass.

No body parts are grafted or erased. A whole-frame translation corrects camera drift
and grounds the supporting sole. Cycle selection uses pose recurrence, leg
alternation, body motion and the wrap seam, not a mandatory head bounce.
"""

from __future__ import annotations

import argparse
from collections import deque
import json
import pathlib
import subprocess
import sys
import tempfile

import numpy as np
from walk_cycle import plant_idle
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
    save_png,
    to_image,
    write_json,
)

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
        appearance = next((c["desc"] for c in content_json("content/characters.json") if c["id"] == sheet_id), sheet_id)
        fill = {"{facing}": tpl["facing"][d], "{endSec}": f"{task['duration']:.2f}", "{appearance}": appearance}
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


def seed(sheet_id: str, d: str, image: pathlib.Path | None = None) -> np.ndarray:
    """The exact cell `prep` sent as first/last frame, read back from <dir>.png."""
    _, wv, sprites = _cfg()
    cell, pad, scale = sprites["sheetCell"], wv["pad"], wv["scale"]
    big = load_rgb(image or _dir_of(sheet_id) / f"{d}.png")
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
    # Relative island-size filters can delete tiny hands. Validate connectivity instead.
    small = clean_specks(small, wv["atlas"]["minSpeck"])
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


def _islands(f: np.ndarray) -> tuple[np.ndarray, list[int]]:
    """8-connected pixel clusters, retaining legitimate diagonal wrist/outline joins."""
    op = _opaque(f)
    h, w = op.shape
    mask = op.tolist()
    labels = [[-1] * w for _ in range(h)]
    sizes = []
    for y in range(h):
        for x in range(w):
            if not mask[y][x] or labels[y][x] >= 0:
                continue
            label, size = len(sizes), 0
            todo = deque([(y, x)])
            labels[y][x] = label
            while todo:
                cy, cx = todo.popleft()
                size += 1
                for ny in range(max(0, cy - 1), min(h, cy + 2)):
                    for nx in range(max(0, cx - 1), min(w, cx + 2)):
                        if mask[ny][nx] and labels[ny][nx] < 0:
                            labels[ny][nx] = label
                            todo.append((ny, nx))
            sizes.append(size)
    return np.array(labels, np.int32), sizes


def clean_specks(f: np.ndarray, minimum: int) -> np.ndarray:
    labels, sizes = _islands(f)
    out = f.copy()
    for i, size in enumerate(sizes):
        if size < minimum:
            out[labels == i] = 0
    return out


def detached_pixels(f: np.ndarray, ref: np.ndarray) -> int:
    labels, sizes = _islands(f)
    if not sizes:
        return f.shape[0] * f.shape[1]
    ref_labels, ref_sizes = _islands(ref)
    allowed = np.zeros(ref.shape[:2], bool)
    if ref_sizes:
        main = int(np.argmax(ref_sizes))
        allowed = dilate((ref_labels >= 0) & (ref_labels != main), 3)
    main = int(np.argmax(sizes))
    return int(((_opaque(f) & (labels != main)) & ~allowed).sum())


def cycle(
    cells: list[np.ndarray], bob: list[float], ref: np.ndarray, cfg: dict, scfg: dict
) -> tuple[list[np.ndarray], dict]:
    """Separate standing frame and a temporally ordered, complete-body cycle."""
    c = cfg["cycle"]
    a = cfg["atlas"]
    count = a["frames"]
    if len(cells) != len(bob) or len(cells) < count + 1:
        raise ValueError("clip too short for a complete cycle")
    start = _head_diff(cells[0], ref, slice(None))
    if start > c["seedMaxDiff"]:
        raise ValueError(f"clip does not start on its seed ({start} px differ)")
    op = _opaque(ref)
    top, foot = _extent(op)
    h = foot - top + 1
    neck = top + round(c["neckBand"][0] * h)
    head = slice(0, neck)
    joint = foot + 1 - round(c["legFrac"] * h)
    legs = slice(joint, foot + 1)
    palette = np.unique(ref[..., :3][op], axis=0)
    # frames where the clip grew a floor, shadow or prop or lost the key colour: too many pixels beyond the seed's
    # silhouette
    near = dilate(op, c["reach"])
    clean, prepared, identity = [], [], []
    baseline = ref.shape[0] - 1 - scfg["bottomMargin"]
    for f, b in zip(cells, bob, strict=True):
        if not _opaque(f).any():
            prepared.append(f)
            identity.append(1e6)
            clean.append(False)
            continue
        _, dx, diff = _align(f, ref, head, c["maxShift"])
        g = _shift(f, baseline - _extent(_opaque(f))[1], dx)
        visible = _opaque(g)
        idx = ((g[..., :3][visible][:, None] - palette[None]) ** 2).sum(-1).argmin(axis=1)
        g[visible, :3] = palette[idx]
        g[~visible] = 0
        prepared.append(g)
        identity.append(diff)
        clean.append(
            int((_opaque(f) & ~near).sum()) <= c["maxStray"]
            and abs(b - bob[0]) <= c["maxBob"]
            and detached_pixels(g, ref) <= a["maxDetached"]
            and int(visible.sum()) == int(_opaque(f).sum())
        )

    best = None
    lo, hi = c["edgeFrames"], len(cells) - c["edgeFrames"]
    for period in range(max(count, a["minPeriod"]), min(a["maxPeriod"], hi - lo - 1) + 1):
        for first in range(lo, hi - period):
            if not all(clean[first : first + period + 1]):
                continue
            ts = [first + int(i * period / count) for i in range(count)]
            row = [prepared[t] for t in ts]
            if len({f.tobytes() for f in row}) < a["minUnique"]:
                continue
            leg_motion = max(_head_diff(row[i], row[(i + count // 2) % count], legs) for i in range(count))
            body_motion = max(_head_diff(row[0], f, slice(neck, joint)) for f in row[1:])
            if leg_motion < c["minAlternate"] or body_motion < a["minBodyMotion"]:
                continue
            changes = [_head_diff(row[i], row[(i + 1) % count], slice(None)) for i in range(count)]
            mean_change = max(float(np.mean(changes)), 1.0)
            seam_ratio = changes[-1] / mean_change
            if seam_ratio > a["maxSeamRatio"]:
                continue
            recurrence = _head_diff(prepared[first], prepared[first + period], slice(None))
            # Prefer a true recurring pose, a quiet wrap seam and little identity drift.
            score = 4 * recurrence / mean_change + max(changes) / mean_change + np.mean([identity[t] for t in ts]) / max(int(op[:neck].sum()), 1)
            if best is None or score < best[0]:
                best = (score, ts, row, period, seam_ratio, body_motion, leg_motion)
    if best is None:
        raise ValueError(f"no connected, moving, continuous cycle ({sum(clean)}/{len(clean)} usable frames)")
    _, ts, row, period, seam_ratio, body_motion, leg_motion = best
    stand = plant_idle(ref, scfg["walkCycle"])
    stand = _shift(stand, baseline - _extent(_opaque(stand))[1], 0)
    return [stand, *row], {
        "frames": ts, "period": period, "unique": len({f.tobytes() for f in row}),
        "seamRatio": round(seam_ratio, 3), "bodyMotionPixels": body_motion,
        "legMotionPixels": leg_motion, "completeBody": True,
    }


def clip_cells(video: pathlib.Path) -> tuple[list[np.ndarray], list[float]]:
    pairs = [to_cell(f) for f in video_frames(video)]
    return [p[0] for p in pairs], [p[1] for p in pairs]


def rows(sheet_id: str) -> dict[str, tuple[list[np.ndarray] | None, dict]]:
    """Prefer regenerated clips; retain source provenance for each direction."""
    cfg, wv, _ = _cfg()
    out: dict[str, tuple[list[np.ndarray] | None, dict]] = {}
    current = ROOT / wv["rawDirV2"] / sheet_id
    videos = {p.stem: p for p in sorted(_dir_of(sheet_id).glob("*.mp4"))}
    videos.update({p.stem: p for p in sorted(current.glob("*.mp4"))})
    for direction, video in videos.items():
        try:
            cells, bob = clip_cells(video)
            cycle_cfg = wv
            if video.parent == current:
                lower, upper = wv["atlas"]["regeneratedPeriod"]
                cycle_cfg = {**wv, "atlas": {**wv["atlas"], "minPeriod": lower, "maxPeriod": upper}}
            row, report = cycle(
                cells, bob, seed(sheet_id, direction, video.with_suffix(".png")), cycle_cfg, cfg["sheet"]
            )
            out[direction] = row, {**report, "source": str(video.relative_to(ROOT)), "regenerated": video.parent == current}
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
        order = sorted(_cfg()[2]["sheetRows"].items(), key=lambda kv: kv[1])
        if any(d not in got or got[d][0] is None for d, _ in order):
            print(json.dumps({d: rep for d, (_, rep) in got.items()}))
            return 1
        ncols = _cfg()[1]["atlas"]["frames"] + 1
        sheet = np.zeros((cell * len(order), cell * ncols, 4), np.float32)
        for direction, r in order:
            for c, f in enumerate(got[direction][0]):
                sheet[r * cell : (r + 1) * cell, c * cell : (c + 1) * cell] = f
        save_png(to_image(sheet), a.out)
        print(json.dumps({d: rep for d, (_, rep) in got.items()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
