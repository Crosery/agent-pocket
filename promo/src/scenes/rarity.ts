// Plate 5 — rarity, N → MYTHIC. One creature per tier every two beats; each gets a faint light of its tier colour
// and a little more sparkle. Two beats of charge: the stage empties and the five tier pips fly into one point while
// the MYTHIC pip fills with the riser; then MYTHIC on the bar. Gold is only ever light (a small core, thin beams);
// the falloff around it is the navy-blue halo, so the field never takes the colour. The rarity colours are this
// plate's accent and appear nowhere else.
import * as THREE from 'three';
import { Scene, type Frame, type SfxEvent } from '../engine/scene';
import { Layer2D } from '../engine/gl';
import { GlowBatch, RectBatch, SpriteBatch } from '../engine/sprites';
import { ATLAS } from '../engine/assets';
import { D, copy, displayName, lin, rarity } from '../engine/data';
import { clamp, ease, frameIdx, hash, prog, pulse } from '../engine/util';
import { drawCopy, drawPixel, pixelWidth } from '../engine/text';
import { Backdrop, ShadowBatch, creatureBox, creatureHeight, drawCreature, grow, landing, safeGlowI, sparkles, type Rect } from './_kit';

type Tier = { tier: string; id: string; beat: number };

export default class Rarity extends Scene {
  bg = new Backdrop();
  text = new Layer2D();
  sb = new SpriteBatch(ATLAS.texture, ATLAS.canvas.width, ATLAS.canvas.height, 4);
  sh = new ShadowBatch(4);
  under = new GlowBatch(32);
  rb = new RectBatch(2048, 'add');
  pips = new RectBatch(64, 'add');
  gb = new GlowBatch(512);

  private tiers() { return D.cast.rarity as Tier[]; }

  override cutTimes() { return [...this.tiers().slice(1).map((t) => this.beatT(t.beat)), this.cueT('charge')]; }

  override sfx(): SfxEvent[] {
    const T = this.tiers(), last = T.length - 1;
    const ev: SfxEvent[] = T.map((t, i) => ({ t: this.beatT(t.beat), id: i === last ? 'mythic' : i === last - 1 ? 'tierHigh' : 'tier', pitch: 2 ** ([0, 2, 4, 7, 9, 0][i]! / 12) }));
    return [...ev, { t: this.beatT(T[last]!.beat) - D.style.rarity.chargeSfxLeadSec, id: 'charge' }];
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp, cues } = this.ctx;
    const S = D.style.rarity, M = S.mythic;
    const b = f.lb, L = D.style.layout, sc = 4;
    const tiers = this.tiers();
    let ti = 0;
    for (let i = 0; i < tiers.length; i++) if (b >= tiers[i]!.beat) ti = i;
    const cur = tiers[ti]!;
    const last = ti === tiers.length - 1;
    const charging = !last && b >= cues.charge;
    const u = b - cur.beat, us = u * this.spb; // beats / seconds since the landing
    const col = lin(rarity(cur.tier).color);
    const ord = rarity(cur.tier).order;
    const gold = lin('goldHi');
    const ground = Math.round(L.heroY + creatureHeight(cur.id, sc) / 2 + S.spriteDy);
    const cy = L.heroY + S.spriteDy - 10;
    const mythicB = tiers[tiers.length - 1]!.beat;

    // the field stays navy: tiers light it faintly in their colour (capped so it never turns warm), the blue halo
    // carries the falloff; MYTHIC adds a small gold core and thin beams
    const ch = charging ? prog(b, cues.charge, mythicB, ease.inCubic) : 0;
    if (charging) this.bg.set({ glowPos: [960, cy], haloI: S.haloI * (0.3 + 0.7 * ch), haloR: S.haloR }).render(renderer, out);
    else if (last) this.bg.set({ glowPos: [960, cy], haloI: M.haloI * (0.85 + 0.6 * Math.exp(-us * 3)), haloR: M.haloR }).render(renderer, out);
    else this.bg.set({ glow: col, glowI: safeGlowI(col, S.glow[ord]! * (0.7 + 0.3 * Math.exp(-u * 2))), glowR: S.glowR[ord]!, glowPos: [960, cy], haloI: S.haloI, haloR: S.haloR }).render(renderer, out);

    // light behind the subject (additive, under the sprite): the charge's gathering point; MYTHIC's core and beams
    this.under.begin();
    if (charging) this.under.glow(960, cy, M.chargeR[0] + (M.chargeR[1] - M.chargeR[0]) * ch, gold, M.chargeI[0] + (M.chargeI[1] - M.chargeI[0]) * ch);
    if (last) {
      this.under.glow(960, cy, M.coreR, gold, M.coreI * (0.8 + 0.2 * Math.exp(-u * 1.5)) + M.coreBurst * pulse(us, 0, 0.08));
      const Bm = M.beams;
      for (let i = 0; i < Bm.count; i++) {
        const rot = (i / Bm.count) * Math.PI + f.t * Bm.spin;
        this.under.glow(960, cy, Bm.len, gold, Bm.I * (0.85 + 0.15 * Math.sin(f.t * 2 + i * 1.7)), Bm.width, 1, rot);
      }
    }
    this.under.render(renderer, out);

    const post: Record<string, any> = {};
    let box: Rect | null = null;
    if (!charging) {
      const lnd = landing(u, 0.3, last ? 60 : 36);
      const ab = ATLAS.box(cur.id);
      this.sh.begin().shadow(960, ground, (ab.x1 - ab.x0) * sc * 0.9, 0.5, 0.16);
      this.sh.render(renderer, out);
      const hot = ord >= 4 ? (last ? M : S.ur) : null;
      this.sb.begin();
      drawCreature(this.sb, cur.id, 960, ground, sc, { hop: Math.round(lnd.hop / sc) * sc, squash: lnd.squash, flash: hot ? hot.spriteFlash * pulse(us, 0, 0.02) : 0 });
      this.sb.render(renderer, out);
      box = creatureBox(cur.id, 960, ground, sc);
      if (hot) {
        // a radial burst of light on the subject (corners stay dark) plus one bone frame at its core
        const fl = hot.flash;
        post.flash = fl.I * pulse(us, 0, fl.halfLifeSec);
        post.flashR = fl.r; post.flashPos = [960, cy];
        post.flashCore = frameIdx(f.ft) === frameIdx(this.beatT(cur.beat)) ? fl.core : 0;
        post.flashCoreR = fl.coreR;
        post.flashColor = lin('bone');
        const s = hot.shakePx * pulse(us, 0, 0.05);
        post.shake = [Math.round((hash(frameIdx(f.t), 1) - 0.5) * 2 * s), Math.round((hash(frameIdx(f.t), 2) - 0.5) * 2 * s)];
      }
    }

    // the tier label (and its keep-out box for the sparkles)
    const big = cur.tier.length > 3 ? 5 : 6;
    const labelY = L.labelY + S.labelDy;
    const labelBox: Rect = { x0: 960 - pixelWidth(cur.tier, big) / 2, y0: labelY - 6, x1: 960 + pixelWidth(cur.tier, big) / 2, y1: labelY + S.captionDy + 16 * S.captionScale };

    // sparkles, or (charging) the five tier pips and gold specks converging on one point
    const P = S.pips, x0 = 960 - P.gap * 2.5;
    this.rb.begin(); this.gb.begin();
    if (charging) {
      // frame-stepped specks (crisp squares of light, never smeared into a dull trail)
      for (let i = 0; i < M.chargeParticles; i++) {
        const a = hash(i, 9) * Math.PI * 2, k = ((f.flb - cues.charge) * (0.6 + 0.6 * hash(i, 4)) + hash(i, 5)) % 1;
        const r = (1 - ease.inQuad(k)) * (520 - 200 * ch);
        const x = Math.round((960 + Math.cos(a) * r) / 4) * 4, y = Math.round((cy + Math.sin(a) * r * 0.7) / 4) * 4;
        this.rb.rectPx(x, y, 4, 4, [gold[0] * M.chargeI2, gold[1] * M.chargeI2, gold[2] * M.chargeI2], Math.sin(k * Math.PI) * (0.5 + 0.5 * ch));
      }
    } else if (S.spark[ord]! > 0) {
      const avoid = [grow(box!, S.keepOutPx), grow(labelBox, 24)];
      sparkles(this.rb, this.gb, f.t, 960, cy, S.spark[ord]!, S.sparkR[ord]!, last ? gold : col, { seed: ord, intensity: last ? 2.4 : 2.0, rise: last ? 40 : 16, avoid });
    }
    this.gb.render(renderer, out);
    this.rb.render(renderer, out);

    // the ladder: six pips, lit up to the current tier. While charging, the five lit pips leave the row and fly
    // into the gathering point; the MYTHIC pip fills with the riser
    this.pips.begin();
    D.game.rarities.forEach((r, i) => {
      const pc = lin(r.color);
      let x = x0 + i * P.gap, y = P.y, on = i <= ord ? (i === ord && !charging ? 1.5 : 0.9) : 0.14, al = 1, s = P.px;
      if (charging && i < 5) {
        const k = prog(b, cues.charge + i * P.flyStagger, cues.charge + i * P.flyStagger + P.flyBeats, ease.inQuad);
        const side = (i - 2) * 140;
        // a curve: out to the side, then into the point
        const mx = 960 + side * (1 - k) * 1.6, my = P.y - 260 * Math.sin(Math.PI * k * 0.5);
        x = x + (mx - x) * Math.min(1, k * 1.4); y = y + (my - y) * Math.min(1, k * 1.4);
        x = x + (960 - x) * k; y = y + (cy - y) * k;
        on = 1.4 + k; al = k >= 1 ? 0 : 1; s = P.px * (1 - 0.4 * k);
      }
      if (charging && i === 5) {
        const fill = prog(b, cues.charge, mythicB);
        on = 0.14 + 1.4 * fill * (((b * 8) % 1) < 0.5 ? 1 : 0.6);
      }
      this.pips.rectPx(Math.round(x - s / 2), Math.round(y - s / 2), s, s, [pc[0] * on, pc[1] * on, pc[2] * on], al);
    });
    this.pips.render(renderer, out);

    const c = this.text.ctx;
    this.text.clear();
    const fb = f.flb;
    if (!charging) {
      // hot tiers: the label waits for the flash to pass; outlines only where contrast needs them (UR, MYTHIC)
      const delay = S.labelDelaySec[ord]!;
      const la = prog((fb - cur.beat) * this.spb, delay, delay + 0.12, ease.outCubic);
      const ol = S.labelOutline[ord] ? { outline: 'navy', outlineAlpha: S.outlineAlpha } : {};
      // a one-art-pixel bob as it lands (frame-stepped), then still
      const lb = (fb - cur.beat) * this.spb - delay;
      const bob = lb >= 0.12 && lb < 0.12 + S.labelBobSec ? -1 : 0;
      drawPixel(c, cur.tier, 960, labelY - 6 + (Math.round((1 - la) * 3) + bob) * big, big, { align: 'center', color: rarity(cur.tier).color, alpha: la, ...ol });
      drawPixel(c, `${rarity(cur.tier).nameZh} · ${displayName(cur.id)}`, 960, labelY + S.captionDy, S.captionScale, { align: 'center', color: 'ash', alpha: la });
    }
    const cp = copy('rarity');
    const ca = prog(fb, cues.copyIn, cues.copyIn + 0.5, ease.outCubic) * (1 - prog(fb, cues.copyOut, cues.copyOut + 0.5));
    if (ca > 0) drawCopy(c, cp.zh, cp.en, 960, S.headlineY, { alpha: ca, zhScale: 3 });
    comp.draw(renderer, this.text.upload(), out);
    void clamp;
    return post;
  }
}
