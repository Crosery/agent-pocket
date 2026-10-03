"""Contact sheet of every plate cut, tiled from the exported MP4 (one frame either side of each bar line).

uv run --with pillow python scripts/cuts_sheet.py [out/agent-pocket-promo.mp4] [out/cuts_sheet.png]
Cut times come from data/timeline.json (bars) resolved through data/audio.json (downbeats); bar -1 is t = 0.
"""
import json, os, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FFMPEG = '/opt/homebrew/bin/ffmpeg'
src = os.path.join(ROOT, sys.argv[1] if len(sys.argv) > 1 else 'out/agent-pocket-promo.mp4')
dst = os.path.join(ROOT, sys.argv[2] if len(sys.argv) > 2 else 'out/cuts_sheet.png')
audio = json.load(open(os.path.join(ROOT, 'data/audio.json')))
plates = json.load(open(os.path.join(ROOT, 'data/timeline.json')))['plates']
style = json.load(open(os.path.join(ROOT, 'data/style.json')))
bar = lambda k: 0.0 if k < 0 else audio['downbeats'][k]
cuts = [bar(p['from']) for p in plates[1:]]
times = [0.5] + [x for c in cuts for x in (c - 0.04, c + 0.05)] + [audio['duration'] - 1.1]

hexrgb = lambda h: tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
ink, gold = hexrgb(style['palette']['ink']), hexrgb(style['palette']['goldHi'])
font = ImageFont.truetype(os.path.join(ROOT, 'public/fonts/IBMPlexMono-Medium.ttf'), 16)
cols, pad, w = 4, 6, 480
tiles = []
with tempfile.TemporaryDirectory() as tmp:
    for i, t in enumerate(times):
        f = os.path.join(tmp, f'{i:02d}.png')
        subprocess.run([FFMPEG, '-v', 'error', '-y', '-ss', f'{t:.3f}', '-i', src, '-frames:v', '1', '-update', '1',
                        '-vf', f'scale={w}:-1:flags=area,format=rgb24', f], check=True)
        im = Image.open(f).convert('RGB')
        d = ImageDraw.Draw(im)
        label = f'{t:.2f}s'
        d.rectangle([6, 6, 14 + d.textlength(label, font=font), 30], fill=ink)
        d.text((10, 8), label, font=font, fill=gold)
        tiles.append(im)
h = tiles[0].size[1]
rows = (len(tiles) + cols - 1) // cols
sheet = Image.new('RGB', (cols * w + (cols + 1) * pad, rows * h + (rows + 1) * pad), ink)
for i, im in enumerate(tiles):
    sheet.paste(im, (pad + (i % cols) * (w + pad), pad + (i // cols) * (h + pad)))
sheet.save(dst)
print(dst, sheet.size, len(tiles), 'frames')
