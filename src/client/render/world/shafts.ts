// Light shafts: soft additive beams that fall from tree canopies along the sun (or moon) direction. Anchors are tree gaps
// registered by the prop layer (render.json lighting.shafts.props / density); the nearest ones within reach are drawn as
// billboards turned around their own axis. Strength follows the time of day and weather (LightingState.shaft, weather
// grade), so beams are strongest at dawn / dusk and in fog, and vanish in rain and in interiors.
import * as THREE from 'three'
import { RENDER, type Vec3 } from '../config.ts'
import type { ShaftAnchor } from './props.ts'

const SH = RENDER.lighting.shafts
const MAX = Math.max(1, ...Object.values(RENDER.lighting.quality).map((t) => t.shafts))

export interface ShaftFrame {
  dt: number
  time: number
  focus: THREE.Vector3
  /** Quality tier: how many beams may show (0 = none). */
  count: number
  /** Unit direction toward the light and its colour (linear). */
  dir: Vec3
  color: THREE.Color
  /** 0..1 strength from the time of day, weather and quality (already includes the moon factor). */
  strength: number
  /** The light is the moon: beams use the moon share and the colour as given. */
  moon: boolean
}

export interface ShaftRig {
  readonly mesh: THREE.Mesh
  /** Beams drawn this frame (diagnostics). */
  readonly shown: number
  setAnchors(list: ShaftAnchor[]): void
  update(f: ShaftFrame): void
  dispose(): void
}

export function createShafts(): ShaftRig {
  const quad = new THREE.PlaneGeometry(1, 1)
  const geo = new THREE.InstancedBufferGeometry()
  geo.index = quad.index
  geo.setAttribute('position', quad.getAttribute('position'))
  geo.setAttribute('uv', quad.getAttribute('uv'))
  const base = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3)
  const top = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3)
  const params = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4)
  for (const a of [base, top, params]) a.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('aBase', base)
  geo.setAttribute('aTop', top)
  geo.setAttribute('aParams', params)
  geo.instanceCount = 0
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9)

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color() },
      uTime: { value: 0 },
      uTip: { value: SH.tipFade },
      uFoot: { value: SH.footFade },
      uShimmer: { value: SH.shimmer },
      uShimmerSpeed: { value: SH.shimmerSpeed },
      uDust: { value: SH.dust },
    },
    vertexShader: /* glsl */`
attribute vec3 aBase;
attribute vec3 aTop;
attribute vec4 aParams;
varying vec2 vUv;
varying vec4 vP;
void main() {
  vec3 axis = aTop - aBase;
  vec3 mid = (aTop + aBase) * 0.5;
  vec3 side = normalize(cross(axis, cameraPosition - mid) + vec3(1e-5));
  float v = position.y + 0.5;
  float w = aParams.x * (0.75 + 0.5 * (1.0 - v));
  vec3 p = aBase + axis * v + side * position.x * w;
  vUv = vec2(position.x + 0.5, v);
  vP = aParams;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`,
    fragmentShader: /* glsl */`
uniform vec3 uColor;
uniform float uTime, uTip, uFoot, uShimmer, uShimmerSpeed, uDust;
varying vec2 vUv;
varying vec4 vP;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  // soft gaussian cross-section, narrower toward the foot, fading in and out along the beam; slow dust streaks break it up
  float x = vUv.x * 2.0 - 1.0;
  float across = exp(-x * x * 3.2);
  float along = smoothstep(0.0, max(uFoot, 1e-3), vUv.y) * (1.0 - smoothstep(1.0 - uTip, 1.0, vUv.y));
  float seed = vP.y * 40.0;
  float breathe = 1.0 - uShimmer + uShimmer * (0.5 + 0.5 * sin(uTime * uShimmerSpeed + seed + vUv.y * 2.5));
  float streak = mix(1.0, 0.25 + 1.1 * vnoise(vec2(vUv.x * 4.0 + seed, vUv.y * 2.5 - uTime * 0.1)), uDust);
  float a = across * along * breathe * streak * vP.z;
  gl_FragColor = vec4(uColor, a);
}`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  mesh.renderOrder = 4
  mesh.name = 'shafts'
  mesh.visible = false

  let anchors: ShaftAnchor[] = []
  const levels = new Map<ShaftAnchor, number>()
  let chosen = new Set<ShaftAnchor>()
  let reselectT = 0
  const _d = new THREE.Vector3()

  return {
    mesh,
    get shown() { return geo.instanceCount },
    setAnchors(list) {
      anchors = list
      const alive = new Set(list)
      for (const a of levels.keys()) if (!alive.has(a)) levels.delete(a)
      for (const a of chosen) if (!alive.has(a)) chosen.delete(a)
      reselectT = 0
    },
    update(f) {
      const on = f.count > 0 && f.strength > 0.004 && f.dir[1] > Math.sin((SH.minElevationDeg * Math.PI) / 180) && anchors.length > 0
      if (!on) {
        // fade out through levels so a weather change does not pop; hide when empty
        if (levels.size === 0 || f.count <= 0) { levels.clear(); chosen.clear(); mesh.visible = false; geo.instanceCount = 0; return }
      }
      reselectT -= f.dt
      if (reselectT <= 0) {
        reselectT = SH.reselectSeconds
        const r2 = SH.radius * SH.radius
        const near: { a: ShaftAnchor; d: number }[] = []
        for (const a of anchors) {
          const d = (a.x - f.focus.x) ** 2 + (a.z - f.focus.z) ** 2
          if (d <= r2) near.push({ a, d })
        }
        near.sort((p, q) => p.d - q.d)
        chosen = new Set(near.slice(0, Math.min(MAX, f.count)).map((r) => r.a))
      }
      const k = 1 - Math.exp(-2.2 * f.dt)
      for (const a of chosen) if (!levels.has(a)) levels.set(a, 0)
      for (const [a, lvl] of levels) {
        const target = on && chosen.has(a) ? 1 : 0
        const next = lvl + (target - lvl) * k
        if (target === 0 && next < 0.01) levels.delete(a)
        else levels.set(a, next)
      }
      let n = 0
      // beams are stylised steeper than the light (floor SH.steepDeg): a near-horizontal beam would lie flat on the ground
      // seen from the HD-2D camera instead of reading as a shaft falling through the canopy
      const hLen = Math.hypot(f.dir[0], f.dir[2]) || 1
      const el = Math.max(Math.asin(Math.min(1, Math.max(-1, f.dir[1]))), (SH.steepDeg * Math.PI) / 180)
      _d.set((f.dir[0] / hLen) * Math.cos(el), Math.sin(el), (f.dir[2] / hLen) * Math.cos(el))
      for (const [a, lvl] of levels) {
        if (n >= MAX) break
        const len = Math.min(SH.maxLength, a.h / Math.sin(el))
        base.setXYZ(n, a.x, a.y, a.z)
        top.setXYZ(n, a.x + _d.x * len, a.y + _d.y * len, a.z + _d.z * len)
        // distance fade toward the edge of the reach keeps beams from popping in and out
        const dist = Math.hypot(a.x - f.focus.x, a.z - f.focus.z)
        const edge = Math.min(1, Math.max(0, (SH.radius - dist) / Math.max(SH.fade, 1e-3)))
        const w = SH.width[0] + (SH.width[1] - SH.width[0]) * a.seed
        params.setXYZW(n, w, a.seed, SH.intensity * f.strength * lvl * edge, 0)
        n++
      }
      base.needsUpdate = top.needsUpdate = params.needsUpdate = true
      geo.instanceCount = n
      mesh.visible = n > 0
      mat.uniforms.uColor.value.copy(f.color)
      mat.uniforms.uTime.value = f.time
    },
    dispose() {
      geo.dispose()
      quad.dispose()
      mat.dispose()
    },
  }
}
