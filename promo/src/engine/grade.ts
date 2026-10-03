// Per-plate colour grade for picture plates (3D diorama, painted backdrops), applied inside the scene before its
// type is composited, so bone copy is never dimmed. Values come from data/style.json `grade.<plate>`.
import * as THREE from 'three';
import { FSPass, makeRT, W, H } from './gl';

export interface GradeParams {
  /** linear gain (EV: 2^ev) */
  exposure?: number;
  /** 1 = unchanged, 0 = grey */
  saturation?: number;
  /** multiply tint (linear rgb) */
  tint?: [number, number, number];
  /** contrast around a mid-grey pivot (linear 0.18); 1 = unchanged */
  contrast?: number;
}

export class Grade {
  pass = new FSPass(/* glsl */ `
    uniform sampler2D src; uniform float exposure, saturation, contrast; uniform vec3 tint;
    void main() {
      vec3 c = texture(src, vUv).rgb * exposure * tint;
      float l = luma(c);
      c = max(vec3(0.0), mix(vec3(l), c, saturation));
      // contrast in log2 around 0.18 (keeps black at black, highlights scale smoothly)
      c = 0.18 * pow(max(c, vec3(1e-6)) / 0.18, vec3(contrast));
      fragColor = vec4(c, 1.0);
    }`, { src: { value: null }, exposure: { value: 1 }, saturation: { value: 1 }, contrast: { value: 1 }, tint: { value: new THREE.Vector3(1, 1, 1) } });
  set(g: GradeParams = {}) {
    const u = this.pass.u;
    u.exposure!.value = g.exposure ?? 1;
    u.saturation!.value = g.saturation ?? 1;
    u.contrast!.value = g.contrast ?? 1;
    (u.tint!.value as THREE.Vector3).set(...(g.tint ?? [1, 1, 1]));
    return this;
  }
  render(r: THREE.WebGLRenderer, src: THREE.Texture, out: THREE.WebGLRenderTarget) {
    this.pass.u.src!.value = src;
    this.pass.render(r, out);
  }
}

/** Separable Gaussian blur (radius in logical px) of a full-frame texture into `out`. */
export class Blur {
  private tmp = makeRT(W, H, { depthBuffer: false });
  private pass = new FSPass(/* glsl */ `
    uniform sampler2D src; uniform vec2 dir; uniform float r;
    void main() {
      vec3 acc = vec3(0.0); float ws = 0.0;
      for (int i = -8; i <= 8; i++) {
        float x = float(i) / 8.0, w = exp(-x * x * 3.0);
        acc += texture(src, vUv + dir * x * r / vec2(${W}.0, ${H}.0)).rgb * w; ws += w;
      }
      fragColor = vec4(acc / ws, 1.0);
    }`, { src: { value: null }, dir: { value: new THREE.Vector2(1, 0) }, r: { value: 0 } });
  render(rd: THREE.WebGLRenderer, src: THREE.Texture, out: THREE.WebGLRenderTarget, radius: number) {
    const u = this.pass.u;
    u.r!.value = radius;
    u.src!.value = src; (u.dir!.value as THREE.Vector2).set(1, 0); this.pass.render(rd, this.tmp);
    u.src!.value = this.tmp.texture; (u.dir!.value as THREE.Vector2).set(0, 1); this.pass.render(rd, out);
  }
}
