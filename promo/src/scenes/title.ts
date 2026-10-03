// Plate 10 — the title on the final chord. The gold point bursts, and its light becomes the sun of the game's own
// key art (public/assets/ui/title.png: the nine-heroine cast at golden hour): the art blooms out of the point
// (a radial reveal, over-exposed for a moment), then holds on a slow push about the sun. The logo assembles in
// 16-px tiles at 1:1 in the sky (darkened behind it), a pixel glint crosses it; 「都装进口袋」 and the call to action
// sit at the bottom on an ink falloff. Fade to pure black, held for the last frames.
import * as THREE from 'three';
import { Scene, type Frame, type SfxEvent } from '../engine/scene';
import { FSPass, Layer2D } from '../engine/gl';
import { GlowBatch, RectBatch, SpriteBatch } from '../engine/sprites';
import { IMG, TEX } from '../engine/assets';
import { D, copy, lin } from '../engine/data';
import { clamp, ease, frameIdx, hash, prog, pulse } from '../engine/util';
import { drawCopy, drawMono, drawPixel, monoWidth, pixelBody, pixelWidth } from '../engine/text';
import { typingSfx } from './_kit';

const TILE = 16;
const mix3 = (a: [number, number, number], b: [number, number, number], k: number): [number, number, number] => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

export default class Title extends Scene {
  text = new Layer2D();
  logo!: SpriteBatch;
  rb = new RectBatch(1024, 'add');
  gb = new GlowBatch(128);
  art!: FSPass;
  shine!: FSPass;

  override init() {
    const im = IMG.get('logo')!;
    this.logo = new SpriteBatch(TEX.get('logo')!, im.width, im.height, Math.ceil(im.width / TILE) * Math.ceil(im.height / TILE) + 4);
    const K = D.style.title.keyArt, ai = IMG.get('keyart')!;
    const v4 = (a: number[]) => new THREE.Vector4(a[0], a[1], a[2], a[3]);
    this.art = new FSPass(/* glsl */ `
      uniform sampler2D art; uniform vec2 artSize, pivot; uniform vec4 crop, darkLogo, darkBottom;
      uniform float push, exposure, reveal, soft, hot, darkLogoK, darkBottomK, vignette;
      void main() {
        vec2 px = vec2(vUv.x, 1.0 - vUv.y) * vec2(1920.0, 1080.0);
        vec2 q = (px - pivot) / push + pivot;
        vec2 auv = (crop.xy + q / vec2(1920.0, 1080.0) * crop.zw) / artSize;
        vec3 c = texture(art, auv).rgb * exposure;
        // it blooms out of the point: a radial reveal, over-exposed for a moment
        float d = length(px - pivot);
        c *= smoothstep(reveal, reveal - soft, d);
        c *= 1.0 + hot * (1.0 - smoothstep(0.0, max(reveal, 1.0), d) * 0.6);
        // the sky behind the logo and the bottom behind the type fall toward ink
        vec2 a = (px - darkLogo.xy) / darkLogo.zw, b = (px - darkBottom.xy) / darkBottom.zw;
        c *= 1.0 - darkLogoK * exp(-dot(a, a));
        c *= 1.0 - darkBottomK * exp(-dot(b, b));
        vec2 dc = vUv - 0.5;
        float v = smoothstep(0.95, 0.3, length(dc * vec2(1.0, 0.8)));
        c = mix(C_INK, c, mix(1.0, v, vignette));
        fragColor = vec4(c, 1.0);
      }`, {
      art: { value: TEX.get('keyart') }, artSize: { value: new THREE.Vector2(ai.width, ai.height) }, pivot: { value: new THREE.Vector2(...(K.pivot as [number, number])) },
      crop: { value: v4(K.crop) }, darkLogo: { value: v4(K.darkLogo) }, darkBottom: { value: v4(K.darkBottom) },
      push: { value: 1 }, exposure: { value: K.exposure }, reveal: { value: 0 }, soft: { value: K.revealSoftPx }, hot: { value: 0 },
      darkLogoK: { value: K.darkLogoK }, darkBottomK: { value: K.darkBottomK }, vignette: { value: K.vignette },
    });
    // the glint: an additive band a few art pixels wide, clipped to the logo's alpha, stepped in whole art pixels
    const Sh = D.style.title.shine;
    this.shine = new FSPass(/* glsl */ `
      uniform sampler2D logo; uniform vec4 rect; uniform float pos, width, slant, artPx, I; uniform vec3 col;
      void main() {
        vec2 px = vec2(vUv.x, 1.0 - vUv.y) * vec2(1920.0, 1080.0);
        vec2 l = (px - rect.xy) / rect.zw;
        if (l.x < 0.0 || l.y < 0.0 || l.x > 1.0 || l.y > 1.0) discard;
        float a = texture(logo, l).a;
        vec2 lp = floor((px - rect.xy) / artPx) * artPx;
        float dg = lp.x + lp.y * slant;
        float band = step(pos, dg) * step(dg, pos + width);
        fragColor = vec4(col * I * band * a, 1.0);
      }`, {
      logo: { value: TEX.get('logo') }, rect: { value: new THREE.Vector4() }, pos: { value: -1e4 }, width: { value: Sh.widthArtPx * Sh.artPx },
      slant: { value: Sh.slant }, artPx: { value: Sh.artPx }, I: { value: Sh.I }, col: { value: new THREE.Vector3(...lin(Sh.color)) },
    }, { blending: THREE.AdditiveBlending, transparent: true });
  }

  override sfx(): SfxEvent[] {
    const c = this.ctx.cues;
    return [{ t: this.cueT('logo'), id: 'catch' }, { t: this.cueT('logo'), id: 'boom' }, ...typingSfx(this, [...copy('tagline').zh], c.tagline, c.typeRate), { t: this.cueT('cta'), id: 'cta' }];
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp, cues } = this.ctx;
    const S = D.style.title, K = S.keyArt;
    const b = f.lb;
    const kb = b - cues.logo, ks = kb * this.spb; // beats / seconds since the burst
    const [px, py] = K.pivot as [number, number];
    const gold = lin('goldHi'), warm = lin(S.logoGlow), spark = lin(S.logoSpark);
    // the burst is gold; its light warms into the sunset over coolSec
    const cool = prog(ks, 0, S.coolSec, ease.inOutQuad);
    const burst = pulse(b, cues.logo, 0.35);
    const im = IMG.get('logo')!;
    const lx = Math.round(960 - im.width / 2), ly = Math.round(S.logoY - im.height / 2);

    // the key art: blooms out of the point, then a slow push about the sun
    const ka = ks - (cues.keyArtIn - cues.logo) * this.spb;
    const A = this.art.u;
    A.reveal!.value = ka < 0 ? 0 : K.revealMaxPx * ease.outCubic(clamp(ka / K.revealSec));
    A.hot!.value = ka < 0 ? 0 : K.hot * (1 - ease.outCubic(clamp(ka / K.hotSec)));
    A.push!.value = K.push[0] + (K.push[1] - K.push[0]) * clamp((f.t - this.beatT(cues.keyArtIn)) / (this.ctx.end - this.beatT(cues.keyArtIn)));
    this.art.render(renderer, out);

    // burst: a few gold pixels radiating from the point (capped, gone by debrisSec), warming as they fly
    this.rb.begin(); this.gb.begin();
    for (let i = 0; i < S.debris; i++) {
      const a = hash(i, 31) * Math.PI * 2, sp = 500 + hash(i, 32) * 900;
      const life = clamp(1 - ks / (S.debrisSec * (0.6 + 0.4 * hash(i, 33))));
      if (ks < 0 || life <= 0) continue;
      const r = sp * (1 - Math.exp(-ks * 6)) * 0.5;
      const pc = mix3(gold, spark, cool);
      this.rb.rectPx(Math.round((px + Math.cos(a) * r) / 4) * 4, Math.round((py + Math.sin(a) * r * 0.62) / 4) * 4, 4, 4, [pc[0] * 3, pc[1] * 3, pc[2] * 3], life);
    }
    // the point's light: a small gold core (r <= 60) inside a warm sunset glow, settling into the art's own sun
    this.gb.glow(px, py, 60, gold, S.burstGlow * 2 * burst * (1 - cool));
    this.gb.glow(px, py, 420, warm, S.burstGlow * burst);
    this.gb.glow(px, py, S.sunGlowR, warm, S.sunGlowI * prog(ks, 0.1, 0.8) * (0.9 + 0.1 * Math.sin(f.t * 2.4)));
    this.gb.render(renderer, out);

    // logo: whole 16-px tiles, swept column by column from the centre outward over sweepBeats. Each tile is either
    // there or not on a given frame (frame-stepped, never half-transparent through the shutter) and lands with a
    // short flash for tileFlashFrames frames
    const cols = Math.ceil(im.width / TILE), rows = Math.ceil(im.height / TILE);
    const fk = f.flb - cues.logo, fi = frameIdx(f.ft);
    this.logo.begin();
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const dc = Math.abs((i + 0.5) / cols - 0.5) * 2; // 0 centre .. 1 edge
      const at = dc * cues.sweepBeats;
      if (fk < at) continue;
      const age = fi - frameIdx(this.beatT(cues.logo + at)); // frames since this column landed
      const w = Math.min(TILE, im.width - i * TILE), h = Math.min(TILE, im.height - j * TILE);
      const fl = age < S.tileFlashFrames ? 0.8 * (1 - age / S.tileFlashFrames) : 0;
      this.logo.add({ x: lx + i * TILE, y: ly + j * TILE, w, h, uv: [i * TILE, j * TILE, w, h], flash: fl });
    }
    const fc = mix3(gold, spark, cool);
    this.logo.setFlashColor([fc[0] * 1.3, fc[1] * 1.3, fc[2] * 1.3]);
    this.logo.render(renderer, out);
    // the glint: frame-stepped, in whole art pixels
    const Sh = S.shine, sk = (f.ft - this.beatT(cues.shine)) / Sh.sec;
    if (sk >= 0 && sk <= 1) {
      const span = im.width + im.height * Sh.slant + Sh.widthArtPx * Sh.artPx;
      const U = this.shine.u;
      (U.rect!.value as THREE.Vector4).set(lx, ly, im.width, im.height);
      U.pos!.value = Math.round((-Sh.widthArtPx * Sh.artPx + span * ease.inOutQuad(sk)) / Sh.artPx) * Sh.artPx;
      this.shine.render(renderer, out);
    }
    this.rb.render(renderer, out);

    const c = this.text.ctx;
    this.text.clear();
    const fb = f.flb;
    const tg = copy('tagline'), cta = copy('cta');
    const T = D.style.type;
    const ta = prog(fb, cues.tagline, cues.tagline + 0.5, ease.outCubic);
    if (ta > 0) {
      const typed = (fb - cues.tagline) / cues.typeRate;
      drawCopy(c, tg.zh, tg.en, 960, S.taglineY, { chars: typed + 1, enChars: clamp((typed + 1) / [...tg.zh].length) * tg.en.length, zhScale: T.narratorScale, enPx: T.narratorEnPx, outline: true, enColor: 'bone' });
    }
    // CTA: Chinese (pixel) · English (mono), one gold, centred on one visual line (CJK body centre = cap-height centre)
    const ctaZs = S.ctaZhScale, ctaEp = S.ctaEnPx, tr = S.ctaTracking;
    const zw = pixelWidth(cta.zh, ctaZs), ew = monoWidth(c, cta.en, ctaEp, tr, 500);
    const dotW = S.ctaDotArtPx * ctaZs, gap = S.ctaGapArtPx * ctaZs;
    const total = zw + gap + dotW + gap + ew, cx0 = Math.round(960 - total / 2);
    const ca = prog(fb, cues.cta, cues.cta + 0.6, ease.outCubic);
    if (ca > 0) {
      const B = pixelBody();
      const mid = S.ctaY - Math.round(ctaEp * S.ctaCapHeight / 2); // centre of the English caps (baseline ctaY)
      const zTop = Math.round((mid - (B.top + B.bottom) / 2 * ctaZs) / ctaZs) * ctaZs;
      const OP = T.overPicture;
      drawPixel(c, cta.zh, cx0, zTop, ctaZs, { color: 'goldHi', alpha: ca, outline: OP.outline, outlineAlpha: OP.outlineAlpha });
      c.save(); c.globalAlpha = ca; c.fillStyle = D.style.palette.goldHi!;
      c.fillRect(cx0 + zw + gap, Math.round(mid - dotW / 2), dotW, dotW); c.restore();
      drawMono(c, cta.en, cx0 + zw + gap + dotW + gap, S.ctaY, ctaEp, { color: 'goldHi', alpha: ca, tracking: tr, weight: 500, shadow: OP.enShadow });
      // the destination, once the owner decides on one (data/copy.json cta.url; empty = none)
      const url = (D.copy.cta.url as string | undefined) ?? '';
      if (url) drawMono(c, url, 960, S.ctaY + S.urlDy, D.style.type.enPx, { color: 'bone', align: 'center', alpha: ca, tracking: 0.08, shadow: OP.enShadow });
    }
    comp.draw(renderer, this.text.upload(), out);
    // fade to black, then hold pure black for the last frames
    const fadeEnd = this.ctx.end - cues.blackSec, fadeStart = fadeEnd - cues.fadeOutSec;
    const fade = f.t >= fadeEnd ? 1 : clamp((f.t - fadeStart) / cues.fadeOutSec) ** 1.5;
    const fl = S.flash;
    return {
      fade, flash: fl.I * pulse(ks, 0, fl.halfLifeSec), flashR: fl.r, flashPos: [px, py] as [number, number],
      flashCore: frameIdx(f.ft) === frameIdx(this.cueT('logo')) ? fl.core : 0, flashCoreR: fl.coreR, flashColor: lin('bone'),
    };
  }
}
