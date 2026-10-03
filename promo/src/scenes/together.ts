// Plate 7 — together. A wide 3/4 overhead shot (the game's own camera angle) at dusk: two players walk toward
// each other along a diagonal path, partners in tow, meet and face each other; two speech bubbles (the player's
// name is the bubble's header) pop on the beat. Trainers are drawn at the creatures' pixel density (Scale2x).
import * as THREE from 'three';
import { Scene, type Frame, type SfxEvent } from '../engine/scene';
import { Layer2D } from '../engine/gl';
import { D, copy, rgba } from '../engine/data';
import { clamp, ease, keys, prog, type Key } from '../engine/util';
import { drawCopy, drawPixel, pixelWidth } from '../engine/text';
import { Diorama, characterBillboard, creatureBillboard, setCharFrame, type Billboard, type Tile } from './_diorama';

interface Walker { key: string; body: Billboard; pet: Billboard; dir: 1 | -1; name: string; say: string }

export default class Together extends Scene {
  dio!: Diorama;
  text = new Layer2D();
  walkers: Walker[] = [];
  ground = 0;
  d = new THREE.Vector2();

  override async init() {
    const C = D.world.together, W0 = D.world;
    this.dio = new Diorama(C.fov, 'together');
    this.ground = W0.baseHeight + W0.spawn.level * W0.levelHeight;
    this.d.set(C.walkDir[0], C.walkDir[1]).normalize();
    const d = this.d;
    await this.dio.build(C.radiusMax, (t: Tile) => {
      // signed distance from the diagonal path (negative = the camera's side)
      const sd = t.x * d.y - t.z * d.x;
      if (Math.abs(sd) <= C.flatHalf) { t.water = false; t.h = this.ground; t.biome = 'meadow'; t.top = W0.biomes.meadow.top; t.side = W0.biomes.meadow.side; }
      if (Math.abs(sd) <= C.pathHalfWidth) { t.top = 'path'; (t as any).noProps = true; }
      // keep the camera side clear (nothing between the lens and the path); trees stay behind it
      if (sd < C.clearBehind) (t as any).noProps = true;
    }, 0);
    const cast = D.cast.together as { character: string; partner: string }[];
    cast.forEach((c, i) => {
      const body = this.dio.add(characterBillboard(c.character, W0.world.hero.height, undefined, this.dio.sky, this.dio.rim));
      const pet = this.dio.add(creatureBillboard(c.partner, C.partnerHeight, undefined, this.dio.sky, this.dio.rim));
      const pl = D.copy.players[i];
      this.walkers.push({ key: c.character, body, pet, dir: i === 0 ? 1 : -1, name: pl.name, say: pl.say });
    });
    this.dio.fireflies(0, 0, () => this.ground, 9);
  }

  override sfx(): SfxEvent[] {
    const c = this.ctx.cues, ev: SfxEvent[] = [];
    // footsteps on the walk cycle's contact frames from the first step (on the re-entry's first hit), then the bubbles
    for (let b = c.walkStart; b < c.meet; b += 0.5) ev.push({ t: this.beatT(b), id: 'step', pitch: (b * 2) % 2 ? 0.9 : 1 });
    ev.push({ t: this.cueT('say1'), id: 'chat' }, { t: this.cueT('say2'), id: 'chat', pitch: 1.12246 });
    // the cut in from the world wide: a whoosh that peaks on the downbeat
    ev.push({ t: this.beatT(0) - D.world.together.cutWhooshLeadSec, id: 'cutWhoosh' });
    return ev;
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp, cues } = this.ctx;
    const C = D.world.together;
    const b = f.lb;
    this.dio.setTime(f.t);
    const cam = this.dio.camera;
    const ck = C.camera as [number, number[], number[]][];
    const kv = (i: number, sel: 1 | 2) => keys(b, ck.map((k) => [k[0], k[sel][i]!, ease.inOutQuad] as Key));
    cam.position.set(kv(0, 1), kv(1, 1), kv(2, 1));
    cam.lookAt(kv(0, 2), kv(1, 2), kv(2, 2));
    cam.updateMatrixWorld();
    this.dio.setFog(C.fogNearFar[0], C.fogNearFar[1]);
    const origin = new THREE.Vector3(0, this.ground, 0);
    this.dio.aimSun(origin, 24);
    this.dio.aimPool(origin);

    const meet = cues.meet as number, w0 = cues.walkStart as number;
    const speed = (C.walkFrom - C.meetGap / 2) / (meet - w0);
    const d = this.d;
    const heads: { x: number; y: number; w: Walker; i: number }[] = [];
    this.walkers.forEach((w, i) => {
      const walked = clamp(b - w0, 0, meet - w0) * speed;
      const along = -w.dir * (C.walkFrom - walked);
      const moving = b >= w0 && b < meet;
      const frame = moving ? Math.floor((b - w0) * 4) % 4 : 0;
      // walking toward each other on the side rows; at rest they stay turned to each other
      setCharFrame(w.body, w.key, w.dir === 1 ? 2 : 1, frame);
      const stepBob = moving && frame % 2 === 1 ? 0.04 : 0;
      const x = d.x * along, z = d.y * along;
      w.body.place(x, this.ground + stepBob, z, this.ground);
      w.body.face(cam);
      // the partner trails behind on the path and hops when they stop
      const pb = clamp(b - w0 - C.partnerLag * 0.3, 0, meet - w0);
      const palong = -w.dir * (C.walkFrom - pb * speed) - w.dir * C.partnerLag;
      const hop = !moving && b >= meet ? Math.max(0, Math.sin(Math.PI * clamp((b - meet - 0.25) / 0.5))) * 0.35 : moving ? (Math.floor((b - w0) * 2) % 2) * 0.05 : 0;
      w.pet.place(d.x * palong + C.petSide[0], this.ground + hop, d.y * palong + C.petSide[1], this.ground);
      w.pet.face(cam);
      const head = new THREE.Vector3(x, this.ground + D.world.world.hero.height * C.headTopFrac, z).project(cam);
      heads.push({ x: (head.x * 0.5 + 0.5) * 1920, y: (1 - (head.y * 0.5 + 0.5)) * 1080, w, i });
    });
    this.dio.render(renderer, out, C.focus.y, C.focus.band[0], C.focus.blurPx[0]);

    // speech bubbles: right above the head, a pixel tail, the player's name as the header (frame-stepped pop)
    const c = this.text.ctx;
    this.text.clear();
    const B = C.bubble, fb = f.flb;
    for (const h of heads) {
      const col = h.i === 0 ? 'goldHi' : 'sky';
      const sayAt = h.i === 0 ? cues.say1 : cues.say2;
      const k = prog(fb, sayAt, sayAt + 0.25, (t) => ease.outBack(t, 2.5));
      if (k <= 0) continue;
      const x = Math.round(h.x), tip = Math.round(h.y - B.gapPx);
      const tw = Math.max(pixelWidth(h.w.say, B.textScale), pixelWidth(h.w.name, B.nameScale));
      const bw = tw + B.pad * 2, bh = B.pad * 2 + 13 * B.nameScale + B.lineGap + 13 * B.textScale;
      const bx = Math.round(x - bw / 2), by = tip - B.tail - bh;
      c.save();
      c.translate(x, tip); c.scale(k, k); c.translate(-x, -tip);
      c.fillStyle = rgba('navy', 0.94); c.fillRect(bx, by, bw, bh);
      c.fillStyle = rgba(col); const e = B.border;
      c.fillRect(bx, by, bw, e); c.fillRect(bx, by + bh - e, bw, e); c.fillRect(bx, by, e, bh); c.fillRect(bx + bw - e, by, e, bh);
      // stepped tail, outlined in the player colour
      for (let r = 0; r < 3; r++) {
        const w = (3 - r) * 2 * e + e, y0 = by + bh - e + r * e * 2;
        c.fillStyle = rgba(col); c.fillRect(x - w / 2 - e, y0, w + 2 * e, e * 2);
        c.fillStyle = rgba('navy', 0.94); c.fillRect(x - w / 2, y0, w, e * 2);
      }
      drawPixel(c, h.w.name, bx + B.pad, by + B.pad - 2 * B.nameScale, B.nameScale, { color: col });
      drawPixel(c, h.w.say, bx + B.pad, by + B.pad + 13 * B.nameScale + B.lineGap - 2 * B.textScale, B.textScale);
      c.restore();
    }
    const cp = copy('together');
    // the line is there on the cut frame (eye trace from the world's line), typing from beat 0
    const ta = fb >= cues.copy ? 1 : 0;
    if (ta > 0) {
      // an ink wash from the top keeps the line clear of the treetops
      const g = c.createLinearGradient(0, 0, 0, C.copyY + 190);
      g.addColorStop(0, rgba('ink', C.copyWash * ta)); g.addColorStop(1, rgba('ink', 0));
      c.fillStyle = g; c.fillRect(0, 0, 1920, C.copyY + 190);
      const typed = (fb - cues.copy) / cues.copyRate;
      drawCopy(c, cp.zh, cp.en, 960, C.copyY, { alpha: ta, chars: typed + 1, enChars: clamp((typed + 1) / [...cp.zh].length) * cp.en.length, outline: true, enColor: 'bone' });
    }
    comp.draw(renderer, this.text.upload(), out);
    return {};
  }
}
