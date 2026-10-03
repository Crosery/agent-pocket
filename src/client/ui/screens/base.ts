// Shared scaffolding for full-screen panels: open/close lifecycle on ctx.ui.pushPanel, header/body/footer frame,
// key-hint bar, popup menus, quantity picker, pixel icons and small DOM helpers. All text via t(), data via JSON.
import type { Creature } from '../../../shared/types.ts'
import type { GameContext, Input, InputAction, ListItem, Screens, UIPanel } from '../../contracts.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { INPUT_BINDINGS, UI_CONFIG, type GlyphDef } from '../config.ts'
import { createRowMenu } from '../menu.ts'
import { rasterizeGlyph } from '../pixel.ts'
import { getUIScale } from '../scale.ts'
import { actionKeyLabel, append, button, el, glyphEl, keyHint, panel, type Child } from '../widgets.ts'
import { SCREENS, type ScreensConfig } from './config.ts'

// ---------------------------------------------------------------------------
// Environment shared by every screen module
// ---------------------------------------------------------------------------

export interface PartyOptions {
  title?: string
  filter?: (c: Creature) => boolean
  /** Per-card note (e.g. a "can learn" label); ok=false renders it as a warning. */
  annotate?: (c: Creature, index: number) => { text: string; ok: boolean } | null
}

/** Internal entry points that take richer options than the public Screens contract. */
export interface ScreenInternals {
  party(mode: 'view' | 'select' | 'battleSwitch', opts?: PartyOptions): Promise<number>
  summaryOf(list: Creature[], index: number): Promise<void>
  badges(): Promise<void>
}

export interface ScreenState {
  /** Number of screens currently open (nested). */
  depth: number
  /** Set by a flow that must leave every open screen (e.g. an escape item warps the player). */
  leave: boolean
  /** Runs once the last screen has closed. */
  after: (() => void) | null
}

export interface ScreenEnv {
  readonly ctx: GameContext
  /** The Screens object itself, so screens open each other without relying on ctx.screens being wired. */
  readonly screens: Screens
  readonly internal: ScreenInternals
  readonly state: ScreenState
}

/** Closes every open screen, then runs `after` (world actions must not happen under open menus). */
export function leaveAllScreens(env: ScreenEnv, after: () => void): void {
  env.state.leave = true
  env.state.after = after
}

export const sfx = (env: ScreenEnv, key: keyof ScreensConfig['sfx']) => env.ctx.audio.playSfx(SCREENS.sfx[key])
export const uiSfx = (env: ScreenEnv, key: keyof typeof UI_CONFIG.sfx) => env.ctx.audio.playSfx(UI_CONFIG.sfx[key])

/** True (and consumed) when the player backs out: cancel or menu. */
export function backPressed(input: Input): boolean {
  if (input.pressed('cancel')) { input.consume('cancel'); input.consume('menu'); return true }
  if (input.pressed('menu')) { input.consume('menu'); input.consume('cancel'); return true }
  return false
}

export function pressed(input: Input, a: InputAction, repeat = false): boolean {
  if (!input.pressed(a, repeat)) return false
  input.consume(a)
  return true
}

/** Text that may either be a literal (proper nouns in data) or a text key. */
export const textOrKey = (s: string): string => (s in CONTENT.text ? t(s) : s)

export const isCompact = (): boolean => getUIScale().compact

// ---------------------------------------------------------------------------
// Pixel icons: content/screens.json glyphs (palette merged over content/ui.json), falling back to ui glyphs.
// ---------------------------------------------------------------------------

const iconUrls = new Map<string, string>()

function screenGlyphUrl(id: string, def: GlyphDef, palette?: Record<string, string>): string {
  const key = `${id}|${palette ? JSON.stringify(palette) : ''}`
  let url = iconUrls.get(key)
  if (url) return url
  const bmp = rasterizeGlyph(def, { ...UI_CONFIG.glyphPalette, ...SCREENS.glyphPalette }, palette)
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, bmp.width)
  cv.height = Math.max(1, bmp.height)
  if (bmp.width && bmp.height) cv.getContext('2d')!.putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0)
  url = cv.toDataURL('image/png')
  iconUrls.set(key, url)
  return url
}

export function icon(id: string, opts?: { className?: string; palette?: Record<string, string> }): HTMLElement {
  const def = SCREENS.glyphs[id]
  if (!def) return glyphEl(id, { className: opts?.className, palette: opts?.palette })
  const span = el('span', { class: `ap-glyph${opts?.className ? ` ${opts.className}` : ''}`, attrs: { 'aria-hidden': 'true' } })
  span.style.width = `calc(var(--u) * ${def.rows[0]?.length ?? 0})`
  span.style.height = `calc(var(--u) * ${def.rows.length})`
  span.style.backgroundImage = `url("${screenGlyphUrl(id, def, opts?.palette)}")`
  return span
}

/** Row of `count` icons, the first `on` lit (IV stars, friendship hearts). */
export function meterIcons(on: number, count: number, onId: string, offId: string): HTMLElement {
  const box = el('span', 'aps-meter')
  for (let i = 0; i < count; i++) box.append(icon(i < on ? onId : offId))
  return box
}

// ---------------------------------------------------------------------------
// Screen lifecycle
// ---------------------------------------------------------------------------

export interface ScreenApi<T> {
  readonly root: HTMLElement
  readonly closed: boolean
  readonly busy: boolean
  close(value: T): void
  /** Runs an async sub-flow; this screen ignores input and pointer events until it settles. */
  run<R>(fn: () => Promise<R>): Promise<R>
  /** Wraps a DOM handler so it is ignored while busy or closed. */
  guard<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void
}

export interface ScreenBehaviour {
  onInput(input: Input): void
  update?(dtSec: number): void
  onShow?(): void
  dispose?(): void
}

/**
 * Pushes a full-screen panel built by `build`; resolves with the value passed to api.close().
 * `leave` supplies the result used when leaveAllScreens() unwinds the stack (screens without it stay open).
 */
export function openScreen<T>(env: ScreenEnv, className: string, build: (api: ScreenApi<T>) => ScreenBehaviour, leave?: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const root = el('div', { class: `aps-screen ${className}`, attrs: { role: 'dialog', 'aria-modal': 'true' } })
    let closed = false
    let busy = 0
    let behaviour: ScreenBehaviour | null = null
    const setBusy = (d: number) => { busy += d; root.classList.toggle('is-busy', busy > 0) }
    const ui: UIPanel = {
      el: root,
      onInput(input) {
        if (!closed && !busy && behaviour) behaviour.onInput(input)
        return true
      },
      update(dt) { if (!closed) behaviour?.update?.(dt) },
      onShow() { behaviour?.onShow?.() },
    }
    const api: ScreenApi<T> = {
      root,
      get closed() { return closed },
      get busy() { return busy > 0 },
      close(value: T) {
        if (closed) return
        closed = true
        env.ctx.ui.popPanel(ui)
        behaviour?.dispose?.()
        env.state.depth = Math.max(0, env.state.depth - 1)
        if (env.state.depth === 0) {
          const after = env.state.after
          env.state.leave = false
          env.state.after = null
          after?.()
        }
        resolve(value)
      },
      async run<R>(fn: () => Promise<R>): Promise<R> {
        setBusy(1)
        try { return await fn() } finally {
          setBusy(-1)
          if (env.state.leave && leave && !closed) api.close(leave())
        }
      },
      guard<A extends unknown[]>(fn: (...args: A) => void) {
        return (...args: A) => { if (!closed && !busy) fn(...args) }
      },
    }
    env.state.depth++
    behaviour = build(api)
    env.ctx.ui.pushPanel(ui)
  })
}

// ---------------------------------------------------------------------------
// Frame: header (icon, title, right-side slot, close button) / body / footer hints
// ---------------------------------------------------------------------------

export interface Frame {
  readonly el: HTMLElement
  readonly head: HTMLElement
  readonly right: HTMLElement
  readonly body: HTMLElement
  readonly foot: HTMLElement
  setTitle(text: string): void
  setHints(hints: Hint[]): void
}

export type Hint = [InputAction | 'lr' | 'ud', string]

/** Key-cap text of a direction, preferring arrow keys on keyboards. */
function dirLabel(a: InputAction, device: Input['lastDevice']): string {
  if (device === 'keyboard') {
    const arrow = INPUT_BINDINGS.keyboard[a]?.find((k) => k.startsWith('Arrow'))
    if (arrow) return `ui.keyNames.${arrow}` in CONTENT.text ? t(`ui.keyNames.${arrow}`) : arrow
  }
  return actionKeyLabel(a, device)
}

export function hintBar(env: ScreenEnv, hints: Hint[]): HTMLElement[] {
  const device = env.ctx.input.lastDevice
  return hints.flatMap(([a, label]) => {
    if (a !== 'lr' && a !== 'ud') return [keyHint(a, { label, device })]
    if (device === 'touch') return []
    const [x, y] = a === 'lr' ? (['left', 'right'] as const) : (['up', 'down'] as const)
    return [el('span', 'ap-key', [el('kbd', { text: `${dirLabel(x, device)}${dirLabel(y, device)}` }), label])]
  })
}

export function frame(env: ScreenEnv, opts: { title: string; glyph?: string; onClose?: () => void; hints?: Hint[] }): Frame {
  const titleEl = el('h2', { class: 'aps-title', text: opts.title })
  const right = el('div', 'aps-head-right')
  const close = opts.onClose
    ? button('', opts.onClose, { className: 'aps-close' })
    : null
  if (close) {
    close.setAttribute('aria-label', t('screens.common.close'))
    close.append(icon('close'))
  }
  const head = el('header', 'aps-head', [opts.glyph ? icon(opts.glyph, { className: 'aps-head-icon' }) : null, titleEl, right, close])
  const body = el('div', 'aps-body')
  const foot = el('footer', 'aps-foot')
  const root = el('div', 'aps-frame', [head, body, foot])
  const f: Frame = {
    el: root,
    head,
    right,
    body,
    foot,
    setTitle(text) { titleEl.textContent = text },
    setHints(hints) { foot.replaceChildren(...hintBar(env, hints)) },
  }
  if (opts.hints) f.setHints(opts.hints)
  return f
}

/** Standard footer hints. */
export const H = {
  select: (): Hint => ['confirm', t('screens.hint.select')],
  confirm: (): Hint => ['confirm', t('screens.hint.confirm')],
  back: (): Hint => ['cancel', t('screens.hint.back')],
  tabs: (): Hint => ['lr', t('screens.hint.tabs')],
}

// ---------------------------------------------------------------------------
// Popup menu & quantity picker (each is its own pushed layer, so they own input while open)
// ---------------------------------------------------------------------------

function placeNear(win: HTMLElement, layer: HTMLElement, anchor: HTMLElement | null | undefined): void {
  const box = layer.getBoundingClientRect()
  const w = win.offsetWidth
  const h = win.offsetHeight
  const margin = getUIScale().cssPerUnit * 6
  let x = (box.width - w) / 2
  let y = (box.height - h) / 2
  if (anchor && anchor.isConnected) {
    const a = anchor.getBoundingClientRect()
    x = a.right - box.left + margin
    if (x + w > box.width - margin) x = a.left - box.left - w - margin
    if (x < margin) x = Math.min(box.width - w - margin, a.left - box.left + margin)
    y = a.top - box.top
  }
  win.style.left = `${Math.round(Math.max(margin, Math.min(box.width - w - margin, x)))}px`
  win.style.top = `${Math.round(Math.max(margin, Math.min(box.height - h - margin, y)))}px`
}

export function popupMenu(env: ScreenEnv, items: ListItem[], opts?: { anchor?: HTMLElement | null; title?: string; initial?: number }): Promise<number> {
  return new Promise<number>((resolve) => {
    let done = false
    const win = panel(opts?.title ?? null, { className: 'aps-popup ap-anim-in' })
    const layer = el('div', 'aps-popup-layer', [win.el])
    const finish = (i: number) => {
      if (done) return
      done = true
      env.ctx.ui.popPanel(p)
      resolve(i)
    }
    const menu = createRowMenu(items, {
      visibleRows: Math.min(items.length, UI_CONFIG.list.visibleRows),
      initial: opts?.initial,
      wrap: true,
      audio: env.ctx.audio,
      onPick: (i) => { uiSfx(env, 'confirm'); finish(i) },
    })
    win.body.append(menu.el)
    layer.addEventListener('pointerdown', (e) => { if (e.target === layer) { e.preventDefault(); finish(-1) } })
    layer.addEventListener('contextmenu', (e) => { e.preventDefault(); finish(-1) })
    const p: UIPanel = {
      el: layer,
      onInput(input) {
        const r = menu.handleInput(input)
        if (r === 'confirm') { uiSfx(env, 'confirm'); finish(menu.index) }
        else if (r === 'cancel' || pressed(input, 'menu')) finish(-1)
        return true
      },
    }
    env.ctx.ui.pushPanel(p)
    placeNear(win.el, layer, opts?.anchor)
  })
}

export interface QuantityOptions {
  title: string
  max: number
  initial?: number
  /** Unit price: shows a running total. */
  price?: number
  /** Optional extra line (e.g. owned count). */
  note?: string
  anchor?: HTMLElement | null
}

/** Resolves the chosen quantity, or 0 when cancelled. ↑/↓ ±1 (wraps), ←/→ ±qtyBigStep. */
export function quantityPicker(env: ScreenEnv, o: QuantityOptions): Promise<number> {
  return new Promise<number>((resolve) => {
    const max = Math.max(1, Math.floor(o.max))
    let qty = Math.min(max, Math.max(1, Math.floor(o.initial ?? 1)))
    let done = false
    const qtyEl = el('span', 'aps-qty-num')
    const totalEl = o.price !== undefined ? el('span', 'aps-qty-total') : null
    const set = (v: number, wrap: boolean) => {
      let n = v
      if (wrap) n = n > max ? 1 : n < 1 ? max : n
      n = Math.min(max, Math.max(1, n))
      if (n === qty) return
      qty = n
      uiSfx(env, 'move')
      paint()
    }
    const paint = () => {
      qtyEl.textContent = t('screens.qty.value', { n: qty })
      if (totalEl && o.price !== undefined) totalEl.replaceChildren(icon('coin'), t('screens.common.money', { n: (o.price * qty).toLocaleString(t('ui.locale')) }))
    }
    const step = SCREENS.shop.qtyBigStep
    const btn = (label: string, d: number, wrap: boolean) => button(label, () => set(qty + d, wrap), { className: 'aps-qty-btn' })
    const win = panel(o.title, { className: 'aps-qty ap-anim-in' })
    append(win.body, [
      el('div', 'aps-qty-row', [btn(t('screens.qty.minusBig', { n: step }), -step, false), btn(t('screens.qty.minus'), -1, true), qtyEl, btn(t('screens.qty.plus'), 1, true), btn(t('screens.qty.plusBig', { n: step }), step, false)]),
      totalEl ? el('div', 'aps-qty-sum', [el('span', { class: 'ap-dim', text: t('screens.qty.total') }), totalEl]) : null,
      o.note ? el('div', { class: 'aps-qty-note ap-dim', text: o.note }) : null,
      el('div', 'ap-btn-row', [button(t('screens.common.cancel'), () => finish(0)), button(t('screens.common.ok'), () => finish(qty), { primary: true })]),
    ])
    const layer = el('div', 'aps-popup-layer', [win.el])
    layer.addEventListener('pointerdown', (e) => { if (e.target === layer) { e.preventDefault(); finish(0) } })
    win.el.addEventListener('wheel', (e) => { e.preventDefault(); set(qty - Math.sign(e.deltaY), true) }, { passive: false })
    const finish = (v: number) => {
      if (done) return
      done = true
      uiSfx(env, v > 0 ? 'confirm' : 'cancel')
      env.ctx.ui.popPanel(p)
      resolve(v)
    }
    const p: UIPanel = {
      el: layer,
      onInput(input) {
        if (pressed(input, 'up', true)) set(qty + 1, true)
        else if (pressed(input, 'down', true)) set(qty - 1, true)
        else if (pressed(input, 'right', true)) set(qty + step, false)
        else if (pressed(input, 'left', true)) set(qty - step, false)
        else if (pressed(input, 'confirm')) finish(qty)
        else if (backPressed(input)) finish(0)
        return true
      },
    }
    paint()
    env.ctx.ui.pushPanel(p)
    placeNear(win.el, layer, o.anchor)
  })
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

/** Label/value line used by info tables. */
export function infoRow(label: string, value: Child | Child[], className?: string): HTMLElement {
  return el('div', `aps-info-row${className ? ` ${className}` : ''}`, [
    el('span', { class: 'aps-info-k', text: label }),
    el('span', 'aps-info-v', Array.isArray(value) ? value : [value]),
  ])
}

export function sectionTitle(text: string): HTMLElement {
  return el('div', { class: 'aps-sec', text })
}

/** Scrolls `child` into view inside `scroller` (keyboard navigation over overflowing lists). */
export function keepVisible(scroller: HTMLElement, child: HTMLElement | null | undefined): void {
  if (!child) return
  const s = scroller.getBoundingClientRect()
  const c = child.getBoundingClientRect()
  if (c.top < s.top) scroller.scrollTop -= s.top - c.top
  else if (c.bottom > s.bottom) scroller.scrollTop += c.bottom - s.bottom
}

/** Horizontal tab strips may overflow (bag pockets on narrow screens): keep the active tab scrolled into view. */
const markedStrips = new WeakSet<HTMLElement>()
function markOverflow(strip: HTMLElement): void {
  strip.classList.toggle('is-more-left', strip.scrollLeft > 1)
  strip.classList.toggle('is-more-right', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1)
}

export function keepTabVisible(strip: HTMLElement, index: number): void {
  if (!markedStrips.has(strip)) {
    markedStrips.add(strip)
    strip.addEventListener('scroll', () => markOverflow(strip), { passive: true })
    new ResizeObserver(() => markOverflow(strip)).observe(strip)
  }
  markOverflow(strip)
  const child = strip.children[index] as HTMLElement | undefined
  if (!child) return
  const s = strip.getBoundingClientRect()
  const c = child.getBoundingClientRect()
  const pad = c.width / 2
  if (c.left < s.left) strip.scrollLeft -= s.left - c.left + pad
  else if (c.right > s.right) strip.scrollLeft += c.right - s.right + pad
}

/** Small pixel arrow button (previous / next). */
export function arrowButton(dir: 'left' | 'right', label: string, onClick: () => void): HTMLButtonElement {
  const b = button('', onClick, { className: `aps-arrow is-${dir}` })
  b.setAttribute('aria-label', label)
  b.append(icon(dir === 'left' ? 'arrowL' : 'arrowR'))
  return b
}

/** replaceChildren() that skips null/false children. */
export function setChildren(node: HTMLElement, children: Child[]): void {
  node.replaceChildren()
  append(node, children)
}

/** Money formatted with the Token-coin icon. */
export function moneyEl(n: number): HTMLElement {
  return el('span', 'aps-money', [icon('coin'), el('span', { text: t('screens.common.money', { n: n.toLocaleString(t('ui.locale')) }) })])
}
