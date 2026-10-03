// Scene API. A scene owns one plate (a time window of the music) and renders HDR linear colour into the
// render target it is given. Output must be a deterministic function of time.
// Adapted from mexicat/pdoom-video (MIT, see THIRD_PARTY.md).
import type * as THREE from 'three';
import type { AudioData, AudioSample } from './audio';
import type { Compositor } from './gl';
import type { PostParams } from './post';
import type { PlateDef } from './data';

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  audio: AudioData;
  comp: Compositor;
  W: number;
  H: number;
  id: string;
  plate: PlateDef;
  /** Per-plate cue values from data/timeline.json (beats from the plate start unless noted). */
  cues: Record<string, any>;
  params: Record<string, any>;
  /** Plate window (s). */
  start: number;
  end: number;
  /** Beat index (analysed grid) of the plate's first downbeat; cue beats count from here. */
  beat0: number;
}

export interface Frame {
  t: number;
  dt: number;
  /** Local time (s) since the plate start, and 0..1 progress through it. */
  lt: number;
  p: number;
  /**
   * Frame-stepped time: the 60 fps frame's own time (and plate beat), constant over the frame's whole
   * motion-blur shutter. Type, logo tiles and pops animate on it, so they never smear (a closed shutter for type).
   */
  ft: number;
  flb: number;
  start: number;
  end: number;
  seeked: boolean;
  preroll: boolean;
  /** Continuous beat count from the plate's first downbeat (cue beats use the same origin). */
  lb: number;
  beat: number;
  bar: number;
  beatPhase: number;
  barPhase: number;
  a: AudioSample;
  under: THREE.Texture | null;
  tin: number;
  tout: number;
}

export type PostOverrides = Partial<PostParams>;

export interface SfxEvent { t: number; id: string; gain?: number; pitch?: number }

export abstract class Scene {
  stateful = false;
  prerollMax = 6;
  handlesTransition = false;
  constructor(protected ctx: SceneCtx) {}
  init(): Promise<void> | void {}
  reset(): void {}
  abstract render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides | void;
  dispose(): void {}
  /** Absolute times of hard cuts inside this plate (the plate's own start/end are added by the engine): motion-blur sub-frames never straddle one. */
  cutTimes(): number[] { return []; }
  /** Sound events (absolute times, ids from data/sfx.json) — rendered and mixed by analysis/mix.py. */
  sfx(): SfxEvent[] { return []; }

  /** Absolute time of beat `b` counted from this plate's first downbeat (follows the analysed grid). */
  beatT(b: number) {
    return this.ctx.audio.timeOfBeat(this.ctx.beat0 + b);
  }
  /** Seconds per beat around this plate. */
  get spb() { return this.beatT(1) - this.beatT(0); }
  /** Cue value (beats) -> absolute time. */
  cueT(name: string) {
    const v = this.ctx.cues[name];
    if (typeof v !== 'number') throw new Error(`plate ${this.ctx.id}: cue "${name}" missing in data/timeline.json`);
    return this.beatT(v);
  }
}

export type SceneClass = new (ctx: SceneCtx) => Scene;
