#!/usr/bin/env python3
"""Encodes a raw H3 boss intro clip for the web (issue #32): 1280x720 h264, no audio, faststart, the smallest CRF
that fits intro.maxBytes, plus a JPEG poster. Settings: content/boss-presentation.json "encode" / "intro.maxBytes".

  python3 tools/boss_intro_encode.py <boss> <raw.mp4>      -> public/assets/boss-intro/<boss>.mp4 / .jpg
Prints one JSON line with the numbers the manifest records (bytes, width, height, fps, durationSec, crf)."""
import json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / 'content/boss-presentation.json').read_text())
E, MAX = CFG['encode'], CFG['intro']['maxBytes']


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,duration',
                          '-of', 'json', str(path)], check=True, capture_output=True, text=True).stdout
    s = json.loads(out)['streams'][0]
    n, d = s['r_frame_rate'].split('/')
    return {'width': s['width'], 'height': s['height'], 'fps': round(int(n) / int(d), 3), 'durationSec': round(float(s['duration']), 3)}


def main():
    boss, raw = sys.argv[1], Path(sys.argv[2])
    out_dir = ROOT / E['outDir']
    out_dir.mkdir(parents=True, exist_ok=True)
    mp4, jpg = out_dir / f'{boss}.mp4', out_dir / f'{boss}.jpg'
    scale = f"scale={E['width']}:{E['height']}:flags=lanczos"
    crf = E['crfStart']
    while True:
        run(['ffmpeg', '-v', 'error', '-y', '-i', str(raw), '-an', '-vf', scale, '-c:v', 'libx264', '-preset', E['preset'], '-crf', str(crf),
             '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', str(mp4)])
        if mp4.stat().st_size <= MAX or crf >= E['crfMax']:
            break
        crf += E['crfStep']
    info = probe(mp4)
    run(['ffmpeg', '-v', 'error', '-y', '-ss', str(round(info['durationSec'] * E['posterAt'], 3)), '-i', str(mp4), '-frames:v', '1',
         '-q:v', str(E['posterQuality']), str(jpg)])
    print(json.dumps({'boss': boss, 'bytes': mp4.stat().st_size, 'posterBytes': jpg.stat().st_size, 'crf': crf, **info}))
    if mp4.stat().st_size > MAX:
        sys.exit(f'{boss}: {mp4.stat().st_size} bytes exceeds the {MAX} cap even at crf {crf}')


if __name__ == '__main__':
    main()
