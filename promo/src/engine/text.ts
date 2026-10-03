// Typography. Two faces (data/style.json): Fusion Pixel (the game's pixel face, Chinese display + labels) and
// IBM Plex Mono (small English / metadata). Pixel text is rasterised at its 12-px design size, alpha is
// binarised, and it is drawn scaled by whole numbers with smoothing off: every glyph pixel is an exact square.
import { D, rgba } from './data';

export async function loadFonts() {
  const f = D.style.fonts;
  const faces = [
    new FontFace(f.pixel.family, `url(${f.pixel.url})`),
    new FontFace(f.mono.family, `url(${f.mono.url})`, { weight: '400' }),
    new FontFace(f.mono.family, `url(${f.mono.urlMedium})`, { weight: '500' }),
  ];
  await Promise.all(faces.map(async (ff) => { await ff.load(); document.fonts.add(ff); }));
}

export interface PixelGlyphs { canvas: HTMLCanvasElement; w: number; h: number }
const cache = new Map<string, PixelGlyphs>();

const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/;
type Item = { k: 'text'; s: string; w: number } | { k: 'dot'; w: number } | { k: 'space'; w: number };

/**
 * Spacing in the pixel face (data/style.json type.pixelSpacing): a space next to a CJK character is a hair
 * space of `zhGapPx` design px instead of the font's wide space, and '·' is drawn as a `dotPx` square on the
 * CJK body's centre line with exactly `dotGapPx` on either side (spaces around it are absorbed).
 */
function layout(m: CanvasRenderingContext2D, s: string): { items: Item[]; w: number } {
  const S = D.style.type.pixelSpacing;
  const raw = s.split(/( |·)/).filter((x) => x !== '');
  const items: Item[] = raw.map((x) => (x === ' ' ? { k: 'space', w: 0 } : x === '·' ? { k: 'dot', w: S.dotPx } : { k: 'text', s: x, w: m.measureText(x).width }));
  const sp = m.measureText(' ').width;
  items.forEach((it, i) => {
    if (it.k !== 'space') return;
    const prev = items.slice(0, i).reverse().find((x) => x.k !== 'space'), next = items.slice(i + 1).find((x) => x.k !== 'space');
    if (prev?.k === 'dot' || next?.k === 'dot') { it.w = 0; return; }
    const a = prev?.k === 'text' ? prev.s.slice(-1) : '', b = next?.k === 'text' ? next.s[0]! : '';
    it.w = CJK.test(a) || CJK.test(b) ? S.zhGapPx : sp;
  });
  // the dot's own side gaps, measured from the neighbours' INK (not their advance boxes): a Latin glyph's side
  // bearing would otherwise push the dot toward the CJK side
  const out: Item[] = [];
  items.forEach((it, i) => {
    if (it.k !== 'dot') { out.push(it); return; }
    const prev = items.slice(0, i).reverse().find((x) => x.k === 'text') as { s: string } | undefined;
    const next = items.slice(i + 1).find((x) => x.k === 'text') as { s: string } | undefined;
    const br = prev ? inkBearings(m, [...prev.s].slice(-1).join('')).r : 0;
    const bl = next ? inkBearings(m, [...next.s][0]!).l : 0;
    out.push({ k: 'space', w: S.dotGapPx - br }, it, { k: 'space', w: S.dotGapPx - bl });
  });
  return { items: out, w: out.reduce((a, x) => a + x.w, 0) };
}

/** Left/right ink bearings (design px) of one glyph in the pixel face: empty columns inside its advance. */
const bearings = new Map<string, { l: number; r: number }>();
function inkBearings(m: CanvasRenderingContext2D, ch: string) {
  let b = bearings.get(ch);
  if (b) return b;
  const P = D.style.fonts.pixel, adv = Math.round(m.measureText(ch).width);
  const c = document.createElement('canvas');
  c.width = adv + 8; c.height = P.ascentPx + 4;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.font = m.font; x.textBaseline = 'alphabetic'; x.fillStyle = '#fff';
  x.fillText(ch, 4, P.ascentPx);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, x1 = -1;
  for (let yy = 0; yy < c.height; yy++) for (let xx = 0; xx < c.width; xx++) if (d[(yy * c.width + xx) * 4 + 3]! >= 110) { x0 = Math.min(x0, xx); x1 = Math.max(x1, xx); }
  b = x1 < 0 ? { l: 0, r: 0 } : { l: x0 - 4, r: adv - (x1 - 4 + 1) };
  bearings.set(ch, b);
  return b;
}

/** The CJK glyph body (design px rows, from the em top used by drawPixel): where cursors and dots sit. */
let body: { top: number; bottom: number } | null = null;
export function pixelBody() {
  if (body) return body;
  const P = D.style.fonts.pixel;
  const c = document.createElement('canvas');
  c.width = 32; c.height = P.ascentPx + 3;
  const x = c.getContext('2d')!;
  x.font = `${P.designPx}px "${P.family}"`;
  x.textBaseline = 'alphabetic'; x.fillStyle = '#fff';
  x.fillText(D.style.type.pixelSpacing.bodyRef, 0, P.ascentPx);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let top = c.height, bottom = 0;
  for (let y = 0; y < c.height; y++) for (let i = 0; i < c.width; i++) if (d[(y * c.width + i) * 4 + 3]! >= 110) { top = Math.min(top, y); bottom = Math.max(bottom, y + 1); }
  body = { top, bottom };
  return body;
}

/** Text rasterised at design size (1 canvas px = 1 art pixel), binary alpha, in one colour. */
export function pixelText(s: string, color = 'bone'): PixelGlyphs {
  const key = `${color}|${s}`;
  let g = cache.get(key);
  if (g) return g;
  const P = D.style.fonts.pixel;
  const m = document.createElement('canvas').getContext('2d')!;
  m.font = `${P.designPx}px "${P.family}"`;
  const L = layout(m, s);
  const w = Math.max(1, Math.ceil(L.w));
  const h = P.ascentPx + 3;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d')!;
  x.font = m.font;
  x.textBaseline = 'alphabetic';
  x.fillStyle = '#fff';
  const B = pixelBody(), dp = D.style.type.pixelSpacing.dotPx;
  let cx = 0;
  for (const it of L.items) {
    if (it.k === 'text') x.fillText(it.s, Math.round(cx), P.ascentPx);
    else if (it.k === 'dot') x.fillRect(Math.round(cx), Math.round((B.top + B.bottom - dp) / 2), dp, dp);
    cx += it.w;
  }
  const img = x.getImageData(0, 0, w, h);
  const hx = color.startsWith('#') ? color : D.style.palette[color]!;
  const n = parseInt(hx.slice(1), 16);
  const [r, gg, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  for (let i = 0; i < img.data.length; i += 4) {
    const on = img.data[i + 3]! >= 110;
    img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = on ? 255 : 0;
  }
  x.putImageData(img, 0, 0);
  g = { canvas: c, w, h };
  cache.set(key, g);
  return g;
}

export type Align = 'left' | 'center' | 'right';

/** Draw pixel text at integer scale; (x, y) is the anchor of the top of the em box. Returns the drawn box. */
export function drawPixel(c: CanvasRenderingContext2D, s: string, x: number, y: number, scale: number, o: { color?: string; align?: Align; alpha?: number; outline?: string; outlineAlpha?: number } = {}) {
  const g = pixelText(s, o.color ?? 'bone');
  const w = g.w * scale;
  const x0 = Math.round(o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x);
  // keep glyph pixels on the scaled pixel grid
  const xs = Math.round(x0 / scale) * scale, ys = Math.round(y / scale) * scale;
  c.save();
  c.imageSmoothingEnabled = false;
  c.globalAlpha *= o.alpha ?? 1;
  // a one-art-pixel outline keeps light text legible over busy backdrops
  if (o.outline) {
    // drawn once into a mask (union of the 8 offsets) so a translucent outline does not stack
    const mk = outlineMask(s, o.outline);
    c.save(); c.globalAlpha *= o.outlineAlpha ?? 1;
    c.drawImage(mk, xs - scale, ys - scale, mk.width * scale, mk.height * scale);
    c.restore();
  }
  c.drawImage(g.canvas, xs, ys, w, g.h * scale);
  c.restore();
  return { x: xs, y: ys, w, h: g.h * scale };
}

/** Ink bounds (design px, within the pixelText canvas) of a string in the pixel face. */
const inks = new Map<string, { top: number; bottom: number; left: number; right: number }>();
export function pixelInk(s: string) {
  let r = inks.get(s);
  if (r) return r;
  const g = pixelText(s);
  const d = g.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, g.w, g.h).data;
  let top = g.h, bottom = 0, left = g.w, right = 0;
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (d[(y * g.w + x) * 4 + 3]! > 0) { top = Math.min(top, y); bottom = Math.max(bottom, y + 1); left = Math.min(left, x); right = Math.max(right, x + 1); }
  r = { top, bottom, left, right };
  inks.set(s, r);
  return r;
}

const masks = new Map<string, HTMLCanvasElement>();
function outlineMask(s: string, color: string) {
  const key = `${color}|${s}`;
  let mk = masks.get(key);
  if (mk) return mk;
  const og = pixelText(s, color);
  mk = document.createElement('canvas');
  mk.width = og.w + 2; mk.height = og.h + 2;
  const mx = mk.getContext('2d')!;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) mx.drawImage(og.canvas, 1 + dx, 1 + dy);
  masks.set(key, mk);
  return mk;
}

export const pixelWidth = (s: string, scale: number) => pixelText(s).w * scale;
/** Width (design px) of the first `n` characters' layout — where a typing cursor sits after them. */
export const pixelPrefixWidth = (s: string, n: number, scale: number) => (n <= 0 ? 0 : pixelText([...s].slice(0, n).join('')).w * scale);

/** IBM Plex Mono text (antialiased vector) with tracking. y is the alphabetic baseline. */
export function drawMono(c: CanvasRenderingContext2D, s: string, x: number, y: number, px: number, o: { color?: string; align?: Align; alpha?: number; tracking?: number; weight?: number; shadow?: number } = {}) {
  c.save();
  // a soft ink shadow keeps small English legible over a lit picture plate
  if (o.shadow) { c.shadowColor = rgba('ink', o.shadow * (o.alpha ?? 1)); c.shadowBlur = px * 0.35; c.shadowOffsetY = Math.max(1, Math.round(px / 15)); }
  c.font = `${o.weight ?? 400} ${px}px "${D.style.fonts.mono.family}"`;
  (c as any).letterSpacing = `${(o.tracking ?? D.style.type.enTracking) * px}px`;
  c.textAlign = o.align ?? 'left';
  c.textBaseline = 'alphabetic';
  c.fillStyle = rgba(o.color ?? 'ash', o.alpha ?? 1);
  // letterSpacing adds trailing space after the last glyph: compensate when centring/right-aligning
  const tr = (o.tracking ?? D.style.type.enTracking) * px;
  const dx = o.align === 'center' ? tr / 2 : o.align === 'right' ? tr : 0;
  c.fillText(s, x + dx, y);
  c.restore();
}

/** Width of IBM Plex Mono text with tracking (no trailing tracking). */
export function monoWidth(c: CanvasRenderingContext2D, s: string, px: number, tracking = D.style.type.enTracking, weight = 400) {
  c.save();
  c.font = `${weight} ${px}px "${D.style.fonts.mono.family}"`;
  (c as any).letterSpacing = `${tracking * px}px`;
  const w = c.measureText(s).width - tracking * px;
  c.restore();
  return w;
}

/** Standard copy block (Chinese pixel line + English mono line), centred on x. Characters beyond `chars` are hidden (typing). */
export function drawCopy(c: CanvasRenderingContext2D, zh: string, en: string, x: number, y: number, o: { alpha?: number; chars?: number; enChars?: number; zhScale?: number; enPx?: number; zhColor?: string; enColor?: string; outline?: boolean } = {}) {
  const T = D.style.type, L = D.style.layout;
  const sc = o.zhScale ?? T.zhScale, ep = o.enPx ?? T.enPx;
  const full = pixelWidth(zh, sc);
  const shown = o.chars === undefined ? zh : zh.slice(0, Math.max(0, Math.floor(o.chars)));
  // over a picture plate: a one-art-pixel ink outline (zh) and a soft ink shadow (en), data/style.json type.overPicture
  const OP = T.overPicture;
  if (shown) drawPixel(c, shown, x - full / 2, y, sc, { color: o.zhColor ?? 'bone', alpha: o.alpha, ...(o.outline ? { outline: OP.outline, outlineAlpha: OP.outlineAlpha } : {}) });
  const enShown = o.enChars === undefined ? en : en.slice(0, Math.max(0, Math.floor(o.enChars)));
  if (enShown && en) {
    c.save();
    c.font = `400 ${ep}px "${D.style.fonts.mono.family}"`;
    (c as any).letterSpacing = `${T.enTracking * ep}px`;
    const fw = c.measureText(en).width - T.enTracking * ep;
    c.restore();
    drawMono(c, enShown, x - fw / 2, y + (D.style.fonts.pixel.ascentPx + 3) * sc + L.copyEnGap + ep * 0.8, ep, { color: o.enColor ?? 'ash', alpha: o.alpha, shadow: o.outline ? OP.enShadow : 0 });
  }
  return full;
}
