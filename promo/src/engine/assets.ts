// Game assets copied into public/game/ by scripts/sync-assets.ts. Creature sprites are packed into one atlas
// (one draw call for 190 sprites); everything pixel-art is uploaded premultiplied with LINEAR filtering and
// sampled through pixelUV() (see glsl.ts), which is crisp at any scale.
import * as THREE from 'three';
import { D } from './data';

export const CELL = 128, PAD = 4, STRIDE = CELL + 2 * PAD;

export interface Box { x0: number; y0: number; x1: number; y1: number }

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error(`image failed: ${url}`));
    im.src = url;
  });
}

export function pixelTexture(src: HTMLCanvasElement | HTMLImageElement) {
  const t = new THREE.Texture(src as any);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.premultiplyAlpha = true;
  t.flipY = false;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

class Atlas {
  canvas = document.createElement('canvas');
  texture!: THREE.Texture;
  cols = 15;
  index = new Map<string, number>();
  boxes = new Map<string, Box>();
  pixels = new Map<string, ImageData>();
  tones = new Map<string, [number, number, number]>();
  async build(ids: string[]) {
    const rows = Math.ceil(ids.length / this.cols);
    this.canvas.width = this.cols * STRIDE;
    this.canvas.height = rows * STRIDE;
    const c = this.canvas.getContext('2d', { willReadFrequently: true })!;
    const imgs = await Promise.all(ids.map((id) => loadImage(`game/creatures/${id}.png`).catch(() => null)));
    ids.forEach((id, i) => {
      const im = imgs[i];
      if (!im) return;
      const x = (i % this.cols) * STRIDE + PAD, y = Math.floor(i / this.cols) * STRIDE + PAD;
      c.drawImage(im, x, y, CELL, CELL);
      this.index.set(id, i);
      const d = c.getImageData(x, y, CELL, CELL);
      this.pixels.set(id, d);
      let x0 = CELL, y0 = CELL, x1 = 0, y1 = 0;
      for (let py = 0; py < CELL; py++) for (let px = 0; px < CELL; px++) if (d.data[(py * CELL + px) * 4 + 3]! > 24) {
        x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px + 1); y1 = Math.max(y1, py + 1);
      }
      this.boxes.set(id, { x0, y0, x1, y1 });
      // the sprite's tone: mean colour of its most saturated opaque pixels (sRGB 0..1)
      const cols: [number, number, number, number][] = [];
      for (let k = 0; k < d.data.length; k += 4) if (d.data[k + 3]! > 200) {
        const r = d.data[k]! / 255, g = d.data[k + 1]! / 255, b = d.data[k + 2]! / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        cols.push([r, g, b, mx > 0 ? (mx - mn) / mx * mx : 0]);
      }
      cols.sort((a, b) => b[3] - a[3]);
      const top = cols.slice(0, Math.max(1, Math.floor(cols.length * 0.3)));
      const m = top.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]] as [number, number, number], [0, 0, 0] as [number, number, number]);
      this.tones.set(id, [m[0] / top.length, m[1] / top.length, m[2] / top.length]);
    });
    this.texture = pixelTexture(this.canvas);
  }
  has(id: string) { return this.index.has(id); }
  /** Pixel rect of a sprite cell inside the atlas (x, y, w, h). */
  cell(id: string): [number, number, number, number] {
    const i = this.index.get(id);
    if (i === undefined) throw new Error(`no sprite for ${id}`);
    return [(i % this.cols) * STRIDE + PAD, Math.floor(i / this.cols) * STRIDE + PAD, CELL, CELL];
  }
  /** Linear-light tone of a sprite (for glows that take the creature's colour). */
  tone(id: string): [number, number, number] {
    const c = this.tones.get(id) ?? [0.5, 0.5, 0.5];
    return c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  }
  /** Opaque bounding box of a sprite within its 128x128 cell. */
  box(id: string): Box { return this.boxes.get(id) ?? { x0: 0, y0: 0, x1: CELL, y1: CELL }; }
}

export const ATLAS = new Atlas();
export const TEX = new Map<string, THREE.Texture>();
export const IMG = new Map<string, HTMLImageElement | HTMLCanvasElement>();

/**
 * Scale2x (EPX) with a colour tolerance: doubles a pixel-art image without blur, rounding diagonal steps
 * where neighbours agree. The game's 64-px character sheets then carry the same pixel density as its
 * 128-px creature sprites, so trainer and partner read as one art style when they stand side by side.
 */
function scale2x(src: HTMLImageElement, tol: number) {
  const w = src.width, h = src.height;
  const a = document.createElement('canvas'); a.width = w; a.height = h;
  const ax = a.getContext('2d', { willReadFrequently: true })!; ax.drawImage(src, 0, 0);
  const d = ax.getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas'); out.width = w * 2; out.height = h * 2;
  const ox = out.getContext('2d')!;
  const od = ox.createImageData(w * 2, h * 2);
  const at = (x: number, y: number) => (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
  const eq = (i: number, j: number) => {
    const ta = d[i + 3]! < 128, tb = d[j + 3]! < 128;
    if (ta || tb) return ta && tb;
    return Math.abs(d[i]! - d[j]!) + Math.abs(d[i + 1]! - d[j + 1]!) + Math.abs(d[i + 2]! - d[j + 2]!) <= tol;
  };
  const put = (x: number, y: number, k: number) => { const o = (y * w * 2 + x) * 4; for (let c = 0; c < 4; c++) od.data[o + c] = d[k + c]!; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const P = at(x, y), A = at(x, y - 1), B = at(x + 1, y), C = at(x - 1, y), Dn = at(x, y + 1);
    put(2 * x, 2 * y, eq(C, A) && !eq(C, Dn) && !eq(A, B) ? A : P);
    put(2 * x + 1, 2 * y, eq(A, B) && !eq(A, C) && !eq(B, Dn) ? B : P);
    put(2 * x, 2 * y + 1, eq(Dn, C) && !eq(Dn, B) && !eq(C, A) ? C : P);
    put(2 * x + 1, 2 * y + 1, eq(B, Dn) && !eq(B, A) && !eq(Dn, C) ? Dn : P);
  }
  ox.putImageData(od, 0, 0);
  return out;
}

export async function loadAssets() {
  await ATLAS.build(D.game.species.map((s) => s.id));
  const chars = D.world.characters as { sheets: string[]; scale2x: boolean; tol: number };
  const images: [string, string][] = [
    ['logo', 'game/ui/logo.png'],
    ...(D.style.title?.keyArt?.file ? [['keyart', D.style.title.keyArt.file] as [string, string]] : []),
    ...(D.cast.items as string[]).map((k) => [`item:${k}`, `game/items/${k}.png`] as [string, string]),
    ...(D.cast.tufts as string[]).map((k) => [`tuft:${k}`, `game/terrain/${k}.png`] as [string, string]),
    ...chars.sheets.map((k) => [`char:${k}`, `game/characters/${k}.png`] as [string, string]),
  ];
  const bg = D.cast.battle?.bg;
  if (bg) images.push([`ui:${bg}`, `game/ui/${bg}.png`]);
  await Promise.all(images.map(async ([k, url]) => {
    const im = await loadImage(url);
    const src = k.startsWith('char:') && chars.scale2x ? scale2x(im, chars.tol) : im;
    IMG.set(k, src);
    TEX.set(k, pixelTexture(src));
  }));
}

/** A terrain tile texture (32 px), nearest-sampled and repeating — the HD-2D ground look. */
const terrainCache = new Map<string, Promise<THREE.Texture>>();
export function terrainTexture(key: string) {
  let p = terrainCache.get(key);
  if (!p) {
    p = loadImage(`game/terrain/${key}.png`).then((im) => {
      const t = new THREE.Texture(im);
      t.colorSpace = THREE.SRGBColorSpace;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.needsUpdate = true;
      return t;
    });
    terrainCache.set(key, p);
  }
  return p;
}
