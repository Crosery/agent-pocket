"""Battle UI pixel art (issue #32): 9-slice window frames and 14x14 icons -> public/assets/ui/battle/.

  python3 tools/battle_ui_art.py            # regenerate every PNG
  python3 tools/battle_ui_art.py --sheet P  # also write a magnified preview sheet to P

Frames are drawn pixel by pixel here (1 source pixel = 1 UI pixel; CSS border-image scales them by --u with
image-rendering: pixelated). Icon shapes live in assets_src/battle-ui/icons.json.
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "assets" / "ui" / "battle"
ICONS = ROOT / "assets_src" / "battle-ui" / "icons.json"

INK = (10, 13, 9, 255)
GOLD_HI = (242, 217, 142, 255)
GOLD_LT = (216, 189, 130, 255)
GOLD = (201, 168, 92, 255)
GOLD_MD = (179, 152, 102, 255)
GOLD_DK = (118, 99, 56, 255)
GOLD_DD = (92, 76, 40, 255)


def pix(img):
    """Pixel access for an image (never None for the RGBA images built here)."""
    p = img.load()
    assert p is not None
    return p


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def over(px, x, y, rgba):
    """Alpha-composites rgba onto the pixel (x, y)."""
    r, g, b, a = rgba
    dr, dg, db, da = px[x, y]
    ao = a / 255.0
    ad = da / 255.0
    out_a = ao + ad * (1 - ao)
    if out_a <= 0:
        return
    px[x, y] = (
        round((r * ao + dr * ad * (1 - ao)) / out_a),
        round((g * ao + dg * ad * (1 - ao)) / out_a),
        round((b * ao + db * ad * (1 - ao)) / out_a),
        round(out_a * 255),
    )


def window(size, accent, fill_top, fill_mid, fill_bot, slice_px):
    """A beveled gold window: ink outline with chamfered corners, 2px bevel, ink inner line (accent-tinted), glow, studs."""
    w = h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = pix(img)
    s = slice_px
    for y in range(h):
        if y < s:
            c = lerp(fill_top, fill_mid, y / max(1, s - 1))
        elif y >= h - s:
            c = lerp(fill_mid, fill_bot, (y - (h - s)) / max(1, s - 1))
        else:
            c = fill_mid
        for x in range(w):
            px[x, y] = (*c, 255)

    def ring(inset, top, left, bottom, right, corner=None):
        x0, y0, x1, y1 = inset, inset, w - 1 - inset, h - 1 - inset
        for x in range(x0, x1 + 1):
            px[x, y0] = top
            px[x, y1] = bottom
        for y in range(y0, y1 + 1):
            px[x0, y] = left
            px[x1, y] = right
        if corner:
            for cx, cy in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
                px[cx, cy] = corner

    ring(0, INK, INK, INK, INK)
    ring(1, GOLD_HI, GOLD_LT, GOLD_DK, GOLD_DK)
    ring(2, GOLD_LT, GOLD_MD, GOLD_DD, GOLD_DD)
    ring(3, accent, accent, accent, accent)
    # inner light: top / left glow, bottom / right shade
    for x in range(4, w - 4):
        over(px, x, 4, (255, 255, 255, 26))
        over(px, x, h - 5, (0, 0, 0, 90))
    for y in range(4, h - 4):
        over(px, 4, y, (255, 255, 255, 12))
        over(px, w - 5, y, (0, 0, 0, 60))
    # chamfered corners: knock out the pixels outside the notch
    for cx, cy, dx, dy in (
        (0, 0, 1, 1),
        (w - 1, 0, -1, 1),
        (0, h - 1, 1, -1),
        (w - 1, h - 1, -1, -1),
    ):
        px[cx, cy] = (0, 0, 0, 0)
        px[cx + dx, cy] = (0, 0, 0, 0)
        px[cx, cy + dy] = (0, 0, 0, 0)
        px[cx + dx, cy + dy] = INK
    # corner brackets and studs
    for ox, oy, dx, dy in (
        (4, 4, 1, 1),
        (w - 5, 4, -1, 1),
        (4, h - 5, 1, -1),
        (w - 5, h - 5, -1, -1),
    ):
        for i in range(5):
            over(px, ox + dx * i, oy, (*GOLD_HI[:3], 200 - i * 24))
            over(px, ox, oy + dy * i, (*GOLD_HI[:3], 200 - i * 24))
        px[ox + dx, oy + dy] = GOLD_HI
    return img


def slot(size=12):
    """A sunken well (bar trough, icon slot): dark fill, ink rim, inner shadow on top / left, faint light on bottom / right."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = pix(img)
    for y in range(size):
        for x in range(size):
            px[x, y] = (13, 17, 12, 255)
    for i in range(size):
        px[i, 0] = px[i, size - 1] = px[0, i] = px[size - 1, i] = INK
    for i in range(1, size - 1):
        over(px, i, 1, (0, 0, 0, 140))
        over(px, 1, i, (0, 0, 0, 100))
        over(px, i, size - 2, (255, 255, 255, 22))
        over(px, size - 2, i, (255, 255, 255, 14))
    return img


def plate(w=24, h=16, accent=GOLD):
    """A small name / label plate: ink rim, accent line, dark gradient fill."""
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = pix(img)
    for y in range(h):
        c = lerp((42, 48, 36), (20, 25, 19), y / (h - 1))
        for x in range(w):
            px[x, y] = (*c, 255)
    for x in range(w):
        px[x, 0] = px[x, h - 1] = INK
        px[x, 1] = accent
        over(px, x, 2, (255, 255, 255, 30))
    for y in range(h):
        px[0, y] = px[w - 1, y] = INK
    for cx, cy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        px[cx, cy] = (0, 0, 0, 0)
    return img


def draw_icon(shapes, palette):
    base = Image.new("RGBA", (12, 12), (0, 0, 0, 0))
    d = ImageDraw.Draw(base)
    for sh in shapes:
        col = tuple(int(palette[sh["c"]][i : i + 2], 16) for i in (1, 3, 5)) + (255,)
        if "rect" in sh:
            x0, y0, x1, y1 = sh["rect"]
            d.rectangle([x0, y0, x1, y1], fill=col)
        elif "line" in sh:
            d.line(sh["line"], fill=col, width=1)
        elif "poly" in sh:
            d.polygon([tuple(p) for p in sh["poly"]], fill=col)
        elif "disc" in sh:
            cx, cy, r = sh["disc"]
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
        elif "px" in sh:
            for x, y in sh["px"]:
                if 0 <= x < 12 and 0 <= y < 12:
                    base.putpixel((x, y), col)
    out = Image.new("RGBA", (14, 14), (0, 0, 0, 0))
    out.paste(base, (1, 1), base)
    src = pix(out.copy())
    px = pix(out)
    for y in range(14):
        for x in range(14):
            if src[x, y][3]:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < 14 and 0 <= ny < 14 and src[nx, ny][3]:
                    px[x, y] = INK
                    break
    return out


def nine(img, s, w, h):
    """Preview of a 9-slice image stretched to w x h."""
    iw, ih = img.size
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    parts = {
        "tl": (0, 0, s, s),
        "tr": (iw - s, 0, iw, s),
        "bl": (0, ih - s, s, ih),
        "br": (iw - s, ih - s, iw, ih),
        "t": (s, 0, iw - s, s),
        "b": (s, ih - s, iw - s, ih),
        "l": (0, s, s, ih - s),
        "r": (iw - s, s, iw, ih - s),
        "c": (s, s, iw - s, ih - s),
    }
    dst = {
        "tl": (0, 0),
        "tr": (w - s, 0),
        "bl": (0, h - s),
        "br": (w - s, h - s),
        "t": (s, 0, w - s, s),
        "b": (s, h - s, w - s, h),
        "l": (0, s, s, h - s),
        "r": (w - s, s, w, h - s),
        "c": (s, s, w - s, h - s),
    }
    for k, box in parts.items():
        piece = img.crop(box)
        d = dst[k]
        if len(d) == 2:
            out.paste(piece, d, piece)
        else:
            piece = piece.resize((d[2] - d[0], d[3] - d[1]), Image.Resampling.NEAREST)
            out.paste(piece, (d[0], d[1]), piece)
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    frames = {
        "frame-main": (window(28, INK, (46, 52, 40), (31, 37, 28), (20, 25, 19), 7), 7),
        "frame-foe": (
            window(28, (142, 42, 34, 255), (52, 40, 38), (36, 28, 27), (24, 18, 18), 7),
            7,
        ),
        "frame-own": (
            window(28, (47, 95, 168, 255), (40, 48, 46), (27, 35, 34), (18, 24, 24), 7),
            7,
        ),
        "frame-slot": (slot(12), 3),
        "frame-plate": (plate(24, 16, GOLD), 5),
        "frame-plate-red": (plate(24, 16, (226, 91, 74, 255)), 5),
    }
    for name, (img, _s) in frames.items():
        img.save(OUT / f"{name}.png")
    data = json.loads(ICONS.read_text())
    icons = {
        name: draw_icon(shapes, data["palette"])
        for name, shapes in data["icons"].items()
    }
    for name, img in icons.items():
        img.save(OUT / f"icon-{name}.png")
    if len(sys.argv) > 2 and sys.argv[1] == "--sheet":
        scale = 6
        bg = Image.new("RGBA", (1500, 760), (60, 70, 90, 255))
        x, y = 10, 10
        for name, (img, s) in frames.items():
            big = nine(
                img,
                s,
                140,
                70
                if name not in ("frame-slot", "frame-plate", "frame-plate-red")
                else 30,
            ).resize(
                (
                    420,
                    210
                    if name not in ("frame-slot", "frame-plate", "frame-plate-red")
                    else 90,
                ),
                Image.Resampling.NEAREST,
            )
            bg.paste(big, (x, y), big)
            x += 440
            if x > 1000:
                x, y = 10, y + 230
        x, y = 10, 480
        for name, img in icons.items():
            big = img.resize((14 * scale, 14 * scale), Image.Resampling.NEAREST)
            bg.paste(big, (x, y), big)
            x += 14 * scale + 8
            if x > 1400:
                x, y = 10, y + 14 * scale + 8
        bg.save(sys.argv[2])
    print(f"wrote {len(frames)} frames, {len(icons)} icons to {OUT}")


if __name__ == "__main__":
    main()
