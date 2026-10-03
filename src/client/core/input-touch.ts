// On-screen touch controls: floating virtual stick (left zone) + pixel-styled action buttons (right).
// Layout numbers come from content/input.json; labels from the audio text namespace.
import type { InputAction } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import type { InputConfig, TouchStyle } from './input-config.ts'

export interface TouchCallbacks {
  onButton(action: InputAction, down: boolean): void
  /** Normalised stick vector after deadzone (magnitude 0..1). */
  onStick(x: number, y: number): void
  onActivity(): void
}

export interface TouchControls {
  readonly el: HTMLElement
  setVisible(v: boolean): void
  /** Releases every pressed button / the stick (blur, text input). Toggles stay latched. */
  release(): void
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
.ap-touch__zone{position:absolute;left:0;bottom:0;pointer-events:auto;touch-action:none;}
.ap-touch__stick{position:absolute;transform:translate(-50%,-50%);opacity:${st.idleOpacity};transition:opacity .15s;}
.ap-touch__stick.is-active{opacity:1;}
.ap-touch__ring,.ap-touch__ring-in,.ap-touch__knob,.ap-touch__knob-in{position:absolute;}
.ap-touch__ring{inset:0;background:${st.frame};}
.ap-touch__ring-in{inset:${px}px;background:${st.ringFill};box-shadow:inset 0 0 0 ${px}px ${st.ringEdge};}
.ap-touch__knob{left:50%;top:50%;transform:translate(-50%,-50%);background:${st.frame};}
.ap-touch__knob-in{inset:${px}px;background:linear-gradient(${st.knobHi} 0 45%,${st.knobLo} 45% 100%);}
.ap-touch__btns{position:absolute;pointer-events:none;}
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

export function createTouchControls(root: HTMLElement, cfg: InputConfig['touch'], cb: TouchCallbacks): TouchControls {
  const px = cfg.pixel
  injectStyle(px, cfg.style)
  const circle = (size: number) => pixelCirclePath(size, px)
  const el = document.createElement('div')
  el.className = 'ap-touch'

  // --- stick -------------------------------------------------------------
  const zone = document.createElement('div')
  zone.className = 'ap-touch__zone'
  zone.style.width = `${cfg.zoneWidthFraction * 100}%`
  zone.style.height = `${cfg.zoneHeightFraction * 100}%`
  zone.setAttribute('aria-label', t('audio.touch.stick'))
  const stick = document.createElement('div')
  stick.className = 'ap-touch__stick'
  const stickSize = cfg.stickRadius * 2
  stick.style.width = stick.style.height = `${stickSize}px`
  const ring = document.createElement('div')
  ring.className = 'ap-touch__ring'
  ring.style.clipPath = circle(stickSize)
  const ringIn = document.createElement('div')
  ringIn.className = 'ap-touch__ring-in'
  ringIn.style.clipPath = circle(stickSize - px * 2)
  ring.appendChild(ringIn)
  const knob = document.createElement('div')
  knob.className = 'ap-touch__knob'
  const knobSize = cfg.knobRadius * 2
  knob.style.width = knob.style.height = `${knobSize}px`
  knob.style.clipPath = circle(knobSize)
  const knobIn = document.createElement('div')
  knobIn.className = 'ap-touch__knob-in'
  knobIn.style.clipPath = circle(knobSize - px * 2)
  knob.appendChild(knobIn)
  stick.append(ring, knob)
  zone.appendChild(stick)

  let stickPointer: number | null = null
  let center = { x: 0, y: 0 }
  const restPosition = () => {
    const r = zone.getBoundingClientRect()
    return { x: cfg.margin + cfg.stickRadius, y: r.height - cfg.margin - cfg.stickRadius }
  }
  const placeStick = (x: number, y: number) => { stick.style.left = `${x}px`; stick.style.top = `${y}px` }
  const placeKnob = (dx: number, dy: number) => { knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))` }
  const resetStick = () => {
    stickPointer = null
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
    const dist = Math.hypot(dx, dy)
    const max = cfg.stickRadius
    if (dist > max) { dx = (dx / dist) * max; dy = (dy / dist) * max }
    placeKnob(dx, dy)
    const mag = Math.min(1, dist / max)
    if (mag < cfg.deadzone || dist === 0) { cb.onStick(0, 0); return }
    const scaled = (mag - cfg.deadzone) / (1 - cfg.deadzone)
    cb.onStick((dx / Math.hypot(dx, dy)) * scaled, (dy / Math.hypot(dx, dy)) * scaled)
  }
  zone.addEventListener('pointerdown', (e) => {
    if (stickPointer !== null) return
    e.preventDefault()
    cb.onActivity()
    stickPointer = e.pointerId
    zone.setPointerCapture(e.pointerId)
    // The stick base floats to the touch point so the first contact is always neutral.
    const r = zone.getBoundingClientRect()
    center = { x: e.clientX - r.left, y: e.clientY - r.top }
    placeStick(center.x, center.y)
    stick.classList.add('is-active')
    updateStick(e.clientX, e.clientY)
  })
  zone.addEventListener('pointermove', (e) => { if (e.pointerId === stickPointer) { e.preventDefault(); updateStick(e.clientX, e.clientY) } })
  const endStick = (e: PointerEvent) => { if (e.pointerId === stickPointer) resetStick() }
  zone.addEventListener('pointerup', endStick)
  zone.addEventListener('pointercancel', endStick)
  zone.addEventListener('lostpointercapture', endStick)

  // --- buttons -----------------------------------------------------------
  const btns = document.createElement('div')
  btns.className = 'ap-touch__btns'
  btns.style.right = `${cfg.margin}px`
  btns.style.bottom = `${cfg.margin}px`
  const latched = new Map<InputAction, boolean>()
  const held: { action: InputAction; btn: HTMLElement; pointer: number }[] = []

  for (const def of cfg.buttons) {
    const size = def.size === 'large' ? cfg.buttonSize : cfg.smallButtonSize
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `ap-touch__btn ap-touch__btn--${def.size}`
    btn.dataset.action = def.action
    btn.tabIndex = -1
    btn.style.width = btn.style.height = `${size}px`
    btn.style.right = `${def.right}px`
    btn.style.bottom = `${def.bottom}px`
    btn.style.clipPath = circle(size)
    btn.style.setProperty('--btn-font', `${Math.round(size * cfg.labelScale[def.size])}px`)
    const inner = document.createElement('span')
    inner.className = 'ap-touch__btn-in'
    inner.style.clipPath = circle(size - px * 2)
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
        cb.onButton(def.action, on)
        return
      }
      btn.setPointerCapture(e.pointerId)
      btn.classList.add('is-down')
      held.push({ action: def.action, btn, pointer: e.pointerId })
      cb.onButton(def.action, true)
    })
    const up = (e: PointerEvent) => {
      const i = held.findIndex((h) => h.pointer === e.pointerId && h.btn === btn)
      if (i < 0) return
      held.splice(i, 1)
      btn.classList.remove('is-down')
      if (!held.some((h) => h.action === def.action)) cb.onButton(def.action, false)
    }
    btn.addEventListener('pointerup', up)
    btn.addEventListener('pointercancel', up)
    btn.addEventListener('lostpointercapture', up)
    btns.appendChild(btn)
  }

  el.append(zone, btns)
  root.appendChild(el)
  const onResize = () => { if (stickPointer === null) resetStick() }
  window.addEventListener('resize', onResize)
  requestAnimationFrame(() => resetStick())

  return {
    el,
    setVisible(v: boolean) {
      el.classList.toggle('is-hidden', !v)
      if (!v) this.release()
      else requestAnimationFrame(() => { if (stickPointer === null) resetStick() })
    },
    release() {
      for (const h of held.splice(0)) { h.btn.classList.remove('is-down'); cb.onButton(h.action, false) }
      if (stickPointer !== null) resetStick()
    },
    dispose() {
      window.removeEventListener('resize', onResize)
      el.remove()
    },
  }
}
