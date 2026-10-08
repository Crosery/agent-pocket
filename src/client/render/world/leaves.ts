// Falling leaves and petals with simple physics: they leave the canopies near the camera (or blow in from upwind where
// there is no tree), fall with gravity, drag and a flutter that tumbles them, are carried and lifted by the shared wind
// gusts (wind.ts), land on the ground or float on water, lie there for a while and fade. CPU-simulated and drawn as
// one InstancedMesh of tiny diamonds; the biome ambient (render.json biomes ambient "leaves" / "petals") sets how many
// are wanted, render.json "leaves" tunes everything else, the quality tier caps the count.
import * as THREE from 'three'
import { RENDER, hexToRgb } from '../config.ts'
import type { LeavesKind } from '../physics-config.ts'
import type { Canopy } from './props.ts'
import { gustAt, windVelocity } from './wind.ts'

export interface LeafSystem {
  readonly mesh: THREE.InstancedMesh
  /** Live leaf cap from the quality tier (0 = off: nothing spawns, live leaves fall out). */
  setLimit(n: number): void
  /** Ambient level per kind (0..1, already including the time-of-day factor); unlisted kinds are 0. */
  setLevels(levels: Record<string, number>): void
  /** Canopies near the focus that may shed leaves. */
  setCanopies(list: readonly Canopy[]): void
  /** Ground height at a point (liquid surface over water) and whether it is water. */
  setGround(fn: ((x: number, z: number) => number) | null, water: ((x: number, z: number) => boolean) | null): void
  /** Drops every live leaf (map change). */
  reset(): void
  update(dt: number, time: number, focus: THREE.Vector3, light: THREE.Color): void
  readonly stats: { live: number; airborne: number }
  dispose(): void
}

const AIR = 0, GROUND = 1, WATER = 2
const rand = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0])

export function createLeafSystem(capacity: number): LeafSystem {
  const L = RENDER.leaves
  const N = Math.max(1, capacity)
  const geo = new THREE.PlaneGeometry(1, 1)
  const aFade = new THREE.InstancedBufferAttribute(new Float32Array(N), 1)
  aFade.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('aFade', aFade)
  const mat = new THREE.ShaderMaterial({
    uniforms: { uLight: { value: new THREE.Color(1, 1, 1) } },
    vertexShader: /* glsl */`
attribute float aFade;
varying float vFade;
varying vec3 vColor;
varying vec2 vUv;
void main() {
  vFade = aFade; vUv = uv - 0.5;
  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #else
    vColor = vec3(1.0);
  #endif
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}`,
    fragmentShader: /* glsl */`
uniform vec3 uLight;
varying float vFade;
varying vec3 vColor;
varying vec2 vUv;
void main() {
  // diamond leaf with a darker midrib
  if (abs(vUv.x) * 1.7 + abs(vUv.y) > 0.5 || vFade <= 0.0) discard;
  float rib = 1.0 - 0.22 * step(abs(vUv.x), 0.035);
  gl_FragColor = vec4(vColor * uLight * rib, vFade);
}`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, N)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3)
  mesh.frustumCulled = false
  mesh.renderOrder = 9
  mesh.name = 'leaves'
  mesh.count = 0

  // SoA leaf state
  const st = new Uint8Array(N), live = new Uint8Array(N)
  const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N)
  const vx = new Float32Array(N), vy = new Float32Array(N), vz = new Float32Array(N)
  const yaw = new Float32Array(N), spin = new Float32Array(N), phase = new Float32Array(N), hz = new Float32Array(N)
  const term = new Float32Array(N), size = new Float32Array(N), gain = new Float32Array(N)
  const age = new Float32Array(N), rest = new Float32Array(N), fadeT = new Float32Array(N)
  const lean = new Float32Array(N)
  let limit = 0, levels: Record<string, number> = {}, canopies: readonly Canopy[] = [], groundFn: ((x: number, z: number) => number) | null = null, waterFn: ((x: number, z: number) => boolean) | null = null
  let cursor = 0, liveCount = 0, airborne = 0
  const smoothed: Record<string, number> = {}
  const spawnCarry: Record<string, number> = {}
  const colorCache = new Map<string, THREE.Color[]>()
  const palette = (kind: string, def: LeavesKind): THREE.Color[] => {
    let c = colorCache.get(kind)
    if (!c) { c = def.colors.map((h) => new THREE.Color().setRGB(...hexToRgb(h), THREE.SRGBColorSpace)); colorCache.set(kind, c) }
    return c
  }
  const w = { x: 0, z: 0 }
  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _qa = new THREE.Quaternion(), _s = new THREE.Vector3()
  const _x = new THREE.Vector3(1, 0, 0), _y = new THREE.Vector3(0, 1, 0)

  function slot(): number {
    for (let t = 0; t < N; t++) { const j = (cursor + t) % N; if (!live[j]) { cursor = (j + 1) % N; return j } }
    return -1
  }

  function spawn(kind: string, def: LeavesKind, x: number, y: number, z: number): void {
    if (liveCount >= limit) return
    const k = slot()
    if (k < 0) return
    live[k] = 1; st[k] = AIR
    px[k] = x; py[k] = y; pz[k] = z
    vx[k] = 0; vy[k] = 0; vz[k] = 0
    yaw[k] = Math.random() * Math.PI * 2
    spin[k] = rand(L.tumble) * (Math.random() < 0.5 ? -1 : 1)
    phase[k] = Math.random() * Math.PI * 2
    hz[k] = rand(L.flutter.hz)
    term[k] = rand(L.terminal)
    size[k] = rand(def.size)
    gain[k] = def.windGain
    age[k] = 0; rest[k] = 0; fadeT[k] = 0
    lean[k] = 0
    const pal = palette(kind, def), c = pal[Math.floor(Math.random() * pal.length)]
    mesh.setColorAt(k, c)
    liveCount++
  }

  const sys: LeafSystem = {
    mesh,
    setLimit(n) { limit = Math.max(0, Math.min(N, Math.round(n))) },
    setLevels(l) { levels = l },
    setCanopies(list) { canopies = list },
    setGround(fn, water) { groundFn = fn; waterFn = water },
    reset() {
      for (let k = 0; k < N; k++) if (live[k]) { live[k] = 0; aFade.setX(k, 0); mesh.setMatrixAt(k, _m.makeScale(0, 0, 0)) }
      liveCount = 0; airborne = 0; mesh.count = 0
      for (const key of Object.keys(smoothed)) smoothed[key] = 0
    },
    update(dt, time, focus, light) {
      ;(mat.uniforms.uLight.value as THREE.Color).copy(light)
      // --- spawning -----------------------------------------------------------------------------------------
      if (limit > 0 && groundFn) {
        const rate = Math.max(0.01, 1 / 3.5)
        for (const [kind, def] of Object.entries(L.kinds)) {
          smoothed[kind] = (smoothed[kind] ?? 0) + ((levels[kind] ?? 0) - (smoothed[kind] ?? 0)) * Math.min(1, dt * 1.2)
          const lvl = smoothed[kind]
          if (lvl < 0.01) continue
          const mine = canopies.filter((c) => def.props.includes(c.key))
          // airborne leaves wanted at this level, replaced as they land (mean flight ~ 1 / rate seconds)
          let perSec = def.air * lvl * (limit / N) * rate
          if (!mine.length) perSec = Math.min(perSec, L.stray.rate * lvl)
          spawnCarry[kind] = Math.min(L.spawnPerFrame, (spawnCarry[kind] ?? 0) + perSec * dt)
          while (spawnCarry[kind] >= 1) {
            spawnCarry[kind] -= 1
            if (mine.length) {
              const c = mine[Math.floor(Math.random() * mine.length)]
              const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * c.r * L.emit.spread
              spawn(kind, def, c.x + Math.cos(a) * r, c.y + c.h * rand(L.emit.height), c.z + Math.sin(a) * r)
            } else {
              // wind-borne from upwind of the camera box
              const d = RENDER.wind.dir, dl = Math.hypot(d[0], d[1]) || 1
              const side = (Math.random() - 0.5) * 24
              spawn(kind, def, focus.x - (d[0] / dl) * 14 - (d[1] / dl) * side, focus.y + rand(L.stray.height), focus.z - (d[1] / dl) * 14 + (d[0] / dl) * side)
            }
          }
        }
      }
      // --- physics ------------------------------------------------------------------------------------------
      let air = 0, shown = 0
      for (let k = 0; k < N; k++) {
        if (!live[k]) continue
        age[k] += dt
        if (Math.hypot(px[k] - focus.x, pz[k] - focus.z) > L.cull) { live[k] = 0; liveCount--; aFade.setX(k, 0); mesh.setMatrixAt(k, _m.makeScale(0, 0, 0)); continue }
        if (st[k] === AIR) {
          air++
          phase[k] += dt * hz[k] * Math.PI * 2
          windVelocity(px[k], pz[k], time, gain[k], w)
          // sideways swerve (perpendicular to the wind) and a gust lift
          const sw = Math.sin(phase[k]) * L.flutter.amp
          const wl = Math.hypot(w.x, w.z) || 1
          const tx = w.x + (-w.z / wl) * sw, tz = w.z + (w.x / wl) * sw
          const k1 = Math.min(1, L.drag * dt)
          vx[k] += (tx - vx[k]) * k1; vz[k] += (tz - vz[k]) * k1
          const target = -term[k] * (1 - L.flutter.fall * 0.5 * (1 + Math.sin(phase[k] * 2))) + L.gustLift * gustAt(px[k], pz[k], time)
          const dv = target - vy[k], maxA = L.gravity * dt
          vy[k] += Math.max(-maxA, Math.min(maxA * 2, dv))
          px[k] += vx[k] * dt; py[k] += vy[k] * dt; pz[k] += vz[k] * dt
          yaw[k] += spin[k] * dt
          const g = groundFn ? groundFn(px[k], pz[k]) : 0
          if (py[k] <= g + 0.02) {
            const onWater = !!waterFn && waterFn(px[k], pz[k])
            st[k] = onWater ? WATER : GROUND
            py[k] = g + 0.02
            vx[k] = vz[k] = vy[k] = 0
            age[k] = 0
            rest[k] = rand(onWater ? L.water.rest : L.rest)
            fadeT[k] = L.fade
          }
          lean[k] = Math.sin(phase[k]) * 0.9
        } else {
          if (st[k] === WATER) {
            windVelocity(px[k], pz[k], time, 1, w)
            px[k] += w.x * L.water.drift * dt; pz[k] += w.z * L.water.drift * dt
          }
          lean[k] += (-Math.PI / 2 - lean[k]) * Math.min(1, dt * 10)
          if (age[k] > rest[k] + fadeT[k]) { live[k] = 0; liveCount--; aFade.setX(k, 0); mesh.setMatrixAt(k, _m.makeScale(0, 0, 0)); continue }
        }
        const fade = age[k] <= rest[k] || st[k] === AIR ? 1 : 1 - (age[k] - rest[k]) / fadeT[k]
        // a leaf in the air tilts with its flutter; on the ground it lies flat, turned by its yaw
        _q.setFromAxisAngle(_y, yaw[k])
        _qa.setFromAxisAngle(_x, st[k] === AIR ? lean[k] : -Math.PI / 2)
        _q.multiply(_qa)
        const s = size[k]
        _m.compose(_p.set(px[k], py[k], pz[k]), _q, _s.set(s, s * 1.4, s))
        mesh.setMatrixAt(k, _m)
        aFade.setX(k, fade)
        shown = k + 1
      }
      liveCount = Math.max(0, liveCount)
      airborne = air
      mesh.count = Math.max(shown, 0)
      mesh.instanceMatrix.needsUpdate = true
      aFade.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    },
    get stats() { return { live: liveCount, airborne } },
    dispose() { geo.dispose(); mat.dispose(); mesh.dispose() },
  }
  return sys
}
