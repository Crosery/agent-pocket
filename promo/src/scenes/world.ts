// Plate 6 — a world without end. Golden hour. It opens low and close on the player and her partner (DeepSeek-V4,
// caught in the catch plate) on a lit clearing, encounter grass soft in the foreground, fireflies, the sun low on
// the horizon behind them; then one continuous crane up and back while the world generates outward: tiles rise
// under the gold frontier, the other heroines drop in where it has passed. It ends on a 3/4 wide (the pair still
// ≥ 90 px tall in the lower third) with the frontier racing off into the sunset haze, and 「一个没有尽头的世界」
// types in the sky.
import * as THREE from 'three';
import { Scene, type Frame, type SfxEvent } from '../engine/scene';
import { Layer2D } from '../engine/gl';
import { D, copy, lin } from '../engine/data';
import { clamp, ease, hash, keys, prog, type Key } from '../engine/util';
import { drawCopy } from '../engine/text';
import { Diorama, characterBillboard, creatureBillboard, tuftBillboard, type Billboard } from './_diorama';

interface Board { b: Billboard; x: number; z: number; ph: number; birth: number | null; still?: boolean; minBeat?: number }

export default class World extends Scene {
  dio!: Diorama;
  text = new Layer2D();
  boards: Board[] = [];
  curve!: THREE.CatmullRomCurve3;
  tcurve!: THREE.CatmullRomCurve3;
  camBeats: number[] = [];

  override async init() {
    const C = D.world.world;
    this.dio = new Diorama(C.fov, 'world');
    await this.dio.build(C.radiusMax);
    const { sky, rim, frontier } = this.dio;
    const add = (b: Billboard, x: number, z: number, ph: number, birth: number | null, still = false, blob = true) => {
      this.dio.add(b, blob);
      b.place(x, this.dio.heightAt(x, z), z);
      this.boards.push({ b, x, z, ph, birth, still });
    };
    add(characterBillboard(C.hero.character, C.hero.height, frontier, sky, rim), C.hero.at[0], C.hero.at[1], 0, null);
    add(creatureBillboard(D.cast.world.partner, C.partner.height, frontier, sky, rim), C.partner.at[0], C.partner.at[1], 0.5, null);
    // extras: the data gives approximate spots; each snaps to the nearest standable tile and drops in once the
    // frontier has passed it
    (D.cast.world.extras as string[]).forEach((id, i) => {
      const p = C.extras[i];
      if (!p) return;
      const [x, z] = this.dio.nearestStandable(p[0], p[1]);
      add(creatureBillboard(id, C.creatureHeight, frontier, sky, rim), x, z, i * 0.37, this.dio.birthAt(x, z));
      this.boards[this.boards.length - 1]!.minBeat = (C.extrasBeats as number[] | undefined)?.[i] ?? 0;
    });
    // encounter grass: foreground clumps for depth, and a loose ring around the clearing (low-res pass, no blobs)
    const T = C.tufts;
    for (const [x, z, h] of T.near as [number, number, number][]) add(tuftBillboard(T.key, h, sky), x, z, 0, null, true, false);
    for (let i = 0; i < T.ring.n; i++) {
      const a = hash(i, T.ring.seed) * Math.PI * 2, r = T.ring.r[0] + hash(i, T.ring.seed + 1) * (T.ring.r[1] - T.ring.r[0]);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      add(tuftBillboard(T.key, T.ring.h[0] + hash(i, T.ring.seed + 2) * (T.ring.h[1] - T.ring.h[0]), sky), x, z, 0, null, true, false);
    }
    this.dio.fireflies(0, 0, (x, z) => this.dio.heightAt(x, z));
    const cam = C.camera as [number, number[], number[]][];
    this.camBeats = cam.map((k) => k[0]);
    this.curve = new THREE.CatmullRomCurve3(cam.map((k) => new THREE.Vector3(...k[1])), false, 'centripetal');
    this.tcurve = new THREE.CatmullRomCurve3(cam.map((k) => new THREE.Vector3(...k[2])), false, 'centripetal');
  }

  /** Beat at which an extra lands: the frontier has passed it by landAfterTiles, and not before its own beat (-1: never in this plate). */
  private landBeat(bd: Board) {
    const C = D.world.world;
    if (bd.birth === null) return -1;
    for (let b = 0; b < 16; b += 1 / 32) if (this.radius(b) >= bd.birth! + C.landAfterTiles) return Math.max(b, bd.minBeat ?? 0);
    return -1;
  }

  /** Frontier radius (tiles) at plate beat b. */
  private radius(b: number) { return keys(b, (D.world.world.radiusKeys as [number, number][]).map(([bb, r]) => [bb, r, ease.inOutQuad] as Key)); }

  override sfx(): SfxEvent[] {
    // a soft pop as each extra lands (the beat of its arrival, from the same frontier keys the picture uses)
    const C = D.world.world, ev: SfxEvent[] = [];
    for (const bd of this.boards) {
      const b0 = this.landBeat(bd);
      if (b0 > 0) ev.push({ t: this.beatT(b0 + C.dropBeats), id: 'pop', pitch: 2 ** ((bd.ph * 13 % 5) / 12) });
    }
    return ev;
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp, cues } = this.ctx;
    const C = D.world.world;
    const b = f.lb;
    const total = this.camBeats[this.camBeats.length - 1]!;
    this.dio.setTime(f.t);
    // camera: eased progress along the key curve (moving from the first frame, easing into the cut)
    const u = clamp(b / total);
    const e = 0.15 * u + 0.85 * ease.inOutSine(u);
    const cam = this.dio.camera;
    cam.position.copy(this.curve.getPoint(e));
    const tgt = this.tcurve.getPoint(e);
    cam.lookAt(tgt);
    cam.updateMatrixWorld();
    const dist = cam.position.distanceTo(tgt);
    const fk = C.fog as [number, number, number][];
    const fogK = (i: 1 | 2) => keys(b, fk.map((k) => [k[0], k[i], ease.inOutQuad] as Key));
    this.dio.setFog(dist * fogK(1), dist * fogK(2));
    const hero = new THREE.Vector3(C.hero.at[0], this.dio.heightAt(C.hero.at[0], C.hero.at[1]), C.hero.at[1]);
    this.dio.aimSun(hero.clone().lerp(tgt, 0.5), Math.max(14, dist * 0.9));
    this.dio.aimPool(hero);

    const fr = this.dio.frontier;
    const R = this.radius(b);
    fr.uR.value = R;
    // tiles rise over a distance that scales with the view, so the wavefront reads at every height
    fr.uRise.value = clamp(C.rise.perDist * dist, C.rise.min, C.rise.max);
    fr.uBand.value = Math.max(C.rise.bandMin, fr.uRise.value * C.rise.band);
    fr.uGold.value.setRGB(...lin(C.rise.color ?? 'goldHi')).multiplyScalar(C.rise.gold);
    fr.uDrop.value = 4 + dist * 0.08;

    // pixel-art idle: a one-frame bob on the beat; billboards face the camera; extras drop in behind the frontier
    for (const bd of this.boards) {
      const ground = this.dio.heightAt(bd.x, bd.z);
      const bob = !bd.still && ((b + bd.ph) % 1 + 1) % 1 < 0.5 ? 0.04 : 0;
      let y = ground + bob, sx = 1, sy = 1, vis = true;
      if (bd.birth !== null) {
        // the beat at which the frontier passed this spot (+ a little), then a drop with a squash on contact
        const b0 = this.landBeat(bd);
        if (b0 < 0 || b < b0) vis = false;
        else if (b0 === 0) { /* already there when the plate starts */ }
        else {
          const k = (b - b0) / C.dropBeats;
          if (k < 1) y += (1 - ease.inQuad(clamp(k))) * C.dropHeight;
          else { const a = (b - b0 - C.dropBeats) * this.spb; const q = 0.12 * Math.exp(-a * 9) * Math.cos(a * 24); sx = 1 + q; sy = 1 - q; }
        }
      }
      bd.b.mesh.visible = vis;
      bd.b.place(bd.x, y, bd.z, ground, sx, sy);
      bd.b.face(cam);
    }
    // the focus band follows the pair's feet, widening as we rise
    const p = hero.clone().setY(hero.y + 0.6).project(cam);
    const fy = clamp(p.y * 0.5 + 0.5, 0.12, 0.8);
    const band = keys(u, [[0, C.focus.band[0]], [1, C.focus.band[1], ease.inOutQuad]]);
    const blur = keys(u, [[0, C.focus.blurPx[0]], [1, C.focus.blurPx[1]]]);
    this.dio.render(renderer, out, fy * (1 - u * 0.3) + C.focus.endY * u * 0.3, band, blur);

    // the line types in the sky, above the light on the horizon
    const c = this.text.ctx;
    this.text.clear();
    const cp = copy('world');
    const fb = f.flb;
    const ta = prog(fb, cues.copy, cues.copy + 0.4, ease.outCubic);
    if (ta > 0) {
      const typed = (fb - cues.copy) / cues.copyRate;
      drawCopy(c, cp.zh, cp.en, 960, C.copyY, { chars: typed + 1, enChars: clamp((typed + 1) / [...cp.zh].length) * cp.en.length, outline: true, enColor: 'bone' });
    }
    comp.draw(renderer, this.text.upload(), out);
    return {};
  }
}
