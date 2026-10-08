// Pooled CPU puffs: dust clouds, snow powder, mud and water droplets thrown up by feet and landings. One Points
// object with alpha blending (the fx pool is additive and unlit, which reads as a glow rather than dust); colour is
// lit by the scene ambient so puffs darken at night. Particles are cheap SoA arrays; kinds come from render.json
// footsteps.puffs.
import * as THREE from 'three'
import type { PuffKind } from '../physics-config.ts'
import { hexToRgb } from '../config.ts'
import { windVelocity } from './wind.ts'

export interface PuffSystem {
  readonly points: THREE.Points
  /** Live particle cap (<= capacity); lowering it never kills particles, new ones just wait for free slots. */
  limit: number
  spawn(kind: PuffKind, x: number, y: number, z: number, opts?: { dirX?: number; dirZ?: number; scale?: number }): void
  update(dt: number, time: number, light: THREE.Color, pxScale: number): void
  dispose(): void
}

const colorCache = new Map<string, THREE.Color>()
const srgb = (hex: string): THREE.Color => {
  let c = colorCache.get(hex)
  if (!c) { c = new THREE.Color().setRGB(...hexToRgb(hex), THREE.SRGBColorSpace); colorCache.set(hex, c) }
  return c
}
const rand = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0])

export function createPuffSystem(capacity: number): PuffSystem {
  const N = Math.max(8, capacity)
  const pos = new Float32Array(N * 3), vel = new Float32Array(N * 3), col = new Float32Array(N * 3)
  const size = new Float32Array(N), alpha = new Float32Array(N), shape = new Float32Array(N)
  const life = new Float32Array(N), maxLife = new Float32Array(N), size0 = new Float32Array(N), grow = new Float32Array(N)
  const alpha0 = new Float32Array(N), grav = new Float32Array(N), drag = new Float32Array(N), windF = new Float32Array(N)
  const ground = new Float32Array(N)
  let cursor = 0
  const geo = new THREE.BufferGeometry()
  const attr = (a: Float32Array, n: number) => { const b = new THREE.BufferAttribute(a, n); b.setUsage(THREE.DynamicDrawUsage); return b }
  geo.setAttribute('position', attr(pos, 3))
  geo.setAttribute('aColor', attr(col, 3))
  geo.setAttribute('aSize', attr(size, 1))
  geo.setAttribute('aAlpha', attr(alpha, 1))
  geo.setAttribute('aShape', attr(shape, 1))
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 300 }, uLight: { value: new THREE.Color(1, 1, 1) } },
    vertexShader: /* glsl */`
uniform float uScale;
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
attribute float aShape;
varying vec3 vColor;
varying float vAlpha;
varying float vShape;
void main() {
  vColor = aColor; vAlpha = aAlpha; vShape = aShape;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aAlpha > 0.0 ? max(2.0, aSize * uScale / -mv.z) : 0.0;
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */`
uniform vec3 uLight;
varying vec3 vColor;
varying float vAlpha;
varying float vShape;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float r = length(p) * 2.0;
  if (r > 1.0) discard;
  float a;
  if (vShape > 0.5) a = 1.0;
  else a = floor(clamp((1.0 - r) * 1.6, 0.0, 1.0) * 4.0 + 0.5) / 4.0;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vColor * uLight, a * vAlpha);
}`,
    transparent: true,
    depthWrite: false,
  })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  points.renderOrder = 11
  points.name = 'puffs'
  const w = { x: 0, z: 0 }

  const sys: PuffSystem = {
    points,
    limit: N,
    spawn(kind, x, y, z, opts) {
      const s = opts?.scale ?? 1
      const dx = opts?.dirX ?? 0, dz = opts?.dirZ ?? 0
      const colors = kind.colors
      for (let i = 0; i < kind.count; i++) {
        let k = -1
        for (let t = 0; t < N && k < 0; t++) { const j = (cursor + t) % N; if (life[j] <= 0 && j < sys.limit) k = j }
        if (k < 0) return
        cursor = (k + 1) % N
        const a = Math.random() * Math.PI * 2
        const sp = rand(kind.speed) * s
        // a ring launch starts on the circle and pushes outward; a spray starts at the foot
        const r0 = kind.radius * s
        pos[k * 3] = x + Math.cos(a) * r0
        pos[k * 3 + 1] = y
        pos[k * 3 + 2] = z + Math.sin(a) * r0
        // moving feet kick the dust back along the path
        vel[k * 3] = Math.cos(a) * sp - dx * sp * 0.6
        vel[k * 3 + 1] = rand(kind.up) * s
        vel[k * 3 + 2] = Math.sin(a) * sp - dz * sp * 0.6
        const c = srgb(colors[Math.floor(Math.random() * colors.length)])
        col.set([c.r * kind.glow, c.g * kind.glow, c.b * kind.glow], k * 3)
        life[k] = maxLife[k] = rand(kind.life)
        size0[k] = rand(kind.size) * s
        size[k] = size0[k]
        grow[k] = kind.grow
        alpha0[k] = kind.alpha
        alpha[k] = kind.alpha
        grav[k] = kind.gravity
        drag[k] = kind.drag
        windF[k] = kind.wind
        shape[k] = kind.shape === 'drop' ? 1 : 0
        ground[k] = y
      }
    },
    update(dt, time, light, pxScale) {
      mat.uniforms.uScale.value = pxScale
      ;(mat.uniforms.uLight.value as THREE.Color).copy(light)
      let any = false
      for (let k = 0; k < N; k++) {
        if (life[k] <= 0) { if (alpha[k] !== 0) { alpha[k] = 0; any = true } continue }
        any = true
        life[k] -= dt
        const f = life[k] / maxLife[k]
        if (life[k] <= 0) { alpha[k] = 0; continue }
        const d = Math.exp(-drag[k] * dt)
        vel[k * 3] *= d; vel[k * 3 + 2] *= d
        vel[k * 3 + 1] = vel[k * 3 + 1] * d - grav[k] * dt
        if (windF[k] > 0) {
          windVelocity(pos[k * 3], pos[k * 3 + 2], time, windF[k], w)
          vel[k * 3] += (w.x - vel[k * 3]) * Math.min(1, dt * 1.5) * 0.35
          vel[k * 3 + 2] += (w.z - vel[k * 3 + 2]) * Math.min(1, dt * 1.5) * 0.35
        }
        pos[k * 3] += vel[k * 3] * dt
        pos[k * 3 + 1] += vel[k * 3 + 1] * dt
        pos[k * 3 + 2] += vel[k * 3 + 2] * dt
        if (shape[k] > 0.5 && pos[k * 3 + 1] < ground[k] && vel[k * 3 + 1] < 0) { life[k] = 0; alpha[k] = 0; continue }
        size[k] = size0[k] * (1 + (grow[k] - 1) * (1 - f))
        // quick fade-in over the first tenth, long fade-out
        alpha[k] = alpha0[k] * Math.min(1, (1 - f) * 10) * Math.min(1, f * 1.8)
      }
      if (any) for (const name of ['position', 'aColor', 'aSize', 'aAlpha', 'aShape']) (geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true
    },
    dispose() { geo.dispose(); mat.dispose() },
  }
  return sys
}
