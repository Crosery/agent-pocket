// Cinematic battle camera: eased blends between data-defined shots (relative to the stage origin), temporary
// push-ins that return to the base shot, and a slow idle sway layered on top.
import * as THREE from 'three'
import { STAGE, type ShotDef } from './config.ts'
import { ease, type Ease } from './timeline.ts'

interface CamState { pos: THREE.Vector3; look: THREE.Vector3; fov: number }

export interface BattleCamera {
  readonly camera: THREE.PerspectiveCamera
  /** Current (unswayed) look-at point, world space. */
  readonly look: THREE.Vector3
  /** Camera-to-look distance. */
  readonly distance: number
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
  let base = abs(C.shots.base as ShotDef)
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
    setBase(shot) { base = abs(shot) },
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
      // narrower than the framing aspect: widen the vertical FOV so both sides stay in frame horizontally
      const widen = Math.max(1, C.refAspect / camera.aspect)
      const fov = widen === 1 ? cur.fov : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(cur.fov) / 2) * widen))
      if (Math.abs(camera.fov - fov) > 1e-4) { camera.fov = fov; camera.updateProjectionMatrix() }
      camera.updateMatrixWorld()
    },
  }
  return api
}
