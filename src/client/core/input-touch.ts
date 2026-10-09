// On-screen touch controls: a floating virtual stick (thumb zone), pixel-styled action buttons, and world taps.
// Placement comes from touch-layout.ts (content/input.json): orientation, hand, size preset; labels from the audio
// text namespace. A touch in the stick zone is a stick drag, or a world tap when it stays put and ends quickly.
import type { InputAction } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import type { InputConfig, TouchStyle } from './input-config.ts'
import { computeTouchLayout, type TouchLayout } from './touch-layout.ts'

export interface TouchCallbacks {
  onButton(action: InputAction, down: boolean): void
  /** Normalised stick vector after deadzone (magnitude 0..1). */
  onStick(x: number, y: number): void
  onActivity(): void
  /** A short, still touch on the game surface (client px). */
  onTap(p: { x: number; y: number }): void
}

export interface TouchControls {
  readonly el: HTMLElement
  setVisible(v: boolean): void
  /** Releases every pressed button / the stick (blur, text input). Toggles stay latched. */
  release(): void
  /** Re-reads hand / size / orientation and re-places everything. */
  relayout(): void
  dispose(): void
}

const STYLE_ID = 'ap-core-touch-style'

/** Stepped "pixel circle" clip-path for a square box of `size` CSS px. */
export function pixelCirclePath(size: number, px: number): string {
  const n = Math.max(4, Math.round(size / px))
  const r = n / 2
  const right: string[] = []
  const left: string[] = []
  for (let row = 0; row < n; row++) {
    const dy = row + 0.5 - r
    const half = Math.min(r, Math.round(Math.sqrt(Math.max(0, r * r - dy * dy)) + 0.35))
    const x0 = ((r - half) / n) * 100
    const x1 = ((r + half) / n) * 100
    const y0 = (row / n) * 100
    const y1 = ((row + 1) / n) * 100
    right.push(`${x1.toFixed(2)}% ${y0.toFixed(2)}%`, `${x1.toFixed(2)}% ${y1.toFixed(2)}%`)
    left.unshift(`${x0.toFixed(2)}% ${y1.toFixed(2)}%`, `${x0.toFixed(2)}% ${y0.toFixed(2)}%`)
  }
  return `polygon(${[...right, ...left].join(',')})`
}

function injectStyle(px: number, st: TouchStyle): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const btnVars = (c: { hi: string; base: string; lo: string }) => `--btn-hi:${c.hi};--btn-base:${c.base};--btn-lo:${c.lo};`
  const perAction = Object.entries(st.buttons)
    .map(([action, c]) => (c ? `.ap-touch__btn[data-action="${CSS.escape(action)}"]{${btnVars(c)}}` : ''))
    .join('\n')
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.ap-touch{position:fixed;inset:0;z-index:60;pointer-events:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:none;font-family:var(--ap-font,inherit);}
html[data-touch-controls="off"] .ap-touch,.ap-touch.is-hidden{display:none;}
/* While a modal UI owns input the stick zone must not swallow taps on lists / choices / chat, and the world-only buttons do nothing. */
html.ap-ui-blocking .ap-touch__zone{pointer-events:none;visibility:hidden;}
html.ap-ui-blocking .ap-touch__btn[data-world-only]{display:none;}
.ap-touch__zone{position:absolute;bottom:0;pointer-events:auto;touch-action:none;}
.ap-touch__stick{position:absolute;transform:translate(-50%,-50%);opacity:${st.idleOpacity};transition:opacity .15s;}
.ap-touch__stick.is-active{opacity:1;}
.ap-touch__ring,.ap-touch__ring-in,.ap-touch__knob,.ap-touch__knob-in{position:absolute;}
.ap-touch__ring{inset:0;background:${st.frame};}
.ap-touch__ring-in{inset:${px}px;background:${st.ringFill};box-shadow:inset 0 0 0 ${px}px ${st.ringEdge};}
.ap-touch__knob{left:50%;top:50%;transform:translate(-50%,-50%);background:${st.frame};}
.ap-touch__knob-in{inset:${px}px;background:linear-gradient(${st.knobHi} 0 45%,${st.knobLo} 45% 100%);}
.ap-touch__btn{position:absolute;pointer-events:auto;touch-action:none;border:0;padding:0;margin:0;background:${st.frame};cursor:pointer;-webkit-tap-highlight-color:transparent;${btnVars(st.buttonDefault)}}
.ap-touch__btn-in{position:absolute;inset:${px}px;display:flex;align-items:center;justify-content:center;color:${st.label};
  text-shadow:${px / 3}px ${px / 3}px 0 ${st.labelShadow};font-size:var(--btn-font);line-height:1;letter-spacing:0;
  background:linear-gradient(var(--btn-hi) 0 40%,var(--btn-base) 40% 78%,var(--btn-lo) 78% 100%);}
.ap-touch__btn.is-down .ap-touch__btn-in,.ap-touch__btn.is-on .ap-touch__btn-in{background:linear-gradient(var(--btn-lo) 0 30%,var(--btn-base) 30% 100%);transform:translateY(${px / 3}px);}
.ap-touch__btn.is-on{box-shadow:0 0 0 ${px}px ${st.toggleGlow};}
${perAction}
`
  document.head.appendChild(style)
}

function readPrefs(): { hand: 'right' | 'left'; size: 'small' | 'normal' | 'large'; haptics: boolean } {
  const d = document.documentElement.dataset
  return {
    hand: d.touchHand === 'left' ? 'left' : 'right',
    size: d.touchSize === 'small' || d.touchSize === 'large' ? d.touchSize : 'normal',
    haptics: d.haptics !== 'false',
  }
}

const safeInset = (side: 'left' | 'right' | 'bottom') => `env(safe-area-inset-${side},0px)`

export function createTouchControls(root: HTMLElement, cfg: InputConfig['touch'], cb: TouchCallbacks): TouchControls {
  const px = cfg.pixel
  injectStyle(px, cfg.style)
  const circle = (size: number) => pixelCirclePath(size, px)
  const el = document.createElement('div')
  el.className = 'ap-touch'
  let layout: TouchLayout = computeTouchLayout(cfg, { width: window.innerWidth, height: window.innerHeight }, 'right', 'normal', cfg.insetGap)
  let haptics = true
  const buzz = (ms: number) => {
    if (haptics && ms > 0 && typeof navigator.vibrate === 'function') navigator.vibrate(ms)
  }

  // --- stick -------------------------------------------------------------
  const zone = document.createElement('div')
  zone.className = 'ap-touch__zone'
  zone.setAttribute('aria-label', t('audio.touch.stick'))
  const stick = document.createElement('div')
  stick.className = 'ap-touch__stick'
  const ring = document.createElement('div')
  ring.className = 'ap-touch__ring'
  const ringIn = document.createElement('div')
  ringIn.className = 'ap-touch__ring-in'
  ring.appendChild(ringIn)
  const knob = document.createElement('div')
  knob.className = 'ap-touch__knob'
  const knobIn = document.createElement('div')
  knobIn.className = 'ap-touch__knob-in'
  knob.appendChild(knobIn)
  stick.append(ring, knob)
  zone.appendChild(stick)

  type Gesture = { id: number; x0: number; y0: number; t0: number; mode: 'pending' | 'stick' | 'drag'; timer: ReturnType<typeof setTimeout> | null; host: HTMLElement }
  let gesture: Gesture | null = null
  let center = { x: 0, y: 0 }
  const restPosition = () => {
    const r = zone.getBoundingClientRect()
    const side = layout.stickRest.side
    return { x: layout.hand === 'right' ? side : r.width - side, y: r.height - layout.stickRest.bottom }
  }
  const placeStick = (x: number, y: number) => { stick.style.left = `${x}px`; stick.style.top = `${y}px` }
  const placeKnob = (dx: number, dy: number) => { knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))` }
  const resetStick = () => {
    stick.classList.remove('is-active')
    const rest = restPosition()
    placeStick(rest.x, rest.y)
    placeKnob(0, 0)
    cb.onStick(0, 0)
  }
  const updateStick = (clientX: number, clientY: number) => {
    const r = zone.getBoundingClientRect()
    let dx = clientX - r.left - center.x
    let dy = clientY - r.top - center.y
    let dist = Math.hypot(dx, dy)
    const max = layout.stickRadius
    if (dist > max) {
      if (cfg.follow) {
        // The base trails the thumb, so reversing direction needs only a ring's worth of travel.
        center = { x: center.x + (dx / dist) * (dist - max), y: center.y + (dy / dist) * (dist - max) }
        placeStick(center.x, center.y)
      }
      dx = (dx / dist) * max
      dy = (dy / dist) * max
      dist = max
    }
    placeKnob(dx, dy)
    const mag = Math.min(1, dist / max)
    if (mag < cfg.deadzone || dist === 0) { cb.onStick(0, 0); return }
    const scaled = (mag - cfg.deadzone) / (1 - cfg.deadzone)
    cb.onStick((dx / dist) * scaled, (dy / dist) * scaled)
  }
  const startStick = (g: Gesture) => {
    g.mode = 'stick'
    if (g.timer) { clearTimeout(g.timer); g.timer = null }
    // The stick base floats to where the thumb landed, so the first contact is always neutral.
    const r = zone.getBoundingClientRect()
    center = { x: g.x0 - r.left, y: g.y0 - r.top }
    placeStick(center.x, center.y)
    stick.classList.add('is-active')
    buzz(cfg.haptics.stick)
  }
  const finish = (e: PointerEvent, cancelled: boolean) => {
    const g = gesture
    if (!g || e.pointerId !== g.id) return
    gesture = null
    if (g.timer) clearTimeout(g.timer)
    if (g.mode === 'stick') resetStick()
    else if (g.mode === 'pending' && !cancelled && e.timeStamp - g.t0 <= cfg.tap.maxMs && documentTouchOn()) {
      buzz(cfg.haptics.tap)
      cb.onTap({ x: e.clientX, y: e.clientY })
    }
  }
  const documentTouchOn = () => document.documentElement.dataset.touchControls === 'on'
  const begin = (e: PointerEvent, host: HTMLElement, stickCapable: boolean) => {
    if (gesture) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    cb.onActivity()
    gesture = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, mode: 'pending', timer: null, host }
    host.setPointerCapture?.(e.pointerId)
    const g = gesture
    if (stickCapable) g.timer = setTimeout(() => { if (gesture === g && g.mode === 'pending') { startStick(g); updateStick(g.x0, g.y0) } }, cfg.tap.stickHoldMs)
  }
  const moved = (e: PointerEvent) => {
    const g = gesture
    if (!g || e.pointerId !== g.id) return
    if (g.mode === 'pending' && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > cfg.tap.slopPx) {
      if (g.host === zone) startStick(g)
      else g.mode = 'drag'
    }
    if (g.mode === 'stick') { e.preventDefault(); updateStick(e.clientX, e.clientY) }
  }
  zone.addEventListener('pointerdown', (e) => { e.preventDefault(); begin(e, zone, true) })
  zone.addEventListener('pointermove', moved)
  zone.addEventListener('pointerup', (e) => finish(e, false))
  zone.addEventListener('pointercancel', (e) => finish(e, true))
  zone.addEventListener('lostpointercapture', (e) => finish(e, true))
  // Outside the zone the canvas itself receives the touch (HUD layers let it through): taps only.
  const canvas = root.querySelector('canvas')
  const onCanvasDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' || e.target !== canvas) return
    begin(e, canvas as HTMLElement, false)
  }
  root.addEventListener('pointerdown', onCanvasDown)
  root.addEventListener('pointermove', moved)
  const onRootUp = (e: PointerEvent) => finish(e, false)
  const onRootCancel = (e: PointerEvent) => finish(e, true)
  root.addEventListener('pointerup', onRootUp)
  root.addEventListener('pointercancel', onRootCancel)

  // --- buttons -----------------------------------------------------------
  const btns = document.createElement('div')
  btns.className = 'ap-touch__btns'
  btns.style.cssText = 'position:absolute;inset:0;pointer-events:none;'
  const latched = new Map<InputAction, boolean>()
  const held: { action: InputAction; btn: HTMLElement; pointer: number }[] = []
  const buttonEls = new Map<InputAction, HTMLButtonElement>()

  for (const def of cfg.buttons) {
    const onRelease = def.action === 'menu' || def.action === 'bag' || def.action === 'map'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `ap-touch__btn ap-touch__btn--${def.size}`
    btn.dataset.action = def.action
    if (def.worldOnly) btn.dataset.worldOnly = ''
    btn.tabIndex = -1
    const inner = document.createElement('span')
    inner.className = 'ap-touch__btn-in'
    inner.textContent = t(def.label)
    btn.setAttribute('aria-label', t(def.label))
    btn.appendChild(inner)
    btn.addEventListener('contextmenu', (e) => e.preventDefault())
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      cb.onActivity()
      if (def.toggle) {
        const on = !latched.get(def.action)
        latched.set(def.action, on)
        btn.classList.toggle('is-on', on)
        buzz(cfg.haptics.toggle)
        cb.onButton(def.action, on)
        return
      }
      buzz(cfg.haptics.button)
      btn.setPointerCapture(e.pointerId)
      btn.classList.add('is-down')
      held.push({ action: def.action, btn, pointer: e.pointerId })
      if (!onRelease) cb.onButton(def.action, true)
    })
    const up = (e: PointerEvent) => {
      const i = held.findIndex((h) => h.pointer === e.pointerId && h.btn === btn)
      if (i < 0) return
      held.splice(i, 1)
      btn.classList.remove('is-down')
      // A modal must not reflow beneath the touch gesture that opens it.
      if (onRelease && e.type === 'pointerup') cb.onButton(def.action, true)
      if (!held.some((h) => h.action === def.action)) cb.onButton(def.action, false)
    }
    btn.addEventListener('pointerup', up)
    btn.addEventListener('pointercancel', up)
    btn.addEventListener('lostpointercapture', up)
    buttonEls.set(def.action, btn)
    btns.appendChild(btn)
  }

  el.append(zone, btns)
  root.appendChild(el)

  /** Applies hand / size / orientation: zone, stick, buttons and the published --ap-touch-* insets. */
  function relayout(): void {
    const prefs = readPrefs()
    haptics = prefs.haptics
    layout = computeTouchLayout(cfg, { width: window.innerWidth, height: window.innerHeight }, prefs.hand, prefs.size, cfg.insetGap)
    const left = layout.hand === 'right'
    zone.style.left = left ? '0' : 'auto'
    zone.style.right = left ? 'auto' : '0'
    zone.style.width = `${cfg.zoneWidthFraction * 100}%`
    zone.style.height = `${(layout.portrait ? cfg.zoneHeightFraction.portrait : cfg.zoneHeightFraction.landscape) * 100}%`
    const stickSize = layout.stickRadius * 2
    stick.style.width = stick.style.height = `${stickSize}px`
    ring.style.clipPath = circle(stickSize)
    ringIn.style.clipPath = circle(stickSize - px * 2)
    const knobSize = layout.knobRadius * 2
    knob.style.width = knob.style.height = `${knobSize}px`
    knob.style.clipPath = circle(knobSize)
    knobIn.style.clipPath = circle(knobSize - px * 2)
    for (const b of layout.buttons) {
      const btn = buttonEls.get(b.def.action)
      if (!btn) continue
      const edge = cfg.margin + b.side
      btn.style.width = btn.style.height = `${b.size}px`
      btn.style.left = left ? 'auto' : `calc(${edge}px + ${safeInset('left')})`
      btn.style.right = left ? `calc(${edge}px + ${safeInset('right')})` : 'auto'
      btn.style.bottom = `calc(${cfg.margin + b.bottom}px + ${safeInset('bottom')})`
      btn.style.clipPath = circle(b.size)
      btn.style.setProperty('--btn-font', `${Math.round(b.size * cfg.labelScale[b.def.size])}px`)
      const inner = btn.firstElementChild as HTMLElement
      inner.style.clipPath = circle(b.size - px * 2)
    }
    const html = document.documentElement.style
    html.setProperty('--ap-touch-inset', `${layout.insets.bottom}px`)
    html.setProperty('--ap-touch-left-inset', `${layout.insets.left}px`)
    html.setProperty('--ap-touch-right-inset', `${layout.insets.right}px`)
    zone.style.visibility = ''
    if (!gesture) resetStick()
  }
  const onResize = () => relayout()
  window.addEventListener('resize', onResize)
  window.addEventListener('orientationchange', onResize)
  relayout()
  requestAnimationFrame(() => relayout())

  return {
    el,
    setVisible(v: boolean) {
      el.classList.toggle('is-hidden', !v)
      if (!v) this.release()
      else requestAnimationFrame(() => relayout())
    },
    release() {
      for (const h of held.splice(0)) { h.btn.classList.remove('is-down'); cb.onButton(h.action, false) }
      if (gesture) {
        if (gesture.timer) clearTimeout(gesture.timer)
        const wasStick = gesture.mode === 'stick'
        gesture = null
        if (wasStick) resetStick()
      }
    },
    relayout,
    dispose() {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      root.removeEventListener('pointerdown', onCanvasDown)
      root.removeEventListener('pointermove', moved)
      root.removeEventListener('pointerup', onRootUp)
      root.removeEventListener('pointercancel', onRootCancel)
      el.remove()
    },
  }
}
