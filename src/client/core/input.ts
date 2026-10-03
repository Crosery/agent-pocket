import type { Input, InputAction } from '../contracts.ts'
import { INPUT_CONFIG, boundActions } from './input-config.ts'
import type { InputConfig } from './input-config.ts'
import { createTouchControls } from './input-touch.ts'
import type { TouchControls } from './input-touch.ts'
import { isTouchDevice } from './settings.ts'

type Device = Input['lastDevice']
type DirAction = 'up' | 'down' | 'left' | 'right'

/**
 * Unified keyboard / gamepad / touch input with per-frame edge detection.
 * Edges raised by DOM events between frames are kept until endFrame(), so a tap shorter than one
 * frame still reads as pressed. Gamepads are polled lazily on the first query of each frame.
 */
export function createInput(root: HTMLElement, cfg: InputConfig = INPUT_CONFIG): Input {
  const actions = boundActions(cfg)
  const keyToActions = new Map<string, InputAction[]>()
  for (const [action, codes] of Object.entries(cfg.keyboard) as [InputAction, string[]][]) {
    for (const code of codes) keyToActions.set(code, [...(keyToActions.get(code) ?? []), action])
  }
  const repeatable = new Set<InputAction>(cfg.repeat.actions)

  // Per-source holds; an action is held when any source holds it.
  const keysDown = new Set<string>()
  const keyCount = new Map<InputAction, number>()
  const padHeld = new Set<InputAction>()
  const touchHeld = new Set<InputAction>()
  const stickHeld = new Set<InputAction>()
  const pressedEdge = new Set<InputAction>()
  const releasedEdge = new Set<InputAction>()
  const repeatEdge = new Set<InputAction>()
  const consumed = new Set<InputAction>()
  const nextRepeat = new Map<InputAction, number>()

  let padAxis = { x: 0, y: 0 }
  let padDpad = { x: 0, y: 0 }
  let touchAxis = { x: 0, y: 0 }
  let frame = 0
  let polledFrame = -1
  let textInput = false
  let lastDevice: Device = isTouchDevice() ? 'touch' : 'keyboard'

  const now = () => performance.now()
  const isHeld = (a: InputAction) => (keyCount.get(a) ?? 0) > 0 || padHeld.has(a) || touchHeld.has(a) || stickHeld.has(a)

  /** Applies a source-level change and derives combined edges. */
  const change = (a: InputAction, mutate: () => void) => {
    const before = isHeld(a)
    mutate()
    const after = isHeld(a)
    if (!before && after) {
      pressedEdge.add(a)
      if (repeatable.has(a)) nextRepeat.set(a, now() + cfg.repeat.delayMs)
    } else if (before && !after) {
      releasedEdge.add(a)
      nextRepeat.delete(a)
    }
  }

  const setSet = (set: Set<InputAction>, a: InputAction, on: boolean) => change(a, () => { if (on) set.add(a); else set.delete(a) })

  const releaseAll = () => {
    for (const a of actions) {
      change(a, () => { keyCount.delete(a); padHeld.delete(a); touchHeld.delete(a); stickHeld.delete(a) })
    }
    keysDown.clear()
    padAxis = { x: 0, y: 0 }
    padDpad = { x: 0, y: 0 }
    touchAxis = { x: 0, y: 0 }
    touch.release()
  }

  // --- keyboard ------------------------------------------------------------
  const isEditable = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null
    if (!el || typeof el.tagName !== 'string') return false
    const tag = el.tagName
    return el.isContentEditable || tag === 'TEXTAREA' || tag === 'SELECT' ||
      (tag === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes((el as HTMLInputElement).type))
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (textInput || isEditable(e.target)) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const mapped = keyToActions.get(e.code)
    if (!mapped) return
    e.preventDefault()
    lastDevice = 'keyboard'
    if (e.repeat || keysDown.has(e.code)) return
    keysDown.add(e.code)
    for (const a of mapped) change(a, () => keyCount.set(a, (keyCount.get(a) ?? 0) + 1))
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (!keysDown.has(e.code)) return
    keysDown.delete(e.code)
    for (const a of keyToActions.get(e.code) ?? []) change(a, () => keyCount.set(a, Math.max(0, (keyCount.get(a) ?? 0) - 1)))
    if (!textInput && !isEditable(e.target)) e.preventDefault()
  }
  const onBlur = () => releaseAll()
  const onVisibility = () => { if (document.hidden) releaseAll() }
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    lastDevice = 'touch'
    const html = document.documentElement
    html.dataset.touchSeen = 'true'
    if (html.dataset.touchPref === 'auto' && html.dataset.touchControls !== 'on') html.dataset.touchControls = 'on'
  }

  // --- touch ---------------------------------------------------------------
  if (!document.documentElement.dataset.touchControls) {
    document.documentElement.dataset.touchControls = isTouchDevice() ? 'on' : 'off'
  }
  const dirsFromVector = (x: number, y: number, threshold: number): Set<DirAction> => {
    const out = new Set<DirAction>()
    if (x <= -threshold) out.add('left')
    if (x >= threshold) out.add('right')
    if (y <= -threshold) out.add('up')
    if (y >= threshold) out.add('down')
    return out
  }
  const DIRS: readonly DirAction[] = ['up', 'down', 'left', 'right']
  const touch: TouchControls = createTouchControls(root, cfg.touch, {
    onButton: (a, down) => { lastDevice = 'touch'; setSet(touchHeld, a, down) },
    onStick: (x, y) => {
      touchAxis = { x, y }
      const dirs = dirsFromVector(x, y, cfg.touch.digitalThreshold)
      for (const d of DIRS) setSet(stickHeld, d, dirs.has(d))
    },
    onActivity: () => { lastDevice = 'touch' },
  })

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibility)
  root.addEventListener('pointerdown', onPointerDown, { capture: true })

  // --- gamepad -------------------------------------------------------------
  const pollGamepads = () => {
    let pads: (Gamepad | null)[] = []
    try { pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [] } catch { /* blocked by permissions policy */ }
    const down = new Set<InputAction>()
    const buttons = new Set<InputAction>()
    let ax = 0
    let ay = 0
    for (const pad of pads) {
      if (!pad || !pad.connected) continue
      for (const [action, idxs] of Object.entries(cfg.gamepad.buttons) as [InputAction, number[]][]) {
        for (const i of idxs) {
          const b = pad.buttons[i]
          if (b && (b.pressed || b.value > cfg.gamepad.buttonThreshold)) { down.add(action); buttons.add(action) }
        }
      }
      const sx = pad.axes[cfg.gamepad.stick.xAxis] ?? 0
      const sy = pad.axes[cfg.gamepad.stick.yAxis] ?? 0
      const mag = Math.hypot(sx, sy)
      const dz = cfg.gamepad.stick.deadzone
      if (mag > dz && mag > Math.hypot(ax, ay)) {
        const scaled = Math.min(1, (mag - dz) / (1 - dz))
        ax = (sx / mag) * scaled
        ay = (sy / mag) * scaled
      }
    }
    for (const d of dirsFromVector(ax, ay, cfg.gamepad.stick.digitalThreshold)) down.add(d)
    if (down.size || ax || ay) lastDevice = 'gamepad'
    padAxis = { x: ax, y: ay }
    const b = (a: InputAction) => (buttons.has(a) ? 1 : 0)
    padDpad = { x: b('right') - b('left'), y: b('down') - b('up') }
    for (const a of actions) if (padHeld.has(a) !== down.has(a)) setSet(padHeld, a, down.has(a))
  }

  const beginFrame = () => {
    if (polledFrame === frame) return
    polledFrame = frame
    pollGamepads()
    const t = now()
    for (const [a, at] of nextRepeat) {
      if (t < at || !isHeld(a)) continue
      repeatEdge.add(a)
      const next = at + cfg.repeat.intervalMs
      nextRepeat.set(a, next > t ? next : t + cfg.repeat.intervalMs)
    }
  }

  /** Digital directions from keys and the d-pad, normalised on diagonals. */
  const digitalAxis = () => {
    const k = (a: InputAction) => ((keyCount.get(a) ?? 0) > 0 ? 1 : 0)
    let x = Math.sign(k('right') - k('left') + padDpad.x)
    let y = Math.sign(k('down') - k('up') + padDpad.y)
    if (x && y) { x *= Math.SQRT1_2; y *= Math.SQRT1_2 }
    return { x, y }
  }

  return {
    axis() {
      beginFrame()
      if (textInput) return { x: 0, y: 0 }
      const kb = digitalAxis()
      let x = kb.x + padAxis.x + touchAxis.x
      let y = kb.y + padAxis.y + touchAxis.y
      const mag = Math.hypot(x, y)
      if (mag > 1) { x /= mag; y /= mag }
      return { x, y }
    },
    held(a) {
      beginFrame()
      return !textInput && isHeld(a)
    },
    pressed(a, repeat = false) {
      beginFrame()
      if (textInput || consumed.has(a)) return false
      return pressedEdge.has(a) || (repeat && repeatEdge.has(a))
    },
    released(a) {
      beginFrame()
      return !textInput && !consumed.has(a) && releasedEdge.has(a)
    },
    consume(a) { consumed.add(a) },
    endFrame() {
      pressedEdge.clear()
      releasedEdge.clear()
      repeatEdge.clear()
      consumed.clear()
      frame++
    },
    setTextInputActive(active: boolean) {
      if (active === textInput) return
      textInput = active
      if (active) releaseAll()
    },
    get lastDevice() { return lastDevice },
    setTouchControlsVisible(visible: boolean) { touch.setVisible(visible) },
  }
}
