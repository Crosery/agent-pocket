// Additive HDR glow meshes used by the VFX primitives: soft glows, rings, beams, slash arcs, light columns,
// shield bubbles and lightning ribbons. Colors arrive pre-multiplied by their glow factor so they bloom.
import * as THREE from 'three'

export const GLOW_MODE = { glow: 0, ring: 1, beam: 2, slash: 3, column: 4, shield: 5, bolt: 6 } as const
export type GlowMode = keyof typeof GLOW_MODE

const VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vNormalV;
varying vec3 vViewPos;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  vNormalV = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}`

const FRAG = /* glsl */`
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uAlpha;
uniform float uTime;
uniform float uProgress;
uniform vec4 uParam;
varying vec2 vUv;
varying vec3 vNormalV;
varying vec3 vViewPos;
void main() {
  vec3 col = vec3(0.0);
#if MODE == 0
  float r = length(vUv - 0.5) * 2.0;
  if (r > 1.0) discard;
  float halo = pow(1.0 - r, uParam.x);
  float core = smoothstep(uParam.y, 0.0, r);
  col = uColor * halo + uColor2 * core;
#elif MODE == 1
  float r = length(vUv - 0.5) * 2.0;
  float inner = 1.0 - uParam.x;
  float soft = max(0.02, uParam.x * 0.45);
  float a = smoothstep(inner - soft, inner + soft * 0.3, r) * (1.0 - smoothstep(1.0 - soft, 1.0, r));
  float crest = 1.0 - abs(r - (inner + 1.0) * 0.5) / max(0.01, uParam.x * 0.5);
  col = uColor * a + uColor2 * a * clamp(crest, 0.0, 1.0) * uParam.y;
#elif MODE == 2
  float across = abs(vUv.y - 0.5) * 2.0;
  float edge = pow(max(0.0, 1.0 - across), 1.6);
  float core = smoothstep(uParam.x, 0.0, across);
  float flow = 0.72 + 0.28 * sin(vUv.x * uParam.y - uTime * uParam.z);
  float ends = smoothstep(0.0, 0.03, vUv.x) * smoothstep(1.0, 0.97, vUv.x);
  col = (uColor * edge * flow + uColor2 * core) * ends;
#elif MODE == 3
  float head = uProgress;
  float tail = uParam.x;
  if (vUv.x > head) discard;
  float along = smoothstep(head - tail, head, vUv.x);
  float across = abs(vUv.y - 0.5) * 2.0;
  float thick = 1.0 - smoothstep(0.2 + 0.8 * along, 1.0, across);
  float core = smoothstep(0.45 * along, 0.0, across);
  col = (uColor * thick + uColor2 * core) * along;
#elif MODE == 4
  float k = pow(max(0.0, 1.0 - vUv.y), 1.3) * smoothstep(0.0, 0.05, vUv.y);
  float streak = 0.65 + 0.35 * sin(vUv.x * 6.2831853 * uParam.x + uTime * uParam.y + sin(vUv.y * 9.0 - uTime * 4.0));
  col = uColor * k * streak + uColor2 * k * k * 0.5;
#elif MODE == 5
  vec3 v = normalize(-vViewPos);
  float f = pow(1.0 - abs(dot(normalize(vNormalV), v)), uParam.x);
  vec2 h = vUv * vec2(uParam.y * 2.0, uParam.y);
  vec2 g = abs(fract(h + vec2(0.5 * floor(h.y), 0.0)) - 0.5);
  float hex = smoothstep(0.42, 0.5, max(g.x, g.y));
  float sweep = 0.5 + 0.5 * sin(vUv.y * 12.0 - uTime * 5.0);
  col = uColor * (f + hex * 0.35 * (0.5 + sweep)) + uColor2 * f * f;
#else
  float across = abs(vUv.y - 0.5) * 2.0;
  float core = smoothstep(0.55, 0.0, across);
  float edge = pow(max(0.0, 1.0 - across), 2.0);
  col = uColor * edge + uColor2 * core;
#endif
  gl_FragColor = vec4(col * uAlpha, 1.0);
}`

export interface GlowMaterial extends THREE.ShaderMaterial {
  uniforms: {
    uColor: { value: THREE.Color }
    uColor2: { value: THREE.Color }
    uAlpha: { value: number }
    uTime: { value: number }
    uProgress: { value: number }
    uParam: { value: THREE.Vector4 }
  }
}

export function glowMaterial(mode: GlowMode, color: THREE.Color, color2: THREE.Color, param: [number, number, number, number] = [0, 0, 0, 0]): GlowMaterial {
  return new THREE.ShaderMaterial({
    defines: { MODE: GLOW_MODE[mode] },
    uniforms: {
      uColor: { value: color.clone() },
      uColor2: { value: color2.clone() },
      uAlpha: { value: 1 },
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uParam: { value: new THREE.Vector4(...param) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  }) as GlowMaterial
}

export interface SharedGeometries {
  quad: THREE.PlaneGeometry
  /** Open cylinder, radius 1, y in [0, 1]. */
  column: THREE.CylinderGeometry
  sphere: THREE.IcosahedronGeometry
  /** Cone, base radius 1, y in [0, 1]. */
  cone: THREE.ConeGeometry
  dispose(): void
}

export function createSharedGeometries(res: { columnSegments: number; sphereDetail: number; coneSides: number }): SharedGeometries {
  const quad = new THREE.PlaneGeometry(1, 1)
  const column = new THREE.CylinderGeometry(1, 1, 1, res.columnSegments, 1, true)
  column.translate(0, 0.5, 0)
  const sphere = new THREE.IcosahedronGeometry(1, res.sphereDetail)
  const cone = new THREE.ConeGeometry(1, 1, res.coneSides, 1)
  cone.translate(0, 0.5, 0)
  return {
    quad, column, sphere, cone,
    dispose() { quad.dispose(); column.dispose(); sphere.dispose(); cone.dispose() },
  }
}

/**
 * Arc ribbon: uv.x runs along the arc (0..1), uv.y across it. Centred on the arc's circle centre, in the XY plane.
 * `taper` > 1 reaches the thin tail before the arc's end; `tip` = width kept at the tips (fraction of `width`).
 */
export function arcRibbonGeometry(radius: number, width: number, arcRad: number, segments: number, taper: number, tip: number): THREE.BufferGeometry {
  const n = Math.max(4, segments)
  const pos: number[] = [], uv: number[] = [], idx: number[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const a = -arcRad / 2 + arcRad * t
    // taper toward both tips so the swipe reads as a blade
    const w = width * Math.sin(Math.PI * Math.min(1, t * taper)) * 0.5 + width * tip
    const ci = Math.cos(a), si = Math.sin(a)
    pos.push(ci * (radius - w), si * (radius - w), 0, ci * (radius + w), si * (radius + w), 0)
    uv.push(t, 0, t, 1)
    if (i < n) { const b = i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2) }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array((n + 1) * 2).fill([0, 0, 1]).flat(), 3))
  geo.setIndex(idx)
  return geo
}

/** Camera-facing ribbon through a polyline (lightning). Rewrite with `update`. */
export interface Ribbon {
  readonly geometry: THREE.BufferGeometry
  update(points: THREE.Vector3[], width: number, camera: THREE.Camera): void
  dispose(): void
}

export function createRibbon(maxPoints: number): Ribbon {
  const n = Math.max(2, maxPoints)
  const pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2), nrm = new Float32Array(n * 2 * 3)
  const idx: number[] = []
  for (let i = 0; i < n - 1; i++) { const b = i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2) }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage))
  geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  geometry.setIndex(idx)
  const _d = new THREE.Vector3(), _s = new THREE.Vector3(), _v = new THREE.Vector3()
  return {
    geometry,
    update(points, width, camera) {
      const m = Math.min(n, points.length)
      camera.getWorldDirection(_v)
      for (let i = 0; i < n; i++) {
        const p = points[Math.min(i, m - 1)]
        const a = points[Math.max(0, Math.min(i, m - 1) - 1)], b = points[Math.min(m - 1, Math.min(i, m - 1) + 1)]
        _d.subVectors(b, a)
        _s.crossVectors(_d, _v)
        if (_s.lengthSq() < 1e-8) _s.set(1, 0, 0)
        _s.normalize().multiplyScalar(width / 2)
        pos.set([p.x - _s.x, p.y - _s.y, p.z - _s.z, p.x + _s.x, p.y + _s.y, p.z + _s.z], i * 6)
        const t = i / (n - 1)
        uv.set([t, 0, t, 1], i * 4)
      }
      geometry.getAttribute('position').needsUpdate = true
      geometry.getAttribute('uv').needsUpdate = true
      geometry.computeBoundingSphere()
    },
    dispose() { geometry.dispose() },
  }
}

const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _cam = new THREE.Vector3()

/** Places a unit quad as an axial billboard from a to b with the given width (beams). */
export function placeAxialQuad(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, width: number, camera: THREE.Camera): void {
  _x.subVectors(b, a)
  const len = Math.max(1e-4, _x.length())
  _x.divideScalar(len)
  camera.getWorldDirection(_cam)
  _y.crossVectors(_cam, _x)
  if (_y.lengthSq() < 1e-8) _y.set(0, 1, 0)
  _y.normalize()
  _z.crossVectors(_x, _y).normalize()
  mesh.matrixAutoUpdate = false
  mesh.matrix.makeBasis(_x.multiplyScalar(len), _y.multiplyScalar(width), _z)
  mesh.matrix.setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  mesh.matrixWorldNeedsUpdate = true
}
