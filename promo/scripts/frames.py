# Tile frames of a rendered video at given song times (frame-exact: t is snapped to the 60 fps grid).
#   uv run --with pillow python scripts/frames.py out/agent-pocket-promo.mp4 --t 43.45,43.47 [--cols 4] [--w 640] --out /tmp/x.png
import subprocess, sys
from PIL import Image, ImageDraw
args = sys.argv[1:]
video = args[0]
opt = lambda k, d=None: args[args.index(f'--{k}') + 1] if f'--{k}' in args else d
times = [float(x) for x in opt('t').split(',')]
cols, W = int(opt('cols', '4')), int(opt('w', '640'))
H = W * 9 // 16
tiles = []
for t in times:
    n = round(t * 60)
    raw = subprocess.run(['/opt/homebrew/bin/ffmpeg', '-loglevel', 'error', '-i', video, '-vf', f'select=eq(n\\,{n}),scale={W}:{H}:flags=area', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
    im = Image.frombytes('RGB', (W, H), raw)
    ImageDraw.Draw(im).text((6, 6), f'{t:.3f} (#{n})', fill=(255, 255, 0))
    tiles.append(im)
rows = (len(tiles) + cols - 1) // cols
out = Image.new('RGB', (W * cols, H * rows))
for i, im in enumerate(tiles):
    out.paste(im, ((i % cols) * W, (i // cols) * H))
out.save(opt('out', '/tmp/frames.png'))
print(opt('out', '/tmp/frames.png'))
