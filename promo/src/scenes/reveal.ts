// Plate 2 — the cursor unpacks into the first AI companion (dex No.001): every art pixel of the sprite flies
// out of the cursor to its place, gold cooling to its true colour. Then a quiet idle and its name card. On its last
// bar (cue `cast`, a hard cut) the nine heroines of the game's key art pop in on eighths in an arc, DeepSeek-V4 at
// the centre and bigger (data/cast.json heroines, data/style.json castArc), and the narrator types 「现在，见见它们」.
import * as THREE from 'three';
import { Scene, type Frame, type SfxEvent } from '../engine/scene';
import { Layer2D } from '../engine/gl';
import { RectBatch, SpriteBatch } from '../engine/sprites';
import { ATLAS, CELL } from '../engine/assets';
import { D, copy, lin } from '../engine/data';
import { drawCopy, pixelBody, pixelPrefixWidth, pixelWidth } from '../engine/text';
import { clamp, ease, hash, prog, hexToLinear } from '../engine/util';
import { Backdrop, ShadowBatch, creatureRect, drawCreature, drawLabel, cursor, creatureHeight, haloLight, landing, typingSfx } from './_kit';

interface Px { x: number; y: number; c: [number, number, number]; d: number; j: number }

export default class Reveal extends Scene {
  bg = new Backdrop();
  text = new Layer2D();
  rb = new RectBatch(CELL * CELL + 16);
  sb = new SpriteBatch(ATLAS.texture, ATLAS.canvas.width, ATLAS.canvas.height, 16);
  sh = new ShadowBatch(16);
  id = D.cast.reveal as string;
  px: Px[] = [];
  scale = 4;
  ground = 0;

  override cutTimes() { return [this.cueT('cast')]; }

  override sfx(): SfxEvent[] {
    const c = this.ctx.cues;
    const pops = this.castSlots().map((sl) => ({ t: this.beatT(c.cast + sl.at), id: sl.k === 0 ? 'castLead' : 'castPop', pitch: 2 ** ([0, 2, 4, 7, 9][Math.abs(sl.k)]! / 12) }));
    return [{ t: this.cueT('burst'), id: 'unpack' }, ...pops, ...typingSfx(this, [...copy('reveal').zh], c.copy, c.copyRate)];
  }

  /** The heroines' arc: slot k (0 = centre, then -1, +1, -2, +2 …), its x, feet line, scale and pop beat (from cue `cast`). */
  private castSlots() {
    const ids = D.cast.heroines as string[], A = D.style.castArc;
    return ids.map((id, i) => {
      const k = i === 0 ? 0 : (i % 2 ? -1 : 1) * Math.ceil(i / 2);
      const ring = Math.abs(k) / Math.ceil((ids.length - 1) / 2);
      return { id, k, x: 960 + k * A.stepPx, ground: Math.round(A.groundY - A.risePx * ring ** A.risePow), scale: k === 0 ? A.leadScale : A.scale, at: Math.ceil(i / 2) * A.popBeats };
    });
  }

  override init() {
    const img = ATLAS.pixels.get(this.id)!;
    this.ground = Math.round(D.style.layout.heroY + creatureHeight(this.id, this.scale) / 2);
    const r = creatureRect(this.id, 960, this.ground, this.scale);
    const toLin = (v: number) => hexToLinear('#' + v.toString(16).padStart(6, '0'));
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const k = (y * CELL + x) * 4;
      if (img.data[k + 3]! < 128) continue;
      const X = r.x + x * this.scale, Y = r.y + y * this.scale;
      const d = Math.hypot(X + 2 - 960, Y + 2 - D.style.layout.heroY) / 300;
      this.px.push({ x: X, y: Y, c: toLin((img.data[k]! << 16) | (img.data[k + 1]! << 8) | img.data[k + 2]!), d, j: hash(x, y, 7) });
    }
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp, cues } = this.ctx;
    const b = f.lb, sc = this.scale, hy = D.style.layout.heroY;
    // the room takes the companion's own hue as it settles (not leftover gold from the unpack)
    const settle = prog(b, 0.4, 2.0, ease.outCubic);
    const hl = haloLight(ATLAS.tone(this.id), 'reveal');
    this.bg.set({ ...hl, glowI: hl.glowI * settle, haloI: hl.haloI * settle }).render(renderer, out);

    if (b >= cues.cast) return this.renderCast(f, out);
    const u = b - cues.burst;
    const travel = 0.7, spread = 0.55;
    const done = u > spread + 0.12 + travel;
    // floor shadow grows in as the pixels land
    const r = creatureRect(this.id, 960, this.ground, sc);
    const bob = done ? (((b % 1) + 1) % 1 < 0.5 ? sc : 0) : 0;
    this.sh.begin().shadow(960, this.ground, (ATLAS.box(this.id).x1 - ATLAS.box(this.id).x0) * sc * 0.9, 0.55 * prog(u, 0.3, 1.3), 0.16);
    this.sh.render(renderer, out);

    if (u < 0) {
      this.rb.begin(); cursor(this.rb, 960 - 3 * 4, hy - 6 * 4, 4, 1); this.rb.render(renderer, out);
    } else if (!done) {
      const gold = lin('goldHi');
      this.rb.begin();
      for (const p of this.px) {
        const k = clamp((u - p.d * spread - p.j * 0.12) / travel);
        if (k <= 0) continue;
        const e = ease.outExpo(k);
        const sx = 960 - 2 + (p.j - 0.5) * 20, sy = hy - 2 + (hash(p.j, 3) - 0.5) * 44;
        const curl = Math.sin(Math.PI * e) * (p.j - 0.5) * 90;
        const x = sx + (p.x - sx) * e + curl * (p.y - hy) / 300, y = sy + (p.y - sy) * e - curl * (p.x - 960) / 300;
        const heat = (1 - ease.outCubic(k)) * 1.8;
        const c: [number, number, number] = [p.c[0] + (gold[0] * 1.25 - p.c[0]) * Math.min(1, heat), p.c[1] + (gold[1] * 1.25 - p.c[1]) * Math.min(1, heat), p.c[2] + (gold[2] * 1.25 - p.c[2]) * Math.min(1, heat)];
        const s = sc * (k < 1 ? 1 + (1 - e) * 0.5 : 1);
        this.rb.rectPx(k < 1 ? x : p.x, k < 1 ? y : p.y, s, s, c, 1);
      }
      // the cursor collapses as it empties
      const cv = 1 - prog(u, 0, 0.35, ease.inCubic);
      if (cv > 0) cursor(this.rb, 960 - 3 * 4 * cv, hy - 6 * 4 * cv, 4 * cv, 1, D.style.cursor.I * (1 + (1 - cv) * 0.6));
      this.rb.render(renderer, out);
    } else {
      this.sb.begin().add({ ...r, y: r.y - bob, uv: ATLAS.cell(this.id) });
      this.sb.render(renderer, out);
    }

    const c = this.text.ctx;
    this.text.clear();
    // the name card, then (bar 3) the narrator's cursor types the bridge into the faces montage in its place
    const la = prog(b, cues.label, cues.label + 0.5, ease.outCubic);
    if (la > 0) drawLabel(c, this.id, 960, D.style.layout.labelY, { alpha: la, rise: (1 - la) * 10 });
    comp.draw(renderer, this.text.upload(), out);
    return {};
  }

  /** The last bar: the nine heroines pop in on eighths in an arc, and the narrator types the bridge into the faces. */
  private renderCast(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp, cues } = this.ctx;
    const A = D.style.castArc;
    const b = f.lb, slots = this.castSlots();
    const lead = slots[0]!;
    this.bg.set(haloLight(ATLAS.tone(lead.id), 'reveal', [960, A.groundY - 220])).render(renderer, out);
    // back (outer) slots first, the lead last
    const order = [...slots].sort((p, q) => Math.abs(q.k) - Math.abs(p.k));
    this.sh.begin(); this.sb.begin();
    for (const sl of order) {
      const u = b - cues.cast - sl.at;
      if (u < 0) continue;
      const lnd = landing(u, 0.22, A.hopPx);
      const box = ATLAS.box(sl.id);
      this.sh.shadow(sl.x, sl.ground, (box.x1 - box.x0) * sl.scale * 0.85, 0.5 * lnd.alpha, 0.16);
      const bob = u > 1 && ((b + sl.k * 0.25) % 1 + 1) % 1 < 0.5 ? sl.scale : 0;
      drawCreature(this.sb, sl.id, sl.x, sl.ground, sl.scale, { hop: Math.round((lnd.hop + bob) / sl.scale) * sl.scale, squash: lnd.squash, flash: Math.max(0, 0.6 - u * 3) });
    }
    this.sh.render(renderer, out);
    this.sb.render(renderer, out);
    const c = this.text.ctx;
    this.text.clear();
    const cp = copy('reveal'), zs = D.style.type.zhScale, cy = A.copyY;
    const n = (f.flb - cues.copy) / cues.copyRate;
    if (n >= 0) {
      const chars = [...cp.zh], shown = Math.min(chars.length, Math.floor(n) + 1);
      drawCopy(c, cp.zh, cp.en, 960, cy, { chars: shown, enChars: Math.min(1, (n + 1) / chars.length) * cp.en.length });
      comp.draw(renderer, this.text.upload(), out);
      const B = pixelBody(), full = pixelWidth(cp.zh, zs);
      const x = Math.round((960 - full / 2) / zs) * zs + pixelPrefixWidth(cp.zh, shown, zs) + D.style.type.pixelSpacing.zhGapPx * zs;
      const typing = n < chars.length, blink = typing || ((f.flb % 1) + 1) % 1 < 0.6 ? 1 : 0;
      this.rb.begin(); cursor(this.rb, x, Math.round(cy / zs) * zs + B.top * zs, zs, blink, undefined, (B.bottom - B.top) * zs); this.rb.render(renderer, out);
    } else comp.draw(renderer, this.text.upload(), out);
    return {};
  }
}
