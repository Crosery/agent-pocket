// Plate 'catch' — the genre's verb, and the setup the ending pays off. A wild AI hops in the tall grass; a ball
// arcs in from the player's side, the AI turns to gold light and streams into it pixel by pixel (the reveal's
// unpack, reversed); the ball drops, rocks twice on the beat, clicks. 「抓到了 …！」 is the game's own message.
// All sprites (creature, ball, grass tufts) and sounds are the game's. Cues: data/timeline.json catch.
// Staged in the world's clearing at golden hour: the backdrop is the diorama (data/world.json catch camera), the
// same place the world plate opens on, defocused behind the crisp 2D sprites; it is static, so it is rendered once
// per push-in zoom (cached), and live only during the push.
import * as THREE from 'three';
import { Scene, type Frame, type SfxEvent } from '../engine/scene';
import { Layer2D, makeRT, W, H } from '../engine/gl';
import { Diorama } from './_diorama';
import { GlowBatch, RectBatch, SpriteBatch } from '../engine/sprites';
import { ATLAS, CELL, IMG, TEX } from '../engine/assets';
import { D, copy, displayName, lin, hex } from '../engine/data';
import { clamp, ease, hash, hexToLinear, prog } from '../engine/util';
import { drawPixel } from '../engine/text';
import { ShadowBatch, creatureHeight, creatureRect } from './_kit';

interface Px { x: number; y: number; c: [number, number, number]; d: number; j: number }

export default class Catch extends Scene {
  text = new Layer2D();
  sh = new ShadowBatch(8);
  sb = new SpriteBatch(ATLAS.texture, ATLAS.canvas.width, ATLAS.canvas.height, 4, { flashColor: lin('goldHi') });
  grass!: SpriteBatch;
  ball!: SpriteBatch;
  rb = new RectBatch(64, 'add');
  pxb = new RectBatch(CELL * CELL + 16);
  gb = new GlowBatch(16);
  px: Px[] = [];
  grassBack!: SpriteBatch;
  C = D.cast.catch as { wild: string; ball: string; tuft: string; tuftBack: string };
  ground = 0;
  dio!: Diorama;
  bgCache = new Map<string, THREE.WebGLRenderTarget>();
  bgLive = makeRT(W, H, { depthBuffer: false });

  override async init() {
    const S = D.style.catch;
    const gi = IMG.get(`tuft:${this.C.tuft}`)!, bi = IMG.get(`item:${this.C.ball}`)!, gb = IMG.get(`tuft:${this.C.tuftBack}`)!;
    this.grass = new SpriteBatch(TEX.get(`tuft:${this.C.tuft}`)!, gi.width, gi.height, 64);
    this.grassBack = new SpriteBatch(TEX.get(`tuft:${this.C.tuftBack}`)!, gb.width, gb.height, 64);
    const CC = D.world.catch;
    this.dio = new Diorama(CC.fov, 'catch');
    await this.dio.build(CC.radius);
    this.dio.fireflies(0, 0, (x, z) => this.dio.heightAt(x, z), 13);
    this.ball = new SpriteBatch(TEX.get(`item:${this.C.ball}`)!, bi.width, bi.height, 2);
    this.ground = Math.round(D.style.layout.heroY + creatureHeight(this.C.wild, S.scale) / 2);
    // every opaque art pixel of the wild one: where it sits, its colour, and when it leaves for the ball
    const img = ATLAS.pixels.get(this.C.wild)!;
    const r = creatureRect(this.C.wild, 960, this.ground, S.scale);
    const toLin = (v: number) => hexToLinear('#' + v.toString(16).padStart(6, '0'));
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const k = (y * CELL + x) * 4;
      if (img.data[k + 3]! < 128) continue;
      const X = r.x + x * S.scale, Y = r.y + y * S.scale;
      this.px.push({ x: X, y: Y, c: toLin((img.data[k]! << 16) | (img.data[k + 1]! << 8) | img.data[k + 2]!), d: Math.hypot(X - S.hover[0], Y - S.hover[1]) / 500, j: hash(x, y, 13) });
    }
  }

  override sfx(): SfxEvent[] {
    const c = this.ctx.cues;
    return [
      { t: this.cueT('appear'), id: 'wild' }, { t: this.cueT('appear'), id: 'rustle' }, { t: this.beatT(c.appear + 0.25), id: 'rustle', pitch: 1.12 },
      { t: this.cueT('throw'), id: 'throw' },
      { t: this.cueT('hit'), id: 'ballHit' }, { t: this.beatT(c.hit + 0.05), id: 'absorb' },
      { t: this.cueT('land'), id: 'ballLand' },
      ...(c.shake as number[]).map((b) => ({ t: this.beatT(b), id: 'shake' })),
      { t: this.cueT('click'), id: 'caught' },
    ];
  }

  /**
   * The clearing at golden hour behind the sprites, seen through the same zoom/offset as the sprite batches
   * (camera.setViewOffset), so the push-in moves sprites and world together. Cached per zoom (it is static).
   */
  private backdrop(zoom: number, ox: number, oy: number, out: THREE.WebGLRenderTarget) {
    const r = this.ctx.renderer, CC = D.world.catch;
    const key = `${zoom.toFixed(5)}|${ox.toFixed(2)}|${oy.toFixed(2)}`;
    const still = zoom === 1 || Math.abs(zoom - D.style.catch.push.zoom) < 1e-9;
    let rt = still ? this.bgCache.get(key) : undefined;
    if (!rt) {
      rt = still ? makeRT(W, H, { depthBuffer: false }) : this.bgLive;
      const cam = this.dio.camera;
      cam.position.set(...(CC.camera[0] as [number, number, number]));
      cam.lookAt(...(CC.camera[1] as [number, number, number]));
      cam.setViewOffset(W, H, 960 - (960 + ox) / zoom, 540 - (540 + oy) / zoom, W / zoom, H / zoom);
      const tgt = new THREE.Vector3(...(CC.camera[1] as [number, number, number]));
      this.dio.setFog(CC.fog[0], CC.fog[1]);
      this.dio.setTime(0);
      this.dio.aimSun(tgt, 30);
      this.dio.aimPool(tgt);
      this.dio.render(r, rt, CC.focus.y, CC.focus.band, CC.focus.blurPx);
      if (still) this.bgCache.set(key, rt);
    }
    this.ctx.comp.draw(r, rt.texture, out, { mode: 'replace' });
  }

  /** Ball centre (px), rotation and scale at plate beat b. */
  private ballAt(b: number) {
    const S = D.style.catch, c = this.ctx.cues;
    const [hx, hy] = S.hover as [number, number];
    const gy = this.ground + S.ballGroundDy;
    if (b < c.hit) {
      // thrown from below frame-left on a parabola, spinning
      const k = prog(b, c.throw, c.hit);
      const [sx, sy] = S.throwFrom as [number, number];
      const x = sx + (hx - sx) * k, y = sy + (hy - sy) * k - S.throwArc * 4 * k * (1 - k);
      return { x, y, rot: -k * Math.PI * 3, vis: b >= c.throw };
    }
    if (b < c.drop) {
      // a small rebound off the hit, then it hangs while the light pours in
      const k = prog(b, c.hit, c.hit + 0.3, ease.outCubic);
      return { x: hx, y: hy - S.rebound * Math.sin(Math.PI * Math.min(1, k * 1.0)) * (1 - prog(b, c.hit + 0.3, c.drop)), rot: 0, vis: true };
    }
    if (b < c.land) {
      const k = prog(b, c.drop, c.land, ease.inQuad);
      return { x: hx, y: hy + (gy - hy) * k, rot: 0, vis: true };
    }
    // one small bounce, then the two rocks on the beat
    const bk = prog(b, c.land, c.land + 0.35);
    let y = gy - S.bouncePx * Math.sin(Math.PI * bk) * (bk < 1 ? 1 : 0);
    let rot = 0, dx = 0;
    for (const s of c.shake as number[]) {
      if (b >= s && b < s + S.shakeBeats) {
        const k = (b - s) / S.shakeBeats;
        rot += Math.sin(k * Math.PI * 2) * S.shakeRot * (1 - k * 0.3);
        dx += Math.round(Math.sin(k * Math.PI * 2) * 1) * S.ballScale;
      }
    }
    if (b >= c.click) { const k = prog(b, c.click, c.click + 0.25); y -= Math.round(Math.sin(Math.PI * k) * 2) * S.ballScale; }
    return { x: hx + dx, y, rot, vis: true };
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp, cues } = this.ctx;
    const S = D.style.catch;
    const b = f.lb, sc = S.scale, G = this.ground;
    // once the ball is down, a push-in to an integer pixel scale (4 -> 6 screen px per art px) that brings it to
    // the frame's centre column, so the two rocks and the click read
    const pz = prog(b, cues.land, cues.shake[0], ease.inOutCubic);
    const zoom = 1 + (S.push.zoom - 1) * pz;
    const [hx0] = S.hover as [number, number], bgy = G + S.ballGroundDy;
    const ox = (S.push.to[0] - ((hx0 - 960) * S.push.zoom + 960)) * pz, oy = (S.push.to[1] - ((bgy - 540) * S.push.zoom + 540)) * pz;
    for (const bt of [this.grass, this.grassBack, this.ball, this.sb, this.sh, this.rb, this.pxb, this.gb]) bt.setCam(zoom, ox, oy);
    const absorbed = b >= cues.hit + 0.08;
    this.backdrop(zoom, ox, oy, out);

    // grass: a back row (darker) and a front row, the game's tall and dark tufts alternating, each a whole art
    // pixel or two taller or shorter; it rustles when something moves in it
    const tw = 32 * S.tuftScale;
    const rustle = (b0: number) => (b >= b0 && b < b0 + 0.5 ? 1 - (b - b0) / 0.5 : 0);
    const rs = Math.max(rustle(cues.appear), rustle(cues.land) * 0.6);
    const tuftRow = (row: number) => {
      const n = S.tufts[row] as number, y0 = G + S.rowDy[row], tint = S.rowTint[row] as [number, number, number];
      this.grass.begin(); this.grassBack.begin();
      for (let i = 0; i < n; i++) {
        const x = 960 + (i - (n - 1) / 2) * S.tuftGap + (row ? 0 : S.tuftGap / 2) + Math.round((hash(i, row, 3) - 0.5) * 20 / S.tuftScale) * S.tuftScale;
        const sway = rs > 0 ? Math.round(Math.sin(f.ft * 40 + i * 1.7) * rs) * S.tuftScale : 0;
        const jit = Math.round(hash(i, row, 7) * S.tuftJitterArtPx) * S.tuftScale; // sunk 0..n art px into the ground (blade tips intact)
        const dark = (i + row) % 2 === 1, bt = dark ? this.grassBack : this.grass;
        // the dark tuft's cool grey-violet is warmed toward dusky olive so it sits in the golden-hour light
        const tt = dark ? tint.map((v, k) => v * (S.darkTint as number[])[k]!) as [number, number, number] : tint;
        bt.add({ x: Math.round(x - tw / 2 + sway), y: y0 - tw + jit, w: tw, h: tw - jit, uv: [0, 0, 32, 32 - jit / S.tuftScale], tint: tt, flip: hash(i, row, 5) > 0.5 });
      }
      this.grassBack.render(renderer, out); this.grass.render(renderer, out);
    };
    // the wild one's contact shadow on the ground, under the grass
    if (!absorbed) {
      const ab = ATLAS.box(this.C.wild);
      this.sh.begin().shadow(960, G, (ab.x1 - ab.x0) * sc * 0.8, S.contactShadow, 0.14);
      this.sh.render(renderer, out);
    }
    tuftRow(1);

    // the wild one: a surprised hop on the cut, then a one-art-pixel idle bob; gold on the hit
    if (!absorbed) {
      const u = b - cues.appear;
      const hop = u < 0.5 ? Math.sin(Math.PI * clamp(u / 0.5)) * S.hopPx : 0;
      const sq = u >= 0.5 && u < 0.9 ? 0.08 * Math.exp(-(u - 0.5) * 12) * Math.cos((u - 0.5) * 30) : 0;
      const bob = u >= 1 && ((b % 1) + 1) % 1 < 0.5 ? sc : 0;
      const hit = prog(b, cues.hit - 0.02, cues.hit + 0.06);
      this.sb.begin();
      const r = creatureRect(this.C.wild, 960, G, sc, { hop: Math.round((hop + bob) / sc) * sc, squash: Math.abs(sq) < 0.004 ? 0 : sq });
      this.sb.add({ ...r, uv: ATLAS.cell(this.C.wild), flash: hit, tint: D.world.light.spriteTint });
      this.sb.render(renderer, out);
    }

    // front row of grass over its feet
    tuftRow(0);

    // the ball (and its shadow once it is down)
    const bl = this.ballAt(b), bs = 32 * S.ballScale;
    if (b >= cues.land - 0.2) {
      // on the ground line under the ball (it shrinks while the ball is in the air)
      const air = Math.max(0, G + S.ballGroundDy - bl.y);
      this.sh.begin().shadow(bl.x, G + S.ballGroundDy + bs / 2 - S.ballShadowLiftPx, bs * 0.85 * (1 - Math.min(0.5, air / 300)), S.contactShadow * prog(b, cues.land - 0.3, cues.land) * (1 - Math.min(0.6, air / 200)), 0.18);
      this.sh.render(renderer, out);
    }
    if (bl.vis) {
      this.ball.begin().add({ x: bl.x - bs / 2, y: bl.y - bs / 2, w: bs, h: bs, uv: [0, 0, 32, 32], rot: bl.rot });
      this.ball.render(renderer, out);
    }

    // the light: every art pixel streams into the ball, cooling from its own colour to gold on the way in
    this.rb.begin(); this.gb.begin(); this.pxb.begin();
    const gold = lin('goldHi');
    if (absorbed && b < cues.hit + cues.absorb + 0.5) {
      const [hx, hy] = [bl.x, bl.y];
      for (const p of this.px) {
        const k = clamp((b - cues.hit - p.d * cues.absorb * 0.6 - p.j * 0.1) / (cues.absorb * 0.5));
        if (k >= 1) continue;
        const e = ease.inCubic(k);
        const curl = Math.sin(Math.PI * e) * (p.j - 0.5) * 60;
        const x = p.x + (hx - 2 - p.x) * e + curl, y = p.y + (hy - 2 - p.y) * e;
        const heat = Math.min(1, 0.6 + k);
        const col: [number, number, number] = [p.c[0] + (gold[0] * 1.3 - p.c[0]) * heat, p.c[1] + (gold[1] * 1.3 - p.c[1]) * heat, p.c[2] + (gold[2] * 1.3 - p.c[2]) * heat];
        const s = sc * (1 - 0.5 * e);
        this.pxb.rectPx(x, y, s, s, col, 1);
      }
      // the core of the ball glows while it fills (gold kept inside r <= coreR)
      const fill = prog(b, cues.hit, cues.hit + cues.absorb) * (1 - prog(b, cues.drop, cues.land));
      this.gb.glow(hx, hy, S.coreR, gold, S.coreI * fill);
    }
    // the click: three small stars rise from the ball
    if (b >= cues.click) {
      const k = (b - cues.click) / S.starBeats;
      if (k < 1) for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i - 1) * 0.75, d = S.starDist * ease.outCubic(k);
        const x = Math.round((bl.x + Math.cos(a) * d) / 4) * 4, y = Math.round((bl.y - bs * 0.2 + Math.sin(a) * d) / 4) * 4;
        const al = 1 - ease.inQuad(k), s = 4 * (k < 0.5 ? 2 : 1);
        const cc: [number, number, number] = [gold[0] * 2, gold[1] * 2, gold[2] * 2];
        this.rb.rectPx(x - 2, y - s - 2, 4, 2 * s + 4, cc, al);
        this.rb.rectPx(x - s - 2, y - 2, 2 * s + 4, 4, cc, al);
      }
    }
    this.pxb.render(renderer, out);
    this.gb.render(renderer, out);
    this.rb.render(renderer, out);

    // the game's message pops on the click (frame-stepped: type never smears)
    const c = this.text.ctx;
    this.text.clear();
    if (f.flb >= cues.click) {
      const k = prog(f.flb, cues.click, cues.click + 0.2, (t) => ease.outBack(t, 2.6));
      const line = copy('catch', { name: displayName(this.C.wild) }).zh;
      // above the grass as it stands after the push-in
      const bgy2 = G + S.ballGroundDy, grassTop = (G + S.rowDy[1] - 32 * S.tuftScale - bgy2) * S.push.zoom + S.push.to[1];
      const y = Math.round(grassTop - S.textGap - 13 * S.textScale);
      c.save(); c.translate(960, y); c.scale(k, k); c.translate(-960, -y);
      drawPixel(c, line, 960, y - 8 * S.textScale, S.textScale, { align: 'center', color: 'goldHi', outline: D.style.type.overPicture.outline, outlineAlpha: D.style.type.overPicture.outlineAlpha });
      c.restore();
    }
    void hex;
    comp.draw(renderer, this.text.upload(), out);
    return {};
  }
}
