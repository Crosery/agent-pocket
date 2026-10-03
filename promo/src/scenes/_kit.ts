// Shared 2D toolkit for the plates: the backdrop pass, creature placement (feet-anchored, integer scales,
// hop/squash), floor shadows, sparkles and the cursor. Read-only conventions live in docs/ENGINE.md.
import * as THREE from 'three';
import { FSPass } from '../engine/gl';
import { ATLAS, CELL } from '../engine/assets';
import { D, displayName, lin, species, rarity } from '../engine/data';
import { SpriteBatch, softTex, type GlowBatch, type RectBatch } from '../engine/sprites';
import { clamp, ease, hash, lerp } from '../engine/util';
import type { Scene, SfxEvent } from '../engine/scene';
import { drawMono, drawPixel } from '../engine/text';

/** Backdrop: a quiet ink→navy radial field, an optional coloured glow and optional soft rays. */
export class Backdrop {
  pass = new FSPass(/* glsl */ `
    uniform vec3 inner, outer, glowCol, rayCol, haloCol;
    uniform vec2 glowPos; uniform float glowR, glowI, rayI, rayN, rayRot, rayLen, t, haloR, haloI;
    void main() {
      vec2 px = vUv * vec2(1920.0, 1080.0); px.y = 1080.0 - px.y;
      vec2 d = (px - vec2(960.0, 520.0)) / 1080.0;
      vec3 col = mix(inner, outer, smoothstep(0.0, 1.05, length(d * vec2(0.9, 1.15))));
      float g = exp(-pow(length(px - glowPos) / glowR, 2.0));
      col += glowCol * g * glowI;
      // the outer falloff of any light is a navy-tinted blue (palette 'halo'), never a dim wash of the light's own colour
      col += haloCol * exp(-pow(length(px - glowPos) / haloR, 2.0)) * haloI;
      if (rayI > 0.0) {
        vec2 q = px - glowPos;
        float a = atan(q.y, q.x) + rayRot;
        float r = length(q);
        float rays = pow(0.5 + 0.5 * cos(a * rayN), 6.0) * 0.7 + pow(0.5 + 0.5 * cos(a * rayN * 0.5 + 1.3), 10.0) * 0.5;
        col += rayCol * rays * rayI * smoothstep(rayLen, 80.0, r) * smoothstep(0.0, 160.0, r);
      }
      // ordered 1/255 dither against banding in the dark gradient
      col += (hash12(floor(FRAG_PX)) - 0.5) / 255.0 * 0.6;
      fragColor = vec4(col, 1.0);
    }`, {
    inner: { value: new THREE.Vector3() }, outer: { value: new THREE.Vector3() }, glowCol: { value: new THREE.Vector3() },
    rayCol: { value: new THREE.Vector3() }, glowPos: { value: new THREE.Vector2(960, 450) }, glowR: { value: 420 },
    glowI: { value: 0 }, rayI: { value: 0 }, rayN: { value: 12 }, rayRot: { value: 0 }, rayLen: { value: 1400 }, t: { value: 0 },
    haloCol: { value: new THREE.Vector3() }, haloR: { value: 520 }, haloI: { value: 0 },
  });
  constructor() { this.set({}); }
  set(o: { inner?: string; outer?: string; glow?: [number, number, number]; glowI?: number; glowR?: number; glowPos?: [number, number]; rayI?: number; rayCol?: [number, number, number]; rayN?: number; rayRot?: number; rayLen?: number; haloI?: number; haloR?: number }) {
    const u = this.pass.u;
    (u.inner!.value as THREE.Vector3).set(...lin(o.inner ?? 'navy'));
    (u.outer!.value as THREE.Vector3).set(...lin(o.outer ?? 'ink'));
    (u.glowCol!.value as THREE.Vector3).set(...(o.glow ?? [0, 0, 0]));
    u.glowI!.value = o.glowI ?? 0;
    u.glowR!.value = o.glowR ?? 420;
    (u.glowPos!.value as THREE.Vector2).set(...(o.glowPos ?? [960, D.style.layout.heroY]));
    u.rayI!.value = o.rayI ?? 0;
    (u.rayCol!.value as THREE.Vector3).set(...(o.rayCol ?? [0, 0, 0]));
    u.rayN!.value = o.rayN ?? 12;
    u.rayRot!.value = o.rayRot ?? 0;
    u.rayLen!.value = o.rayLen ?? 1400;
    (u.haloCol!.value as THREE.Vector3).set(...lin('halo'));
    u.haloI!.value = o.haloI ?? 0;
    u.haloR!.value = o.haloR ?? 520;
    return this;
  }
  render(r: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget) { this.pass.render(r, out); }
}

/** Where a creature sits: feet (bottom of its opaque box) at (x, groundY), horizontally centred on its box. */
export function creatureRect(id: string, x: number, groundY: number, scale: number, o: { hop?: number; squash?: number } = {}) {
  const b = ATLAS.box(id);
  const sq = o.squash ?? 0; // >0 squashes (wider, shorter), <0 stretches
  const sx = scale * (1 + sq), sy = scale * (1 - sq);
  const cx = (b.x0 + b.x1) / 2;
  const w = CELL * sx, h = CELL * sy;
  // integer scale & no squash: snap to the art-pixel grid so every pixel is an exact square
  let left = x - cx * sx, top = groundY - b.y1 * sy - (o.hop ?? 0);
  if (!sq && Number.isInteger(scale)) { left = Math.round(left); top = Math.round(top); }
  return { x: left, y: top, w, h };
}

export function drawCreature(sb: SpriteBatch, id: string, x: number, groundY: number, scale: number, o: { hop?: number; squash?: number; alpha?: number; flash?: number; flip?: boolean; tint?: [number, number, number] } = {}) {
  const r = creatureRect(id, x, groundY, scale, o);
  sb.add({ ...r, uv: ATLAS.cell(id), alpha: o.alpha, flash: o.flash, flip: o.flip, tint: o.tint });
  return r;
}

/** Visual height (px) of a creature at a scale, and its box centre y relative to the ground line. */
export function creatureHeight(id: string, scale: number) { const b = ATLAS.box(id); return (b.y1 - b.y0) * scale; }

/** Landing hop: drop from `h` px with a small squash on contact. `u` = beats since the cut, `dur` beats. */
export function landing(u: number, dur = 0.35, h = D.style.motion.hopPx) {
  if (u < 0) return { hop: h, squash: 0, alpha: 0 };
  const k = clamp(u / dur);
  const hop = h * (1 - ease.outCubic(k));
  const after = u - dur;
  const squash = after < 0 ? -0.04 * (1 - k) : D.style.motion.squash * Math.exp(-after * 9) * Math.cos(after * 22);
  return { hop, squash: Math.abs(squash) < 0.004 ? 0 : squash, alpha: clamp(u / 0.08) };
}

/** Soft dark ellipses (floor shadows): a normal-blended soft sprite tinted black. */
export class ShadowBatch extends SpriteBatch {
  constructor(capacity = 256) { super(softTex(), 256, 256, capacity, { blend: 'normal', pixel: false }); }
  shadow(x: number, groundY: number, w: number, alpha = 0.6, flat = 0.2) {
    return this.add({ x: x - w / 2, y: groundY - w * flat / 2, w, h: w * flat, uv: [0, 0, 256, 256], tint: [0, 0, 0], alpha });
  }
}

/** Rarity / type colour as linear rgb. */
export const rarityLin = (tier: string) => lin(rarity(tier).color);
export const typeLin = (id: string) => lin(D.game.types.find((t) => t.id === species(id).types[0])!.color);

/** Deterministic sparkle field: four-point pixel stars twinkling around (cx, cy). */
export interface Rect { x0: number; y0: number; x1: number; y1: number }
/** A rect grown by `m` px on every side. */
export const grow = (r: Rect, m: number): Rect => ({ x0: r.x0 - m, y0: r.y0 - m, x1: r.x1 + m, y1: r.y1 + m });
const inside = (x: number, y: number, r: Rect) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

/** Screen rect of a creature's opaque pixels as drawn by drawCreature (no hop/squash). */
export function creatureBox(id: string, x: number, groundY: number, scale: number): Rect {
  const r = creatureRect(id, x, groundY, scale), b = ATLAS.box(id);
  return { x0: r.x + b.x0 * scale, y0: r.y + b.y0 * scale, x1: r.x + b.x1 * scale, y1: r.y + b.y1 * scale };
}

export function sparkles(rb: RectBatch, gb: GlowBatch | null, t: number, cx: number, cy: number, n: number, radius: number, color: [number, number, number], o: { seed?: number; px?: number; intensity?: number; rise?: number; avoid?: Rect[] } = {}) {
  const px = o.px ?? 4, I = o.intensity ?? 2.2, seed = o.seed ?? 1;
  // candidates come from a larger pool; the kept set depends only on the base positions (not on time),
  // so sparkles never pop in to replace ones that fade: `n` stars outside the keep-out rects (subjects, type)
  for (let i = 0, kept = 0; i < n * 8 && kept < n; i++) {
    const a = hash(i, seed) * Math.PI * 2, rr = Math.sqrt(hash(i, seed + 1)) * radius;
    const bx = cx + Math.cos(a) * rr, by = cy + Math.sin(a) * rr * 0.75;
    if (o.avoid?.some((r) => inside(bx, by, r) || inside(bx, by - (o.rise ?? 0), r))) continue;
    kept++;
    const period = 0.9 + hash(i, seed + 2) * 1.2, ph = hash(i, seed + 3);
    const life = ((t / period + ph) % 1 + 1) % 1;
    const tw = Math.sin(life * Math.PI);
    if (tw < 0.05) continue;
    const x = bx, y = by - (o.rise ?? 0) * life;
    const s = Math.max(1, Math.round(tw * (1 + hash(i, seed + 4) * 2))) * px;
    const X = Math.round(x / px) * px, Y = Math.round(y / px) * px;
    const c: [number, number, number] = [color[0] * I, color[1] * I, color[2] * I];
    rb.rectPx(X - px / 2, Y - s - px / 2, px, s * 2 + px, c, tw); // vertical arm
    rb.rectPx(X - s - px / 2, Y - px / 2, s * 2 + px, px, c, tw); // horizontal arm
    gb?.glow(X, Y, s * 3, color, 0.35 * tw);
  }
}

/**
 * A coloured light over the navy field may tint it but never turn it warm: the intensity is capped so the field
 * under the glow's peak keeps B > R (a dim warm wash over navy reads brown/olive). Cool colours pass unchanged.
 */
export function safeGlowI(col: [number, number, number], I: number) {
  const n = lin('navy'), dr = col[0] - col[2];
  return dr <= 0 ? I : Math.min(I, ((n[2] - n[0]) * 0.85) / dr);
}

/** Backdrop settings for a light behind a subject: its own hue (capped, see safeGlowI) plus the blue halo (data/style.json halo.<plate>). */
export function haloLight(tone: [number, number, number], plate: string, pos?: [number, number]) {
  const H = D.style.halo[plate] as { I: number; r: number; haloI: number; haloR: number };
  return { glow: tone, glowI: safeGlowI(tone, H.I), glowR: H.r, haloI: H.haloI, haloR: H.haloR, ...(pos ? { glowPos: pos } : {}) };
}

/** The film's spark: a gold text cursor. At the default intensity it shows goldHi itself (no bloom to white). */
export function cursor(rb: RectBatch, x: number, y: number, scale: number, alpha: number, glow: number = D.style.cursor.I, height?: number) {
  const g = lin('goldHi');
  const w = 6 * scale, h = height ?? 12 * scale;
  rb.rectPx(Math.round(x), Math.round(y), w, h, [g[0] * glow, g[1] * glow, g[2] * glow], alpha);
  return { w, h };
}

export { lerp };

/** One typing tick per visible character (spaces are silent): `start` beat, `rate` beats per character. */
export function typingSfx(sc: Scene, chars: string[], start: number, rate: number, id = 'type'): SfxEvent[] {
  return chars.flatMap((ch, i) => (ch === ' ' ? [] : [{ t: sc.beatT(start + i * rate), id, pitch: i % 2 ? 1 : 1.12246 }]));
}

/** Name card under a creature: dex number (mono, gold), name (pixel), maker (mono, ash). Centred on x. */
export function drawLabel(c: CanvasRenderingContext2D, id: string, x: number, y: number, o: { alpha?: number; rise?: number; nameScale?: number; meta?: boolean } = {}) {
  const sp = species(id);
  const a = o.alpha ?? 1, dy = o.rise ?? 0, T = D.style.type;
  const ns = o.nameScale ?? 3;
  drawMono(c, `${D.copy.dexPrefix}${String(sp.dexNo).padStart(3, '0')}`, x, y + dy, T.monoSmallPx, { color: 'gold', align: 'center', alpha: a, tracking: 0.18, weight: 500 });
  const Lb = D.style.label;
  drawPixel(c, displayName(id), x, y + dy + Lb.nameDy, ns, { align: 'center', alpha: a });
  if (o.meta !== false) {
    const yr = sp.releaseDate ? ` · ${sp.releaseDate.slice(0, 4)}` : '';
    drawMono(c, `${sp.company}${yr}`, x, y + dy + Lb.nameDy + 16 * ns + Lb.metaDy, T.monoSmallPx, { color: 'ash', align: 'center', alpha: a * 0.9, tracking: 0.08 });
  }
}
