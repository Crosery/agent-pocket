// Readable battle-state inspector. The compact status windows stay quiet; this panel is the single place where
// all active passives, statuses, volatiles and stage changes are expanded for both sides.
import type { SideIndex } from '../../shared/types.ts'
import { t } from '../../shared/content/index.ts'
import type { Input } from '../contracts.ts'
import { el, panel, typeChip } from '../ui/widgets.ts'
import { battleStatGlossary, describeBattleEffects, type BattleEffectDetail } from './effect-details.ts'
import type { StatusPanel } from './status-panel.ts'

export interface BattleEffectsPanel {
  readonly el: HTMLElement
  readonly open: boolean
  show(side: SideIndex): void
  close(): void
  input(inp: Input): boolean
}

const groupKey: Record<BattleEffectDetail['group'], string> = {
  ability: 'battleui.effects.ability',
  status: 'battleui.effects.statusTitle',
  volatile: 'battleui.effects.volatileTitle',
  stage: 'battleui.effects.stageTitle',
}

function renderRow(row: BattleEffectDetail): HTMLElement {
  const value = row.value ? el('span', { class: 'apb-effect-value', text: row.value }) : null
  return el('div', `apb-effect-row is-${row.polarity}`, [
    el('div', 'apb-effect-row-head', [
      el('span', { class: 'apb-effect-label', text: row.label }),
      el('span', { class: 'apb-effect-kind', text: t(`battleui.effects.${row.polarity}`) }),
      value,
    ]),
    el('div', { class: 'apb-effect-description', text: row.description }),
  ])
}

function renderSide(panel: StatusPanel, side: SideIndex): HTMLElement {
  const snap = panel.getSnapshot()
  const label = side === 0 ? t('battleui.effects.sideOwn') : t('battleui.effects.sideFoe')
  const title = snap?.name || t('battleui.effects.emptySide')
  const body: HTMLElement[] = [
    el('div', 'apb-effects-side-head', [
      el('span', { class: 'apb-effects-side-label', text: label }),
      el('span', { class: 'apb-effects-side-name ap-model-name', text: title }),
    ]),
  ]
  if (!snap) {
    body.push(el('div', { class: 'apb-effects-empty', text: t('battleui.effects.emptySide') }))
    return el('section', `apb-effects-side is-${side === 0 ? 'own' : 'foe'}`, body)
  }

  if (snap.types.length) {
    body.push(el('div', 'apb-effects-types', [
      el('span', { class: 'apb-effects-section-label', text: t('battleui.effects.types') }),
      el('span', 'apb-effects-type-list', snap.types.map((id) => typeChip(id))),
    ]))
  }
  const rows = describeBattleEffects(snap)
  if (!rows.length) {
    body.push(el('div', { class: 'apb-effects-empty', text: t('battleui.effects.empty') }))
  } else {
    for (const group of ['ability', 'status', 'volatile', 'stage'] as const) {
      const groupRows = rows.filter((row) => row.group === group)
      if (!groupRows.length) continue
      body.push(el('div', { class: 'apb-effects-group-title', text: t(groupKey[group]) }))
      body.push(...groupRows.map(renderRow))
    }
  }
  return el('section', `apb-effects-side is-${side === 0 ? 'own' : 'foe'}`, body)
}

export function createBattleEffectsPanel(root: HTMLElement, statuses: readonly [StatusPanel, StatusPanel]): BattleEffectsPanel {
  const backdrop = el('div', { class: 'apb-effects-backdrop', attrs: { 'aria-hidden': 'true' } })
  const p = panel(t('battleui.effects.title'), { className: 'apb-effects-dialog ap-anim-in' })
  p.el.setAttribute('role', 'dialog')
  p.el.setAttribute('aria-modal', 'true')
  p.el.setAttribute('aria-label', t('battleui.effects.title'))
  const close = el('button', {
    class: 'apb-effects-close',
    attrs: { type: 'button', 'aria-label': t('battleui.effects.close') },
  }, [t('battleui.effects.close')])
  p.titleEl.append(close)
  const columns = el('div', 'apb-effects-columns')
  const glossary = el('section', 'apb-effects-glossary', [
    el('div', { class: 'apb-effects-group-title', text: t('battleui.effects.glossary') }),
    el('div', 'apb-glossary-grid', battleStatGlossary().map((row) => el('div', 'apb-glossary-row', [
      el('span', { class: 'apb-glossary-label', text: row.label }),
      el('span', { class: 'apb-glossary-description', text: row.description }),
    ]))),
  ])
  p.body.append(columns, glossary)
  root.append(backdrop, p.el)
  backdrop.hidden = true
  p.el.hidden = true

  let previousFocus: HTMLElement | null = null
  let shown = false

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
    columns.replaceChildren(renderSide(statuses[0], 0), renderSide(statuses[1], 1))
    columns.querySelector<HTMLElement>(`.apb-effects-side.is-${side === 0 ? 'own' : 'foe'}`)?.classList.add('is-focused')
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
