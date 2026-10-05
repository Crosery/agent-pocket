// Overworld camera: fixed-pitch perspective follow with damping, movement look-ahead, smooth zoom presets,
// clamping to map bounds and room framing for interiors. Numbers from config.camera + render.json camera.
import * as THREE from 'three'
import { CONTENT } from '../../../shared/content/index.ts'
import { RENDER } from '../config.ts'

export interface CameraBounds { minX: number; maxX: number; minZ: number; maxZ: number }

export interface CameraRig {
  readonly camera: THREE.PerspectiveCamera
  /** Smoothed look-at point. */
  readonly target: THREE.Vector3
  readonly distance: number
  setZoom(level: number): void
  setBounds(b: CameraBounds | null, interior: boolean): void
  /** Jump straight to a focus (map load / warp). */
  snap(focus: THREE.Vector3): void
  update(dt: number, focus: THREE.Vector3): void
}

export function createCameraRig(): CameraRig {
  const C = CONTENT.config.camera, R = RENDER.camera
  const camera = new THREE.PerspectiveCamera(C.fov, 16 / 9, R.near, R.far)
  const pitch = THREE.MathUtils.degToRad(C.pitchDeg)
  const target = new THREE.Vector3()
  const look = new THREE.Vector3()
  const lastFocus = new THREE.Vector3()
  const vel = new THREE.Vector3()
  let zoom = 1
  let distance = zoomDistance(1)
  let bounds: CameraBounds | null = null
  let interior = false
  let hasFocus = false

  function zoomDistance(level: number): number {
    const z = C.zoomDistances
    const l = THREE.MathUtils.clamp(level, 0, z.length - 1)
    const i = Math.min(z.length - 2, Math.floor(l))
    if (z.length === 1) return z[0]
    return z[i] + (z[i + 1] - z[i]) * (l - i)
  }

  /** Distance that fits the bounds on screen (interiors). */
  function fitDistance(b: CameraBounds): number {
    const v = THREE.MathUtils.degToRad(camera.fov) / 2
    const h = Math.atan(Math.tan(v) * camera.aspect)
    const w = b.maxX - b.minX + 2 * R.interiorMargin
    const d = b.maxZ - b.minZ + 2 * R.interiorMargin
    const byW = w / 2 / Math.tan(h)
    const byD = (d * Math.sin(pitch)) / (2 * Math.tan(v))
    return Math.max(byW, byD)
  }

  function desiredDistance(): number {
    const z = zoomDistance(zoom)
    if (interior && bounds) return Math.max(C.zoomDistances[0], Math.min(z, fitDistance(bounds)))
    return z
  }

  /**
   * Look-at z that puts the ground span [zN, zS] symmetric about the screen centre: the span's depression angles
   * straddle the pitch, atan(H / (c - zN)) + atan(H / (c - zS)) = 2 * pitch, solved for the camera z `c` by bisection.
   */
  function screenCenterZ(zN: number, zS: number, H: number, back: number): number | null {
    const f = (c: number) => Math.atan2(H, c - zN) + Math.atan2(H, c - zS) - 2 * pitch
    let a = zS + 1e-3, b = zS + 1e4
    if (!(f(a) > 0)) return null
    for (let i = 0; i < 48; i++) {
      const c = (a + b) / 2
      if (f(c) > 0) a = c
      else b = c
    }
    return (a + b) / 2 - back
  }

  /** Clamps the look-at point to the map bounds, then pulls it back so the focus (and a sprite standing on it) stays on screen. */
  function clampTarget(p: THREE.Vector3, dist: number, focus: THREE.Vector3): void {
    if (!bounds) return
    const v = THREE.MathUtils.degToRad(camera.fov) / 2
    const hw = dist * Math.tan(v) * camera.aspect
    const H = dist * Math.sin(pitch)
    const back = dist * Math.cos(pitch)
    const north = pitch - v > 0.01 ? H / Math.tan(pitch - v) - back : Infinity
    const south = back - H / Math.tan(pitch + v)
    const m = interior ? R.interiorMargin : R.edgeMargin
    const fit = (lo: number, hi: number, val: number) => (lo > hi ? (lo + hi) / 2 : THREE.MathUtils.clamp(val, lo, hi))
    p.x = fit(bounds.minX + hw - m, bounds.maxX - hw + m, p.x)
    if (Number.isFinite(north)) {
      const lo = bounds.minZ + north - m, hi = bounds.maxZ - south + m
      // a room smaller than the view is centred on screen, not by ground distance (the far half is foreshortened)
      p.z = lo > hi ? screenCenterZ(bounds.minZ, bounds.maxZ, H, back) ?? (lo + hi) / 2 : THREE.MathUtils.clamp(p.z, lo, hi)
    }
    // focus-safe box in screen fractions (independent of zoom and pitch): ground offset north of the target at screen y
    const safe = R.focusSafe
    const groundAt = (ndcY: number) => {
      const dep = pitch - Math.atan(ndcY * Math.tan(v))
      return dep > 0.01 ? H / Math.tan(dep) - back : Infinity
    }
    p.x = THREE.MathUtils.clamp(p.x, focus.x - safe.side * hw, focus.x + safe.side * hw)
    p.z = THREE.MathUtils.clamp(p.z, focus.z + groundAt(-safe.south), focus.z + groundAt(safe.north))
  }

  function place(): void {
    camera.position.set(target.x, target.y + Math.sin(pitch) * distance, target.z + Math.cos(pitch) * distance)
    camera.lookAt(target)
    camera.updateMatrixWorld()
  }

  const rig: CameraRig = {
    camera,
    target,
    get distance() { return distance },
    setZoom(level) { zoom = level },
    setBounds(b, isInterior) { bounds = b; interior = isInterior; hasFocus = false },
    snap(focus) {
      distance = desiredDistance()
      target.copy(focus)
      clampTarget(target, distance, focus)
      lastFocus.copy(focus)
      vel.set(0, 0, 0)
      hasFocus = true
      place()
    },
    update(dt, focus) {
      if (!hasFocus || focus.distanceTo(lastFocus) > R.snapDistance) { rig.snap(focus); return }
      const d = desiredDistance()
      distance += (d - distance) * (1 - Math.exp(-R.zoomDamping * dt))
      // look-ahead along the smoothed movement direction
      if (dt > 0) {
        const inst = new THREE.Vector3().subVectors(focus, lastFocus).divideScalar(dt)
        inst.y = 0
        // slowing down releases the lead fast: a stopped player must not keep the camera drifting ahead
        const damping = inst.lengthSq() < vel.lengthSq() ? R.lookAheadReleaseDamping : R.lookAheadDamping
        vel.lerp(inst, 1 - Math.exp(-damping * dt))
      }
      lastFocus.copy(focus)
      const speed = vel.length()
      look.copy(focus)
      // the lead grows with speed up to lookAheadFullSpeed, so it shrinks as soon as the player slows down
      const ramp = (speed - R.lookAheadMinSpeed) / Math.max(R.lookAheadFullSpeed - R.lookAheadMinSpeed, 1e-3)
      if (speed > R.lookAheadMinSpeed) look.addScaledVector(vel, (C.lookAhead / speed) * Math.min(1, ramp))
      clampTarget(look, distance, focus)
      target.lerp(look, 1 - Math.exp(-C.followDamping * dt))
      place()
    },
  }
  return rig
}
