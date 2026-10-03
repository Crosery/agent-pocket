// Plate 8 — battle. The two partners face off on the game's own battle backdrop. Bar 1: Lin's partner dashes
// and lands a super-effective hit on beat 2 (flash, shake, a pixel burst in its type colour, HP falls,
// 「效果拔群！」). Bar 2: Kai's partner answers on beat 2 of its bar. Attacks are data (data/cast.json battle).
import * as THREE from 'three';
import { Scene, type Frame, type SfxEvent } from '../engine/scene';
import { Layer2D, makeRT, clearRT } from '../engine/gl';
import { Blur, Grade } from '../engine/grade';
import { GlowBatch, RectBatch, SpriteBatch } from '../engine/sprites';
import { ATLAS, IMG, TEX } from '../engine/assets';
import { D, displayName, lin, rgba, species, rarity } from '../engine/data';
import { clamp, ease, frameIdx, hash, prog, pulse } from '../engine/util';
import { drawPixel, pixelWidth } from '../engine/text';
import { ShadowBatch, drawCreature, typeLin } from './_kit';

interface Attack { by: 'left' | 'right'; dash: number; hit: number; dmg: number; super: boolean }

export default class Battle extends Scene {
  bgSprite!: SpriteBatch;
  bgRT = makeRT(1920, 1080, { depthBuffer: false });
  blur = new Blur();
  grade = new Grade();
  sb = new SpriteBatch(ATLAS.texture, ATLAS.canvas.width, ATLAS.canvas.height, 8);
  sh = new ShadowBatch(8);
  fx = new RectBatch(1024, 'add');
  gb = new GlowBatch(256);
  pool = new GlowBatch(8);
  text = new Layer2D();

  override init() {
    const key = `ui:${D.cast.battle.bg}`;
    const im = IMG.get(key)!;
    this.bgSprite = new SpriteBatch(TEX.get(key)!, im.width, im.height, 1, { pixel: false });
    const G = D.style.grade.battle, Rm = D.style.battle.rim;
    this.grade.set(G);
    // the rim is drawn inside the silhouette, one art pixel on the edge facing the light, at Rm.amount
    const rc = lin(Rm.color);
    this.sb.setRim([Rm.dx, Rm.dy], [rc[0] * Rm.I, rc[1] * Rm.I, rc[2] * Rm.I], Rm.amount);
  }

  private attacks() { return D.cast.battle.attacks as Attack[]; }

  override sfx(): SfxEvent[] {
    return this.attacks().flatMap((a) => [
      { t: this.beatT(a.dash), id: 'dash' },
      { t: this.beatT(a.hit), id: a.super ? 'hitSuper' : 'hit' },
    ]);
  }

  private panel(c: CanvasRenderingContext2D, id: string, x: number, y: number, hp: number, a: number, player: string, pcol: string) {
    const S = D.style.battle, P = S.panel, ns = S.nameScale;
    const sp = species(id), r = rarity(sp.rarity);
    c.save(); c.globalAlpha = a;
    c.fillStyle = rgba('navy', 0.9); c.fillRect(x, y, P.w, P.h);
    // the border is the player's colour (gold = Lin, sky = Kai, as in their speech bubbles)
    c.fillStyle = rgba(pcol); const e = 3;
    c.fillRect(x, y, P.w, e); c.fillRect(x, y + P.h - e, P.w, e); c.fillRect(x, y, e, P.h); c.fillRect(x + P.w - e, y, e, P.h);
    c.restore();
    // owner (player colour) with the rarity chip on its right, the creature's name under it, then the HP bar
    drawPixel(c, player, x + P.pad, y + P.pad - 2 * ns, ns, { color: pcol, alpha: a });
    const cw = pixelWidth(r.id, ns) + 6 * ns, chH = 13 * ns;
    c.save(); c.globalAlpha = a; c.fillStyle = r.color; c.fillRect(x + P.w - P.pad - cw, y + P.pad, cw, chH); c.restore();
    drawPixel(c, r.id, x + P.w - P.pad - cw / 2, y + P.pad - 1 * ns, ns, { color: 'ink', align: 'center', alpha: a });
    drawPixel(c, displayName(id), x + P.pad, y + P.pad + 13 * ns + 10 - 2 * ns, ns, { alpha: a });
    const bx = x + P.pad, by = y + P.h - P.pad - P.bar, bw = P.w - 2 * P.pad;
    c.save(); c.globalAlpha = a;
    c.fillStyle = rgba('ink'); c.fillRect(bx, by, bw, P.bar);
    c.fillStyle = hp > 0.5 ? '#62d65a' : hp > 0.2 ? '#f2c94c' : '#e8513a';
    c.fillRect(bx + 3, by + 3, Math.max(0, (bw - 6) * hp), P.bar - 6);
    c.restore();
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp, cues } = this.ctx;
    const S = D.style.battle;
    const b = f.lb;
    const L = D.cast.battle as { left: string; right: string };
    const c = this.text.ctx;
    this.text.clear();
    const post: Record<string, any> = {};

    // the painted backdrop is a background plane: defocused, darkened and desaturated (data/style.json grade.battle),
    // so the partners own the light and its non-integer scale is invisible
    const im = IMG.get(`ui:${D.cast.battle.bg}`)!;
    const s = Math.max(1920 / im.width, 1080 / im.height) * (1 + 0.03 * prog(b, 0, 8));
    clearRT(renderer, this.bgRT, [0, 0, 0]);
    this.bgSprite.begin().add({ x: 960 - im.width * s / 2, y: 540 - im.height * s / 2 - 40, w: im.width * s, h: im.height * s, uv: [0, 0, im.width, im.height] });
    this.bgSprite.render(renderer, this.bgRT);
    this.blur.render(renderer, this.bgRT.texture, this.bgRT, D.style.grade.battle.blurPx);
    this.grade.render(renderer, this.bgRT.texture, out);
    // entry on the cut: both partners are there on frame 0 and land in two stepped frames (no smeared ghost)
    const fi = frameIdx(f.ft) - frameIdx(this.beatT(cues.drop));
    const entry = (): { hop: number; squash: number; alpha: number } => {
      const H = D.style.battle.entryHopPx as number[];
      if (fi < H.length) return { hop: H[fi]!, squash: -0.03, alpha: 1 };
      const a = (fi - H.length) / 60;
      const q = D.style.motion.squash * Math.exp(-a * 9) * Math.cos(a * 22);
      return { hop: 0, squash: Math.abs(q) < 0.004 ? 0 : q, alpha: 1 };
    };
    const ul = entry(), ur = entry();
    const home = { left: S.left as [number, number, number], right: S.right as [number, number, number] };
    const pos = { left: [home.left[0], home.left[1]], right: [home.right[0], home.right[1]] } as Record<'left' | 'right', [number, number]>;
    const flash = { left: 0, right: 0 }, knock = { left: 0, right: 0 }, hp = { left: 1, right: 1 };
    let shk = 0;
    this.fx.begin(); this.gb.begin();
    let superK = 0;
    for (const a of this.attacks()) {
      const tgt = a.by === 'left' ? 'right' : 'left';
      const from = home[a.by], to = home[tgt];
      // dash out (ease in) to the target, recoil back after the hit
      const d = b < a.dash ? 0 : b < a.hit ? ease.inCubic(prog(b, a.dash, a.hit)) : 1 - ease.outCubic(prog(b, a.hit, a.hit + 0.6));
      pos[a.by] = [pos[a.by][0] + (to[0] - from[0]) * d * S.dashReach, pos[a.by][1] + (to[1] - from[1]) * d * S.dashReach];
      const hk = pulse(b, a.hit, 0.09);
      flash[tgt] = Math.max(flash[tgt], Math.min(1, hk * 1.4));
      shk = Math.max(shk, (a.super ? 12 : 7) * hk);
      if (b >= a.hit) knock[tgt] += Math.sin(Math.PI * prog(b, a.hit, a.hit + 0.4)) * (a.super ? 26 : 16) * (tgt === 'right' ? 1 : -1);
      hp[tgt] -= a.dmg * ease.outCubic(prog(b, a.hit + 0.1, a.hit + 0.9));
      if (a.super) superK = b >= a.hit ? 1 : 0;
      // impact: a burst of 2x2-art-pixel squares in the attacker's type colour + a short glow
      if (b >= a.hit) {
        const k = (b - a.hit) * this.spb, tc = typeLin(L[a.by]);
        const cx = to[0], cy = to[1] - to[2] * 46;
        for (let i = 0; i < S.burst.count; i++) {
          const ang = hash(i, 21 + (a.super ? 0 : 7)) * Math.PI * 2, sp = S.burst.speed[0] + hash(i, 22) * (S.burst.speed[1] - S.burst.speed[0]);
          const life = 1 - k / (S.burst.life * (0.7 + 0.6 * hash(i, 23)));
          if (life <= 0) continue;
          const r = sp * (1 - Math.exp(-k * 9));
          const q = S.burst.px * to[2];
          const x = Math.round((cx + Math.cos(ang) * r) / q) * q, y = Math.round((cy + Math.sin(ang) * r * 0.85) / q) * q;
          this.fx.rectPx(x - q / 2, y - q / 2, q, q, [tc[0] * S.burst.I, tc[1] * S.burst.I, tc[2] * S.burst.I], clamp(life * 2));
        }
        this.gb.glow(cx, cy, 240, tc, 1.4 * pulse(k, 0, 0.06));
      }
    }
    const [lx, ly] = pos.left, [rx, ry] = pos.right;
    // ground contact on the dark backdrop: a faint warm pool of light on the meadow, a dark core under the feet
    // (both stay at home; the core shrinks while the attacker is in the air)
    const Gc = S.ground;
    const gl = lin(Gc.color);
    this.pool.begin();
    this.pool.glow(home.left[0], home.left[1], Gc.poolR * home.left[2] / 4, gl, Gc.poolI, 1, Gc.flat);
    this.pool.glow(home.right[0], home.right[1], Gc.poolR * home.right[2] / 4, gl, Gc.poolI, 1, Gc.flat);
    this.pool.render(renderer, out);
    const airL = Math.hypot(lx - home.left[0], ly - home.left[1]), airR = Math.hypot(rx - home.right[0], ry - home.right[1]);
    this.sh.begin()
      .shadow(lx, home.left[1], Gc.shadowW * home.left[2] / 4 * (1 - Math.min(0.6, airL / 600)), Gc.shadowA * (1 - Math.min(0.7, airL / 400)), Gc.flat)
      .shadow(rx + knock.right, home.right[1], Gc.shadowW * home.right[2] / 4 * (1 - Math.min(0.6, airR / 600)), Gc.shadowA * (1 - Math.min(0.7, airR / 400)), Gc.flat);
    this.sh.render(renderer, out);
    this.sb.begin();
    drawCreature(this.sb, L.right, rx + knock.right, ry, home.right[2], { hop: ur.hop, squash: ur.squash, alpha: ur.alpha, flash: flash.right });
    drawCreature(this.sb, L.left, lx + knock.left, ly, home.left[2], { hop: ul.hop, squash: ul.squash, alpha: ul.alpha, flip: true, flash: flash.left });
    this.sb.render(renderer, out);
    this.gb.render(renderer, out); this.fx.render(renderer, out);

    const pa = prog(f.flb, cues.drop + 0.3, cues.drop + 0.7, ease.outCubic);
    const pl = D.copy.players;
    this.panel(c, L.right, S.panelRight[0], S.panelRight[1], clamp(hp.right), pa, pl[1].name, 'sky');
    this.panel(c, L.left, S.panelLeft[0], S.panelLeft[1], clamp(hp.left), pa, pl[0].name, 'goldHi');
    const sa = this.attacks().find((a) => a.super);
    if (sa && f.flb >= sa.hit) {
      // frame-stepped pop (type is never motion-blurred)
      const sk = prog(f.flb, sa.hit, sa.hit + 0.2, (t) => ease.outBack(t, 3));
      const [tx, ty] = [home.right[0], home.right[1] - S.superAbovePx];
      c.save(); c.translate(tx, ty); c.scale(sk, sk); c.translate(-tx, -ty);
      drawPixel(c, D.copy.battle.super, tx, ty - 30, S.superScale, { align: 'center', color: 'goldHi', outline: 'ink', outlineAlpha: 0.7, alpha: 1 - prog(f.flb, sa.hit + 2.5, sa.hit + 3) });
      c.restore();
    }
    void superK;
    comp.draw(renderer, this.text.upload(), out);
    post.shake = [Math.round((hash(frameIdx(f.t), 1) - 0.5) * 2 * shk), Math.round((hash(frameIdx(f.t), 2) - 0.5) * 2 * shk)];
    // a radial flash on the target of each hit
    let fl = 0, fp: [number, number] = [960, 540];
    for (const a of this.attacks()) { const k = pulse(b, a.hit, 0.06); if (k > fl) { fl = k; const t = home[a.by === 'left' ? 'right' : 'left']; fp = [t[0], t[1] - t[2] * 46]; } }
    post.flash = S.hitFlash.I * fl; post.flashR = S.hitFlash.r; post.flashPos = fp;
    return post;
  }
}
