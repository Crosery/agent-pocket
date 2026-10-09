// Cinematic battle camera: eased blends between data-defined shots (relative to the stage origin), temporary
// push-ins that return to the base shot, and a slow idle sway layered on top.
import * as THREE from 'three'
import { STAGE, type ShotDef } from './config.ts'
import { ease, type Ease } from './timeline.ts'

interface CamState { pos: THREE.Vector3; look: THREE.Vector3; fov: number }

/**
 * Screen-space composition on top of whatever shot is current: `zoom` scales the picture about the screen centre
 * (a narrower FOV), `dx` / `dy` slide it by that fraction of the viewport (a lens shift: no change of perspective).
 * The HUD layout solver (framing.ts) picks it so no creature sits under a window.
 */
export interface Framing { zoom: number; dx: number; dy: number }

export interface BattleCamera {
  readonly camera: THREE.PerspectiveCamera
  /** Current (unswayed) look-at point, world space. */
  readonly look: THREE.Vector3
  /** Camera-to-look distance. */
  readonly distance: number
  /** Where the base shot puts the camera, for projecting stage points without moving the live camera. */
  readonly base: { readonly pos: THREE.Vector3; readonly look: THREE.Vector3; readonly fov: number }
  /** Eased towards `f`; `snap` jumps there at once. */
  setFraming(f: Framing, snap?: boolean): void
  readonly framing: Framing
  /** The base shot as authored (what a timeline's "base" shot resolves to: bosses override it). */
  readonly baseShot: ShotDef
  setBase(shot: ShotDef): void
  cut(shot: ShotDef): void
  /** Eased blend to a shot; stays there. */
  blendTo(shot: ShotDef, dur: number, curve?: Ease): void
  /** Blend to a shot, hold, then blend back to the base shot. */
  push(shot: ShotDef, dur: number, hold: number, back: number): void
  /** Blend back to the base shot. */
  home(dur: number): void
  setSway(mul: number): void
  update(dt: number, time: number): void
}

/** Slides the rendered picture by (dx, dy) viewport fractions (y down) without touching the camera pose. */
export function applyLensShift(camera: THREE.PerspectiveCamera, dx: number, dy: number): void {
  const e = camera.projectionMatrix.elements
  e[8] = -2 * dx
  e[9] = 2 * dy
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
}

export function createBattleCamera(origin: THREE.Vector3): BattleCamera {
  const C = STAGE.camera
  // aspect is synced to the renderer's internal target every frame by the stage
  const camera = new THREE.PerspectiveCamera(C.fov, 1, C.near, C.far)
  camera.name = 'battle-camera'
  const abs = (shot: ShotDef): CamState => ({
    pos: new THREE.Vector3(...shot.pos).add(origin),
    look: new THREE.Vector3(...shot.look).add(origin),
    fov: shot.fov ?? C.fov,
  })
  let baseDef = C.shots.base as ShotDef
  let base = abs(baseDef)
  const cur: CamState = { pos: base.pos.clone(), look: base.look.clone(), fov: base.fov }
  const from: CamState = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: C.fov }
  let to: CamState | null = null
  let t = 0
  let dur = 1
  let curve: Ease = ease.inOutCubic
  let holdLeft = -1
  let backDur = 0
  let swayMul = 1
  let swayLevel = 1
  const framing: Framing = { zoom: 1, dx: 0, dy: 0 }
  const framingTo: Framing = { zoom: 1, dx: 0, dy: 0 }
  const look = new THREE.Vector3()
  const _o = new THREE.Vector3()

  function start(target: CamState, d: number, c: Ease): void {
    from.pos.copy(cur.pos)
    from.look.copy(cur.look)
    from.fov = cur.fov
    to = target
    t = 0
    dur = Math.max(1e-3, d)
    curve = c
  }

  const api: BattleCamera = {
    camera,
    look,
    get distance() { return cur.pos.distanceTo(cur.look) },
    get base() { return base },
    get framing() { return framing },
    setFraming(f, snap = false) {
      Object.assign(framingTo, f)
      if (snap) Object.assign(framing, f)
    },
    get baseShot() { return baseDef },
    setBase(shot) { baseDef = shot; base = abs(shot) },
    cut(shot) {
      const s = abs(shot)
      cur.pos.copy(s.pos)
      cur.look.copy(s.look)
      cur.fov = s.fov
      to = null
      holdLeft = -1
    },
    blendTo(shot, d, c = ease.inOutCubic) { holdLeft = -1; start(abs(shot), d, c) },
    push(shot, d, hold, back) {
      start(abs(shot), d, ease.outCubic)
      holdLeft = Math.max(0, hold)
      backDur = back
    },
    home(d) { holdLeft = -1; start({ pos: base.pos.clone(), look: base.look.clone(), fov: base.fov }, d, ease.inOutCubic) },
    setSway(mul) { swayMul = mul },
    update(dt, time) {
      if (to) {
        t += dt
        const k = curve(t / dur)
        cur.pos.lerpVectors(from.pos, to.pos, k)
        cur.look.lerpVectors(from.look, to.look, k)
        cur.fov = from.fov + (to.fov - from.fov) * k
        // a push keeps its target until the hold elapses, then returns home
        if (t >= dur) to = null
      } else if (holdLeft >= 0) {
        holdLeft -= dt
        if (holdLeft < 0) start({ pos: base.pos.clone(), look: base.look.clone(), fov: base.fov }, backDur, ease.inOutCubic)
      }
      const S = C.sway
      swayLevel += (swayMul - swayLevel) * Math.min(1, dt * S.rate)
      const w = (i: number) => Math.sin(time * S.hz[i] * Math.PI * 2 + i * S.phase)
      _o.set(S.pos[0] * w(0), S.pos[1] * w(1), S.pos[2] * w(2)).multiplyScalar(swayLevel)
      camera.position.copy(cur.pos).add(_o)
      look.copy(cur.look)
      _o.set(S.look[0] * w(1), S.look[1] * w(2), S.look[2] * w(0)).multiplyScalar(swayLevel)
      camera.lookAt(_o.add(cur.look))
      const fk = 1 - Math.exp(-dt * C.framing.rate)
      framing.zoom += (framingTo.zoom - framing.zoom) * fk
      framing.dx += (framingTo.dx - framing.dx) * fk
      framing.dy += (framingTo.dy - framing.dy) * fk
      // narrower than the framing aspect: widen the vertical FOV so both sides stay in frame horizontally
      const widen = Math.max(1, C.refAspect / camera.aspect) / framing.zoom
      const fov = widen === 1 ? cur.fov : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(cur.fov) / 2) * widen))
      if (Math.abs(camera.fov - fov) > 1e-4) camera.fov = fov
      camera.updateProjectionMatrix()
      applyLensShift(camera, framing.dx, framing.dy)
      camera.updateMatrixWorld()
    },
  }
  return api
}
