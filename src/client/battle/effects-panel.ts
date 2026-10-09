// Battle status sheet: both sides' current state next to each other (name, level, types, HP, status condition, stat stage
// chips, volatile chips, ability), then the field row (weather, boss mechanic meters) when there is one. Definitions sit
// behind a focus / tap on a chip and show in the readout line at the foot, never as a wall of text.
import type { SideIndex } from '../../shared/types.ts'
import { t } from '../../shared/content/index.ts'
import type { Input } from '../contracts.ts'
import { actionKeyLabel, button, el, hpBar, panel, typeChip } from '../ui/widgets.ts'
import { icon } from '../ui/screens/base.ts'
import { meterTile, effectIcon } from './badges.ts'
import { sideSheet, weatherSheet, type BattleEffectPolarity, type SheetChip } from './effect-details.ts'
import { BATTLE_UI } from './config.ts'
import type { BossPanelInfo } from './model.ts'
import type { StatusPanel } from './status-panel.ts'

export interface BattleEffectsPanel {
  readonly el: HTMLElement
  readonly open: boolean
  show(side: SideIndex): void
  /** Re-renders while open when either side's effects changed (the battle keeps playing behind the panel). */
  sync(): void
  close(): void
  input(inp: Input): boolean
}

/** What belongs to the whole field rather than to one side. */
export interface FieldInfo { weather: string | null; boss: BossPanelInfo | null }

type Readout = (text: string, polarity?: BattleEffectPolarity) => void

/** A focusable label that explains itself in the readout line (hover, focus or tap) and as a tooltip. */
function chipTrigger(node: HTMLElement, tip: string, polarity: BattleEffectPolarity, readout: Readout): HTMLElement {
  node.title = tip
  node.tabIndex = 0
  node.setAttribute('role', 'button')
  node.setAttribute('aria-label', tip)
  const show = () => readout(tip, polarity)
  node.addEventListener('pointerenter', show)
  node.addEventListener('click', (e) => { e.stopPropagation(); show() })
  node.onfocus = show
  return node
}

function stageChip(c: SheetChip, readout: Readout): HTMLElement {
  return chipTrigger(el('span', `apb-fx-chip is-${c.polarity}`, [
    el('span', { class: 'apb-fx-chip-label', text: c.label }),
    el('span', { class: 'apb-fx-chip-delta', text: c.delta ?? '' }),
    el('span', { class: 'apb-fx-chip-factor', text: c.factor ?? '' }),
  ]), c.tip, c.polarity, readout)
}

function volatileChip(c: SheetChip, readout: Readout): HTMLElement {
  const ico = effectIcon(c.id, c.tip, c.polarity)
  return chipTrigger(el('span', `apb-fx-chip is-${c.polarity}`, [ico, el('span', { class: 'apb-fx-chip-label', text: c.label })]), c.tip, c.polarity, readout)
}

function renderSide(status: StatusPanel, side: SideIndex, readout: Readout): HTMLElement {
  const kind = side === 0 ? 'own' : 'foe'
  const snap = status.getSnapshot()
  const head = el('div', 'apb-fx-side-head', [
    el('span', { class: 'apb-fx-tag', text: t(side === 0 ? 'battleui.effects.sideOwn' : 'battleui.effects.sideFoe') }),
    el('span', { class: 'apb-fx-name ap-model-name', text: snap?.name || t('battleui.effects.emptySide') }),
  ])
  const section = el('section', `apb-fx-side is-${kind}`, [head])
  if (!snap) {
    section.append(el('div', { class: 'apb-fx-quiet', text: t('battleui.effects.emptySide') }))
    return section
  }
  section.append(el('div', 'apb-fx-meta', [
    el('span', 'apb-fx-types', snap.types.map((id) => typeChip(id))),
    snap.level ? el('span', { class: 'apb-fx-lv', text: t('battleui.hud.level', { level: snap.level }) }) : null,
  ]))
  if (snap.maxHp) {
    const hp = hpBar({ width: BATTLE_UI.inspector.hpBarWidth, numbers: side === 0 ? BATTLE_UI.hud.ownHpNumbers : BATTLE_UI.hud.foeHpNumbers })
    hp.set(snap.hp ?? 0, snap.maxHp, false)
    section.append(el('div', 'apb-fx-hp', [el('span', { class: 'apb-fx-hp-label', text: t('battleui.hud.hp') }), hp.el]))
  }

  const sheet = sideSheet(snap)
  if (sheet.status) {
    const s = sheet.status
    const ico = effectIcon(s.id, s.tip, 'debuff')
    section.append(chipTrigger(el('div', 'apb-fx-status', [
      ico,
      el('span', { class: 'apb-fx-status-name', text: s.label }),
      el('span', { class: 'apb-fx-status-line', text: s.line }),
    ]), s.tip, 'debuff', readout))
  }
  const chips = [...sheet.stages.map((c) => stageChip(c, readout)), ...sheet.volatiles.map((c) => volatileChip(c, readout))]
  if (chips.length) section.append(el('div', 'apb-fx-chips', chips))
  if (sheet.quiet) section.append(el('div', { class: 'apb-fx-quiet', text: t('battleui.effects.noEffects') }))
  if (sheet.ability) {
    section.append(chipTrigger(el('div', 'apb-fx-ability', [
      el('span', { class: 'apb-fx-ability-tag', text: t('battleui.effects.ability') }),
      el('span', { class: 'apb-fx-ability-name', text: sheet.ability.label }),
      el('span', { class: 'apb-fx-ability-line', text: sheet.ability.line }),
    ]), sheet.ability.tip, 'neutral', readout))
  }
  return section
}

function renderField(field: FieldInfo | null, readout: Readout): HTMLElement | null {
  const weather = weatherSheet(field?.weather)
  const chips = field?.boss?.chips ?? []
  if (!weather && !chips.length) return null
  const row = el('div', 'apb-fx-field', [el('span', { class: 'apb-fx-field-title', text: t('battleui.effects.fieldTitle') })])
  if (weather) {
    const node = el('span', 'apb-fx-weather', [
      el('span', { class: 'apb-fx-weather-name', text: weather.label }),
      el('span', { class: 'apb-fx-weather-line', text: weather.line }),
    ])
    node.style.setProperty('--wc', weather.color)
    row.append(chipTrigger(node, t('battleui.effects.tip', { label: weather.label, description: weather.line }), 'neutral', readout))
  }
  if (chips.length) row.append(el('div', 'apb-fx-meters', chips.map((c) => meterTile(c, (text) => readout(text, 'neutral')))))
  return row
}

export function createBattleEffectsPanel(root: HTMLElement, statuses: readonly [StatusPanel, StatusPanel], field: () => FieldInfo | null = () => null): BattleEffectsPanel {
  const backdrop = el('div', { class: 'apb-effects-backdrop', attrs: { 'aria-hidden': 'true' } })
  const p = panel(null, { className: 'apb-win apb-effects-dialog ap-anim-in' })
  p.el.setAttribute('role', 'dialog')
  p.el.setAttribute('aria-modal', 'true')
  p.el.setAttribute('aria-label', t('battleui.effects.title'))
  // The same square ✕ as every other screen's header.
  const close = button('', undefined, { className: 'aps-close apb-fx-close' })
  close.setAttribute('aria-label', t('battleui.effects.close'))
  close.append(icon('close'))
  const body = el('div', 'apb-fx-body')
  const hintDefault = el('span', 'apb-fx-hint', [
    el('span', { class: 'apb-hint-keys', text: t('battleui.effects.hintKeys', { cancel: actionKeyLabel('cancel') }) }),
    el('span', { class: 'apb-hint-touch', text: t('battleui.effects.hintTouch') }),
  ])
  const readoutBox = el('div', 'apb-fx-readout', [hintDefault])
  const readout: Readout = (text, polarity = 'neutral') => {
    readoutBox.className = `apb-fx-readout is-${polarity}`
    readoutBox.replaceChildren(text)
  }
  p.body.replaceWith(el('div', 'apb-fx-frame', [
    el('header', 'apb-fx-head', [el('h2', { class: 'apb-fx-title', text: t('battleui.effects.title') }), close]),
    body,
    readoutBox,
  ]))
  root.append(backdrop, p.el)
  backdrop.hidden = true
  p.el.hidden = true

  let previousFocus: HTMLElement | null = null
  let shown = false
  let focusSide: SideIndex = 0
  let signature = ''

  const state = () => JSON.stringify([statuses[0].getSnapshot(), statuses[1].getSnapshot(), field()])
  const render = () => {
    signature = state()
    readoutBox.className = 'apb-fx-readout'
    readoutBox.replaceChildren(hintDefault)
    const sides = el('div', 'apb-fx-sides', [renderSide(statuses[0], 0, readout), renderSide(statuses[1], 1, readout)])
    sides.querySelector(`.apb-fx-side.is-${focusSide === 0 ? 'own' : 'foe'}`)?.classList.add('is-focused')
    body.replaceChildren(sides, ...[renderField(field(), readout)].filter((n): n is HTMLElement => !!n))
  }

  const closePanel = () => {
    if (!shown) return
    shown = false
    backdrop.hidden = true
    p.el.hidden = true
    previousFocus?.focus({ preventScroll: true })
    previousFocus = null
  }
  const showPanel = (side: SideIndex) => {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    focusSide = side
    render()
    body.scrollTop = 0
    shown = true
    backdrop.hidden = false
    p.el.hidden = false
    close.focus({ preventScroll: true })
  }

  close.addEventListener('click', (e) => { e.stopPropagation(); closePanel() })
  backdrop.addEventListener('click', (e) => { e.stopPropagation(); closePanel() })
  p.el.addEventListener('click', (e) => e.stopPropagation())
  p.el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    closePanel()
  })

  return {
    el: p.el,
    get open() { return shown },
    show: showPanel,
    sync() {
      if (shown && state() !== signature) render()
    },
    close: closePanel,
    input(inp) {
      if (!shown) return false
      if (inp.pressed('cancel') || inp.pressed('menu')) {
        inp.consume('cancel')
        inp.consume('menu')
        closePanel()
      } else if (inp.pressed('confirm')) {
        inp.consume('confirm')
      }
      return true
    },
  }
}
