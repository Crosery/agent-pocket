// GPU sprite batch in logical 1920x1080 px (y down). One instanced draw per batch; pixel art is sampled through
// pixelUV() so integer scales are exact and squash/zoom/motion stay crisp without shimmer.
import * as THREE from 'three';
import { glslCommon } from './glsl';
import { W, H } from './gl';

export interface SpriteSpec {
  x: number; y: number; w: number; h: number;
  /** texel rect in the texture (x, y, w, h), top-left origin */
  uv: [number, number, number, number];
  tint?: [number, number, number];
  alpha?: number;
  /** 0..1 blend toward `flashColor` (keeps the sprite's alpha) */
  flash?: number;
  flip?: boolean;
  /** rotation (radians) around the rect centre */
  rot?: number;
}

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aRect; in vec4 aUV; in vec4 aColor; in vec4 aFx;
uniform vec3 uCam; // zoom about the frame centre, then offset (px)
out vec2 vTex; out vec4 vColor; out float vFlash; out float vFlip;
void main() {
  vec2 q = position.xy; // 0..1, y down
  vec2 c = aRect.xy + aRect.zw * 0.5;
  vec2 p = (q - 0.5) * aRect.zw;
  float r = aFx.z; p = mat2(cos(r), sin(r), -sin(r), cos(r)) * p;
  p += c;
  p = (p - vec2(${W / 2}.0, ${H / 2}.0)) * uCam.x + vec2(${W / 2}.0, ${H / 2}.0) + uCam.yz;
  float u = aFx.y > 0.5 ? 1.0 - q.x : q.x;
  vTex = aUV.xy + vec2(u, q.y) * aUV.zw;
  vColor = aColor; vFlash = aFx.x; vFlip = aFx.y;
  gl_Position = vec4(p.x / ${W}.0 * 2.0 - 1.0, 1.0 - p.y / ${H}.0 * 2.0, 0.0, 1.0);
}`;

export class SpriteBatch {
  mesh: THREE.Mesh;
  scene = new THREE.Scene();
  cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  geo: THREE.InstancedBufferGeometry;
  mat: THREE.RawShaderMaterial;
  private rect: Float32Array; private uv: Float32Array; private col: Float32Array; private fx: Float32Array;
  private n = 0;
  constructor(public tex: THREE.Texture, texW: number, texH: number, public capacity = 512, o: { blend?: 'normal' | 'add'; pixel?: boolean; flashColor?: [number, number, number] } = {}) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    this.rect = new Float32Array(capacity * 4); this.uv = new Float32Array(capacity * 4);
    this.col = new Float32Array(capacity * 4); this.fx = new Float32Array(capacity * 4);
    const ia = (a: Float32Array) => new THREE.InstancedBufferAttribute(a, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aRect', ia(this.rect)); g.setAttribute('aUV', ia(this.uv));
    g.setAttribute('aColor', ia(this.col)); g.setAttribute('aFx', ia(this.fx));
    this.geo = g;
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: /* glsl */ `precision highp float;
        in vec2 vTex; in vec4 vColor; in float vFlash; in float vFlip; out vec4 fragColor;
        uniform sampler2D map; uniform vec2 texSize; uniform vec3 flashColor; uniform bool pixel;
        uniform vec2 rimDir; uniform vec3 rimCol; uniform float rimAmt;
        ${glslCommon()}
        void main() {
          vec2 uv = vTex / texSize;
          vec4 c = texture(map, pixel ? pixelUV(uv, texSize) : uv); // premultiplied
          c.rgb *= vColor.rgb;
          if (rimAmt > 0.0) {
            // one art pixel on the silhouette's lit side: opaque here, transparent one texel toward the light
            vec2 rd = vec2(vFlip > 0.5 ? -rimDir.x : rimDir.x, rimDir.y);
            float an = texture(map, pixelUV(uv + rd / texSize, texSize)).a;
            float rk = step(0.5, c.a) * (1.0 - step(0.5, an));
            c.rgb = mix(c.rgb, rimCol * c.a, rk * rimAmt);
          }
          c.rgb = mix(c.rgb, flashColor * c.a, vFlash);
          fragColor = c * vColor.a;
        }`,
      uniforms: {
        map: { value: tex }, texSize: { value: new THREE.Vector2(texW, texH) },
        flashColor: { value: new THREE.Vector3(...(o.flashColor ?? [1, 1, 1])) },
        pixel: { value: o.pixel ?? true }, uCam: { value: new THREE.Vector3(1, 0, 0) },
        rimDir: { value: new THREE.Vector2(0, -1) }, rimCol: { value: new THREE.Vector3(1, 1, 1) }, rimAmt: { value: 0 },
      },
      depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: o.blend === 'add' ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  setCam(zoom = 1, ox = 0, oy = 0) { (this.mat.uniforms.uCam!.value as THREE.Vector3).set(zoom, ox, oy); }
  setFlashColor(c: [number, number, number]) { (this.mat.uniforms.flashColor!.value as THREE.Vector3).set(...c); }
  /** Inside-edge rim light: `dir` = one texel toward the light (screen x, y down), colour (linear), amount 0..1. */
  setRim(dir: [number, number], col: [number, number, number], amt: number) {
    const u = this.mat.uniforms;
    (u.rimDir!.value as THREE.Vector2).set(...dir); (u.rimCol!.value as THREE.Vector3).set(...col); u.rimAmt!.value = amt;
  }
  begin() { this.n = 0; return this; }
  add(s: SpriteSpec) {
    if (this.n >= this.capacity) return this;
    const i = this.n++ * 4;
    this.rect.set([s.x, s.y, s.w, s.h], i);
    this.uv.set(s.uv, i);
    const t = s.tint ?? [1, 1, 1];
    this.col.set([t[0], t[1], t[2], s.alpha ?? 1], i);
    this.fx.set([s.flash ?? 0, s.flip ? 1 : 0, s.rot ?? 0, 0], i);
    return this;
  }
  get count() { return this.n; }
  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null) {
    if (!this.n) return;
    this.geo.instanceCount = this.n;
    for (const k of ['aRect', 'aUV', 'aColor', 'aFx']) {
      const a = this.geo.getAttribute(k) as THREE.InstancedBufferAttribute;
      a.needsUpdate = true;
      a.addUpdateRange(0, this.n * 4);
    }
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.cam);
  }
}

/** A white texel (flat-colour quads) and a soft radial falloff (glows) as tiny textures. */
let white: THREE.Texture | null = null, soft: THREE.Texture | null = null;
export function whiteTex() {
  if (!white) {
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const x = c.getContext('2d')!; x.fillStyle = '#fff'; x.fillRect(0, 0, 4, 4);
    white = new THREE.CanvasTexture(c); white.colorSpace = THREE.NoColorSpace; white.premultiplyAlpha = true;
  }
  return white;
}
export function softTex() {
  if (!soft) {
    // half-float, not 8-bit: glows are drawn at high HDR intensities and magnified, and 1/255 alpha steps of an
    // 8-bit falloff showed as concentric rings around bright points
    const N = 256, data = new Uint16Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const d = Math.hypot(i + 0.5 - N / 2, j + 0.5 - N / 2) / (N / 2);
      const v = Math.max(0, 1 - d) ** 2.2;
      const k = (j * N + i) * 4;
      // premultiplied white
      data[k] = data[k + 1] = data[k + 2] = data[k + 3] = THREE.DataUtils.toHalfFloat(v);
    }
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
    t.colorSpace = THREE.NoColorSpace; t.premultiplyAlpha = false;
    t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
    t.needsUpdate = true;
    soft = t;
  }
  return soft;
}
/** Flat-colour quads (pixel particles, bars, rules). uv is fixed to the white centre. */
export class RectBatch extends SpriteBatch {
  constructor(capacity = 4096, blend: 'normal' | 'add' = 'normal') { super(whiteTex(), 4, 4, capacity, { blend, pixel: false }); }
  rectPx(x: number, y: number, w: number, h: number, color: [number, number, number], alpha = 1, rot = 0) {
    return this.add({ x, y, w, h, uv: [1, 1, 2, 2], tint: color, alpha, rot });
  }
}
/** Soft additive glows (sparkles, auras). */
export class GlowBatch extends SpriteBatch {
  constructor(capacity = 1024) { super(softTex(), 256, 256, capacity, { blend: 'add', pixel: false }); }
  glow(x: number, y: number, r: number, color: [number, number, number], intensity = 1, sx = 1, sy = 1, rot = 0) {
    return this.add({ x: x - r * sx, y: y - r * sy, w: 2 * r * sx, h: 2 * r * sy, uv: [0, 0, 256, 256], tint: [color[0] * intensity, color[1] * intensity, color[2] * intensity], alpha: 1, rot });
  }
}
