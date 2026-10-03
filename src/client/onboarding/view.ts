// DOM for the objective tracker (inside the HUD's top-left stack) and the one-time tip card. Pixel look comes from
// the ui-kit theme (.ap-panel, .ap-key, glyphs); only layout lives in onboarding.css.
import type { Input } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import { actionKeyLabel, el, glyphEl } from '../ui/widgets.ts'
import { KEY_PLACEHOLDERS } from './config.ts'
import './onboarding.css'

type Device = Input['lastDevice']
type KeyAction = (typeof KEY_PLACEHOLDERS)[number]

const isKeyAction = (s: string): s is KeyAction => (KEY_PLACEHOLDERS as readonly string[]).includes(s)

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
  device: Device
}

export function createObjectiveView(uiRoot: HTMLElement) {
  const text = el('div', 'ap-objective-text')
  const arrow = el('span', 'ap-objective-arrow')
  const dist = el('span', 'ap-objective-dist')
  const nav = el('div', 'ap-objective-nav', [arrow, dist])
  const box = el('div', { class: 'ap-objective', attrs: { role: 'status' } }, [
    el('div', 'ap-objective-title', [glyphEl('diamond'), el('span', { text: t('tutorial.objective.title') })]),
    text,
    nav,
  ])
  box.hidden = true
  let host: HTMLElement | null = null
  let shown = ''
  const place = () => {
    const tl = uiRoot.querySelector<HTMLElement>('.ap-hud-tl')
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
    setVisible(v: boolean) { box.hidden = !v || !place() },
    set(s: ObjectiveState) {
      place()
      const key = `${s.textKey}|${JSON.stringify(s.params)}|${s.device}`
      if (key !== shown) {
        shown = key
        text.replaceChildren(...richText(t(s.textKey, s.params), s.device))
        box.classList.remove('is-new')
        void box.offsetWidth
        box.classList.add('is-new')
      }
      nav.hidden = !s.arrow
      if (s.arrow) {
        arrow.style.transform = `rotate(${(s.arrow.angle * 180) / Math.PI}deg)`
        dist.textContent = t('tutorial.objective.distance', { n: s.arrow.steps })
      }
    },
    dispose() { box.remove() },
  }
}

export interface TipState { textKey: string; device: Device; place?: 'top' | 'bottom' | 'right' }

export function createTipView(uiRoot: HTMLElement, input: Input) {
  const title = el('span', 'ap-tip-title-text')
  const body = el('div', 'ap-tip-body')
  const foot = el('div', 'ap-tip-foot')
  const card = el('div', { class: 'ap-panel ap-tip', attrs: { role: 'status', 'aria-live': 'polite' } }, [
    el('div', 'ap-tip-title', [glyphEl('quest'), title]),
    body,
    foot,
  ])
  const layer = el('div', { class: 'ap-layer ap-l-tips' }, [card])
  card.hidden = true
  layer.hidden = true
  uiRoot.append(layer)
  let clicked = false
  card.addEventListener('pointerdown', (e) => { e.stopPropagation(); clicked = true })
  let hideTimer = 0
  return {
    show(s: TipState) {
      window.clearTimeout(hideTimer)
      clicked = false
      title.textContent = t(`${s.textKey}.title`)
      body.replaceChildren(...richText(t(`${s.textKey}.body`), s.device))
      foot.replaceChildren(...richText(t(s.device === 'touch' ? 'tutorial.tip.skipTouch' : 'tutorial.tip.skip'), s.device))
      layer.hidden = false
      layer.classList.toggle('is-top', s.place === 'top')
      layer.classList.toggle('is-right', s.place === 'right')
      card.hidden = false
      card.classList.remove('is-out')
      void card.offsetWidth
      card.classList.add('is-in')
    },
    hide() {
      card.classList.remove('is-in')
      card.classList.add('is-out')
      window.clearTimeout(hideTimer)
      hideTimer = window.setTimeout(() => { card.hidden = true; layer.hidden = true }, 260)
    },
    /** True once the player clicked the card or pressed the cancel key while it is up. */
    dismissed(): boolean {
      if (card.hidden || card.classList.contains('is-out')) return false
      if (clicked || input.pressed('cancel')) { clicked = false; return true }
      return false
    },
    dispose() { window.clearTimeout(hideTimer); layer.remove() },
  }
}
