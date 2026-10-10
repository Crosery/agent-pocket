// World-event HUD: compact activity disclosure, roaming-legend direction and full-screen ambience overlays.
// Overlay styles come from content/events/client.json; the animations themselves are CSS capability ids.
import { t } from '../../shared/content/index.ts'
import type { UIKit, UIPanel } from '../contracts.ts'
import type { EventBenefit } from '../world/event-details.ts'
import { cueDef, GPC } from '../world/gameplay-config.ts'
import { el, glyphEl } from './widgets.ts'
import './event-hud.css'

export interface EventHudChip {
  id: string
  title: string
  /** Remaining time / scope. */
  sub: string
  /** Event tag (data-tag for styling). */
  tag: string
  /** Accent colour (content/events/client.json hud.tagColors). */
  color: string
  description?: string
  scope?: string
  benefits?: readonly EventBenefit[]
}

export interface EventHudSense {
  text: string
  /** Screen-space angle (radians, 0 = east, clockwise) from the player toward the source. */
  angle: number
  color: string
}

export interface EventHud {
  setVisible(v: boolean): void
  setChips(list: readonly EventHudChip[]): void
  setSense(s: EventHudSense | null): void
  setAmbience(cues: readonly string[]): void
  dispose(): void
}

export function createEventHud(uiRoot: HTMLElement, ui?: UIKit): EventHud {
  const fxLayer = el('div', { class: 'ap-layer ap-l-evfx is-hidden', attrs: { 'aria-hidden': 'true' } })
  const hudLayer = el('div', { class: 'ap-layer ap-l-evhud is-hidden' })
  const count = el('span', { class: 'ap-evcount', attrs: { 'aria-hidden': 'true' } })
  const pips = el('span', { class: 'ap-evpips', attrs: { 'aria-hidden': 'true' } })
  const status = el('span', { class: 'ap-sr-only', attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } })
  const listEl = el('ul', 'ap-evlist')
  const close = el('button', { class: 'ap-evclose', attrs: {
    type: 'button', 'aria-label': t('hud.events.close'),
  } }, [glyphEl('close')])
  const done = el('button', { class: 'ap-evdone ap-hud-frame', text: t('hud.events.close'), attrs: { type: 'button' } })
  const detailTitle = el('h3', 'ap-evdetail-title')
  const description = el('p', 'ap-evdescription')
  const scope = el('span', 'ap-evscope')
  const timer = el('span', 'ap-evtimer')
  const benefits = el('ul', 'ap-evbenefits')
  const empty = el('p', { class: 'ap-dim', text: t('hud.events.emptyBenefits') })
  const detail = el('section', { class: 'ap-evdetail', attrs: { 'aria-label': t('hud.events.detail') } }, [
    detailTitle, el('div', 'ap-evmeta', [scope, timer]), description,
    el('h4', { class: 'ap-evbenefits-title', text: t('hud.events.benefits') }), benefits, empty,
    el('p', { class: 'ap-evnote', text: t('hud.events.rulesNote') }),
  ])
  const details = el('dialog', { class: 'ap-evdetails ap-hud-frame', attrs: {
    id: 'ap-evdetails', tabindex: '-1', 'aria-labelledby': 'ap-evheading', 'aria-modal': 'true',
  } }, [
    el('div', 'ap-evheading', [glyphEl('event'), el('h2', { text: t('events.ui.active'), attrs: { id: 'ap-evheading' } }), close]),
    el('div', { class: 'ap-evbody', attrs: { tabindex: '0', 'aria-label': t('hud.events.detail') } }, [
      el('nav', { class: 'ap-evnav', attrs: { 'aria-label': t('hud.events.title') } }, [listEl]), detail,
    ]), done,
  ])
  const toggle = el('button', { class: 'ap-evtoggle ap-hud-frame', attrs: {
    type: 'button', 'aria-expanded': 'false', 'aria-controls': 'ap-evdetails',
  } }, [glyphEl('event'), el('span', { class: 'ap-evlabel', text: t('hud.events.title') }),
    count, pips, glyphEl('advance', { className: 'ap-evchevron' })])
  const chips = el('div', { class: 'ap-evchips is-hidden is-collapsed' }, [toggle, status])
  const senseText = el('span', 'ap-evsense-text')
  const senseArrow = el('span', 'ap-evsense-arrow')
  const sense = el('div', 'ap-evsense is-hidden', [senseArrow, senseText])
  sense.hidden = true
  chips.hidden = true
  details.hidden = true
  hudLayer.append(sense)
  uiRoot.prepend(fxLayer)
  uiRoot.append(hudLayer, details)

  // Activity details share the quest/objective disclosure channel, so only one reading panel can be open.
  let visible = false
  let list: readonly EventHudChip[] = []
  let selectedId = ''
  let selectionKey = ''
  const chipNodes = new Map<string, { el: HTMLElement; button: HTMLButtonElement; title: HTMLElement; sub: HTMLElement }>()
  const select = (id: string, focus = false) => {
    const chip = list.find(c => c.id === id)
    if (!chip) return
    const changed = selectedId !== id
    selectedId = id
    for (const [key, row] of chipNodes) {
      row.button.setAttribute('aria-current', String(key === id))
      row.el.classList.toggle('is-selected', key === id)
    }
    if (focus) chipNodes.get(id)?.button.focus({ preventScroll: true })
    const key = JSON.stringify(chip)
    if (key === selectionKey) return
    selectionKey = key
    detail.style.setProperty('--evc', chip.color)
    detailTitle.textContent = chip.title
    description.textContent = chip.description ?? ''
    scope.textContent = chip.scope ?? ''
    timer.textContent = chip.sub
    const rows = chip.benefits ?? []
    benefits.replaceChildren(...rows.map(b => el('li', `ap-evbenefit is-${b.kind}`, [
      el('span', { class: 'ap-evbenefit-label', text: b.label }),
      el('strong', { class: 'ap-evbenefit-value', text: b.value }),
    ])))
    empty.hidden = rows.length > 0
    if (changed) details.querySelector<HTMLElement>('.ap-evbody')!.scrollTop = 0
  }
  const panel: UIPanel = {
    el: details,
    onInput(input) {
      if (input.pressed('cancel') || input.pressed('menu')) {
        input.consume('cancel'); input.consume('menu')
        expand(false)
        return true
      }
      const delta = input.pressed('down', true) || input.pressed('right', true) ? 1
        : input.pressed('up', true) || input.pressed('left', true) ? -1 : 0
      if (delta && list.length) {
        const index = Math.max(0, list.findIndex(c => c.id === selectedId))
        select(list[(index + delta + list.length) % list.length].id, true)
      }
      if (input.pressed('confirm')) {
        input.consume('confirm')
        if (document.activeElement === close || document.activeElement === done) expand(false)
        else if (document.activeElement instanceof HTMLButtonElement) document.activeElement.click()
      }
      return true
    },
  }
  const expand = (on: boolean) => {
    if (on === details.open) return
    if (on && (!visible || chips.hidden || ui?.isBlocking())) return
    chips.classList.toggle('is-collapsed', !on)
    toggle.setAttribute('aria-expanded', String(on))
    details.hidden = !on
    if (on) {
      chips.dispatchEvent(new CustomEvent('ap-hud-expand', { bubbles: true }))
      if (ui) ui.pushPanel(panel)
      else if (!details.isConnected) uiRoot.append(details)
      select(list.some(c => c.id === selectedId) ? selectedId : list[0].id)
      details.classList.add('ap-fullscreen')
      details.showModal()
      details.querySelector<HTMLElement>('.ap-evbody')!.scrollTop = 0
      close.focus({ preventScroll: true })
    } else {
      details.classList.remove('ap-fullscreen')
      details.close()
      ui?.popPanel(panel)
      if (visible && !chips.hidden && list.length) toggle.focus({ preventScroll: true })
      else if (chips.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
      else if (details.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
    }
  }
  toggle.addEventListener('click', () => expand(!!details.hidden))
  close.addEventListener('click', () => expand(false))
  done.addEventListener('click', () => expand(false))
  toggle.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && details.hidden) { toggle.blur(); return }
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); expand(false) }
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    if (!e.repeat) toggle.click()
  })
  details.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); expand(false) }
    if (e.key === 'Tab') {
      const targets = [...details.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')]
        .filter(node => node.checkVisibility())
      const first = targets[0], last = targets.at(-1)
      // Native dialogs may tab into browser chrome; the next game-bound Tab must stay in this modal.
      if (e.shiftKey && (document.activeElement === first || document.activeElement === details)) {
        e.preventDefault(); last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first?.focus()
      }
    }
  })
  details.addEventListener('cancel', (e) => { e.preventDefault(); expand(false) })
  details.addEventListener('click', (e) => {
    if (e.target !== details) return
    const r = details.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) expand(false)
  })
  const onDetailsOpen = (e: Event) => { if (e.target !== chips) expand(false) }
  uiRoot.addEventListener('ap-hud-expand', onDetailsOpen)

  const placeChips = () => {
    const host = uiRoot.querySelector<HTMLElement>('.ap-hud-tl')
    if (host) {
      chips.classList.remove('is-standalone')
      if (chips.parentElement !== host) host.append(chips)
      if (sense.parentElement !== host) host.insertBefore(sense, chips)
    } else if (chips.parentElement !== hudLayer) {
      chips.classList.add('is-standalone')
      hudLayer.append(sense, chips)
    }
  }
  placeChips()

  const overlays = new Map<string, HTMLElement>()
  let chipKey = ''
  let membershipKey = ''

  return {
    setVisible(v) {
      if (v === visible) return
      visible = v
      fxLayer.classList.toggle('is-hidden', !v)
      hudLayer.classList.toggle('is-hidden', !v)
      chips.classList.toggle('is-hidden', !v)
      sense.classList.toggle('is-hidden', !v)
      if (v) placeChips()
      else {
        if (chips.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
        expand(false)
      }
    },
    setChips(next) {
      const key = JSON.stringify(next)
      if (key === chipKey) return
      chipKey = key
      list = next
      const wanted = new Set(list.map(c => c.id))
      for (const [id, row] of chipNodes) {
        if (wanted.has(id)) continue
        row.el.remove()
        chipNodes.delete(id)
      }
      // Patch rows in place: minute refreshes must not reset reading scroll, keyboard focus or disclosure state.
      list.forEach((c, index) => {
        let row = chipNodes.get(c.id)
        if (!row) {
          const title = el('span', 'ap-evchip-title')
          const sub = el('span', 'ap-evchip-sub')
          const button = el('button', { class: 'ap-evselect', attrs: { type: 'button' } }, [
            el('span', { class: 'ap-evpip', attrs: { 'aria-hidden': 'true' } }),
            el('span', 'ap-evrow-copy', [title, sub]), glyphEl('advance'),
          ])
          button.addEventListener('click', () => select(c.id))
          row = { el: el('li', 'ap-evchip', [button]), button, title, sub }
          chipNodes.set(c.id, row)
        }
        row.el.dataset.id = c.id
        row.el.dataset.tag = c.tag
        row.el.style.setProperty('--evc', c.color)
        row.button.setAttribute('aria-label', t('hud.events.select', { name: c.title }))
        if (row.title.textContent !== c.title) row.title.textContent = c.title
        if (row.sub.textContent !== c.sub) row.sub.textContent = c.sub
        if (listEl.children[index] !== row.el) listEl.insertBefore(row.el, listEl.children[index] ?? null)
      })
      count.textContent = String(list.length)
      const label = t('hud.events.label', { n: list.length })
      toggle.setAttribute('aria-label', label)
      const nextMembership = JSON.stringify(list.map(c => [c.id, c.title, c.tag, c.color]))
      if (nextMembership !== membershipKey) {
        membershipKey = nextMembership
        status.textContent = label
        pips.replaceChildren(...list.slice(0, GPC.hud.maxChips).map(c =>
          el('span', { class: 'ap-evpip', vars: { '--evc': c.color } })))
      }
      if (list.length) select(list.some(c => c.id === selectedId) ? selectedId : list[0].id)
      else {
        if (chips.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
        expand(false)
      }
      chips.hidden = list.length === 0
    },
    setSense(s) {
      sense.hidden = !s
      if (!s) return
      senseText.textContent = s.text
      sense.style.setProperty('--evc', s.color)
      senseArrow.style.transform = `rotate(${s.angle}rad)`
    },
    setAmbience(cues) {
      const want = new Set(cues.filter((k) => cueDef(k)?.overlay))
      for (const [k, node] of overlays) {
        if (want.has(k)) continue
        node.classList.add('is-out')
        overlays.delete(k)
        window.setTimeout(() => node.remove(), GPC.hud.overlayFadeMs)
      }
      for (const k of want) {
        if (overlays.has(k)) continue
        const o = cueDef(k)!.overlay!
        const node = el('div', { class: `ap-evfx is-${o.anim}`, data: { cue: k } })
        node.style.background = o.background
        node.style.mixBlendMode = o.blend
        node.style.setProperty('--evo', String(o.opacity))
        fxLayer.append(node)
        overlays.set(k, node)
      }
    },
    dispose() {
      uiRoot.removeEventListener('ap-hud-expand', onDetailsOpen)
      expand(false)
      fxLayer.remove()
      hudLayer.remove()
      chips.remove()
      details.remove()
      sense.remove()
    },
  }
}
