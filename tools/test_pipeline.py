"""Unit tests for the 2D asset pipeline algorithms.

Run: python3 -m unittest discover -s tools -p 'test_*.py'
"""

from __future__ import annotations

import pathlib
import tempfile
import unittest
from unittest import mock

import numpy as np
import walk_video
from assetlib import ROOT, chroma_key, estimate_grid, medoid_resample, pipeline_cfg
from PIL import Image
from process_sheet import SheetError, fix_facing, process_sheet, split_bands
from process_texture import make_seamless, seam_error
from walk_cycle import walk_cycle
from walk_video import cycle as video_cycle

RNG = np.random.default_rng(7)
SNAP = pipeline_cfg()["sheet"]["bandSnap"]


class SplitBands(unittest.TestCase):
    def test_even_blobs(self):
        prof = np.zeros(400, np.float32)
        for s in (10, 110, 210, 310):
            prof[s : s + 70] = 5
        self.assertEqual(
            split_bands(prof, 4, 0, SNAP),
            [(10, 80), (110, 180), (210, 280), (310, 380)],
        )

    def test_stray_blob_merges_and_touching_figures_split(self):
        prof = np.zeros(400, np.float32)
        prof[10:80] = 5
        prof[84:86] = 1  # detached hair tip belongs to the first figure
        prof[110:280] = 5  # two figures touching
        prof[195] = 0.5  # thin waist between them
        prof[310:380] = 5
        bands = split_bands(prof, 4, 0, SNAP)
        self.assertEqual(len(bands), 4)
        self.assertEqual(bands[0], (10, 86))
        self.assertTrue(185 <= bands[1][1] <= 205 and bands[2][0] == bands[1][1])

    def test_missing_band_raises(self):
        prof = np.zeros(400, np.float32)
        prof[10:80] = 5
        prof[310:380] = 5
        with self.assertRaises(SheetError):
            split_bands(prof, 4, 0, SNAP)


class ChromaKey(unittest.TestCase):
    def test_background_removed_subject_kept(self):
        cfg = pipeline_cfg()["chroma"]
        img = np.zeros((40, 40, 3), np.float32)
        img[:] = (255, 0, 255)
        img[10:30, 10:30] = (30, 30, 40)  # dark outline/body
        img[18:22, 18:22] = (120, 40, 170)  # purple interior must survive
        img[9, 10:30] = (140, 15, 150)  # key blended with the dark outline
        img[30, 10:30] = (227, 92, 211)  # key blended with a light subject (no outline)
        out = chroma_key(img, cfg)
        self.assertEqual(out[0, 0, 3], 0)
        self.assertEqual(out[20, 20, 3], 255)
        self.assertEqual(out[15, 15, 3], 255)
        # dark blend survives but is despilled to a neutral dark; light blend is peeled off
        self.assertTrue(
            out[9, 20, 3] == 0 or (out[9, 20, :3].max() - out[9, 20, :3].min()) < 30
        )
        self.assertEqual(out[30, 20, 3], 0)

    def test_source_alpha_respected(self):
        cfg = pipeline_cfg()["chroma"]
        img = np.zeros((20, 20, 4), np.float32)
        img[..., :3] = 0
        img[5:15, 5:15] = (200, 100, 50, 255)
        self.assertEqual(chroma_key(img, cfg)[0, 0, 3], 0)
        self.assertEqual(chroma_key(img, cfg)[10, 10, 3], 255)


class Grid(unittest.TestCase):
    def test_estimate_and_resample_recovers_native_art(self):
        native = RNG.integers(0, 255, (24, 24, 3)).astype(np.float32)
        g = 5.0
        big = np.repeat(np.repeat(native, 5, axis=0), 5, axis=1)
        big = np.pad(big, ((3, 2), (3, 2), (0, 0)), mode="edge")  # phase offset 3
        est, px, py, _ = estimate_grid(big, 2.5, 14)
        self.assertAlmostEqual(est, g, delta=0.1)
        rgba = np.concatenate(
            [big, np.full(big.shape[:2] + (1,), 255.0, np.float32)], axis=2
        )
        out = medoid_resample(rgba, est, est, px, py, 24, 24)
        self.assertLess(np.abs(out[..., :3] - native).mean(), 1.0)


class Seamless(unittest.TestCase):
    def test_blend_removes_wrap_seam(self):
        tile = RNG.random((64, 64, 4)).astype(np.float32) * 40
        ramp = np.linspace(0, 150, 64, dtype=np.float32)
        tile += (
            ramp[None, :, None] + ramp[:, None, None] * 0.5
        )  # big jump only across the wrap
        self.assertGreater(seam_error(tile[..., :3]), 2.0)
        self.assertLess(seam_error(make_seamless(tile, 0.3)[..., :3]), 1.5)


class Facing(unittest.TestCase):
    def test_right_row_rebuilt_from_left_when_both_face_left(self):
        cell = np.zeros((16, 16, 4), np.float32)
        cell[2:14, 4:9] = (40, 40, 40, 255)
        cell[2:6, 3:6] = (240, 190, 160, 255)  # skin on the left side of the head
        cells = [[cell.copy() for _ in range(4)] for _ in range(4)]
        fix_facing(cells, 1, 2, pipeline_cfg()["sheet"]["facing"])
        self.assertTrue(np.array_equal(cells[2][0], cell[:, ::-1]))
        self.assertTrue(np.array_equal(cells[1][0], cell))


WALK = pipeline_cfg()["sheet"]["walkCycle"]
BODY, LEG_L, LEG_R = (200, 60, 60, 255), (40, 40, 160, 255), (40, 160, 40, 255)


def _lowest(f: np.ndarray, x0: int = 0, x1: int | None = None) -> int:
    return int(np.nonzero(f[:, x0:x1, 3].any(axis=1))[0].max())


def _top(f: np.ndarray) -> int:
    return int(np.nonzero(f[..., 3].any(axis=1))[0].min())


def _front_figure(raise_right: int = 0) -> np.ndarray:
    f = np.zeros((64, 64, 4), np.float32)
    f[10:50, 22:42] = BODY
    f[50:62, 25:31] = LEG_L
    f[50 : 62 - raise_right, 33:39] = LEG_R
    return f


def _side_figure() -> np.ndarray:
    f = np.zeros((64, 64, 4), np.float32)
    f[10:50, 24:40] = BODY
    for i, y in enumerate(range(50, 62)):  # legs splay from the hip to a wide stride
        f[y, 28 - i // 2 : 32 - i // 2] = LEG_L
        f[y, 33 + i // 2 : 37 + i // 2] = LEG_R
    return f


class WalkCycle(unittest.TestCase):
    def test_front_row_alternates_feet_and_bobs(self):
        cells = [_front_figure() for _ in range(4)]
        (row,), _ = walk_cycle([cells], set(), WALK)
        stand, left, stand2, right = row
        self.assertTrue(np.array_equal(stand, stand2))
        self.assertTrue(np.array_equal(stand, cells[0]))
        for f in row:
            self.assertEqual(_lowest(f), 61)
        self.assertEqual(_lowest(left, 0, 32), 61 - WALK["lift"])
        self.assertEqual(_lowest(left, 32), 61)
        self.assertEqual(_lowest(right, 0, 32), 61)
        self.assertEqual(_lowest(right, 32), 61 - WALK["lift"])
        self.assertEqual(_top(left), _top(stand) + WALK["bob"])
        colours = {tuple(c) for c in cells[0].reshape(-1, 4)}
        for f in row:
            self.assertTrue({tuple(c) for c in f.reshape(-1, 4)} <= colours)

    def test_front_row_plants_a_raised_foot(self):
        (row,), _ = walk_cycle([[_front_figure(raise_right=2)] * 4], set(), WALK)
        self.assertEqual(_lowest(row[0], 32), 61)
        self.assertEqual(_lowest(row[0], 0, 32), 61)

    def test_side_row_passing_frame_closes_the_stride(self):
        (row,), rep = walk_cycle([[_side_figure()] * 4], {0}, WALK)
        passing, stride = row[0], row[1]
        self.assertTrue(rep[0]["stride"])
        self.assertTrue(np.array_equal(stride, _side_figure()))
        self.assertTrue(np.array_equal(row[2], passing))
        self.assertEqual(_lowest(passing), 61)
        self.assertEqual(_top(passing), _top(stride) - WALK["bob"])

        def foot_gap(f: np.ndarray) -> float:
            xl = np.nonzero((f[61] == LEG_L).all(axis=1))[0]
            xr = np.nonzero((f[61] == LEG_R).all(axis=1))[0]
            return float(xr.mean() - xl.mean())

        self.assertLess(foot_gap(passing), foot_gap(stride) * (1 - WALK["tuck"] / 2))


HEAD, HEAD_VIDEO, EYE = (230, 190, 150, 255), (236, 196, 140, 255), (20, 20, 20, 255)


def _clip_figure(phase: str, head=HEAD) -> np.ndarray:
    """Seed/clip frame: head 6..29, 4 px neck, torso, legs to row 61. P = passing (body 1 px up, legs together),
    A/B = contacts with the legs spread to opposite sides."""
    up = 1 if phase == "P" else 0
    f = np.zeros((64, 64, 4), np.float32)
    f[6 - up : 30 - up, 20:44] = head
    f[14 - up, 26] = f[14 - up, 37] = EYE
    f[30 - up : 32 - up, 30:34] = BODY
    f[32 - up : 50 - up, 24:40] = BODY
    xl, xr = {"S": (27, 33), "P": (28, 32), "A": (24, 34), "B": (28, 38)}[phase]
    f[50 - up : 62, xl : xl + 4] = LEG_L
    f[50 - up : 62, xr : xr + 4] = LEG_R
    return f


WALK_CFG = pipeline_cfg()


class WalkVideo(unittest.TestCase):
    CFG = WALK_CFG

    def _clip(self, phases: str) -> tuple[list[np.ndarray], list[float]]:
        cells = [_clip_figure(ph, HEAD if ph in "SAB" else HEAD_VIDEO) for ph in phases]
        return cells, [5.0 if ph == "P" else 6.0 for ph in phases]

    def test_picks_passing_contact_passing_contact_with_the_seed_head(self):
        seed = _clip_figure("S")
        cells, bob = self._clip("SSSS" + "PPAAPPBB" * 3 + "SSSS")
        row, rep = video_cycle(
            cells, bob, seed, self.CFG["walkVideo"], self.CFG["sheet"]
        )
        self.assertEqual(rep["frames"], [9, 11, 13, 15])
        self.assertEqual(rep["lift"], [1, 0, 1, 0])
        passing, contact, passing2, contact2 = row
        self.assertTrue(np.array_equal(passing, passing2))
        self.assertFalse(np.array_equal(contact[50:], contact2[50:]))
        for f, lift in zip(row, rep["lift"], strict=True):
            self.assertEqual(_lowest(f), 61)
            self.assertEqual(_top(f), 6 - lift)
            # head is the seed's, not the clip's recoloured one
            self.assertTrue(np.array_equal(f[6 - lift : 30 - lift], seed[6:30]))
        colours = {tuple(c) for c in seed.reshape(-1, 4)}
        for f in row:
            self.assertTrue({tuple(c) for c in f.reshape(-1, 4)} <= colours)

    def test_unusable_frames_cut_the_runs(self):
        seed = _clip_figure("S")
        phases = "SSSS" + "PPAAPPBB" + "XXXX" + "PPAAPPBBPPAAPP" + "SSSS"
        cells, bob = self._clip(phases.replace("X", "P"))
        for t, ph in enumerate(phases):
            if (
                ph == "X"
            ):  # the key colour drifted: the whole cell is opaque, the head top reads 0
                cells[t][:, :, :] = BODY
                bob[t] = 0.0
        _, rep = video_cycle(cells, bob, seed, self.CFG["walkVideo"], self.CFG["sheet"])
        self.assertEqual(rep["frames"], [21, 23, 25, 27])

    def test_rejects_clips_without_a_cycle_or_on_another_seed(self):
        seed = _clip_figure("S")
        cfg, scfg = self.CFG["walkVideo"], self.CFG["sheet"]
        with self.assertRaises(ValueError):
            video_cycle(*self._clip("S" * 20), seed, cfg, scfg)
        with self.assertRaises(ValueError):  # every step puts the same foot forward
            video_cycle(*self._clip("SSSS" + "PPAA" * 6 + "SSSS"), seed, cfg, scfg)
        cells, bob = self._clip("SSSS" + "PPAAPPBB" * 3 + "SSSS")
        with self.assertRaises(ValueError):
            video_cycle(cells, bob, _clip_figure("A", EYE), cfg, scfg)
        for f, ph in zip(cells, "SSSS" + "PPAAPPBB" * 3 + "SSSS", strict=True):
            if ph == "P":
                f[52:62, 2:62] = np.where(f[52:62, 2:62, 3:] > 0, f[52:62, 2:62], BODY)
        with self.assertRaises(
            ValueError
        ):  # the clip drew a floor under every passing frame
            video_cycle(cells, bob, seed, cfg, scfg)


WALK_ROWS = {"down": 0, "left": 1, "right": 2, "up": 3}


class WalkVideoApply(unittest.TestCase):
    ROWS = WALK_ROWS

    def _apply(self, got: dict) -> tuple[list, dict]:
        synth = [[np.full((4, 4, 4), r, np.float32)] * 4 for r in range(4)]
        clip = [np.full((4, 4, 4), 9, np.float32)] * 4
        rows = {d: (clip if ok else None, {}) for d, ok in got.items()}
        with (
            mock.patch.object(walk_video, "rows", return_value=rows),
            mock.patch.object(pathlib.Path, "is_dir", return_value=True),
        ):
            out, rep = walk_video.apply("x", synth, self.ROWS)
        return [r[0][0, 0, 0] for r in out], rep

    def test_sheet_never_mixes_clip_and_synth_rows(self):
        vals, rep = self._apply({d: True for d in self.ROWS})
        self.assertEqual(vals, [9, 9, 9, 9])
        self.assertTrue(rep["used"])
        for got in ({**dict.fromkeys(self.ROWS, True), "up": False}, {"down": True}):
            vals, rep = self._apply(got)
            self.assertEqual(vals, [0, 1, 2, 3])
            self.assertFalse(rep["used"])


class SheetEndToEnd(unittest.TestCase):
    def test_reference_sheet(self):
        sprites = __import__("json").loads(
            (ROOT / "content" / "config.json").read_text()
        )["sprites"]
        cell, frames = sprites["sheetCell"], sprites["sheetFrames"]
        rows = len(sprites["sheetRows"])
        margin = pipeline_cfg()["sheet"]["bottomMargin"]
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "sheet.png"
            rep = process_sheet(
                str(ROOT / "assets_src" / "walk_sheet_reference.png"),
                str(out),
                "reference",
            )
            a = np.asarray(Image.open(out).convert("RGBA"))
        self.assertEqual(a.shape[:2], (cell * rows, cell * frames))
        self.assertTrue(set(np.unique(a[..., 3])) <= {0, 255})
        for r in range(rows):
            for c in range(frames):
                ys = np.nonzero(
                    a[r * cell : (r + 1) * cell, c * cell : (c + 1) * cell, 3].any(
                        axis=1
                    )
                )[0]
                self.assertEqual(ys.max(), cell - 1 - margin)
        self.assertTrue(rep["facing"].startswith("ok"))


if __name__ == "__main__":
    unittest.main()
