// Plate 3 — faces. One AI per cut, centred, 4x, landing on the beat; cuts accelerate (2, 1, then 1/2 beat)
// into the multiply plate. A faint glow in each creature's type colour gives the cuts a colour rhythm.
import * as THREE from 'three';
import { Scene, type Frame, type SfxEvent } from '../engine/scene';
import { Layer2D } from '../engine/gl';
import { SpriteBatch } from '../engine/sprites';
import { ATLAS } from '../engine/assets';
import { D } from '../engine/data';
import { Backdrop, ShadowBatch, drawCreature, drawLabel, haloLight, landing, creatureHeight } from './_kit';

export default class Faces extends Scene {
  bg = new Backdrop();
  text = new Layer2D();
  sb = new SpriteBatch(ATLAS.texture, ATLAS.canvas.width, ATLAS.canvas.height, 4);
  sh = new ShadowBatch(4);
  slots: { id: string; s: number; d: number }[] = [];

  override init() {
    const ids: string[] = D.cast.faces, beats: number[] = D.cast.facesBeats;
    let s = 0;
    ids.forEach((id, i) => { this.slots.push({ id, s, d: beats[i]! }); s += beats[i]!; });
  }

  override cutTimes() { return this.slots.slice(1).map((sl) => this.beatT(sl.s)); }
  override sfx(): SfxEvent[] { return this.slots.map((sl, i) => ({ t: this.beatT(sl.s), id: sl.d >= 1 ? 'face' : 'faceFast', pitch: 2 ** ((i % 4) * 2 / 12) })); }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx;
    const b = f.lb, sc = 4, L = D.style.layout;
    let i = this.slots.length - 1;
    while (i > 0 && this.slots[i]!.s > b) i--;
    const sl = this.slots[i]!;
    const u = b - sl.s;
    this.bg.set(haloLight(ATLAS.tone(sl.id), 'faces')).render(renderer, out);

    const ground = Math.round(L.heroY + creatureHeight(sl.id, sc) / 2);
    // the first face lands on the groove's first bass hit (cue firstLand), the rest on their cut
    const first = i === 0 && typeof this.ctx.cues.firstLand === 'number';
    const lnd = landing(u, first ? this.ctx.cues.firstLand : Math.min(0.3, sl.d * 0.5), first ? D.style.motion.hopPx * 2 : undefined);
    const box = ATLAS.box(sl.id);
    this.sh.begin().shadow(960, ground, (box.x1 - box.x0) * sc * 0.9 * (1 - lnd.hop / 120), 0.55, 0.16);
    this.sh.render(renderer, out);
    this.sb.begin();
    drawCreature(this.sb, sl.id, 960, ground, sc, { hop: Math.round(lnd.hop / sc) * sc, squash: lnd.squash });
    this.sb.render(renderer, out);

    const c = this.text.ctx;
    this.text.clear();
    // the card is there, fully opaque, on the cut frame itself (a fade on half-beat cuts reads as flicker)
    drawLabel(c, sl.id, 960, L.labelY, { meta: sl.d >= 1 });
    comp.draw(renderer, this.text.upload(), out);
    return {};
  }
}
