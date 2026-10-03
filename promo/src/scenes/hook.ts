// Plate 1 — "You talk to AI every day / but you have never seen them." The gold text cursor is there from the
// first frame; it types two lines (in the copy's rhythm), then glides to the frame centre where the next
// plate unpacks it into the first creature.
import * as THREE from 'three';
import { Scene, type Frame, type SfxEvent } from '../engine/scene';
import { Layer2D } from '../engine/gl';
import { RectBatch } from '../engine/sprites';
import { D, copy } from '../engine/data';
import { drawCopy, pixelBody, pixelPrefixWidth, pixelWidth } from '../engine/text';
import { clamp, ease, prog } from '../engine/util';
import { Backdrop, cursor, typingSfx } from './_kit';

export default class Hook extends Scene {
  bg = new Backdrop();
  text = new Layer2D();
  rb = new RectBatch(16);

  private lines() { return [copy('hook1'), copy('hook2')]; }

  override cutTimes() { return [this.cueT('line2')]; }

  override sfx(): SfxEvent[] {
    const c = this.ctx.cues;
    return this.lines().flatMap((l, i) => typingSfx(this, [...l.zh], i ? c.line2 : c.line1, i ? c.line2Rate : c.line1Rate));
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp, cues } = this.ctx;
    const T = D.style.type;
    const b = f.lb;
    this.bg.set({}).render(renderer, out);

    const lines = this.lines();
    const starts = [cues.line1, cues.line2], rates = [cues.line1Rate, cues.line2Rate];
    const li = b >= cues.line2 ? 1 : b >= cues.line1 ? 0 : -1;
    // the narrator's lines are set big (data/style.json type.narratorScale); the cursor settles into the reveal's 4x cursor
    const sc = T.narratorScale, rs = T.zhScale, B = pixelBody();
    const y = 540 - (13 + 3) * sc / 2 - 30;
    const c = this.text.ctx;
    this.text.clear();
    let curX = 960, typing = false;
    // the cursor is exactly the CJK glyph body tall and sits on its baseline
    const curY = Math.round(y / sc) * sc + B.top * sc, curH = (B.bottom - B.top) * sc;
    if (li >= 0) {
      const l = lines[li]!;
      const chars = [...l.zh];
      const n = (f.flb - starts[li]) / rates[li];
      const shown = Math.min(chars.length, Math.floor(n) + 1);
      typing = n < chars.length;
      // after the centring glide starts the line fades; the cursor carries on alone
      const fadeOut = 1 - prog(b, cues.toCenter, cues.toCenter + 0.5, ease.outCubic);
      const enN = Math.floor(clamp((n + 1) / chars.length) * l.en.length);
      drawCopy(c, l.zh, l.en, 960, y, { alpha: fadeOut, chars: shown, enChars: enN, zhScale: sc, enPx: T.narratorEnPx });
      const full = pixelWidth(l.zh, sc);
      curX = Math.round((960 - full / 2) / sc) * sc + pixelPrefixWidth(l.zh, shown, sc) + T.pixelSpacing.zhGapPx * sc;
    } else curX = 960 - 3 * rs;
    comp.draw(renderer, this.text.upload(), out);

    // cursor: there from the first frame, blinks on the beat while idle, solid while typing, glides to centre at the end
    const fadeIn = prog(b, cues.cursorIn, cues.cursorIn + 0.25, ease.outCubic);
    // (a true blink: off is off, so the cursor is only ever gold)
    const blink = typing ? 1 : ((f.flb % 1) + 1) % 1 < 0.6 ? 1 : 0;
    const g = prog(b, cues.toCenter, cues.toCenter + 0.75, ease.inOutCubic);
    const cx = curX + (960 - 3 * rs - curX) * g, cy = curY + (D.style.layout.heroY - 6 * rs - curY) * g;
    // it settles into the reveal's cursor (12 design px tall at 4x) as it glides
    const h = curH + (12 * rs - curH) * g;
    this.rb.begin();
    cursor(this.rb, cx, cy, sc + (rs - sc) * g, fadeIn * (g > 0 ? 1 : blink), undefined, h);
    this.rb.render(renderer, out);
    return {};
  }
}
