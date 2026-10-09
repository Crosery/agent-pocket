// Lamp lighting: a fixed pool of real PointLights assigned to the nearest active sources (the pool size
// never changes at runtime, so no shader recompiles), plus additive glow sprites for every source.
import * as THREE from 'three'
import { RENDER } from '../config.ts'

export interface LightSource {
  x: number; y: number; z: number
  color: THREE.Color
  intensity: number
  radius: number
  nightOnly: boolean
  phase: number
  /** Flicker class (render.json lights.flicker): the emitting prop's key, "map" for map lights; default when absent. */
  kind?: string
}

export interface LightRig {
  readonly group: THREE.Group
  setSources(list: LightSource[]): void
  /** Rebuilds the PointLight pool (quality change). */
  setPoolSize(n: number): void
  update(dt: number, time: number, focus: THREE.Vector3, lamps: number, glow: boolean, pxPerUnit: number): void
  dispose(): void
}

export function createLightRig(): LightRig {
  const L = RENDER.lights
  const group = new THREE.Group()
  group.name = 'lights'
  let sources: LightSource[] = []
  let pool: { light: THREE.PointLight; src: LightSource | null; level: number }[] = []
  let reassignT = 0

  const glowGeo = new THREE.BufferGeometry()
  const glowMat = new THREE.ShaderMaterial({
    uniforms: {
      uLamps: { value: 0 },
      uTime: { value: 0 },
      uScale: { value: 300 },
      uIntensity: { value: L.glowIntensity },
    },
    vertexShader: /* glsl */`
uniform float uLamps, uTime, uScale;
attribute vec3 aColor;
attribute float aSize;
attribute float aNight;
attribute float aPhase;
attribute vec2 aFlick;
varying vec3 vColor;
varying float vOn;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float on = mix(1.0, uLamps, aNight);
  float fl = 1.0 + aFlick.x * (sin(uTime * aFlick.y + aPhase) * 0.6 + sin(uTime * aFlick.y * 2.7 + aPhase * 1.3) * 0.4);
  vOn = on * fl;
  vColor = aColor;
  gl_PointSize = on > 0.01 ? max(1.0, aSize * uScale / -mv.z) : 0.0;
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */`
uniform float uIntensity;
varying vec3 vColor;
varying float vOn;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float core = smoothstep(0.35, 0.0, r);
  float halo = pow(1.0 - r, 2.2);
  gl_FragColor = vec4(vColor * (halo * 0.45 + core * 1.2) * uIntensity * vOn, 1.0);
}`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const glow = new THREE.Points(glowGeo, glowMat)
  glow.frustumCulled = false
  glow.renderOrder = 5
  group.add(glow)

  function setPoolSize(n: number): void {
    for (const p of pool) { group.remove(p.light); p.light.dispose() }
    pool = []
    for (let i = 0; i < Math.max(0, n); i++) {
      const light = new THREE.PointLight(0xffffff, 0, 1, L.decay)
      light.castShadow = false
      group.add(light)
      pool.push({ light, src: null, level: 0 })
    }
    reassignT = 0
  }

  const effective = (s: LightSource, lamps: number) => s.intensity * (s.nightOnly ? lamps : 1)

  return {
    group,
    setSources(list) {
      sources = list
      const n = list.length
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), night = new Float32Array(n), phase = new Float32Array(n)
      const flick = new Float32Array(n * 2)
      list.forEach((s, i) => {
        const f = L.flicker[s.kind ?? 'default'] ?? L.flicker.default
        flick.set([f.amount, f.speed], i * 2)
        pos.set([s.x, s.y, s.z], i * 3)
        col.set([s.color.r * Math.min(2, s.intensity), s.color.g * Math.min(2, s.intensity), s.color.b * Math.min(2, s.intensity)], i * 3)
        size[i] = L.glowSize * Math.sqrt(Math.max(0.1, s.radius))
        night[i] = s.nightOnly ? 1 : 0
        phase[i] = s.phase
      })
      // release the previous GPU buffers (sources change whenever streamed chunks come and go)
      glowGeo.dispose()
      glowGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      glowGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
      glowGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
      glowGeo.setAttribute('aNight', new THREE.BufferAttribute(night, 1))
      glowGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1))
      glowGeo.setAttribute('aFlick', new THREE.BufferAttribute(flick, 2))
      glowGeo.setDrawRange(0, n)
      // streamed chunks swap sources in and out: lights whose source survives keep their slot and level (no flicker)
      const alive = new Set(list)
      for (const p of pool) if (p.src && !alive.has(p.src)) { p.src = null; p.level = 0; p.light.intensity = 0 }
      reassignT = 0
    },
    setPoolSize,
    update(dt, time, focus, lamps, glowOn, pxPerUnit) {
      glowMat.uniforms.uLamps.value = lamps
      glowMat.uniforms.uTime.value = time
      glowMat.uniforms.uScale.value = pxPerUnit
      glow.visible = glowOn && sources.length > 0
      reassignT -= dt
      if (reassignT <= 0 && pool.length) {
        reassignT = L.reassignSeconds
        const ranked = sources
          .filter((s) => effective(s, lamps) > 0.01)
          .map((s) => ({ s, d: (s.x - focus.x) ** 2 + (s.z - focus.z) ** 2 + (s.y - focus.y) ** 2 }))
          .sort((a, b) => a.d - b.d)
          .slice(0, pool.length)
          .map((r) => r.s)
        const keep = new Set(ranked)
        const free = pool.filter((p) => !p.src || !keep.has(p.src))
        const assigned = new Set(pool.filter((p) => p.src && keep.has(p.src)).map((p) => p.src))
        for (const s of ranked) {
          if (assigned.has(s)) continue
          const slot = free.shift()
          if (!slot) break
          slot.src = s
          slot.level = 0
          slot.light.position.set(s.x, s.y, s.z)
          slot.light.color.copy(s.color)
          slot.light.distance = s.radius * L.distanceMul
        }
        for (const p of free) p.src = null
      }
      const k = 1 - Math.exp(-L.fadeSpeed * dt)
      for (const p of pool) {
        const target = p.src ? effective(p.src, lamps) : 0
        p.level += (target - p.level) * k
        const pf = p.src ? L.flicker[p.src.kind ?? 'default'] ?? L.flicker.default : L.flicker.default
        const fl = p.src ? 1 + pf.amount * Math.sin(time * pf.speed + p.src.phase) : 1
        p.light.intensity = p.level * L.pointIntensity * fl
        p.light.visible = true
      }
    },
    dispose() {
      setPoolSize(0)
      glowGeo.dispose()
      glowMat.dispose()
    },
  }
}
