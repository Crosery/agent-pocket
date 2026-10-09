// VFX primitives: turns one expanded timeline step (content/battle-stage.json) into a live effect. Each primitive is
// a code capability keyed by id. Every number, color and timing comes from data: the step's own fields, its
// primitive's defaults (`vfx.defaults`, merged by expandSteps) and the per-primitive curve constants (`vfx.look`).
// Anchors resolve against the creatures / trainers of the call's "self" and "foe" sides; spatial sizes scale with
// the anchored creature.
import * as THREE from 'three'
import type { MoveCategory } from '../../../shared/types.ts'
import type { HD2DRenderer } from '../../contracts.ts'
import { hexToRgb } from '../config.ts'
import type { BattleCamera } from './camera.ts'
import { STAGE, shotFor, type AnchorId, type SideIndex, type Vec2, type Vec3, type VfxStep } from './config.ts'
import { arcRibbonGeometry, createRibbon, glowMaterial, placeAxialQuad, type SharedGeometries } from './meshes.ts'
import type { GlyphAtlas, ParticlePool, ParticleSpawn } from './particles.ts'
import type { BattleSprite } from './sprites.ts'
import { ease, envelope, outAndBack } from './timeline.ts'

export interface FxCtx {
  /** The side the call is about (attacker, the one hit, the one fainting...). */
  self: SideIndex
  foe: SideIndex
  category: MoveCategory | null
  /** Tint for '$main' (linear). */
  main: THREE.Color
}

export interface FxHost {
  readonly group: THREE.Group
  readonly camera: BattleCamera
  readonly renderer: HD2DRenderer
  readonly additive: ParticlePool
  readonly alpha: ParticlePool
  readonly atlas: GlyphAtlas
  readonly geos: SharedGeometries
  readonly origin: THREE.Vector3
  creature(side: SideIndex): BattleSprite
  trainer(side: SideIndex): BattleSprite
  /** Ground home of a slot spot. */
  home(side: SideIndex, who: 'creature' | 'trainer'): THREE.Vector3
  particleScale(): number
  /** Borrows a VFX point light (steals the oldest when all are busy). */
  acquireLight(): THREE.PointLight
  releaseLight(l: THREE.PointLight): void
  /** Adds a dimming amount (0..1) for this frame. */
  dim(amount: number): void
  /** Raises the screen flash overlay to `level` (0..1) for this frame. */
  flash(level: number): void
}

export interface Effect {
  /** Returns false when finished. */
  update(dt: number): boolean
  dispose(): void
}

/** An expanded step: every field its primitive reads is present (vfx.defaults, enforced by validation). */
type Full = Required<VfxStep>

const WHITE = new THREE.Color(1, 1, 1)
const BLACK = new THREE.Color(0, 0, 0)
const UP = new THREE.Vector3(0, 1, 0)
const rand = (r: Vec2) => r[0] + Math.random() * (r[1] - r[0])
const sym = () => Math.random() * 2 - 1
const L = () => STAGE.vfx.look

/** '#rrggbb' or a token ('$main', '$light', '$dark', '$white') -> linear color. */
export function resolveColor(ref: string, ctx: FxCtx): THREE.Color {
  const V = STAGE.vfx
  switch (ref) {
    case '$main': return ctx.main.clone()
    case '$light': return ctx.main.clone().lerp(WHITE, V.lightMix)
    case '$dark': return ctx.main.clone().lerp(BLACK, V.darkMix)
    case '$white': return WHITE.clone()
    default: return new THREE.Color().setRGB(...hexToRgb(ref), THREE.SRGBColorSpace)
  }
}

export function colorHex(c: THREE.Color): string { return `#${c.getHexString(THREE.SRGBColorSpace)}` }

/** Primary and secondary colors of a mesh step, scaled by its glow (HDR so the bloom picks them up). */
function colors2(s: Full, ctx: FxCtx): [THREE.Color, THREE.Color] {
  return [resolveColor(s.color, ctx).multiplyScalar(s.glow), resolveColor(s.color2, ctx).multiplyScalar(s.glow)]
}

// ---------------------------------------------------------------------------
// Anchors and the local frame
// ---------------------------------------------------------------------------

interface Frame { fwd: THREE.Vector3; up: THREE.Vector3; lat: THREE.Vector3 }

function frameOf(host: FxHost, ctx: FxCtx): Frame {
  const fwd = new THREE.Vector3().subVectors(host.home(ctx.foe, 'creature'), host.home(ctx.self, 'creature'))
  fwd.y = 0
  if (fwd.lengthSq() < 1e-6) fwd.set(1, 0, 0)
  fwd.normalize()
  return { fwd, up: UP.clone(), lat: new THREE.Vector3().crossVectors(fwd, UP).normalize() }
}

function spriteFor(host: FxHost, ctx: FxCtx, on: AnchorId): BattleSprite | null {
  switch (on) {
    case 'self': return host.creature(ctx.self)
    case 'foe': return host.creature(ctx.foe)
    case 'selfTrainer': return host.trainer(ctx.self)
    case 'foeTrainer': return host.trainer(ctx.foe)
    default: return null
  }
}

function spritePoint(host: FxHost, ctx: FxCtx, on: AnchorId, h: number, out: THREE.Vector3): THREE.Vector3 {
  const sp = spriteFor(host, ctx, on)
  if (sp && sp.id) return sp.pointAt(h, out)
  const side = on === 'foe' || on === 'foeTrainer' ? ctx.foe : ctx.self
  const who = on === 'selfTrainer' || on === 'foeTrainer' ? 'trainer' : 'creature'
  const nominal = who === 'trainer' ? STAGE.trainer.height : STAGE.creature.height * STAGE.slots[side].scale
  return out.copy(host.home(side, who)).addScaledVector(UP, nominal * h)
}

/** Size factor: anchored creature height relative to a size-1 creature. */
function sizeOf(host: FxHost, ctx: FxCtx, on: AnchorId): number {
  if (on === 'mid' || on === 'stage') return 1
  const sp = spriteFor(host, ctx, on)
  const side = on === 'foe' || on === 'foeTrainer' ? ctx.foe : ctx.self
  const h = sp && sp.id ? sp.height : STAGE.creature.height * STAGE.slots[side].scale
  return h / STAGE.creature.height
}

function anchorPoint(host: FxHost, ctx: FxCtx, fr: Frame, on: AnchorId, h: number, off: Vec3 | undefined, out: THREE.Vector3): THREE.Vector3 {
  if (on === 'stage') out.copy(host.origin).addScaledVector(UP, h)
  else if (on === 'mid') {
    const a = spritePoint(host, ctx, 'self', h, new THREE.Vector3())
    const b = spritePoint(host, ctx, 'foe', h, new THREE.Vector3())
    out.addVectors(a, b).multiplyScalar(0.5)
  } else spritePoint(host, ctx, on, h, out)
  if (off) out.addScaledVector(fr.fwd, off[0]).addScaledVector(fr.up, off[1]).addScaledVector(fr.lat, off[2])
  return out
}

interface Anchor { (out: THREE.Vector3): THREE.Vector3; size: number }

function anchorOf(host: FxHost, ctx: FxCtx, fr: Frame, on: AnchorId, h: number, off: Vec3 | undefined): Anchor {
  const size = sizeOf(host, ctx, on)
  const scaledOff = off ? [off[0] * size, off[1] * size, off[2] * size] as Vec3 : undefined
  const fn = ((out: THREE.Vector3) => anchorPoint(host, ctx, fr, on, h, scaledOff, out)) as Anchor
  fn.size = size
  return fn
}

/** The step's main anchor (`on`, `h`, `off`). */
const mainAnchor = (step: VfxStep, s: Full, ctx: FxCtx, host: FxHost, fr: Frame) => anchorOf(host, ctx, fr, s.on, s.h, step.off)
/** The step's target anchor (`to`, `toH` defaulting to `h`, `toOff`). */
const targetAnchor = (step: VfxStep, to: AnchorId, s: Full, ctx: FxCtx, host: FxHost, fr: Frame) => anchorOf(host, ctx, fr, to, step.toH ?? s.h, step.toOff)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timed(dur: number, tick: (k: number, t: number, dt: number) => void, done?: () => void, cleanup?: () => void): Effect {
  let t = 0
  const d = Math.max(1e-3, dur)
  let finished = false
  return {
    update(dt) {
      if (finished) return false
      t += dt
      tick(Math.min(1, t / d), t, dt)
      if (t >= d) { finished = true; done?.(); return false }
      return true
    },
    dispose() { if (!finished) { finished = true; done?.() } cleanup?.() },
  }
}

/** Runs `count` copies of an effect factory, the i-th starting after i * stagger seconds. */
function staggered(count: number, stagger: number, make: (i: number) => Effect): Effect {
  const n = Math.max(1, count)
  const live: (Effect | null)[] = []
  let t = 0
  let started = 0
  return {
    update(dt) {
      t += dt
      while (started < n && t >= started * stagger) { live.push(make(started)); started++ }
      let alive = started < n
      for (let i = 0; i < live.length; i++) {
        const e = live[i]
        if (!e) continue
        if (e.update(dt)) alive = true
        else { e.dispose(); live[i] = null }
      }
      return alive
    },
    dispose() { for (const e of live) e?.dispose(); live.length = 0 },
  }
}

/** Render orders inside the VFX group: back-to-front layering of the additive meshes. */
const ORDER = { ring: 33, shield: 33, column: 33, glow: 34, beam: 35, projectile: 36, flare: 36, slash: 37, bolt: 38 } as const

function addMesh(host: FxHost, mesh: THREE.Mesh, order: number): void {
  mesh.renderOrder = order
  mesh.frustumCulled = false
  host.group.add(mesh)
}

/** 0..1 attack ramp over the first `inK` share of the step. */
const attack = (k: number, inK: number) => Math.min(1, k / Math.max(1e-3, inK))

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3()

// ---------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------

function particleStep(step: VfxStep, ctx: FxCtx, host: FxHost, fr: Frame): Effect {
  const s = step as Full
  const pool = s.blend === 'alpha' ? host.alpha : host.additive
  const colors = (step.colors?.length ? step.colors : [s.color]).map((c) => resolveColor(c, ctx).multiplyScalar(s.glow))
  const end = step.color2 ? resolveColor(step.color2, ctx).multiplyScalar(s.glow) : null
  const anchor = mainAnchor(step, s, ctx, host, fr)
  const k = anchor.size
  const count = Math.max(1, Math.round(s.count * host.particleScale()))
  const chars = step.chars ? [...step.chars] : null
  const spawn: ParticleSpawn = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, size: 0, grow: s.grow, color: colors[0], color1: colors[0], alpha: 1,
    shape: s.shape, glyph: 0, gravity: s.gravity * k, drag: s.drag, orbit: s.orbit, cx: 0, cz: 0, spin: 0,
  }
  const center = new THREE.Vector3()
  const off = new THREE.Vector3()
  const dir = new THREE.Vector3()
  function one(): void {
    anchor(center)
    off.set(0, 0, 0)
    if (step.spread) off.addScaledVector(fr.fwd, sym() * step.spread[0] * k).addScaledVector(fr.up, sym() * step.spread[1] * k).addScaledVector(fr.lat, sym() * step.spread[2] * k)
    if (s.radius) {
      dir.set(sym(), sym(), sym())
      if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0)
      dir.normalize()
      // inward particles start on the shell; others fill the ball uniformly
      off.addScaledVector(dir, s.radius * k * (s.dir === 'inward' ? 1 : Math.cbrt(Math.random())))
    }
    const sp = rand(s.speed) * k
    switch (s.dir) {
      case 'radial': dir.copy(off); if (dir.lengthSq() < 1e-6) dir.set(sym(), sym(), sym()); dir.normalize().multiplyScalar(sp); break
      case 'inward': dir.copy(off).normalize().multiplyScalar(-sp); break
      case 'up': dir.set(0, sp, 0); break
      case 'down': dir.set(0, -sp, 0); break
      default: dir.set(0, 0, 0)
    }
    if (step.vel) dir.addScaledVector(fr.fwd, step.vel[0] * k).addScaledVector(fr.up, step.vel[1] * k).addScaledVector(fr.lat, step.vel[2] * k)
    spawn.x = center.x + off.x; spawn.y = center.y + off.y; spawn.z = center.z + off.z
    spawn.vx = dir.x; spawn.vy = dir.y; spawn.vz = dir.z
    spawn.life = rand(s.life)
    spawn.size = rand(s.size) * k
    const c = colors[Math.floor(Math.random() * colors.length)]
    spawn.color = c
    spawn.color1 = end ?? c
    spawn.cx = center.x; spawn.cz = center.z
    spawn.spin = sym() * s.spin
    spawn.glyph = chars ? host.atlas.index(chars[Math.floor(Math.random() * chars.length)]) : 0
    pool.spawn(spawn)
  }
  let emitted = 0
  let t = 0
  if (s.emit <= 0) { for (; emitted < count; emitted++) one() }
  return {
    update(dt) {
      t += dt
      if (emitted >= count) return false
      const want = Math.min(count, Math.ceil(count * Math.min(1, t / s.emit)))
      while (emitted < want) { one(); emitted++ }
      return emitted < count
    },
    dispose() {},
  }
}

// ---------------------------------------------------------------------------
// Mesh effects
// ---------------------------------------------------------------------------

function glowStep(step: VfxStep, ctx: FxCtx, host: FxHost, fr: Frame): Effect {
  const s = step as Full
  const anchor = mainAnchor(step, s, ctx, host, fr)
  const [c1, c2] = colors2(s, ctx)
  const mat = glowMaterial('glow', c1, c2, [s.amount, s.width, 0, 0])
  const mesh = new THREE.Mesh(host.geos.quad, mat)
  addMesh(host, mesh, ORDER.glow)
  const [s0, s1] = s.size
  return timed(s.dur, (k, t) => {
    anchor(mesh.position)
    mesh.quaternion.copy(host.camera.camera.quaternion)
    const pulse = step.hz ? 1 + L().glow.pulse * Math.sin(t * step.hz * Math.PI * 2) : 1
    mesh.scale.setScalar((s0 + (s1 - s0) * ease.outCubic(k)) * anchor.size * pulse)
    mat.uniforms.uAlpha.value = envelope(k, s.inK, s.outK)
  }, undefined, () => { mesh.removeFromParent(); mat.dispose() })
}

function ringStep(step: VfxStep, ctx: FxCtx, host: FxHost, fr: Frame): Effect {
  const s = step as Full
  const look = L().ring
  const [c1, c2] = colors2(s, ctx)
  const from = mainAnchor(step, s, ctx, host, fr)
  const to = step.to ? targetAnchor(step, step.to, s, ctx, host, fr) : null
  const [r0, r1] = s.radii
  return staggered(s.count, s.stagger, () => {
    const mat = glowMaterial('ring', c1, c2, [s.width, look.edge, 0, 0])
    const mesh = new THREE.Mesh(host.geos.quad, mat)
    addMesh(host, mesh, ORDER.ring)
    const size = from.size
    return timed(s.dur, (k) => {
      from(_a)
      if (to) { to(_b); mesh.position.lerpVectors(_a, _b, ease.outQuad(k)) } else mesh.position.copy(_a)
      if (s.orient === 'ground') { mesh.rotation.set(-Math.PI / 2, 0, 0); mesh.position.y += look.groundLift }
      else if (s.orient === 'facing') mesh.quaternion.copy(host.camera.camera.quaternion)
      else mesh.lookAt(_p.copy(mesh.position).add(fr.fwd))
      const r = (r0 + (r1 - r0) * ease.outCubic(k)) * size
      mesh.scale.set(r * 2, r * 2, 1)
      mat.uniforms.uAlpha.value = (1 - ease.inQuad(k)) * attack(k, s.inK)
    }, undefined, () => { mesh.removeFromParent(); mat.dispose() })
  })
}

function beamStep(step: VfxStep, ctx: FxCtx, host: FxHost, fr: Frame): Effect {
  const s = step as Full
  const look = L().beam
  const [c1, c2] = colors2(s, ctx)
  const from = mainAnchor(step, s, ctx, host, fr)
  const to = targetAnchor(step, s.to, s, ctx, host, fr)
  const mat = glowMaterial('beam', c1, c2, [look.core, s.segments, s.hz, 0])
  const mesh = new THREE.Mesh(host.geos.quad, mat)
  addMesh(host, mesh, ORDER.beam)
  const flareMat = glowMaterial('glow', c1, c2, [look.flareFalloff, look.flareCore, 0, 0])
  const flare = new THREE.Mesh(host.geos.quad, flareMat)
  addMesh(host, flare, ORDER.flare)
  const width = s.width * from.size
  return timed(s.dur, (k, t) => {
    from(_a)
    to(_b)
    const extend = ease.outCubic(Math.min(1, k / look.extend))
    const thin = k > look.thinFrom ? Math.max(0, 1 - (k - look.thinFrom) / (1 - look.thinFrom)) : 1
    _q.lerpVectors(_a, _b, extend)
    const w = width * thin * (1 + look.flicker * Math.sin(t * look.flickerHz * Math.PI * 2))
    placeAxialQuad(mesh, _a, _q, Math.max(1e-3, w), host.camera.camera)
    mat.uniforms.uTime.value = t
    mat.uniforms.uAlpha.value = attack(k, s.inK)
    flare.position.copy(_q)
    flare.quaternion.copy(host.camera.camera.quaternion)
    flare.scale.setScalar(Math.max(1e-3, w * look.flare))
    flareMat.uniforms.uAlpha.value = thin
  }, undefined, () => { mesh.removeFromParent(); flare.removeFromParent(); mat.dispose(); flareMat.dispose() })
}

function projectileStep(step: VfxStep, ctx: FxCtx, host: FxHost, fr: Frame): Effect {
  const s = step as Full
  const look = L().projectile
  const [c1, c2] = colors2(s, ctx)
  const trail = step.trail
  const trailColor = trail ? resolveColor(trail.color ?? s.color, ctx).multiplyScalar(trail.glow ?? s.glow) : null
  const from = mainAnchor(step, s, ctx, host, fr)
  const to = targetAnchor(step, s.to, s, ctx, host, fr)
  const wob = step.wobble
  return staggered(s.count, s.stagger, () => {
    const mat = glowMaterial('glow', c1, c2, [look.falloff, look.core, 0, 0])
    const mesh = new THREE.Mesh(host.geos.quad, mat)
    addMesh(host, mesh, ORDER.projectile)
    const start = from(new THREE.Vector3())
    const spread = s.radius * to.size
    const jitter = new THREE.Vector3(sym(), sym() * look.jitterUp, sym()).multiplyScalar(spread)
    const phase = Math.random() * Math.PI * 2
    const size = rand(s.size) * from.size
    let acc = 0
    const spawn: ParticleSpawn | null = trail && trailColor ? {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, size: 0, grow: look.trailGrow, color: trailColor, color1: trailColor, alpha: 1,
      shape: trail.shape, glyph: 0, gravity: 0, drag: look.trailDrag, orbit: 0, cx: 0, cz: 0, spin: 0,
    } : null
    return timed(s.dur, (k, t, dt) => {
      to(_b).add(jitter)
      const e = ease.inOutSine(k)
      mesh.position.lerpVectors(start, _b, e)
      // parabolic arc peaking at arcHeight mid-flight
      mesh.position.addScaledVector(UP, s.arcHeight * 4 * e * (1 - e))
      if (wob) mesh.position.addScaledVector(fr.lat, wob[0] * Math.sin(t * wob[1] * Math.PI * 2 + phase) * (1 - e))
      mesh.quaternion.copy(host.camera.camera.quaternion)
      const shrink = k > look.shrinkFrom ? Math.max(look.shrinkMin, (1 - k) / (1 - look.shrinkFrom)) : 1
      mesh.scale.setScalar(size * shrink)
      mat.uniforms.uAlpha.value = attack(k, s.inK)
      if (spawn && trail) {
        acc += trail.rate * dt * host.particleScale()
        while (acc >= 1) {
          acc -= 1
          const sp = (trail.spread ?? look.trailSpread) * from.size
          const v = sp * look.trailVel
          spawn.x = mesh.position.x + sym() * sp; spawn.y = mesh.position.y + sym() * sp; spawn.z = mesh.position.z + sym() * sp
          spawn.vx = sym() * v; spawn.vy = sym() * v; spawn.vz = sym() * v
          spawn.life = rand(trail.life)
          spawn.size = rand(trail.size) * from.size
          host.additive.spawn(spawn)
        }
      }
    }, undefined, () => { mesh.removeFromParent(); mat.dispose() })
  })
}

function slashStep(step: VfxStep, ctx: FxCtx, host: FxHost, fr: Frame): Effect {
  const s = step as Full
  const look = L().slash
  const [c1, c2] = colors2(s, ctx)
  const anchor = mainAnchor(step, s, ctx, host, fr)
  const arc = THREE.MathUtils.degToRad(s.arc)
  const base = THREE.MathUtils.degToRad(s.angle)
  const jit = THREE.MathUtils.degToRad(s.jitter)
  // slashes sweep away from the attacker on screen
  const flip = host.home(ctx.foe, 'creature').x < host.home(ctx.self, 'creature').x ? -1 : 1
  return staggered(s.count, s.stagger, (i) => {
    const geo = arcRibbonGeometry(s.radius * anchor.size, s.width * anchor.size, arc, s.segments, look.taper, look.tip)
    const mat = glowMaterial('slash', c1, c2, [look.core, 0, 0, 0])
    const mesh = new THREE.Mesh(geo, mat)
    addMesh(host, mesh, ORDER.slash)
    const roll = (base + (i % 2 ? Math.PI * look.altRoll : 0) + sym() * jit) * flip
    const center = anchor(new THREE.Vector3())
    const lateral = (i - (s.count - 1) / 2) * s.spacing * anchor.size
    return timed(s.dur, (k) => {
      mesh.position.copy(center).addScaledVector(fr.lat, lateral)
      mesh.quaternion.copy(host.camera.camera.quaternion)
      mesh.rotateZ(roll)
      if (flip < 0) mesh.rotateY(Math.PI)
      mat.uniforms.uProgress.value = ease.outCubic(Math.min(1, k / look.draw)) * look.overshoot
      mat.uniforms.uAlpha.value = k < look.draw ? 1 : 1 - ease.inQuad((k - look.draw) / (1 - look.draw))
    }, undefined, () => { mesh.removeFromParent(); geo.dispose(); mat.dispose() })
  })
}

function boltStep(step: VfxStep, ctx: FxCtx, host: FxHost, fr: Frame): Effect {
  const s = step as Full
  const look = L().bolt
  const [c1, c2] = colors2(s, ctx)
  const target = mainAnchor(step, s, ctx, host, fr)
  const src = step.to ? targetAnchor(step, step.to, s, ctx, host, fr) : null
  const n = Math.max(look.minSegments, s.segments)
  return staggered(s.count, s.stagger, () => {
    const ribbon = createRibbon(n + 1)
    const mat = glowMaterial('bolt', c1, c2)
    const mesh = new THREE.Mesh(ribbon.geometry, mat)
    addMesh(host, mesh, ORDER.bolt)
    const pts = Array.from({ length: n + 1 }, () => new THREE.Vector3())
    const side = new THREE.Vector3(sym(), 0, sym()).multiplyScalar(s.spacing * target.size)
    let regen = 0
    const right = new THREE.Vector3()
    return timed(s.dur, (k, _t, dt) => {
      regen -= dt
      if (regen <= 0) {
        regen = 1 / s.hz
        target(_b)
        if (src) src(_a)
        else _a.copy(_b).addScaledVector(UP, s.height * target.size).add(side)
        right.setFromMatrixColumn(host.camera.camera.matrixWorld, 0)
        const jit = s.jitter * target.size
        for (let i = 0; i <= n; i++) {
          pts[i].lerpVectors(_a, _b, i / n)
          if (i > 0 && i < n) pts[i].addScaledVector(right, sym() * jit).addScaledVector(UP, sym() * jit * look.upJitter)
        }
        ribbon.update(pts, s.width * target.size, host.camera.camera)
      }
      mat.uniforms.uAlpha.value = (1 - look.flicker + look.flicker * Math.random()) * (1 - ease.inQuad(k))
    }, undefined, () => { mesh.removeFromParent(); ribbon.dispose(); mat.dispose() })
  })
}

function shieldStep(step: VfxStep, ctx: FxCtx, host: FxHost, fr: Frame): Effect {
  const s = step as Full
  const look = L().shield
  const anchor = mainAnchor(step, s, ctx, host, fr)
  const [c1, c2] = colors2(s, ctx)
  const mat = glowMaterial('shield', c1, c2, [s.amount, s.segments, 0, 0])
  const mesh = new THREE.Mesh(host.geos.sphere, mat)
  addMesh(host, mesh, ORDER.shield)
  const r = s.radius * anchor.size
  return timed(s.dur, (k, t) => {
    anchor(mesh.position)
    mesh.scale.setScalar(r * (look.popFrom + (1 - look.popFrom) * ease.outBack(Math.min(1, k / look.pop))))
    mesh.rotation.y = t * look.spin
    mat.uniforms.uTime.value = t
    mat.uniforms.uAlpha.value = envelope(k, s.inK, s.outK)
  }, undefined, () => { mesh.removeFromParent(); mat.dispose() })
}

function columnStep(step: VfxStep, ctx: FxCtx, host: FxHost, fr: Frame): Effect {
  const s = step as Full
  const look = L().column
  const [c1, c2] = colors2(s, ctx)
  const anchor = mainAnchor(step, s, ctx, host, fr)
  const count = Math.max(1, s.count)
  const phase = Math.random() * Math.PI * 2
  return staggered(count, s.stagger, (i) => {
    const mat = glowMaterial('column', c1, c2, [s.segments, s.hz, 0, 0])
    const mesh = new THREE.Mesh(host.geos.column, mat)
    addMesh(host, mesh, ORDER.column)
    // several columns stand evenly around the anchor
    const ang = phase + (i / count) * Math.PI * 2
    const ring = count > 1 ? s.spacing * anchor.size : 0
    const r = s.radius * anchor.size, h = s.height * anchor.size
    return timed(s.dur, (k, t) => {
      anchor(mesh.position)
      mesh.position.x += Math.cos(ang) * ring
      mesh.position.z += Math.sin(ang) * ring
      const grow = ease.outCubic(Math.min(1, k / look.grow))
      const narrow = 1 - look.narrow * ease.inQuad(k)
      mesh.scale.set(r * narrow, h * (look.startH + (1 - look.startH) * grow), r * narrow)
      mat.uniforms.uTime.value = t
      mat.uniforms.uAlpha.value = envelope(k, s.inK, s.outK)
    }, undefined, () => { mesh.removeFromParent(); mat.dispose() })
  })
}

function spikesStep(step: VfxStep, ctx: FxCtx, host: FxHost, fr: Frame): Effect {
  const s = step as Full
  const look = L().spikes
  const color = resolveColor(s.color, ctx)
  const mat = new THREE.MeshLambertMaterial({ color, emissive: color.clone().multiplyScalar(s.glow), flatShading: true })
  const anchor = mainAnchor(step, s, ctx, host, fr)
  const count = Math.max(1, Math.round(s.count * Math.max(look.minScale, host.particleScale())))
  const center = anchor(new THREE.Vector3())
  const spikes: { mesh: THREE.Mesh; h: number }[] = []
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(host.geos.cone, mat)
    mesh.castShadow = true
    // the first spike stands in the centre, the rest ring around it leaning outward
    const ang = (i / count) * Math.PI * 2 + sym() * look.angleJitter
    const rr = s.spacing * anchor.size * (i === 0 ? 0 : rand(look.ring))
    mesh.position.set(center.x + Math.cos(ang) * rr, center.y, center.z + Math.sin(ang) * rr)
    const tiltAmt = THREE.MathUtils.degToRad(s.angle) * (i === 0 ? look.centerTilt : 1)
    mesh.rotation.set(Math.sin(ang) * tiltAmt, Math.random() * Math.PI, -Math.cos(ang) * tiltAmt)
    host.group.add(mesh)
    spikes.push({ mesh, h: rand(s.size) * anchor.size })
  }
  const radius = s.radius * anchor.size
  return timed(s.dur, (k) => {
    const up = ease.outBack(Math.min(1, k / look.rise))
    const down = k > look.fallFrom ? ease.inQuad((k - look.fallFrom) / (1 - look.fallFrom)) : 0
    const w = radius * (1 - down * look.fallShrink)
    for (const sp of spikes) sp.mesh.scale.set(w, Math.max(1e-3, sp.h * up * (1 - down)), w)
  }, undefined, () => { for (const sp of spikes) sp.mesh.removeFromParent(); mat.dispose() })
}

function lightStep(step: VfxStep, ctx: FxCtx, host: FxHost, fr: Frame): Effect {
  const s = step as Full
  const anchor = mainAnchor(step, s, ctx, host, fr)
  const light = host.acquireLight()
  light.color.copy(resolveColor(s.color, ctx))
  light.distance = s.radius * anchor.size
  const peak = s.intensity * STAGE.vfx.lightScale
  const pow = L().light.decayPow
  return timed(s.dur, (k) => {
    anchor(light.position)
    light.intensity = peak * (k < s.inK ? k / s.inK : Math.pow(1 - (k - s.inK) / (1 - s.inK), pow))
  }, undefined, () => host.releaseLight(light))
}

// ---------------------------------------------------------------------------
// Actor animation
// ---------------------------------------------------------------------------

function actorOf(step: VfxStep, ctx: FxCtx, host: FxHost): { sprite: BattleSprite; side: SideIndex } {
  const onFoe = step.on === 'foe' || step.on === 'foeTrainer'
  const side = onFoe ? ctx.foe : ctx.self
  const who = step.who ?? (step.on === 'selfTrainer' || step.on === 'foeTrainer' ? 'trainer' : 'creature')
  return { sprite: who === 'trainer' ? host.trainer(side) : host.creature(side), side }
}

function actorStep(step: VfxStep, ctx: FxCtx, host: FxHost): Effect | null {
  const s = step as Full
  const look = L()
  const { sprite, side } = actorOf(step, ctx, host)
  const other = host.home(side === 0 ? 1 : 0, 'creature')
  const toward = new THREE.Vector3().subVectors(other, sprite.home).setY(0).normalize()
  const lat = new THREE.Vector3().crossVectors(toward, UP).normalize()
  const k0 = sprite.height / STAGE.creature.height
  const fx = sprite.fx
  const color = step.color ? resolveColor(step.color, ctx).multiplyScalar(s.glow) : null
  const flash = (v: number) => { if (color && v > fx.flash) { fx.flash = v; fx.flashColor.copy(color) } }
  const hideAfter = () => { if (step.hideAfter) sprite.present = false }
  switch (step.fx) {
    case 'tint': {
      const pulses = Math.max(1, s.pulses)
      return timed(s.dur, (k) => {
        let v = 0
        if (s.mode === 'blink') v = (k * pulses) % 1 < look.tint.duty ? s.amount * (1 - k * look.tint.blinkDecay) : 0
        else if (s.mode === 'fade') v = s.amount * (1 - ease.outQuad(k))
        else if (s.mode === 'hold') v = s.amount * envelope(k, s.inK, s.outK)
        else v = s.amount * ease.inOutQuad(k)
        flash(v)
      }, hideAfter)
    }
    case 'lunge':
      return timed(s.dur, (k) => {
        fx.offset.addScaledVector(toward, s.distance * outAndBack(k, look.lunge.peak)).addScaledVector(UP, s.height * ease.hump(k))
      }, hideAfter)
    case 'knock':
      return timed(s.dur, (k) => { fx.offset.addScaledVector(toward, -s.distance * outAndBack(k, look.knock.peak)) }, hideAfter)
    case 'dodge': {
      const sign = Math.random() < 0.5 ? -1 : 1
      return timed(s.dur, (k) => {
        fx.offset.addScaledVector(lat, sign * s.distance * ease.hump(k)).addScaledVector(UP, s.height * ease.hump(k))
      }, hideAfter)
    }
    case 'jitter': {
      const off = new THREE.Vector3()
      let hue = 0
      let next = 0
      return timed(s.dur, (_k, t) => {
        if (t >= next) {
          next = t + 1 / s.hz
          off.set(sym(), sym() * look.jitter.up, sym()).multiplyScalar(s.amount * k0)
          hue = sym() * s.angle
        }
        fx.offset.add(off)
        fx.hue += hue
        flash(Math.random() < look.jitter.flashChance ? look.jitter.flash : 0)
      }, hideAfter)
    }
    case 'squash':
      return timed(s.dur, (k) => { fx.squash += s.amount * ease.hump(k) }, hideAfter)
    case 'sink':
      return timed(s.dur, (k) => { fx.offset.y -= s.distance * k0 * ease.inQuad(k) }, hideAfter)
    case 'dissolve':
      return timed(s.dur, (k) => { fx.dissolve = Math.max(fx.dissolve, s.mode === 'in' ? 1 - k : k) }, hideAfter)
    case 'reveal': {
      if (!sprite.id) return null
      sprite.present = true
      return timed(s.dur, (k) => {
        if (s.mode === 'pop') { fx.scale *= ease.outBack(k); flash(s.amount * (1 - ease.outQuad(k))) }
        else if (s.mode === 'silhouette') flash(s.amount * (1 - ease.inOutQuad(k)))
        else if (s.mode === 'materialize') fx.dissolve = Math.max(fx.dissolve, 1 - ease.outQuad(k))
        else if (s.mode === 'drop') fx.offset.y += s.height * k0 * (1 - ease.outBounce(k))
      }, hideAfter)
    }
    case 'vanish':
      return timed(s.dur, (k) => {
        if (s.mode === 'shrink') { fx.scale *= 1 - ease.inQuad(k); flash(s.amount * Math.min(1, k * look.vanish.flashRise)) }
        else if (s.mode === 'dissolve') fx.dissolve = Math.max(fx.dissolve, k)
      }, () => { sprite.present = false })
    case 'enter': {
      const from = s.from
      return timed(s.dur, (k) => {
        const f = 1 - ease.outCubic(k)
        fx.offset.x += from[0] * f
        fx.offset.y += from[1] * f
        fx.offset.z += from[2] * f
      }, hideAfter)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** Starts the effect of one expanded step (see expandSteps). Instant steps (shake, camera) return null. */
export function spawnStep(step: VfxStep, ctx: FxCtx, host: FxHost): Effect | null {
  const s = step as Full
  const fr = frameOf(host, ctx)
  switch (step.fx) {
    case 'particles': return particleStep(step, ctx, host, fr)
    case 'projectile': return projectileStep(step, ctx, host, fr)
    case 'beam': return beamStep(step, ctx, host, fr)
    case 'ring': return ringStep(step, ctx, host, fr)
    case 'slash': return slashStep(step, ctx, host, fr)
    case 'bolt': return boltStep(step, ctx, host, fr)
    case 'shield': return shieldStep(step, ctx, host, fr)
    case 'column': return columnStep(step, ctx, host, fr)
    case 'glow': return glowStep(step, ctx, host, fr)
    case 'spikes': return spikesStep(step, ctx, host, fr)
    case 'light': return lightStep(step, ctx, host, fr)
    case 'flash': {
      // compatibility: HD2DRenderer.flash() always peaks at full strength, so it is only used to set the overlay
      // color (zero duration) and the level follows this step's amount through view.post.flash
      host.renderer.flash(colorHex(resolveColor(s.color, ctx)), 0)
      const pow = L().flash.decayPow
      return timed(s.ms / 1000, (k) => host.flash(s.amount * Math.pow(1 - k, pow)))
    }
    case 'shake':
      host.renderer.shake(s.intensity * STAGE.vfx.shakeScale, s.ms)
      return null
    case 'camera': {
      const side = s.on === 'foe' ? ctx.foe : s.on === 'stage' ? 0 : ctx.self
      const cam = host.camera
      const shot = s.shot === 'base' ? cam.baseShot : shotFor(s.shot, side)
      if (!shot) return null
      if (step.mode === 'cut') cam.cut(shot)
      else if (step.hold !== undefined) cam.push(shot, s.dur, step.hold, s.back)
      else cam.blendTo(shot, s.dur)
      return null
    }
    case 'dim':
      return timed(s.dur, (k) => host.dim(s.amount * envelope(k, s.inK, s.outK)))
    case 'tint': case 'lunge': case 'knock': case 'dodge': case 'jitter': case 'squash':
    case 'sink': case 'dissolve': case 'reveal': case 'vanish': case 'enter':
      return actorStep(step, ctx, host)
  }
  return null
}
