# Per-plate exposure check: mean luma (BT.709, 0-255) of every frame sampled at --fps from the MP4, grouped by
# plate (timeline from data/sfx_events.json). Reports per plate the median frame mean (the grade), the max and
# min frame means, corner luma, and the max/median ratio across plates.
#   uv run --with numpy python scripts/plate_luma.py out/agent-pocket-promo.mp4 [--fps 6]
import json, subprocess, sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
args = sys.argv[1:]
video = args[0] if args and not args[0].startswith('--') else str(ROOT / 'out/agent-pocket-promo.mp4')
fps = float(args[args.index('--fps') + 1]) if '--fps' in args else 6.0
W, H = 480, 270
tl = json.loads((ROOT / 'data/sfx_events.json').read_text())['timeline']
raw = subprocess.run(['/opt/homebrew/bin/ffmpeg', '-loglevel', 'error', '-i', video, '-vf', f'fps={fps},scale={W}:{H}:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
fr = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3).astype(np.float32)
luma = fr[..., 0] * 0.2126 + fr[..., 1] * 0.7152 + fr[..., 2] * 0.0722
means = luma.mean(axis=(1, 2))
corner = np.concatenate([luma[:, :20, :30].reshape(len(luma), -1), luma[:, -20:, -30:].reshape(len(luma), -1)], 1).mean(1)
ts = (np.arange(len(means)) + 0.5) / fps
rows = []
for e in tl:
    m = (ts >= e['start']) & (ts < e['end'])
    if not m.any():
        continue
    v = means[m]
    rows.append((e['id'], float(np.median(v)), float(v.min()), float(v.max()), float(np.median(corner[m]))))
print(f"{'plate':10s} {'median':>7s} {'min':>7s} {'max':>7s} {'corner':>7s}")
for r in rows:
    print(f'{r[0]:10s} {r[1]:7.1f} {r[2]:7.1f} {r[3]:7.1f} {r[4]:7.1f}')
med = [r[1] for r in rows]
print(f'max/min of plate medians: {max(med) / max(1e-3, min(med)):.2f}x   (max {max(med):.1f}, min {min(med):.1f})')
