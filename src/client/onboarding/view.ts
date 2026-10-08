// DOM for the objective tracker (inside the HUD's top-left stack) and the one-time tip card. Pixel look comes from
// the ui-kit theme (.ap-panel, .ap-key, glyphs); only layout lives in onboarding.css.
import type { Input } from '../contracts.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { actionKeyLabel, el, glyphEl } from '../ui/widgets.ts'
import { KEY_PLACEHOLDERS, TUTORIAL } from './config.ts'
import './onboarding.css'

type Device = Input['lastDevice']
type KeyAction = (typeof KEY_PLACEHOLDERS)[number]

const isKeyAction = (s: string): s is KeyAction => (KEY_PLACEHOLDERS as readonly string[]).includes(s)

function nativeActivation(button: HTMLButtonElement): void {
  button.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    e.stopPropagation()
    if (!e.repeat) button.click()
  })
}

/** Text with {confirm}-style placeholders rendered as key caps for the active device ({move} = movement keys). */
export function richText(text: string, device: Device): (Node | string)[] {
  const out: (Node | string)[] = []
  let last = 0
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    const key = m[1]
    const cap = key === 'move' ? t(`tutorial.device.${device}.move`) : isKeyAction(key) ? actionKeyLabel(key, device) : null
    if (cap === null) continue
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(el('span', 'ap-key', [el('kbd', { text: cap })]))
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export interface ObjectiveState {
  textKey: string
  params: Record<string, string>
  arrow: { angle: number; steps: number } | null
  note?: string
  device: Device
}

export function createObjectiveView(uiRoot: HTMLElement) {
  const text = el('div', 'ap-objective-text')
  const arrow = el('span', 'ap-objective-arrow')
  const dist = el('span', 'ap-objective-dist')
  const nav = el('div', 'ap-objective-nav', [arrow, dist])
  const summary = el('span', 'ap-objective-summary')
  const details = el('div', { class: 'ap-objective-details', attrs: {
    id: 'ap-objective-details', role: 'region', tabindex: '0', 'aria-label': t('tutorial.objective.title'),
  } }, [text, nav])
  details.hidden = true
  const toggle = el('button', { class: 'ap-objective-toggle', attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'ap-objective-details' } }, [
    glyphEl('objective'),
    el('span', { class: 'ap-objective-title', text: t('tutorial.objective.title') }),
    summary,
    glyphEl('advance', { className: 'ap-objective-chevron' }),
  ])
  const box = el('div', { class: 'ap-objective is-collapsed', attrs: { 'aria-label': t('tutorial.objective.title') } }, [toggle, details])
  box.hidden = true
  let host: HTMLElement | null = null
  let shown = ''
  let device: Device | null = null
  const expand = (on: boolean) => {
    if (!on && !box.hidden && details.contains(document.activeElement)) toggle.focus({ preventScroll: true })
    box.classList.toggle('is-collapsed', !on)
    toggle.setAttribute('aria-expanded', String(on))
    details.hidden = !on
    if (on) box.dispatchEvent(new CustomEvent('ap-hud-expand', { bubbles: true }))
  }
  toggle.addEventListener('click', () => expand(box.classList.contains('is-collapsed')))
  nativeActivation(toggle)
  toggle.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && box.classList.contains('is-collapsed')) { toggle.blur(); return }
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); expand(false) }
  })
  details.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key !== 'Escape') return
    e.preventDefault()
    expand(false)
  })
  const onDetailsOpen = (e: Event) => { if (e.target !== box) expand(false) }
  uiRoot.addEventListener('ap-hud-expand', onDetailsOpen)
  const place = () => {
    const tl = uiRoot.querySelector<HTMLElement>('.ap-hud-missions') ?? uiRoot.querySelector<HTMLElement>('.ap-hud-tl')
    if (!tl) return false
    if (host !== tl || box.parentElement !== tl) {
      host = tl
      const quest = tl.querySelector('.ap-quest')
      if (quest) quest.after(box)
      else tl.append(box)
    }
    return true
  }
  return {
    setVisible(v: boolean) { box.hidden = !v || !place(); if (!v) expand(false) },
    set(s: ObjectiveState) {
      place()
      const key = `${s.textKey}|${JSON.stringify(s.params)}`
      if (key !== shown || device !== s.device) {
        const changed = key !== shown
        shown = key
        device = s.device
        text.replaceChildren(...richText(t(s.textKey, s.params), s.device))
        const short = t(s.textKey.replace('tutorial.objective.', 'tutorial.objective.short.'), s.params)
        summary.textContent = short
        toggle.setAttribute('aria-label', t('tutorial.objective.label', { objective: short }))
        if (changed) {
          expand(false)
          box.classList.remove('is-new')
          void box.offsetWidth
          box.classList.add('is-new')
        }
      }
      nav.hidden = !s.arrow && !s.note
      arrow.hidden = !s.arrow
      if (s.arrow) {
        arrow.style.transform = `rotate(${(s.arrow.angle * 180) / Math.PI}deg)`
        dist.textContent = t('tutorial.objective.distance', { n: s.arrow.steps })
      } else if (s.note) dist.replaceChildren(...richText(t(s.note), s.device))
    },
    dispose() { uiRoot.removeEventListener('ap-hud-expand', onDetailsOpen); box.remove() },
  }
}

export interface TipState { textKey: string; device: Device; place?: 'top' | 'bottom' | 'right' | 'menu' | 'battle' }

export function createTipView(uiRoot: HTMLElement, input: Input) {
  const title = el('span', 'ap-tip-title-text')
  const body = el('div', 'ap-tip-body')
  const footText = el('span', 'ap-tip-foot-text')
  const off = el('button', { class: 'ap-tip-off', attrs: { type: 'button' }, text: t('tutorial.tip.off') })
  const foot = el('div', 'ap-tip-foot', [footText, off])
  const close = el('button', { class: 'ap-tip-close', attrs: { type: 'button', 'aria-label': t('tutorial.tip.close') } }, [glyphEl('close')])
  const progress = el('div', { class: 'ap-tip-progress', attrs: { 'aria-hidden': 'true' } })
  const card = el('div', { class: 'ap-panel ap-tip ap-hud-frame', attrs: { role: 'status', 'aria-live': 'polite' } }, [
    el('div', 'ap-tip-title', [glyphEl('quest'), title, close]),
    body,
    foot,
    progress,
  ])
  const layer = el('div', { class: 'ap-layer ap-l-tips' }, [card])
  card.hidden = true
  layer.hidden = true
  uiRoot.append(layer)
  card.style.setProperty('--ap-tip-fade', `${TUTORIAL.tips.layer.fadeMs}ms`)
  card.style.setProperty('--ap-tip-duration', `${TUTORIAL.tips.layer.ttlSec}s`)
  let clicked = false
  card.addEventListener('pointerdown', (e) => { e.stopPropagation(); clicked = true })
  close.addEventListener('click', () => { clicked = true })
  nativeActivation(close)
  let offAsked = false
  off.addEventListener('click', () => { offAsked = true; clicked = true })
  nativeActivation(off)
  let hideTimer = 0
  let expireTimer = 0
  const api = {
    show(s: TipState) {
      window.clearTimeout(hideTimer)
      window.clearTimeout(expireTimer)
      clicked = false
      title.textContent = t(`${s.textKey}.title`)
      const touchBody = `${s.textKey}.bodyTouch`
      const bodyKey = s.device === 'touch' && touchBody in CONTENT.text ? touchBody : `${s.textKey}.body`
      body.replaceChildren(...richText(t(bodyKey), s.device))
      offAsked = false
      footText.replaceChildren(...richText(t(s.device === 'touch' ? 'tutorial.tip.skipTouch' : 'tutorial.tip.skip'), s.device))
      const host = s.place === 'menu' ? uiRoot.querySelector<HTMLElement>('.aps-pause-detail') : null
      card.classList.toggle('is-inline', !!host)
      if (host) host.prepend(card)
      else layer.append(card)
      layer.hidden = false
      layer.classList.toggle('is-top', s.place === 'top' || s.place === 'battle')
      layer.classList.toggle('is-battle', s.place === 'battle')
      layer.classList.toggle('is-right', s.place === 'right')
      card.hidden = false
      card.classList.remove('is-out')
      card.classList.remove('is-in')
      void card.offsetWidth
      card.classList.add('is-in')
      // A paused render loop or a background tab must not leave an old hint on screen.
      expireTimer = window.setTimeout(() => { clicked = true; api.hide() }, TUTORIAL.tips.layer.ttlSec * 1000)
    },
    hide() {
      window.clearTimeout(expireTimer)
      if (card.hidden || card.classList.contains('is-out')) return
      card.classList.remove('is-in')
      card.classList.add('is-out')
      window.clearTimeout(hideTimer)
      hideTimer = window.setTimeout(() => {
        if (card.classList.contains('is-inline') && card.contains(document.activeElement)) {
          card.closest('.aps-pause')?.querySelector<HTMLElement>('.aps-pause-row.is-active')?.focus({ preventScroll: true })
        }
        card.hidden = true
        layer.hidden = true
      }, TUTORIAL.tips.layer.fadeMs)
    },
    /** True (once) when the player pressed 「不再提示」. */
    disableRequested(): boolean {
      const v = offAsked
      offAsked = false
      return v
    },
    /** True once the player clicked the card or pressed the cancel key while it is up. */
    dismissed(): boolean {
      if (clicked) { clicked = false; return true }
      if (card.hidden || card.classList.contains('is-out')) return false
      if (input.pressed('cancel')) return true
      return false
    },
    dispose() { window.clearTimeout(expireTimer); window.clearTimeout(hideTimer); card.remove(); layer.remove() },
  }
  return api
}
