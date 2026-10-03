// Plate 4 — one becomes all. Four beats subdivide one footprint (4 → 16 → 64 → every species) at whole and
// half scales only, and the count itself is the picture: a big gold pixel number that ticks on each beat,
// then the rest of the line types under it. A ripple runs through the crowd; hard cut on the bar.
import * as THREE from 'three';
import { Scene, type Frame, type SfxEvent } from '../engine/scene';
import { Layer2D } from '../engine/gl';
import { SpriteBatch } from '../engine/sprites';
import { ATLAS, CELL } from '../engine/assets';
import { D, copy } from '../engine/data';
import { clamp, ease, hash, mulberry32, prog } from '../engine/util';
import { Backdrop, typingSfx } from './_kit';
import { drawMono, drawPixel, monoWidth, pixelBody, pixelInk, pixelWidth } from '../engine/text';

interface Layout { cols: number; rows: number; scale: number; cell: number }

export default class Multiply extends Scene {
  bg = new Backdrop();
  text = new Layer2D();
  sb = new SpriteBatch(ATLAS.texture, ATLAS.canvas.width, ATLAS.canvas.height, 256);
  order: string[] = [];
  layouts: Layout[] = [];
  counts: number[] = [];

  override init() {
    const M = D.cast.multiply as { seed: number; grids: [number, number, number, number][] };
    const ids = D.game.species.map((s) => s.id);
    const rnd = mulberry32(M.seed);
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ids[i], ids[j]] = [ids[j]!, ids[i]!]; }
    this.order = ids;
    // grids: [cols, rows, scale, cell]; the last one holds every species (data/cast.json multiply.grids)
    this.layouts = M.grids.map(([cols, rows, scale, cell]) => ({ cols, rows, scale, cell }));
    this.counts = this.layouts.map((L, i) => (i === this.layouts.length - 1 ? ids.length : Math.min(ids.length, L.cols * L.rows)));
  }

  override cutTimes() { return (this.ctx.cues.steps as number[]).slice(1).map((s) => this.beatT(s)); }

  override sfx(): SfxEvent[] {
    const c = this.ctx.cues, steps: number[] = c.steps;
    const ev: SfxEvent[] = steps.map((s, i) => ({ t: this.beatT(s), id: i === steps.length - 1 ? 'countMax' : 'count', pitch: 2 ** ([0, 4, 7, 12][i]! / 12) }));
    return [...ev, ...typingSfx(this, [...(D.copy.multiply.unit as string)], c.unit, c.copyRate), ...typingSfx(this, [...copy('multiply').zh], c.copy, c.copyRate), { t: this.cueT('ripple'), id: 'ripple' }];
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp, cues } = this.ctx;
    const P = D.style.multiply;
    const b = f.lb;
    const steps: number[] = cues.steps;
    let si = 0;
    for (let i = 0; i < steps.length; i++) if (b >= steps[i]!) si = i;
    const L = this.layouts[si]!;
    const n = this.counts[si]!;
    const u = b - steps[si]!;
    const final = si === steps.length - 1;

    this.bg.set({}).render(renderer, out);

    const W0 = L.cols * L.cell, H0 = L.rows * L.cell;
    const x0 = Math.round(960 - W0 / 2), y0 = Math.round(P.gridCy - H0 / 2);
    // the ripple is frame-stepped (one state per frame through the shutter: no ghosted doubles in the crowd)
    const rippleR = (f.flb - cues.ripple) * P.rippleSpeed;
    this.sb.begin();
    for (let i = 0; i < n; i++) {
      const id = this.order[i]!;
      const c = i % L.cols, r = Math.floor(i / L.cols);
      const inRow = r === L.rows - 1 ? n - r * L.cols : L.cols;
      const xoff = (L.cols - inRow) * L.cell / 2;
      const cx = x0 + xoff + (c + 0.5) * L.cell, cy = y0 + (r + 0.5) * L.cell;
      const d = Math.hypot(cx - 960, cy - P.gridCy) / 1000;
      // each subdivision reads on the beat itself; only the full set staggers outward from the centre
      // (every grid is already there on the cut frame itself: an empty frame on the downbeat reads as a blink)
      const k = final ? clamp((u - d * 0.3 - hash(i, 3) * 0.05) / 0.25 + 0.35) : clamp(u / 0.14 + 0.4);
      if (k <= 0) continue;
      const pop = ease.outBack(k, 2.2);
      let hop = 0, flash = 0;
      if (rippleR > 0) {
        const w = Math.exp(-(((d * 1000 - rippleR) / 70) ** 2));
        hop = Math.round(P.rippleHopPx * w / 2) * 2; flash = 0.3 * w;
      }
      const s = L.scale * (k >= 1 ? 1 : 0.55 + 0.45 * pop);
      const box = ATLAS.box(id);
      const bx = (box.x0 + box.x1) / 2, by = (box.y0 + box.y1) / 2;
      let x = cx - bx * s, y = cy - by * s - hop;
      // holds sit on the art-pixel grid (whole scales) or the screen-pixel grid (half scale)
      if (k >= 1) { const g = Math.max(1, L.scale); x = Math.round(x / g) * g; y = Math.round(y / g) * g; }
      this.sb.add({ x, y, w: CELL * s, h: CELL * s, uv: ATLAS.cell(id), alpha: clamp(k * 4), flash });
    }
    this.sb.render(renderer, out);

    // the count is the picture: a big gold pixel number that ticks on each beat. On the last step it becomes one
    // lockup with its unit (「190 位 AI」: the unit on the number's baseline, the pair centred), then the line types under it
    const c = this.text.ctx;
    this.text.clear();
    const fb = f.flb, fu = fb - steps[si]!;
    const num = String(this.counts[si]);
    const ns = P.countScale, us = P.unitScale;
    const cp = copy('multiply'), unit = D.copy.multiply.unit as string;
    const nInk = pixelInk(num), B = pixelBody();
    const numW = (nInk.right - nInk.left) * ns, unitW = pixelWidth(unit, us), gap = P.unitGapArtPx * us;
    const groupW = final ? numW + gap + unitW : numW;
    const nx = Math.round((960 - groupW / 2) / ns) * ns - nInk.left * ns;
    const land = prog(fu, 0, 0.18, ease.outCubic);
    const hopPx = Math.round((1 - land) * P.countHopArtPx) * ns;
    const ny = P.countTop - nInk.top * ns;
    drawPixel(c, num, nx, ny - hopPx, ns, { color: 'goldHi' });
    const baseY = ny + nInk.bottom * ns; // bottom of the digits' ink
    if (final) {
      const typedU = (fb - cues.unit) / cues.copyRate;
      if (typedU >= 0) {
        const ux = nx + nInk.left * ns + numW + gap;
        drawPixel(c, [...unit].slice(0, Math.floor(typedU) + 1).join(''), Math.round(ux / us) * us, baseY - B.bottom * us, us, { color: 'goldHi' });
      }
    }
    const typed = (fb - cues.copy) / cues.copyRate;
    if (typed >= 0) {
      const zs = P.lineScale, nz = [...cp.zh].length;
      const full = pixelWidth(cp.zh, zs);
      drawPixel(c, [...cp.zh].slice(0, Math.floor(typed) + 1).join(''), Math.round((960 - full / 2) / zs) * zs, baseY + P.lineGap, zs);
      const en = cp.en.slice(0, Math.floor(clamp((typed + 1) / nz) * cp.en.length));
      const ep = D.style.type.enPx, tr = D.style.type.enTracking;
      drawMono(c, en, 960 - monoWidth(c, cp.en, ep, tr) / 2, baseY + P.lineGap + 16 * zs + P.enGap + Math.round(ep * 0.8), ep, { color: 'ash', tracking: tr });
    }
    comp.draw(renderer, this.text.upload(), out);
    return {};
  }
}
