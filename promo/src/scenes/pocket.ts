// Plate 9 — the pocket. Every species turns in a slow spiral around one line of copy, then they all spiral
// inward and vanish into a single gold point: the cursor from the first frame, waiting for the final chord.
import * as THREE from 'three';
import { Scene, type Frame, type SfxEvent } from '../engine/scene';
import { Layer2D } from '../engine/gl';
import { GlowBatch, RectBatch, SpriteBatch } from '../engine/sprites';
import { ATLAS, CELL } from '../engine/assets';
import { D, copy, lin } from '../engine/data';
import { clamp, ease, hash, prog, pulse } from '../engine/util';
import { drawCopy } from '../engine/text';
import { Backdrop, cursor, typingSfx } from './_kit';

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export default class Pocket extends Scene {
  bg = new Backdrop();
  text = new Layer2D();
  sb = new SpriteBatch(ATLAS.texture, ATLAS.canvas.width, ATLAS.canvas.height, 256);
  rb = new RectBatch(512, 'add');
  gb = new GlowBatch(64);

  override sfx(): SfxEvent[] {
    const c = this.ctx.cues;
    // the cadence is a catch: they are pulled in (whoosh), the point shakes twice, the title is the catch
    return [...typingSfx(this, [...copy('pocket').zh], c.copy, c.copyRate), { t: this.beatT(c.gather + 1), id: 'gather' }, ...(c.shake as number[]).map((b) => ({ t: this.beatT(b), id: 'shake' }))];
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp, cues } = this.ctx;
    const b = f.lb, cy = 540;
    const ids = D.game.species.map((s) => s.id);
    const n = ids.length;
    const gold = lin('goldHi');
    const core = prog(b, cues.gather + 1, cues.gone, ease.inCubic);
    const Pk = D.style.pocket;
    // the gathering light's falloff is the navy-blue halo; gold stays in the point itself
    this.bg.set({ glowPos: [960, cy], haloI: Pk.haloI[0] + (Pk.haloI[1] - Pk.haloI[0]) * core, haloR: Pk.haloR }).render(renderer, out);

    const r0 = Pk.r0, r1 = Pk.r1, spin = b * 0.09;
    this.sb.begin(); this.rb.begin();
    const sc = 0.42;
    for (let i = 0; i < n; i++) {
      const id = ids[i]!;
      const q = (i + 0.5) / n;
      const rr = r0 + (r1 - r0) * Math.sqrt(q);
      const a0 = i * GOLDEN + spin;
      // gather: inner ones first; the spiral tightens as it falls inward
      const delay = (rr - r0) / (r1 - r0) * 2.2 + hash(i, 4) * 0.4;
      const k = clamp((b - cues.gather - delay) / 1.4);
      const e = ease.inCubic(k);
      const r = rr * (1 - e);
      const a = a0 + e * 2.4;
      const appear = prog(b, -0.2 + hash(i, 9) * 0.6, 0.4 + hash(i, 9) * 0.6, ease.outCubic);
      if (k >= 1) continue;
      const x = 960 + Math.cos(a) * r * 1.25, y = cy + Math.sin(a) * r * 0.78;
      const s = sc * (1 - e * 0.85) * (0.6 + 0.4 * appear);
      const box = ATLAS.box(id);
      const bx = (box.x0 + box.x1) / 2, by = (box.y0 + box.y1) / 2;
      this.sb.add({ x: x - bx * s, y: y - by * s, w: CELL * s, h: CELL * s, uv: ATLAS.cell(id), alpha: appear, flash: e * 0.9 });
      // a gold spark where each one is absorbed
      if (k > 0.85) { const g = (k - 0.85) / 0.15; this.rb.rectPx(Math.round(x / 4) * 4 - 2, Math.round(y / 4) * 4 - 2, 4, 4, [gold[0] * 3, gold[1] * 3, gold[2] * 3], 1 - g); }
    }
    this.sb.render(renderer, out);
    this.rb.render(renderer, out);

    // the point: grows as they gather, then beats twice
    this.gb.begin();
    const beatP = Math.max(0, ...(cues.shake as number[]).map((sb) => pulse(b, sb, 0.12)));
    this.gb.glow(960, cy, Pk.coreR, gold, Pk.coreI * core + Pk.beatI * beatP);
    this.gb.render(renderer, out);
    this.rb.begin();
    const cv = core;
    // each shake rocks the point side to side by one art pixel (a ball wobbling in the grass)
    const wob = (cues.shake as number[]).reduce((a, sb) => a + (b >= sb && b < sb + 0.4 ? Math.sign(Math.sin((b - sb) * Math.PI * 2 / 0.2)) * (1 - (b - sb) / 0.4) : 0), 0);
    if (cv > 0) cursor(this.rb, 960 - 3 * 4 * cv + Math.round(wob * 1.5) * 4, cy - 6 * 4 * cv, 4 * cv, 1, D.style.cursor.I * (1 + 0.5 * beatP));
    this.rb.render(renderer, out);

    const c = this.text.ctx;
    this.text.clear();
    const cp = copy('pocket');
    const ta = prog(b, cues.copy, cues.copy + 0.4, ease.outCubic) * (1 - prog(b, cues.gather + 1.6, cues.gather + 2.2, ease.inQuad));
    if (ta > 0) {
      const typed = (f.flb - cues.copy) / cues.copyRate;
      const T = D.style.type;
      drawCopy(c, cp.zh, cp.en, 960, cy - Pk.copyDy, { alpha: ta, chars: typed + 1, enChars: clamp((typed + 1) / [...cp.zh].length) * cp.en.length, zhScale: T.narratorScale, enPx: T.narratorEnPx });
    }
    comp.draw(renderer, this.text.upload(), out);
    return {};
  }
}
