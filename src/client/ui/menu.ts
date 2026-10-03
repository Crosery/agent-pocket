// Scrollable, cursor-driven row list used by kit.list() and kit.choose(). Keyboard/gamepad via Input,
// mouse hover/click/wheel and touch drag-scroll via DOM events.
import type { AudioManager, Input, ListItem } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import { UI_CONFIG } from './config.ts'
import { el } from './widgets.ts'

export interface RowMenu {
  /** .ap-list-frame: fixed-height .ap-list viewport + scroll indicators. */
  readonly el: HTMLElement
  readonly index: number
  readonly count: number
  setIndex(i: number, sfx?: boolean): void
  /** Reads/consumes navigation input. 'confirm' is only returned for enabled rows. */
  handleInput(input: Input): 'confirm' | 'cancel' | null
}

export interface RowMenuOptions {
  visibleRows: number
  initial?: number
  wrap?: boolean
  audio: AudioManager
  onChange?: (i: number) => void
  /** Pointer activation of an enabled row. */
  onPick: (i: number) => void
}

const ROW_UNITS = UI_CONFIG.list.rowHeight

export function createRowMenu(items: ListItem[], o: RowMenuOptions): RowMenu {
  const count = items.length
  const visible = Math.max(1, Math.min(o.visibleRows, Math.max(1, count)))
  const wrap = o.wrap ?? UI_CONFIG.list.wrap
  const sfx = (k: keyof typeof UI_CONFIG.sfx) => o.audio.playSfx(UI_CONFIG.sfx[k])

  const inner = el('div', 'ap-list-inner')
  const upInd = el('div', 'ap-scroll-ind ap-scroll-ind--up')
  const downInd = el('div', 'ap-scroll-ind ap-scroll-ind--down')
  const viewport = el('div', { class: 'ap-list', vars: { '--rows': visible, '--row-h': ROW_UNITS }, attrs: { role: 'listbox' } }, [inner])
  const root = el('div', 'ap-list-frame', [viewport, upInd, downInd])

  let index = count ? Math.min(Math.max(0, o.initial ?? 0), count - 1) : -1
  let top = 0
  let dragged = false

  const rows = items.map((it, i) => {
    const row = el('div', {
      class: `ap-row ap-cursor-host${it.disabled ? ' is-disabled' : ''}`,
      attrs: { role: 'option', 'aria-disabled': String(!!it.disabled) },
    }, [
      it.icon ? el('img', { class: 'ap-row-icon', attrs: { src: it.icon, alt: '', draggable: 'false' } }) : null,
      el('span', { class: 'ap-row-label', text: it.label }),
      it.sub !== undefined ? el('span', { class: 'ap-row-sub', text: it.sub }) : null,
    ])
    row.addEventListener('mouseenter', () => { if (!dragged) api.setIndex(i, true) })
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      if (dragged) return
      api.setIndex(i)
      if (items[i].disabled) sfx('error')
      else o.onPick(i)
    })
    return row
  })
  if (count) inner.append(...rows)
  else inner.append(el('div', { class: 'ap-list-empty', text: t('ui.list.empty') }))

  const paint = () => {
    inner.style.transform = `translateY(calc(var(--u) * ${-top * ROW_UNITS}))`
    upInd.classList.toggle('is-on', top > 0)
    downInd.classList.toggle('is-on', top + visible < count)
  }
  const scrollTo = (t0: number) => {
    top = Math.max(0, Math.min(Math.max(0, count - visible), t0))
    paint()
  }
  const ensureVisible = () => {
    if (index < top) scrollTo(index)
    else if (index >= top + visible) scrollTo(index - visible + 1)
    else paint()
  }

  root.addEventListener('wheel', (e) => {
    e.preventDefault()
    if (!count) return
    const dir = Math.sign(e.deltaY || e.deltaX)
    if (!dir) return
    const next = Math.max(0, Math.min(count - 1, index + dir))
    api.setIndex(next, true)
  }, { passive: false })

  // Touch/pen drag scrolls the viewport by whole rows; a drag suppresses the click that follows.
  let dragStartY = 0
  let dragStartTop = 0
  let dragging = false
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return
    dragging = true
    dragged = false
    dragStartY = e.clientY
    dragStartTop = top
  })
  root.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const rowPx = viewport.getBoundingClientRect().height / visible
    const delta = Math.round((dragStartY - e.clientY) / rowPx)
    if (delta !== 0) dragged = true
    if (dragged) scrollTo(dragStartTop + delta)
  })
  const endDrag = () => { dragging = false; setTimeout(() => { dragged = false }, 0) }
  root.addEventListener('pointerup', endDrag)
  root.addEventListener('pointercancel', endDrag)

  const api: RowMenu = {
    el: root,
    get index() { return index },
    count,
    setIndex(i: number, playSfx = false) {
      if (!count) return
      const next = Math.max(0, Math.min(count - 1, i))
      if (next === index) { ensureVisible(); return }
      rows[index]?.classList.remove('is-active')
      rows[index]?.setAttribute('aria-selected', 'false')
      index = next
      rows[index].classList.add('is-active')
      rows[index].setAttribute('aria-selected', 'true')
      ensureVisible()
      if (playSfx) sfx('move')
      o.onChange?.(index)
    },
    handleInput(input: Input) {
      const step = (d: number) => {
        if (!count) return
        let i = index + d
        if (i < 0 || i >= count) {
          if (!wrap || Math.abs(d) > 1) i = Math.max(0, Math.min(count - 1, i))
          else i = (i + count) % count
        }
        if (i !== index) api.setIndex(i, true)
      }
      if (input.pressed('up', true)) { input.consume('up'); step(-1) }
      else if (input.pressed('down', true)) { input.consume('down'); step(1) }
      else if (input.pressed('left', true)) { input.consume('left'); step(-UI_CONFIG.list.pageStep) }
      else if (input.pressed('right', true)) { input.consume('right'); step(UI_CONFIG.list.pageStep) }
      if (input.pressed('confirm')) {
        input.consume('confirm')
        if (!count) return 'cancel'
        if (items[index].disabled) { sfx('error'); return null }
        return 'confirm'
      }
      if (input.pressed('cancel')) { input.consume('cancel'); return 'cancel' }
      return null
    },
  }
  if (count) {
    rows[index].classList.add('is-active')
    rows[index].setAttribute('aria-selected', 'true')
  }
  ensureVisible()
  return api
}
