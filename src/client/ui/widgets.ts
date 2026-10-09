/**
 * Pixel UI building blocks shared by kit/, hud, battle UI and ui/screens/.
 * Every size is in UI pixels (var(--u)); all text comes from content via CONTENT / t().
 *
 *   el(tag, props?, children?)          tiny DOM builder (props may be a class string)
 *   panel(title?, opts?)                gold double-border window -> { el, body, titleEl, setTitle }
 *   button(label, onClick?, opts?)      pixel button (.ap-btn, .ap-btn--primary)
 *   hpBar(opts?) / expBar(opts?)        stepped bars -> BarHandle { el, set(value, max, animate?), settled() }
 *   typeChip(typeId)                    chip coloured by CONTENT.typeById
 *   statusChip(statusId)                chip from CONTENT.statusById (short label, colour)
 *   rarityBadge(rarityId, opts?)        badge coloured by CONTENT.rarityById; glow/shimmer by RarityDef.order
 *   creatureIcon(url, shiny, size?)     pixelated creature image with shiny sparkle
 *   statRadar(stats, max, opts?)        aliased polygon chart; axis labels from CONTENT.stats -> { el, set }
 *   tabs(labels, opts?)                 tab strip -> TabsHandle
 *   createGridNav(opts)                 keyboard/gamepad grid navigation over N cells -> GridNav
 *   keyHint(action, opts?)              key cap for an InputAction (first binding in content/input.json)
 *   actionKeyLabel(action, device?)     that label as text (ui.keyNames.<code> / ui.padButtons.<index>)
 *   nameTag(text, color?)               name tag element for HUD.overlay (position with left/top)
 *   speechBubble(text)                  speech bubble element for HUD.overlay
 *   tooltip(target, text)               hover tooltip; returns detach()
 *   glyphEl(id, opts?)                  pixel glyph from content/ui.json (re-export)
 *   formatNumber(n)                     locale thousands separators (locale from ui.locale)
 *
 * CSS hooks for other modules: .ap-layer (root of any UI layer), .ap-panel, .ap-panel-title, .ap-btn,
 * .ap-row(.is-active/.is-disabled) + .ap-cursor-host (animated gold cursor), .ap-list, .ap-big, .ap-dim,
 * .ap-gold, .ap-anim-in/.ap-anim-out, .ap-shake.
 */
import type { StatKey, Stats } from '../../shared/types.ts'
import type { AudioManager, Input, InputAction } from '../contracts.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { INPUT_BINDINGS, UI_CONFIG } from './config.ts'
import { glyphEl } from './glyphs.ts'
import { createBitmap, drawLine, fillPolygon, parseColor, prefersDarkInk } from './pixel.ts'
import { ensureUIEnvironment } from './scale.ts'
import './styles.css'
import './phone.css'

export { glyphEl }

// ---------------------------------------------------------------------------
// DOM builder
// ---------------------------------------------------------------------------

export type Child = Node | string | number | null | undefined | false

export interface ElProps {
  class?: string
  text?: string
  title?: string
  attrs?: Record<string, string>
  data?: Record<string, string>
  /** CSS custom properties, e.g. { '--rows': 6 }. */
  vars?: Record<string, string | number>
  style?: Partial<Record<'width' | 'height' | 'left' | 'top' | 'right' | 'bottom' | 'display' | 'color', string>>
  on?: { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void }
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props?: ElProps | string, children?: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  const p: ElProps = typeof props === 'string' ? { class: props } : (props ?? {})
  if (p.class) node.className = p.class
  if (p.text !== undefined) node.textContent = p.text
  if (p.title) node.title = p.title
  if (p.attrs) for (const [k, v] of Object.entries(p.attrs)) node.setAttribute(k, v)
  if (p.data) for (const [k, v] of Object.entries(p.data)) node.dataset[k] = v
  if (p.vars) for (const [k, v] of Object.entries(p.vars)) node.style.setProperty(k, String(v))
  if (p.style) for (const [k, v] of Object.entries(p.style)) if (v !== undefined) node.style.setProperty(k, v)
  if (p.on) for (const [k, fn] of Object.entries(p.on)) node.addEventListener(k, fn as EventListener)
  if (children) append(node, children)
  return node
}

export function append(parent: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    parent.append(typeof c === 'number' ? String(c) : c)
  }
}

export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString(t('ui.locale'))
}

// ---------------------------------------------------------------------------
// Panel & button
// ---------------------------------------------------------------------------

export interface PanelHandle {
  readonly el: HTMLElement
  readonly body: HTMLElement
  readonly titleEl: HTMLElement
  setTitle(text: string | null): void
}

export function panel(title?: string | null, opts?: { className?: string; flat?: boolean }): PanelHandle {
  ensureUIEnvironment()
  const titleEl = el('div', 'ap-panel-title')
  const body = el('div', 'ap-panel-body')
  const root = el('div', `ap-panel${opts?.flat ? ' ap-panel--flat' : ''}${opts?.className ? ` ${opts.className}` : ''}`, [titleEl, body])
  const setTitle = (text: string | null) => {
    titleEl.textContent = text ?? ''
    titleEl.hidden = !text
  }
  setTitle(title ?? null)
  return { el: root, body, titleEl, setTitle }
}

export function button(label: string, onClick?: (e: MouseEvent) => void, opts?: { primary?: boolean; className?: string }): HTMLButtonElement {
  const b = el('button', `ap-btn${opts?.primary ? ' ap-btn--primary' : ''}${opts?.className ? ` ${opts.className}` : ''}`, [label])
  b.type = 'button'
  if (onClick) b.addEventListener('click', onClick)
  return b
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

export interface BarHandle {
  readonly el: HTMLElement
  /** Sets the bar; animate drains/fills at the configured rate. */
  set(value: number, max: number, animate?: boolean): void
  /** Resolves when the current animation has finished. */
  settled(): Promise<void>
}

/** `speed`: live multiplier on the drain/fill rate (battle speed); absent = 1. */
interface BarOpts { width?: number; numbers?: boolean; label?: string; className?: string; speed?: () => number }

function createBar(kind: 'hp' | 'exp', opts: BarOpts | undefined): BarHandle {
  ensureUIEnvironment()
  const cfg = kind === 'hp' ? UI_CONFIG.bars.hp : UI_CONFIG.bars.exp
  const rate = kind === 'hp' ? UI_CONFIG.bars.hp.drainPerSecond : UI_CONFIG.bars.exp.fillPerSecond
  const width = Math.max(4, Math.round(opts?.width ?? cfg.width))
  const ghost = el('div', 'ap-bar-ghost')
  const fill = el('div', 'ap-bar-fill')
  const bar = el('div', { class: `ap-bar ap-${kind}`, vars: { '--bar-w': width }, attrs: { role: 'meter' } }, [ghost, fill])
  const num = opts?.numbers ? el('span', 'ap-bar-num') : null
  const label = opts?.label ? el('span', { class: 'ap-bar-label', text: opts.label }) : null
  const root = label || num ? el('span', `ap-bar-wrap${opts?.className ? ` ${opts.className}` : ''}`, [label, bar, num]) : bar
  if (!(label || num) && opts?.className) bar.classList.add(...opts.className.split(' '))

  let max = 1
  let target = 0
  let shown = 0
  let trail = 0
  let raf = 0
  let last = 0
  let waiters: (() => void)[] = []

  const render = () => {
    const units = (r: number) => (r <= 0 ? 0 : Math.max(1, Math.round(r * width)))
    bar.style.setProperty('--fill', String(units(shown)))
    bar.style.setProperty('--ghost', String(units(Math.max(trail, shown))))
    if (kind === 'hp') {
      const tier = shown <= UI_CONFIG.bars.hp.lowBelow ? 'low' : shown <= UI_CONFIG.bars.hp.midBelow ? 'mid' : 'hi'
      bar.dataset.tier = tier
    }
    bar.setAttribute('aria-valuenow', String(Math.round(shown * max)))
    bar.setAttribute('aria-valuemax', String(max))
    if (num) num.textContent = t('ui.bar.value', { value: Math.round(shown * max), max })
  }
  const settle = () => {
    const w = waiters
    waiters = []
    for (const fn of w) fn()
  }
  const tick = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const step = rate * (opts?.speed?.() ?? 1) * dt
    shown = shown < target ? Math.min(target, shown + step) : Math.max(target, shown - step)
    // The damage trail waits while the main bar drains, then catches up.
    if (shown === target) trail = Math.max(shown, trail - step * 1.5)
    render()
    if (shown !== target || trail > shown) raf = requestAnimationFrame(tick)
    else { raf = 0; settle() }
  }
  return {
    el: root,
    set(value: number, newMax: number, animate = false) {
      max = Math.max(1, newMax)
      const r = Math.min(1, Math.max(0, value / max))
      if (!animate) {
        if (raf) cancelAnimationFrame(raf)
        raf = 0
        target = shown = trail = r
        render()
        settle()
        return
      }
      if (r < shown) trail = Math.max(trail, shown)
      target = r
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick) }
    },
    settled() {
      return raf ? new Promise<void>((res) => waiters.push(res)) : Promise.resolve()
    },
  }
}

export const hpBar = (opts?: BarOpts) => createBar('hp', opts)
export const expBar = (opts?: BarOpts) => createBar('exp', opts)

// ---------------------------------------------------------------------------
// Chips & badges
// ---------------------------------------------------------------------------

function colorChip(text: string, color: string | undefined, className: string, title?: string): HTMLElement {
  const chip = el('span', { class: `ap-chip ${className}`, text, title })
  if (color) {
    chip.style.setProperty('--chip-c', color)
    chip.classList.add(prefersDarkInk(color, UI_CONFIG.widgets.chipDarkInkAboveLuminance) ? 'is-dark-ink' : 'is-light-ink')
  }
  return chip
}

export function typeChip(typeId: string): HTMLElement {
  ensureUIEnvironment()
  const def = CONTENT.typeById[typeId]
  const chip = colorChip(def?.nameZh ?? t('ui.unknownType'), def?.color, 'ap-chip--type')
  chip.dataset.type = typeId
  return chip
}

export function statusChip(statusId: string): HTMLElement {
  ensureUIEnvironment()
  const def = CONTENT.statusById[statusId]
  const chip = colorChip(def?.short ?? t('ui.unknownType'), def?.color, 'ap-chip--status', def?.nameZh)
  chip.dataset.status = statusId
  return chip
}

/** Quality grade as a coloured shield badge (grade colours: content/quality.json); the nickname is its tooltip. Shape, not text, tells it from the rarity chip. */
export function gradeChip(gradeId: string): HTMLElement {
  ensureUIEnvironment()
  const def = CONTENT.quality.grades.find((g) => g.id === gradeId)
  const badge = el('span', { class: 'ap-grade', text: gradeId, title: def ? t(`screens.quality.grade.${gradeId}`) : undefined, data: { grade: gradeId } })
  if (def) {
    badge.style.setProperty('--gc', def.color)
    badge.classList.add(prefersDarkInk(def.color, UI_CONFIG.widgets.chipDarkInkAboveLuminance) ? 'is-dark-ink' : 'is-light-ink')
  }
  return badge
}

/** Red dot: "there is something here for you" (menu key, menu rows, claimable entries). Decoration; the row keeps its own label. */
export function attentionDot(className = ''): HTMLElement {
  return el('span', { class: `ap-attn-dot ${className}`.trim(), attrs: { role: 'img', 'aria-label': t('hud.attention.dot') } })
}

export function rarityBadge(rarityId: string, opts?: { label?: 'id' | 'name' }): HTMLElement {
  ensureUIEnvironment()
  const def = CONTENT.rarityById[rarityId]
  const text = def ? (opts?.label === 'name' ? def.nameZh : def.id) : rarityId
  const badge = el('span', { class: 'ap-rarity', text, title: def?.nameZh, data: { rarity: rarityId } })
  if (def) {
    badge.style.setProperty('--rc', def.color)
    badge.classList.toggle('is-glow', def.order >= UI_CONFIG.rarity.glowMinOrder)
    badge.classList.toggle('is-shimmer', def.order >= UI_CONFIG.rarity.shimmerMinOrder)
  }
  return badge
}

export function creatureIcon(url: string, shiny: boolean, sizeUnits = UI_CONFIG.widgets.creatureIconSize): HTMLElement {
  ensureUIEnvironment()
  const img = el('img', { attrs: { alt: '', draggable: 'false', decoding: 'async' } })
  img.src = url
  return el('span', { class: `ap-cicon${shiny ? ' is-shiny' : ''}`, vars: { '--ci': sizeUnits }, title: shiny ? t('ui.shiny') : undefined },
    [img, shiny ? glyphEl('shine') : null])
}

// ---------------------------------------------------------------------------
// Stat radar
// ---------------------------------------------------------------------------

export interface RadarHandle { readonly el: HTMLElement; set(stats: Partial<Stats>, max: number): void }

export function statRadar(stats: Partial<Stats>, max: number, opts?: { size?: number; values?: boolean }): RadarHandle {
  ensureUIEnvironment()
  const size = Math.max(1, Math.round(opts?.size ?? UI_CONFIG.radar.size))
  const { labelGap: gap, padX, padY } = UI_CONFIG.radar
  const canvas = el('canvas', { style: { width: `calc(var(--u) * ${size})`, height: `calc(var(--u) * ${size})` } })
  canvas.width = size
  canvas.height = size
  canvas.style.margin = `calc(var(--u) * ${padY}) calc(var(--u) * ${padX})`
  const box = el('div', 'ap-radar', [canvas])
  const labels = new Map<string, HTMLElement>()

  const draw = (s: Partial<Stats>, m: number) => {
    const axes = CONTENT.stats.filter((d) => d.key in s)
    const css = getComputedStyle(document.documentElement)
    const col = (name: string) => parseColor(css.getPropertyValue(name).trim() || 'rgba(0,0,0,0)')
    const bmp = createBitmap(size, size)
    const c = (size - 1) / 2
    const r = c - 1
    const n = axes.length
    const at = (i: number, k: number) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2
      return { x: c + Math.cos(a) * r * k, y: c + Math.sin(a) * r * k }
    }
    if (n >= 3) {
      const rings = Math.max(1, UI_CONFIG.radar.rings)
      for (let ring = 1; ring <= rings; ring++) {
        const k = ring / rings
        for (let i = 0; i < n; i++) { const p = at(i, k), q = at(i + 1, k); drawLine(bmp, p.x, p.y, q.x, q.y, col('--ap-radar-grid')) }
      }
      for (let i = 0; i < n; i++) { const p = at(i, 1); drawLine(bmp, c, c, p.x, p.y, col('--ap-radar-axis')) }
      const pts = axes.map((d, i) => at(i, Math.min(1, Math.max(UI_CONFIG.radar.minRatio, (s[d.key as StatKey] ?? 0) / Math.max(1, m)))))
      fillPolygon(bmp, pts, col('--ap-radar-fill'))
      for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; drawLine(bmp, p.x, p.y, q.x, q.y, col('--ap-radar-line')) }
      for (const p of pts) drawLine(bmp, p.x, p.y, p.x, p.y, col('--ap-radar-dot'))
    }
    canvas.getContext('2d')!.putImageData(new ImageData(bmp.data, size, size), 0, 0)

    for (const [k, node] of labels) if (!axes.some((d) => d.key === k)) { node.remove(); labels.delete(k) }
    axes.forEach((d, i) => {
      let node = labels.get(d.key)
      if (!node) { node = el('div', 'ap-radar-label'); labels.set(d.key, node); box.append(node) }
      node.replaceChildren(d.nameZh, opts?.values === false ? '' : el('b', { text: String(s[d.key as StatKey] ?? 0) }))
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2
      const dx = Math.cos(a), dy = Math.sin(a)
      const lx = c + dx * (r + gap), ly = c + dy * (r + gap)
      node.style.left = `calc(var(--u) * ${Math.round(lx) + padX})`
      node.style.top = `calc(var(--u) * ${Math.round(ly) + padY})`
      const k = UI_CONFIG.radar.labelAnchor
      const tx = dx > k ? '0' : dx < -k ? '-100%' : '-50%'
      const ty = dy > k ? '0' : dy < -k ? '-100%' : '-50%'
      node.style.transform = `translate(${tx}, ${ty})`
    })
  }
  draw(stats, max)
  return { el: box, set: draw }
}

// ---------------------------------------------------------------------------
// Tabs & grid navigation
// ---------------------------------------------------------------------------

export interface TabsHandle {
  readonly el: HTMLElement
  readonly index: number
  set(i: number, silent?: boolean): void
  next(): void
  prev(): void
  setLabel(i: number, label: string): void
}

export function tabs(labels: string[], opts?: { initial?: number; onChange?: (i: number) => void; audio?: AudioManager; className?: string }): TabsHandle {
  ensureUIEnvironment()
  let index = Math.min(Math.max(0, opts?.initial ?? 0), Math.max(0, labels.length - 1))
  const buttons = labels.map((l, i) => {
    const b = el('button', { class: 'ap-tab', text: l, attrs: { role: 'tab', type: 'button' } })
    b.addEventListener('click', () => api.set(i))
    return b
  })
  const root = el('div', { class: `ap-tabs${opts?.className ? ` ${opts.className}` : ''}`, attrs: { role: 'tablist' } }, buttons)
  const paint = () => buttons.forEach((b, i) => { b.classList.toggle('is-active', i === index); b.setAttribute('aria-selected', String(i === index)) })
  const api: TabsHandle = {
    el: root,
    get index() { return index },
    set(i: number, silent = false) {
      const n = labels.length
      if (!n) return
      const next = ((i % n) + n) % n
      if (next === index) return
      index = next
      paint()
      if (!silent) { opts?.audio?.playSfx(UI_CONFIG.sfx.tab); opts?.onChange?.(index) }
    },
    next() { api.set(index + 1) },
    prev() { api.set(index - 1) },
    setLabel(i: number, label: string) { if (buttons[i]) buttons[i].textContent = label },
  }
  paint()
  return api
}

export interface GridNav {
  index: number
  readonly count: number
  readonly cols: number
  set(i: number): void
  setCount(n: number): void
  /** Moves the cursor; returns true if it changed. */
  move(dx: number, dy: number): boolean
  /** Reads and consumes directional/confirm/cancel input. */
  handle(input: Input): 'confirm' | 'cancel' | 'move' | null
}

export function createGridNav(opts: { count: number; cols?: number; wrap?: boolean; initial?: number; onChange?: (i: number, prev: number) => void; audio?: AudioManager }): GridNav {
  const cols = Math.max(1, Math.floor(opts.cols ?? 1))
  const wrap = opts.wrap ?? true
  let count = Math.max(0, opts.count)
  let index = Math.min(Math.max(0, opts.initial ?? 0), Math.max(0, count - 1))
  const changeTo = (i: number) => {
    if (i === index || i < 0 || i >= count) return false
    const prev = index
    index = i
    opts.audio?.playSfx(UI_CONFIG.sfx.move)
    opts.onChange?.(index, prev)
    return true
  }
  const nav: GridNav = {
    get index() { return index },
    set index(i: number) { index = Math.min(Math.max(0, i), Math.max(0, count - 1)) },
    get count() { return count },
    cols,
    set(i: number) { nav.index = i },
    setCount(n: number) { count = Math.max(0, n); nav.index = index },
    move(dx: number, dy: number) {
      if (count <= 0) return false
      const rows = Math.ceil(count / cols)
      if (dx) {
        if (cols === 1) return false
        let i = index + dx
        if (i < 0 || i >= count) { if (!wrap) return false; i = (i + count) % count }
        return changeTo(i)
      }
      if (dy) {
        let row = Math.floor(index / cols) + dy
        if (row < 0 || row >= rows) { if (!wrap) return false; row = (row + rows) % rows }
        // A partial last row clamps onto its last cell.
        return changeTo(Math.min(count - 1, row * cols + (index % cols)))
      }
      return false
    },
    handle(input: Input) {
      const dirs: [InputAction, number, number][] = [['up', 0, -1], ['down', 0, 1], ['left', -1, 0], ['right', 1, 0]]
      for (const [a, dx, dy] of dirs) {
        if (input.pressed(a, true)) { input.consume(a); return nav.move(dx, dy) ? 'move' : null }
      }
      if (input.pressed('confirm')) { input.consume('confirm'); return 'confirm' }
      if (input.pressed('cancel')) { input.consume('cancel'); return 'cancel' }
      return null
    },
  }
  return nav
}

// ---------------------------------------------------------------------------
// Hints, overlay elements, tooltip
// ---------------------------------------------------------------------------

/** Display label of the first binding of an action on a device, read from content/input.json. */
export function actionKeyLabel(action: InputAction, device: Input['lastDevice'] = 'keyboard'): string {
  const named = (key: string, fallback: string) => (key in CONTENT.text ? t(key) : fallback)
  if (device === 'gamepad') {
    const idx = INPUT_BINDINGS.gamepad.buttons[action]?.[0]
    if (idx !== undefined) return named(`ui.padButtons.${idx}`, String(idx))
  }
  if (device === 'touch') {
    const btn = INPUT_BINDINGS.touch.buttons.find((b) => b.action === action)
    if (btn) return t(btn.label)
    // No pad button (chat, minimap): name the on-screen control instead of a key that does not exist here.
    if (`audio.touch.${action}` in CONTENT.text) return t(`audio.touch.${action}`)
  }
  const code = INPUT_BINDINGS.keyboard[action]?.[0]
  return code ? named(`ui.keyNames.${code}`, code.replace(/^(Key|Digit)/, '')) : ''
}

export function keyHint(action: InputAction, opts?: { label?: string; device?: Input['lastDevice'] }): HTMLElement {
  ensureUIEnvironment()
  return el('span', 'ap-key', [el('kbd', { text: actionKeyLabel(action, opts?.device) }), opts?.label ?? null])
}

export function nameTag(text: string, color?: string): HTMLElement {
  ensureUIEnvironment()
  const tag = el('div', { class: 'ap-nametag', text })
  if (color) tag.style.setProperty('--tag-c', color)
  return tag
}

export function speechBubble(text: string): HTMLElement {
  ensureUIEnvironment()
  return el('div', { class: 'ap-bubble', text })
}

let tipEl: HTMLElement | null = null

export function tooltip(target: HTMLElement, text: string | (() => string)): () => void {
  ensureUIEnvironment()
  const show = (e: MouseEvent) => {
    if (!tipEl) { tipEl = el('div', 'ap-tooltip'); document.body.append(tipEl) }
    tipEl.textContent = typeof text === 'function' ? text() : text
    tipEl.hidden = false
    move(e)
  }
  const move = (e: MouseEvent) => {
    if (!tipEl) return
    const pad = UI_CONFIG.widgets.tooltipOffsetPx
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight
    tipEl.style.left = `${Math.min(window.innerWidth - w - 4, e.clientX + pad)}px`
    tipEl.style.top = `${Math.min(window.innerHeight - h - 4, e.clientY + pad)}px`
  }
  const hide = () => { if (tipEl) tipEl.hidden = true }
  target.addEventListener('mouseenter', show)
  target.addEventListener('mousemove', move)
  target.addEventListener('mouseleave', hide)
  return () => {
    hide()
    target.removeEventListener('mouseenter', show)
    target.removeEventListener('mousemove', move)
    target.removeEventListener('mouseleave', hide)
  }
}
