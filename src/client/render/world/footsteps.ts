// Footstep feedback by terrain for every walking actor (player, follower, NPCs, wild creatures): dust puffs on dirt,
// sand grains, powder and fading footprints on snow and sand, mud splats, splash + expanding water rings in shallows,
// gentle rings where an actor stands at a shore, and the dust ring of a ledge landing. One footstep per stride of
// walked distance (the walk cadence); creatures leave one per hop. All numbers: render.json "footsteps".
import * as THREE from 'three'
import { RENDER, hexToRgb } from '../config.ts'
import type { PhysicsTier, PrintKind, PuffKind, StepClass } from '../physics-config.ts'
import { createPuffSystem, type PuffSystem } from './puffs.ts'
import { createCanvas } from '../sprite-utils.ts'

export interface FootstepEnv {
  /** Terrain key of a tile (null outside the map). */
  terrainKey(tx: number, ty: number): string | null
  isLiquid(tx: number, ty: number): boolean
  /** Water surface height of a liquid tile. */
  liquidY(tx: number, ty: number): number
  /** Walking height at a point (liquid surface over liquid tiles). */
  groundY(x: number, z: number): number
  /** Climate snow field 0..1 at a point. */
  snowAt(x: number, z: number): number
}

export interface StepActor {
  /** Stable identity (the registry entry). */
  readonly id: object
  x: number; y: number; z: number
  visible: boolean
  /** Characters step by walked distance, creatures leave one mark per hop stride. */
  kind: 'foot' | 'hop'
  /** Size multiplier of puffs and prints (species size). */
  scale: number
}

export interface FootstepSystem {
  readonly group: THREE.Group
  setEnv(env: FootstepEnv | null): void
  /** Applies the quality tier (pool limits; `footsteps: 'off'` stops everything and clears it). */
  configure(tier: PhysicsTier): void
  update(dt: number, time: number, focus: THREE.Vector3, actors: Iterable<StepActor>, light: THREE.Color, pxScale: number): void
  /** Landing from a ledge hop at ground point (x, z). */
  landing(x: number, z: number, scale?: number): void
  /** Plays a world fx kind as puffs (render.json footsteps.fxRoute). True when handled. */
  route(kind: string, x: number, y: number, z: number): boolean
  readonly stats: { puffs: number; prints: number }
  dispose(): void
}

interface Walker {
  x: number; z: number; acc: number; foot: number; init: boolean
  hx: number; hz: number
  idleT: number; shoreT: number
}

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])

/** Foot print sprite: rows of 'X' (filled) / '.' texels from render.json, nearest sampled. */
function printTexture(): THREE.CanvasTexture {
  const T = RENDER.footsteps.printTexture
  const c = createCanvas(T.width, T.height)
  const g = c.getContext('2d')!
  const img = g.createImageData(T.width, T.height)
  T.rows.forEach((row, y) => {
    for (let x = 0; x < T.width; x++) {
      const i = (y * T.width + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
      img.data[i + 3] = row[x] === 'X' ? 255 : 0
    }
  })
  g.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(c)
  tex.magFilter = tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  return tex
}

export function createFootsteps(onRipple: (x: number, z: number, y: number, amp: number) => void): FootstepSystem {
  const F = RENDER.footsteps
  const tiers = Object.values(RENDER.physics.tiers)
  const puffCap = Math.max(...tiers.map((t) => t.puffPool))
  const printCap = Math.max(1, ...tiers.map((t) => t.printPool))
  const group = new THREE.Group()
  group.name = 'footsteps'
  const puffs = createPuffSystem(puffCap)
  group.add(puffs.points)

  // --- footprints: one instanced flat quad per print, fading in the shader ---------------------------------------
  const tex = printTexture()
  const printGeo = new THREE.PlaneGeometry(1, 1)
  printGeo.rotateX(-Math.PI / 2)
  const aFade = new THREE.InstancedBufferAttribute(new Float32Array(printCap), 1)
  const aTint = new THREE.InstancedBufferAttribute(new Float32Array(printCap * 3), 3)
  aFade.setUsage(THREE.DynamicDrawUsage)
  printGeo.setAttribute('aFade', aFade)
  printGeo.setAttribute('aTint', aTint)
  const printMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: tex }, uLight: { value: new THREE.Color(1, 1, 1) } },
    vertexShader: /* glsl */`
attribute float aFade;
attribute vec3 aTint;
varying float vFade;
varying vec3 vTint;
varying vec2 vUv;
void main() {
  vFade = aFade; vTint = aTint; vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}`,
    fragmentShader: /* glsl */`
uniform sampler2D uMap;
uniform vec3 uLight;
varying float vFade;
varying vec3 vTint;
varying vec2 vUv;
void main() {
  float m = texture2D(uMap, vUv).a;
  if (m < 0.5 || vFade <= 0.0) discard;
  gl_FragColor = vec4(vTint * uLight, vFade);
}`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  const prints = new THREE.InstancedMesh(printGeo, printMat, printCap)
  prints.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  prints.frustumCulled = false
  prints.renderOrder = 4
  prints.name = 'prints'
  const zeroM = new THREE.Matrix4().makeScale(0, 0, 0)
  for (let i = 0; i < printCap; i++) prints.setMatrixAt(i, zeroM)
  group.add(prints)
  const pr = { born: new Float64Array(printCap).fill(-1e9), life: new Float32Array(printCap), fade: new Float32Array(printCap), alpha: new Float32Array(printCap) }
  let printCursor = 0, printLimit = 0, livePrints = 0
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0)
  const _c = new THREE.Color()

  let env: FootstepEnv | null = null
  let mode: PhysicsTier['footsteps'] = 'off'
  let now = 0
  const walkers = new WeakMap<object, Walker>()
  const rippleAt = (x: number, z: number, y: number, amp: number, rings: number) => {
    for (let i = 0; i < rings; i++) onRipple(x + (i ? 0.14 : 0) * (Math.random() - 0.5), z + (i ? 0.14 : 0) * (Math.random() - 0.5), y, amp * (i ? 0.7 : 1))
  }

  function spawnPuffs(ids: string[], x: number, y: number, z: number, hx: number, hz: number, scale: number): void {
    for (const id of ids) {
      const k: PuffKind | undefined = F.puffs[id]
      if (k) puffs.spawn(k, x, y + F.lift, z, { dirX: hx, dirZ: hz, scale })
    }
  }

  function addPrint(kindId: string, x: number, y: number, z: number, hx: number, hz: number, foot: number, scale: number): void {
    const k: PrintKind | undefined = F.prints[kindId]
    if (!k || printLimit <= 0) return
    const i = printCursor % printLimit
    printCursor = (printCursor + 1) % printLimit
    // the foot sits left / right of the heading
    const px = x + -hz * k.gap * foot * scale, pz = z + hx * k.gap * foot * scale
    _p.set(px, y + F.lift, pz)
    _q.setFromAxisAngle(_up, Math.atan2(-hx, -hz))
    _s.set(k.size[1] * scale * foot, 1, k.size[0] * scale)
    prints.setMatrixAt(i, _m.compose(_p, _q, _s))
    _c.setRGB(...hexToRgb(k.color), THREE.SRGBColorSpace)
    aTint.setXYZ(i, _c.r, _c.g, _c.b)
    pr.born[i] = now
    pr.life[i] = k.lifeSec
    pr.fade[i] = k.fadeSec
    pr.alpha[i] = k.alpha
    aFade.setX(i, k.alpha)
  }

  function classOf(x: number, z: number): { cls: StepClass; id: string; liquid: boolean; tx: number; tz: number } | null {
    if (!env) return null
    const tx = Math.floor(x), tz = Math.floor(z)
    const key = env.terrainKey(tx, tz)
    if (!key) return null
    let id = F.terrain[key]
    const S = F.climateSnow
    if (S && S.terrains.includes(key) && env.snowAt(x, z) >= S.threshold) id = S.class
    const cls = id ? F.classes[id] : undefined
    return cls ? { cls, id, liquid: env.isLiquid(tx, tz), tx, tz } : null
  }

  function step(a: StepActor, w: Walker): void {
    const at = classOf(a.x, a.z)
    if (!at) return
    const y = at.liquid ? env!.liquidY(at.tx, at.tz) : env!.groundY(a.x, a.z)
    spawnPuffs(list(at.cls.puff), a.x, y, a.z, w.hx, w.hz, a.scale)
    if (at.cls.print && mode === 'full' && !at.liquid) addPrint(at.cls.print, a.x, y, a.z, w.hx, w.hz, w.foot, a.scale)
    if (at.cls.ripple && at.liquid && mode === 'full') rippleAt(a.x, a.z, y, at.cls.ripple.amp, at.cls.ripple.rings)
  }

  /** Gentle rings where an actor stands or walks on land next to water. */
  function shore(a: StepActor, w: Walker, dt: number): void {
    w.shoreT -= dt
    if (w.shoreT > 0 || !env) return
    const tx = Math.floor(a.x), tz = Math.floor(a.z)
    if (env.isLiquid(tx, tz)) return
    let best = F.shore.reach, bx = 0, bz = 0, by = 0
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue
      if (!env.isLiquid(tx + dx, tz + dz)) continue
      // nearest point of that water tile to the foot
      const nx = Math.min(tx + dx + 1, Math.max(tx + dx, a.x)), nz = Math.min(tz + dz + 1, Math.max(tz + dz, a.z))
      const d = Math.hypot(nx - a.x, nz - a.z)
      if (d < best) { best = d; bx = nx; bz = nz; by = env.liquidY(tx + dx, tz + dz) }
    }
    if (best >= F.shore.reach) { w.shoreT = 0.3; return }
    w.shoreT = F.shore.everySec * (0.7 + Math.random() * 0.6)
    onRipple(bx, bz, by, F.shore.amp)
  }

  function updateWalker(a: StepActor, dt: number): void {
    let w = walkers.get(a.id)
    if (!w) { w = { x: a.x, z: a.z, acc: 0, foot: 1, init: false, hx: 0, hz: 1, idleT: 0, shoreT: 0 }; walkers.set(a.id, w) }
    const dx = a.x - w.x, dz = a.z - w.z
    const moved = Math.hypot(dx, dz)
    w.x = a.x; w.z = a.z
    if (!w.init || moved >= F.teleportTiles) { w.init = true; w.acc = 0; return }
    if (moved > 1e-4) {
      // smoothed heading for print / dust direction
      const k = Math.min(1, moved * 8)
      w.hx += (dx / moved - w.hx) * k; w.hz += (dz / moved - w.hz) * k
      const l = Math.hypot(w.hx, w.hz) || 1
      w.hx /= l; w.hz /= l
    }
    const speed = dt > 0 ? moved / dt : 0
    const stride = a.kind === 'hop' ? F.stride.hop : speed > F.runSpeed ? F.stride.run : F.stride.walk
    w.acc += moved
    while (w.acc >= stride * a.scale ** 0.5) {
      w.acc -= stride * a.scale ** 0.5
      w.foot = -w.foot
      step(a, w)
    }
    if (mode === 'full') {
      shore(a, w, dt)
      // standing in water keeps stirring it
      if (speed < 0.2) {
        const at = classOf(a.x, a.z)
        if (at?.liquid && at.cls.idleEverySec && at.cls.ripple) {
          w.idleT -= dt
          if (w.idleT <= 0) { w.idleT = at.cls.idleEverySec * (0.8 + Math.random() * 0.4); rippleAt(a.x, a.z, env!.liquidY(at.tx, at.tz), at.cls.ripple.amp * 0.6, 1) }
        }
      } else w.idleT = 0
    }
  }

  const sys: FootstepSystem = {
    group,
    setEnv(e) { env = e },
    configure(t) {
      mode = t.footsteps
      puffs.limit = mode === 'off' ? 0 : Math.min(puffCap, t.puffPool)
      printLimit = mode === 'full' ? Math.min(printCap, t.printPool) : 0
      group.visible = mode !== 'off'
      if (mode === 'off') {
        for (let i = 0; i < printCap; i++) { pr.born[i] = -1e9; aFade.setX(i, 0) }
        aFade.needsUpdate = true
      }
    },
    update(dt, time, focus, actors, light, pxScale) {
      now = time
      if (mode === 'off' || !env) return
      for (const a of actors) {
        if (!a.visible) { const w = walkers.get(a.id); if (w) w.init = false; continue }
        if (Math.hypot(a.x - focus.x, a.z - focus.z) > F.maxDistance) { const w = walkers.get(a.id); if (w) w.init = false; continue }
        updateWalker(a, dt)
      }
      puffs.update(dt, time, light, pxScale)
      ;(printMat.uniforms.uLight.value as THREE.Color).copy(light)
      // fade prints
      let live = 0
      for (let i = 0; i < printCap; i++) {
        const age = time - pr.born[i]
        if (age < 0 || age > pr.life[i] + pr.fade[i]) { if (aFade.getX(i) !== 0) { aFade.setX(i, 0); prints.setMatrixAt(i, zeroM) } continue }
        live++
        aFade.setX(i, age <= pr.life[i] ? pr.alpha[i] : pr.alpha[i] * (1 - (age - pr.life[i]) / pr.fade[i]))
      }
      livePrints = live
      aFade.needsUpdate = true
      prints.instanceMatrix.needsUpdate = true
      aTint.needsUpdate = true
    },
    landing(x, z, scale = 1) {
      if (mode === 'off' || !env) return
      const at = classOf(x, z)
      const tx = Math.floor(x), tz = Math.floor(z)
      if (env.isLiquid(tx, tz)) {
        const y = env.liquidY(tx, tz)
        spawnPuffs(list(F.land.splash), x, y, z, 0, 0, scale)
        if (mode === 'full') rippleAt(x, z, y, F.land.ripple.amp, F.land.ripple.rings)
        return
      }
      const y = env.groundY(x, z)
      // dirt-like terrain lands in its own colour, everything else in generic dust
      const own = list(at?.cls.puff).filter((id) => F.puffs[id]?.shape === 'cloud')
      spawnPuffs(own.length ? own : list(F.land.puff), x, y, z, 0, 0, scale * 1.4)
      if (at?.cls.print && mode === 'full') {
        addPrint(at.cls.print, x, y, z, 0, 1, 1, scale)
        addPrint(at.cls.print, x, y, z, 0, 1, -1, scale)
      }
    },
    route(kind, x, y, z) {
      const r = F.fxRoute[kind]
      if (!r || mode === 'off' || !env) return false
      if (r.land) { sys.landing(x, z); return true }
      spawnPuffs(list(r.puff), x, y, z, 0, 0, 1)
      if (r.ripple && mode === 'full' && env.isLiquid(Math.floor(x), Math.floor(z))) rippleAt(x, z, env.liquidY(Math.floor(x), Math.floor(z)), r.ripple.amp, r.ripple.rings)
      return true
    },
    get stats() { return { puffs: puffs.limit, prints: livePrints } },
    dispose() { puffs.dispose(); printGeo.dispose(); printMat.dispose(); tex.dispose(); prints.dispose() },
  }
  return sys
}
