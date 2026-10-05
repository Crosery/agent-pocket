"""Complete-body H3 extraction regressions, including sleeve/hand continuity."""

from __future__ import annotations

import copy
import unittest

import numpy as np

from assetlib import pipeline_cfg
from walk_video import _head_diff, cycle, to_cell

SKIN = (230, 190, 150, 255)
BLUE = (30, 90, 160, 255)
DARK = (20, 25, 40, 255)


def walking_frame(phase: int) -> np.ndarray:
    f = np.zeros((64, 64, 4), np.float32)
    f[6:30, 20:44] = SKIN
    f[30:34, 30:34] = BLUE
    f[32:48, 26:38] = BLUE
    swing, left_lift, right_lift = [
        (-3, 0, 1), (-2, 0, 2), (0, 0, 2), (2, 0, 1),
        (3, 1, 0), (2, 2, 0), (0, 2, 0), (-2, 1, 0),
    ][phase % 8]
    for y in range(34, 47):
        dx = round(swing * (y - 34) / 12)
        f[y, 24 + dx : 28 + dx] = BLUE
        f[y, 36 - dx : 40 - dx] = BLUE
    f[46:49, 24 + swing : 28 + swing] = SKIN
    f[46:49, 36 - swing : 40 - swing] = SKIN
    f[48 : 62 - left_lift, 27:31] = DARK
    f[48 : 62 - right_lift, 33:37] = DARK
    return f


class CompleteBodyWalk(unittest.TestCase):
    def setUp(self):
        self.cfg = copy.deepcopy(pipeline_cfg()["walkVideo"])
        self.cfg["atlas"] = {
            "frames": 8, "minPeriod": 8, "maxPeriod": 16,
            "minUnique": 6, "maxSeamRatio": 2.5, "minBodyMotion": 8,
            "maxDetached": 3, "minSpeck": 2,
        }
        self.scfg = pipeline_cfg()["sheet"]
        self.ref = walking_frame(2)
        self.ref[60:62, 33:37] = DARK
        self.cells = [self.ref.copy()] * 4 + [walking_frame(t) for t in range(24)] + [self.ref.copy()] * 4
        self.bob = [6.0] * len(self.cells)

    def test_idle_is_separate_from_eight_forward_ordered_complete_poses(self):
        row, report = cycle(self.cells, self.bob, self.ref, self.cfg, self.scfg)
        self.assertEqual(len(row), 9, "idle + eight real walk poses, not four rigid composites")
        self.assertTrue(np.array_equal(row[0], self.ref))
        self.assertGreaterEqual(len({f.tobytes() for f in row[1:]}), 6)
        self.assertEqual(len(report["frames"]), 8)
        self.assertEqual(report["frames"], sorted(set(report["frames"])))
        self.assertGreater(
            max(_head_diff(f, row[1], slice(32, 49)) for f in row[2:]),
            8,
            "video shoulders, arms and hands must not be overwritten with the idle torso",
        )
        source_poses = {f.tobytes() for f in self.cells}
        self.assertTrue(all(f.tobytes() in source_poses for f in row[1:]))

    def test_small_diagonally_connected_hand_is_not_erased_as_a_speck(self):
        f = self.ref.copy()
        f[46:50, :24] = 0
        f[45, 23] = BLUE
        f[46:48, 21:23] = SKIN
        rgb = np.full((80, 80, 3), (255, 0, 255), np.float32)
        view = rgb[8:72, 8:72]
        view[f[..., 3] > 0] = f[..., :3][f[..., 3] > 0]
        big = np.repeat(np.repeat(rgb, 8, axis=0), 8, axis=1)
        cell, _ = to_cell(big)
        self.assertTrue((cell[46:48, 21:23, 3] == 255).all())

    def test_detached_hand_and_frozen_clips_are_rejected(self):
        broken = [f.copy() for f in self.cells]
        for f in broken[4:-4]:
            f[40:43, 48:51] = SKIN
        with self.assertRaises(ValueError):
            cycle(broken, self.bob, self.ref, self.cfg, self.scfg)
        with self.assertRaises(ValueError):
            cycle([self.ref] * 32, self.bob, self.ref, self.cfg, self.scfg)


if __name__ == "__main__":
    unittest.main()
