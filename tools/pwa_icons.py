#!/usr/bin/env python3
"""Home-screen icons for the web app: the title logo centred on the theme colour.

Which files and sizes exist comes from public/manifest.webmanifest (icons[]); maskable entries keep the logo inside the
central safe zone. The iOS touch icon is not in the manifest, so it is listed here. Needs ImageMagick (`magick`).
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / 'public/assets/ui/logo.png'
MANIFEST = ROOT / 'public/manifest.webmanifest'
APPLE = {'src': '/assets/pwa/apple-touch-icon.png', 'sizes': '180x180', 'purpose': 'any'}
# Logo width as a fraction of the icon edge. Maskable icons are cropped to a circle of 0.8 of the edge.
FILL = {'any': 0.86, 'maskable': 0.62}


def render(src: str, size: int, purpose: str, bg: str) -> None:
    out = ROOT / 'public' / src.lstrip('/')
    out.parent.mkdir(parents=True, exist_ok=True)
    w = round(size * FILL[purpose])
    subprocess.run(
        ['magick', '-size', f'{size}x{size}', f'xc:{bg}', '(', str(LOGO), '-filter', 'Lanczos', '-resize', f'{w}x', ')',
         '-gravity', 'center', '-composite', '-strip', '-colors', '96', f'PNG8:{out}'],
        check=True,
    )
    print(f'{out.relative_to(ROOT)}  {size}x{size}  {purpose}')


def main() -> int:
    manifest = json.loads(MANIFEST.read_text())
    for icon in [*manifest['icons'], APPLE]:
        size = int(icon['sizes'].split('x')[0])
        render(icon['src'], size, icon.get('purpose', 'any'), manifest['background_color'])
    return 0


if __name__ == '__main__':
    sys.exit(main())
