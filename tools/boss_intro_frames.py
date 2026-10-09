#!/usr/bin/env python3
"""First frames for the boss intro clips (issue #32): the boss's own creature art, nearest-scaled, on a dark
arena backdrop tinted by its two types. Output: assets_src/boss-intro/frames/<boss>.png (16:9).

Layout numbers come from content/boss-presentation.json "frames"; boss -> species and types from content."""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
PRES = json.loads((ROOT / 'content/boss-presentation.json').read_text())
F = PRES['frames']


def rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def build(boss_id, species, types, colors):
    w, h = F['size']
    base = rgb(F['base'])
    c1 = mix(base, rgb(colors[types[0]]), F['tint'])
    c2 = mix(base, rgb(colors[types[-1]]), F['tint'])
    img = Image.new('RGB', (w, h), base)
    px = img.load()
    cx, cy = w * F['glowAt'][0], h * F['glowAt'][1]
    rmax = (w ** 2 + h ** 2) ** 0.5 * F['glowRadius']
    for y in range(h):
        for x in range(w):
            d = min(1.0, (((x - cx) ** 2 + ((y - cy) * 1.4) ** 2) ** 0.5) / rmax)
            glow = (1 - d) ** F['falloff']
            side = x / w
            tint = mix(c1, c2, side)
            px[x, y] = mix(base, tint, glow)
    # floor ellipse under the character
    ell = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(ell)
    fw, fh = F['floor']['w'] * w, F['floor']['h'] * h
    fx, fy = w * 0.5, h * F['floor']['y']
    d.ellipse([fx - fw / 2, fy - fh / 2, fx + fw / 2, fy + fh / 2], fill=round(255 * F['floor']['alpha']))
    ell = ell.filter(ImageFilter.GaussianBlur(F['floor']['blur']))
    img.paste(Image.new('RGB', (w, h), mix(c1, (255, 255, 255), 0.35)), (0, 0), ell)
    art = Image.open(ROOT / f'public/assets/creatures/{species}.png').convert('RGBA')
    bbox = art.getbbox()
    art = art.crop(bbox)
    scale = F['artHeightFrac'] * h / art.height
    scale = max(1, round(scale))
    art = art.resize((art.width * scale, art.height * scale), Image.NEAREST)
    x = round(w * 0.5 - art.width / 2)
    y = round(h * F['footY'] - art.height)
    img.paste(art, (x, y), art)
    out = ROOT / 'assets_src/boss-intro/frames' / f'{boss_id}.png'
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    return out, scale


def main():
    bosses = PRES['bosses']
    species = {s['id']: s for s in json.loads((ROOT / 'content/species.json').read_text())}
    colors = {t['id']: t['color'] for t in json.loads((ROOT / 'content/types.json').read_text())['types']}
    only = set(sys.argv[1:])
    for bid, b in bosses.items():
        if only and bid not in only:
            continue
        sid = b['species']
        out, scale = build(bid, sid, species[sid]['types'], colors)
        print(bid, sid, f'x{scale}', out.relative_to(ROOT))


if __name__ == '__main__':
    main()
