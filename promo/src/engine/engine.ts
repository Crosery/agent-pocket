// The engine: owns the renderer, loads scenes for the timeline, renders any time deterministically
// (with preroll for stateful scenes), composites transitions and post.
// Adapted from mexicat/pdoom-video (MIT, see THIRD_PARTY.md): lyrics/HUD removed, data-driven timeline.
import * as THREE from 'three';
import { AudioData } from './audio';
import { Compositor, FSPass, W, H, PW, PH, SCALE, SS_TAP, makeRT, clearRT } from './gl';
import { DEFAULT_POST, Post, SHOULDER_GLSL, type PostParams } from './post';
import type { Frame, Scene, SceneClass, SceneCtx, PostOverrides } from './scene';
import { D, loadData, type PlateDef } from './data';
import { loadFonts } from './text';
import { loadAssets } from './assets';

export interface TimelineEntry {
  id: string;
  load: () => Promise<{ default: SceneClass }>;
  start: number;
  end: number;
  plate: PlateDef;
  post?: PostOverrides;
  params?: Record<string, any>;
  maxSamples?: number;
}

interface Loaded { entry: TimelineEntry; scene: Scene | null; error?: string; lastT: number }

/**
 * Per-frame adaptive motion-blur sampling (see Engine.render): the sub-frame count steps through
 * 4, 12, 36, 108, 324 … from `min` up to at most `max` (both rounded to that series) until the frame's
 * estimated remaining sampling error is below `tol` 8-bit levels everywhere (worst 2x2-logical-px block).
 */
export interface AdaptiveSampling { min: number; max: number; tol: number }

/**
 * Shutter offsets (-0.5..0.5) of an adaptive run's sub-frames in rendering order: 4 evenly spread, then
 * each step splits every interval in three, adding a sub-frame either side of each old one. Every
 * prefix of 4·3^l is then evenly spread and centred on the frame's time, and so is each step's new set:
 * comparing the new set's average with the old one's measures sampling error, not a shift in time
 * (with doublings the new half sits half a step later, and any motion at all would read as error).
 */
function ternaryOffsets(steps: number) {
  const u = [0, 1, 2, 3].map((i) => (i + 0.5) / 4 - 0.5);
  for (let l = 0, n = 4; l < steps; l++, n *= 3)
    for (let m = 0; m < n; m++) u.push((3 * m + 0.5) / (3 * n) - 0.5, (3 * m + 2.5) / (3 * n) - 0.5);
  return u;
}

export class Engine {
  renderer: THREE.WebGLRenderer;
  audio!: AudioData;
  post!: Post;
  comp = new Compositor();
  loaded = new Map<string, Loaded>();
  private rts = [makeRT(), makeRT(), makeRT()];
  private mixRT = makeRT(W, H, { depthBuffer: false });
  // motion-blur sub-frame sums (float: up to hundreds of sub-frames), their average, and the error estimate
  private sumRT = makeRT(W, H, { depthBuffer: false, type: THREE.FloatType });
  private newRT = makeRT(W, H, { depthBuffer: false, type: THREE.FloatType });
  private avgRT = makeRT(W, H, { depthBuffer: false });
  private errRT: THREE.WebGLRenderTarget;
  private maxRT: THREE.WebGLRenderTarget;
  private errPass: FSPass;
  private maxPass: FSPass;
  private errBuf: Float32Array;
  /** Sub-frames used for the last rendered frame, and its estimated sampling error after each step. */
  lastSamples = 1;
  lastErrors: number[] = [];
  private finalRT = new THREE.WebGLRenderTarget(PW, PH, { type: THREE.UnsignedByteType, depthBuffer: false });
  private blit: FSPass;
  private xfade: FSPass;
  private accum: FSPass;
  private lastT = -1;
  lastPost: PostParams = { ...DEFAULT_POST };
  errors: string[] = [];
  timeline: TimelineEntry[] = [];
  /** Every hard cut (plate boundaries + scene cutTimes()), sorted: the shutter is closed across them. */
  cuts: number[] = [];

  constructor(public canvas: HTMLCanvasElement, private makeTimeline: (audio: AudioData) => TimelineEntry[]) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(PW, PH, false);
    this.renderer.autoClear = false;
    this.blit = new FSPass(`uniform sampler2D src; void main(){ fragColor = texture(src, vUv); }`, { src: { value: null } });
    this.xfade = new FSPass(`uniform sampler2D a; uniform sampler2D b; uniform float k;
      void main(){ fragColor = mix(texture(a, vUv), texture(b, vUv), k); }`, { a: { value: null }, b: { value: null }, k: { value: 0 } });
    // adds a sub-frame to a sum; a non-finite pixel (a stray NaN from some shader in one sub-frame out of
    // hundreds) is dropped, or it would poison the average and bloom into a disc
    this.accum = new FSPass(`uniform sampler2D src;
      void main() {
        vec4 c = texture(src, vUv);
        bool ok = abs(c.r) <= 6e4 && abs(c.g) <= 6e4 && abs(c.b) <= 6e4 && abs(c.a) <= 6e4;
        fragColor = ok ? c : vec4(0.0);
      }`, { src: { value: null } }, { blending: THREE.CustomBlending, transparent: true });
    const am = this.accum.mat;
    am.blendEquation = THREE.AddEquation;
    am.blendSrc = THREE.OneFactor; am.blendDst = THREE.OneFactor;
    am.blendSrcAlpha = THREE.ZeroFactor; am.blendDstAlpha = THREE.OneFactor;
    // sampling error: per block of B x B physical px (2x2 logical), how far the displayed average moves when a
    // step's new sub-frames (2n, summed in b) are merged with the n before them (summed in a): 2/3 of the gap
    const B = 2 * SCALE, ew = Math.ceil(PW / B), eh = Math.ceil(PH / B), R = 16;
    const small = { depthBuffer: false, type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, pxScale: 1 } as const;
    this.errRT = makeRT(ew, eh, small);
    this.maxRT = makeRT(Math.ceil(ew / R), Math.ceil(eh / R), small);
    this.errBuf = new Float32Array(this.maxRT.width * this.maxRT.height * 4);
    this.errPass = new FSPass(/* glsl */ `
      uniform sampler2D a; uniform sampler2D b; uniform float invA, invB;
      ${SHOULDER_GLSL}
      vec3 disp(vec3 x) { return toSRGB(sat(shoulder(max(x, 0.0)))); }
      void main() {
        ivec2 p0 = ivec2(gl_FragCoord.xy) * ${B}, lim = ivec2(${PW - 1}, ${PH - 1});
        vec3 sa = vec3(0.0), sb = vec3(0.0);
        for (int y = 0; y < ${B}; y++) for (int x = 0; x < ${B}; x++) {
          ivec2 p = min(p0 + ivec2(x, y), lim);
          sa += texelFetch(a, p, 0).rgb; sb += texelFetch(b, p, 0).rgb;
        }
        vec3 e = abs(disp(sa * (invA / ${B * B}.0)) - disp(sb * (invB / ${B * B}.0)));
        fragColor = vec4(170.0 * max(e.r, max(e.g, e.b)), 0.0, 0.0, 1.0);
      }`, { a: { value: null }, b: { value: null }, invA: { value: 1 }, invB: { value: 1 } });
    this.maxPass = new FSPass(/* glsl */ `
      uniform sampler2D e;
      void main() {
        ivec2 p0 = ivec2(gl_FragCoord.xy) * ${R};
        float m = 0.0;
        for (int y = 0; y < ${R}; y++) for (int x = 0; x < ${R}; x++) {
          ivec2 p = p0 + ivec2(x, y);
          if (p.x < ${ew} && p.y < ${eh}) m = max(m, texelFetch(e, p, 0).r);
        }
        fragColor = vec4(m, 0.0, 0.0, 1.0);
      }`, { e: { value: null } });
  }

  async init(only?: (e: TimelineEntry) => boolean) {
    await loadData();
    Object.assign(DEFAULT_POST, D.style.post);
    [this.audio] = await Promise.all([AudioData.load(), loadFonts(), loadAssets()]) as [AudioData, void, void];
    this.timeline = this.makeTimeline(this.audio);
    this.post = new Post();
    const entries = only ? this.timeline.filter(only) : this.timeline;
    await Promise.all(entries.map((e) => this.loadEntry(e)));
    this.collectCuts();
  }

  private collectCuts() {
    const c = new Set<number>();
    for (const e of this.timeline) { if (e.start > 0) c.add(e.start); c.add(e.end); }
    for (const rec of this.loaded.values()) for (const x of rec.scene?.cutTimes() ?? []) c.add(x);
    this.cuts = [...c].sort((a, b) => a - b);
  }

  /** All scenes' sound events, sorted by time (scripts/render.ts sfx -> data/sfx_events.json). */
  sfxEvents() {
    const ev: { t: number; id: string; gain?: number; pitch?: number; plate: string }[] = [];
    for (const rec of this.loaded.values()) for (const x of rec.scene?.sfx() ?? []) ev.push({ ...x, plate: rec.entry.id });
    return ev.sort((a, b) => a.t - b.t);
  }

  /** [last cut <= t, first cut > t] */
  private cutWindow(t: number): [number, number] {
    let lo = -Infinity, hi = Infinity;
    for (const c of this.cuts) { if (c <= t) lo = c; else { hi = c; break; } }
    return [lo, hi];
  }

  private async loadEntry(e: TimelineEntry) {
    const rec: Loaded = { entry: e, scene: null, lastT: -1 };
    this.loaded.set(e.id, rec);
    try {
      const mod = await e.load();
      const ctx: SceneCtx = { renderer: this.renderer, audio: this.audio, comp: this.comp, W, H, id: e.id, plate: e.plate, cues: e.plate.cues ?? {}, params: e.params ?? {}, start: e.start, end: e.end, beat0: this.beat0(e) };
      const s = new mod.default(ctx);
      await s.init();
      rec.scene = s;
    } catch (err) {
      rec.error = String((err as Error)?.stack ?? err);
      this.errors.push(`[${e.id}] ${rec.error}`);
      console.error(`scene ${e.id} failed`, err);
    }
  }

  /** Hot-swap a scene module (used by Vite HMR in preview). */
  async reload(id: string) {
    const e = this.timeline.find((x) => x.id === id);
    if (!e) return;
    this.loaded.get(id)?.scene?.dispose();
    await this.loadEntry(e);
    this.collectCuts();
    this.lastT = -1;
  }

  /** Film length: the end of the last plate (title `to` in data/timeline.json), never past the audio. */
  get duration() { return Math.min(this.audio.duration, Math.max(...this.timeline.map((e) => e.end))); }

  /** Beat index of a plate's first downbeat (bar `from`; bar -1 is the virtual bar before the first downbeat). */
  beat0(e: TimelineEntry) {
    const first = Math.round(this.audio.beatAt(this.audio.downbeats[0]!));
    return first + 4 * (e.plate.from as number);
  }

  private frameFor(e: TimelineEntry, t: number, dt: number, seeked: boolean, preroll: boolean, under: THREE.Texture | null, tin: number, tout: number): Frame {
    const beat = this.audio.beatAt(t), bar = this.audio.barAt(t);
    // the frame's own time, clamped into the plate (a frame whose reference point is in this shot)
    const ft = Math.min(Math.max(Math.round(t * 60) / 60, e.start), e.end - 1e-4);
    return {
      t, dt, lt: t - e.start, p: (t - e.start) / (e.end - e.start), start: e.start, end: e.end, seeked, preroll,
      lb: beat - this.beat0(e), ft, flb: this.audio.beatAt(ft) - this.beat0(e),
      beat, bar, beatPhase: beat - Math.floor(beat), barPhase: bar - Math.floor(bar),
      a: this.audio.sample(t), under, tin, tout,
    };
  }

  /**
   * Render song time t. `dt` is the nominal frame step (1/fps). A non-sequential t counts as a
   * seek: stateful scenes are reset and fast-forwarded.
   *
   * Motion blur (offline export; the preview uses 1 sample): `samples` > 1 renders that many sub-frames
   * spread evenly over `shutter` x dt around t and averages them before post-processing, which gives real
   * motion blur plus temporal anti-aliasing. With an AdaptiveSampling the count is chosen per frame:
   * sub-frames are added in nested steps (4, 12, 36 … each set evenly spread over the shutter, see
   * ternaryOffsets) until the estimated remaining error is below `tol` levels. Stepped copies of a moving
   * edge shrink as 1/count, so when a step changes the frame by e, what is left is about e/2
   * (e·(1/3 + 1/9 + …)). A still frame stops at 3 x min; a whip pan goes on until its streaks are
   * continuous instead of stepped copies.
   * Returns the number of sub-frames used.
   */
  render(t: number, dt = 1 / 60, toScreen = true, samples: number | AdaptiveSampling = 1, shutter = 0.5): number {
    const r = this.renderer;
    const seeked = this.lastT < 0 || t < this.lastT - 1e-6 || t - this.lastT > Math.max(0.25, dt * 4);
    this.lastT = t;
    let outTex: THREE.Texture;
    let post: PostParams = { ...DEFAULT_POST };
    let n = 1;
    // per-plate shutter (data/timeline.json plate `shutter`, a factor): pixel crowds and dashes stay readable mid-move
    shutter *= Math.min(1, ...this.timeline.filter((e) => t >= e.start && t < e.end).map((e) => (e.plate as { shutter?: number }).shutter ?? 1));
    if (samples === 1) {
      SS_TAP.value = -1;
      ({ outTex, post } = this.composite(t, dt, seeked));
    } else {
      const adaptive = typeof samples !== 'number';
      let maxAdaptive = adaptive ? samples.max : 0;
      if (adaptive) {
        // sub-frames are rendered out of time order: fine for pure functions of t, not for scenes that integrate state
        const w = dt * shutter;
        const on = this.timeline.filter((e) => t + w / 2 >= e.start && t - w / 2 < e.end);
        const st = on.find((e) => this.loaded.get(e.id)?.scene?.stateful);
        if (st) throw new Error(`adaptive sampling needs stateless scenes; '${st.id}' is stateful (use a fixed --samples)`);
        for (const e of on) if (e.maxSamples) maxAdaptive = Math.min(maxAdaptive, e.maxSamples);
      }
      // shaders that supersample share their 4 taps across the sub-frames when every set holds a multiple
      // of 4 (rotated by k/4 so a tap doesn't always land in the same part of the shutter)
      const cycle = adaptive || samples % 4 === 0;
      // post parameters (shake, flash, zoom, fades, the HUD's paper mode) are read at one point of the shutter,
      // 1/8 of it after t: where the video was tuned (4 sub-frames, the third) and a point every adaptive set
      // includes. (A flash that starts between t and there shows at its peak on this frame, not one frame on.)
      const POST_U = 0.125;
      let nearest = Infinity;
      // a hard cut closes the shutter: the frame belongs to the shot that holds its reference point
      // (POST_U), and its sub-frames are clamped to that shot's side of the nearest cuts (no double exposure)
      const [c0, c1] = this.cutWindow(Math.max(0, t + dt * shutter * POST_U));
      // sub-frame k at shutter offset u (-0.5..0.5), summed into `into`; `step` = the sub-frame spacing
      const sub = (k: number, u: number, into: THREE.WebGLRenderTarget, step: number) => {
        SS_TAP.value = cycle ? (k + (k >> 2)) % 4 : -1;
        // (clamped at 0: before the song no scene is active, and frame 0 would come out half black)
        const ts = Math.min(Math.max(t + dt * shutter * u, c0, 0), c1 - 1e-4);
        const res = this.composite(ts, step, seeked && k === 0);
        this.accum.u.src!.value = res.outTex;
        this.accum.render(r, into);
        const d = Math.abs(u - POST_U);
        if (d < nearest - 1e-9 || (d < nearest + 1e-9 && u > POST_U)) { nearest = d; post = res.post; }
      };
      clearRT(r, this.sumRT, [0, 0, 0], 0);
      if (!adaptive) {
        n = samples;
        for (let k = 0; k < n; k++) sub(k, (k + 0.5) / n - 0.5, this.sumRT, dt / n);
      } else {
        const lg3 = (x: number) => Math.log(x / 4) / Math.log(3);
        const lo = Math.max(0, Math.round(lg3(samples.min))), hi = Math.max(lo, Math.floor(lg3(maxAdaptive) + 1e-9));
        const u = ternaryOffsets(hi);
        n = 4 * 3 ** lo;
        this.lastErrors = [];
        for (let k = 0; k < n; k++) sub(k, u[k]!, this.sumRT, dt / n);
        for (let l = lo; l < hi; l++) {
          clearRT(r, this.newRT, [0, 0, 0], 0);
          for (let k = n; k < 3 * n; k++) sub(k, u[k]!, this.newRT, dt / (3 * n));
          const err = this.sampleError(n) / 2;
          this.lastErrors.push(err);
          this.comp.draw(r, this.newRT.texture, this.sumRT, { mode: 'add', opacity: 1, premult: false });
          n *= 3;
          if (err < samples.tol) break;
        }
      }
      SS_TAP.value = -1;
      this.comp.draw(r, this.sumRT.texture, this.avgRT, { mode: 'replace', opacity: 1 / n, premult: false });
      outTex = this.avgRT.texture;
    }
    this.lastSamples = n;
    this.post.render(r, outTex, this.finalRT, post, t);
    this.lastPost = post;
    if (toScreen) {
      this.blit.u.src!.value = this.finalRT.texture;
      this.blit.render(r, null);
    }
    return n;
  }

  /**
   * How far the displayed frame (8-bit levels, worst block) moves when the 2n sub-frames summed in newRT
   * are merged with the n summed in sumRT. Stepped copies of a fast edge differ between the two
   * interleaved sets; a converged streak does not.
   */
  private sampleError(n: number) {
    const r = this.renderer;
    this.errPass.u.a!.value = this.sumRT.texture;
    this.errPass.u.b!.value = this.newRT.texture;
    this.errPass.u.invA!.value = 1 / n;
    this.errPass.u.invB!.value = 1 / (2 * n);
    this.errPass.render(r, this.errRT);
    this.maxPass.u.e!.value = this.errRT.texture;
    this.maxPass.render(r, this.maxRT);
    r.readRenderTargetPixels(this.maxRT, 0, 0, this.maxRT.width, this.maxRT.height, this.errBuf);
    let m = 0;
    for (let i = 0; i < this.errBuf.length; i += 4) m = Math.max(m, this.errBuf[i]!);
    return m;
  }

  /**
   * Render and composite all scenes active at t into an HDR texture (no post). `dt` is the step handed to
   * scenes (the frame step, or the sub-frame spacing); `seeked` says time jumped before this call.
   */
  private composite(t: number, dt: number, seeked: boolean): { outTex: THREE.Texture; post: PostParams } {
    const r = this.renderer;

    const active = this.timeline.filter((e) => t >= e.start && t < e.end).sort((a, b) => a.start - b.start);
    let post: PostParams = { ...DEFAULT_POST };
    let under: THREE.Texture | null = null;
    let outTex: THREE.Texture | null = null;

    active.forEach((e, idx) => {
      const rec = this.loaded.get(e.id);
      const rt = this.rts[idx % this.rts.length]!;
      const prev = active[idx - 1], next = active[idx + 1];
      const tin = prev ? Math.min(1, (t - e.start) / Math.max(1e-3, prev.end - e.start)) : 1;
      const tout = next ? Math.max(0, (t - next.start) / Math.max(1e-3, e.end - next.start)) : 0;
      if (!rec?.scene) {
        clearRT(r, rt, [0.25, 0.0, 0.0]);
        under = rt.texture; outTex = rt.texture;
        return;
      }
      const s = rec.scene;
      // (sub-frames of one frame may step back within its shutter: not a seek)
      const sceneSeeked = seeked || rec.lastT < 0 || Math.abs(t - rec.lastT) > 0.25;
      if (s.stateful && sceneSeeked) {
        s.reset();
        const from = Math.max(e.start, t - s.prerollMax);
        const step = 1 / 60;
        let first = true;
        for (let pt = from; pt < t - step * 0.5; pt += step) {
          s.render(this.frameFor(e, pt, first ? 0 : step, first, true, null, 1, 0), rt);
          first = false;
        }
      }
      let ov: PostOverrides | void = undefined;
      try {
        ov = s.render(this.frameFor(e, t, sceneSeeked ? 0 : dt, sceneSeeked && !s.stateful, false, idx > 0 ? under : null, tin, tout), rt);
      } catch (err) {
        console.error(`scene ${e.id} render error`, err);
        clearRT(r, rt, [0.25, 0.0, 0.0]);
      }
      rec.lastT = t;
      post = { ...post, ...(e.post ?? {}), ...(ov ?? {}) };
      if (idx > 0 && !s.handlesTransition && under) {
        // default: crossfade from the previous scene over the overlap
        this.xfade.u.a!.value = under;
        this.xfade.u.b!.value = rt.texture;
        this.xfade.u.k!.value = tin;
        this.xfade.render(r, this.mixRT);
        outTex = this.mixRT.texture;
      } else outTex = rt.texture;
      under = outTex;
    });

    if (!outTex) { clearRT(r, this.rts[0]!, [0, 0, 0]); outTex = this.rts[0]!.texture; }
    return { outTex, post };
  }

  /** RGBA8 pixels of the last rendered frame (bottom-up rows), PW x PH. */
  readPixels(buf?: Uint8Array) {
    const out = buf ?? new Uint8Array(PW * PH * 4);
    this.renderer.readRenderTargetPixels(this.finalRT, 0, 0, PW, PH, out);
    return out;
  }

  /**
   * Same pixels as readPixels(), read through a pixel-pack buffer and a fence instead of a blocking
   * readPixels: several times faster in Chrome (~15 ms instead of ~40 ms at 1080p, ~150 ms at 4K).
   */
  async readPixelsAsync(buf?: Uint8Array) {
    const out = buf ?? new Uint8Array(PW * PH * 4);
    await this.renderer.readRenderTargetPixelsAsync(this.finalRT, 0, 0, PW, PH, out);
    return out;
  }
}
