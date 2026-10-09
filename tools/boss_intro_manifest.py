#!/usr/bin/env python3
"""Writes the intro cut-in manifest of content/boss-presentation.json (issue #32): for every boss that has a clip in
public/assets/boss-intro/ it records the file facts (probed) and where the clip came from.

  python3 tools/boss_intro_manifest.py <jobs.json>
jobs.json: {"<boss>": {"task": "<xiaochui-video task id>", "seed": <int>, "file": "<uploaded first-frame name>",
                        "rejected": [{"task": ..., "seed": ..., "reason": ...}]}}
Prompts come from assets_src/boss-intro/prompts.json, first frames from assets_src/boss-intro/frames/<boss>.png."""
import json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRES = ROOT / 'content/boss-presentation.json'
OUT = ROOT / 'public/assets/boss-intro'
PARAMS = {'flow': 'i2v', 'aspect': '16:9', 'megapixels': 1, 'profile': 'fidelity', 'durationSec': 4, 'steps': 8, 'width': 1376, 'height': 768, 'fps': 24, 'frames': 107}


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,duration',
                          '-of', 'json', str(path)], check=True, capture_output=True, text=True).stdout
    s = json.loads(out)['streams'][0]
    n, d = s['r_frame_rate'].split('/')
    return {'width': s['width'], 'height': s['height'], 'fps': round(int(n) / int(d), 3), 'durationSec': round(float(s['duration']), 3)}


def main():
    jobs = json.loads(Path(sys.argv[1]).read_text())
    prompts = json.loads((ROOT / 'assets_src/boss-intro/prompts.json').read_text())
    d = json.loads(PRES.read_text())
    for boss, entry in d['bosses'].items():
        mp4 = OUT / f'{boss}.mp4'
        job = jobs.get(boss)
        if not mp4.exists() or not job or not job.get('task'):
            entry.pop('intro', None)
            continue
        src = {
            'tool': 'xiaochui-video MCP create_video_task',
            'model': 'MiniMax H3 (Hailuo 3.0)',
            'taskId': job['task'],
            'seed': job['seed'],
            'prompt': prompts[boss],
            'params': PARAMS,
            'firstFrame': f'assets_src/boss-intro/frames/{boss}.png',
        }
        if job.get('rejected'):
            src['rejected'] = job['rejected']
        entry['intro'] = {'src': f'assets/boss-intro/{boss}.mp4', 'poster': f'assets/boss-intro/{boss}.jpg', 'bytes': mp4.stat().st_size,
                          **probe(mp4), 'source': src}
    PRES.write_text(json.dumps(d, ensure_ascii=False, indent=1))
    n = sum(1 for e in d['bosses'].values() if 'intro' in e)
    print(f'manifest: {n}/{len(d["bosses"])} bosses have a clip')


if __name__ == '__main__':
    main()
