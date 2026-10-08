// Creature status window (name, shiny mark, rarity, Lv, types, status, volatiles, stat stages, animated HP, own
// EXP bar) and the party ball indicators. Built from ui-kit widgets.
import type { BattleStatKey, CreatureView } from '../../shared/types.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { creatureName } from '../../shared/creature.ts'
import { describeBattleEffects, effectCount, type BattleStatusSnapshot } from './effect-details.ts'
import { append, el, expBar, hpBar, panel, rarityBadge, statusChip, typeChip, type BarHandle } from '../ui/widgets.ts'
import { BATTLE_UI } from './config.ts'
import type { SlotInfo } from './model.ts'

export interface StatusPanel {
  readonly el: HTMLElement
  setCreature(v: CreatureView, abilityId?: string): void
  setLevel(level: number): void
  setHp(hp: number, maxHp: number, animate: boolean): Promise<void>
  setStatus(status: string | null): void
  setVolatiles(ids: readonly string[]): void
  setStages(stages: Partial<Record<BattleStatKey, number>>): void
  getSnapshot(): BattleStatusSnapshot | null
  /** Own panel only: exp bar ratio (0..1). */
  setExp(ratio: number, animate: boolean): Promise<void>
  setSlots(slots: readonly SlotInfo[] | null, size: number): void
  setAway(away: boolean): void
}

export function createStatusPanel(own: boolean, onInspect: () => void): StatusPanel {
  const H = BATTLE_UI.hud
  const p = panel(null, { className: `apb-status ${own ? 'is-own' : 'is-foe'} is-away is-empty` })
  const name = el('span', 'apb-st-name ap-model-name')
  const shiny = el('span', { class: 'apb-st-shiny', text: t('ui.shiny') })
  shiny.hidden = true
  const rarity = el('span')
  const lv = el('span', 'apb-st-lv')
  const tags = el('span', 'apb-st-taglist')
  const hp = hpBar({ width: H.hpBarWidth, numbers: own ? H.ownHpNumbers : H.foeHpNumbers })
  const exp: BarHandle | null = own ? expBar({ width: H.expBarWidth }) : null
  const balls = el('div', 'apb-balls')
  const inspect = el('button', {
    class: 'apb-st-details-btn',
    attrs: { type: 'button', 'aria-label': t('battleui.hud.statusLabel', { name: own ? t('battleui.effects.sideOwn') : t('battleui.effects.sideFoe') }) },
  }, [t('battleui.effects.open')])
  inspect.addEventListener('click', (e) => { e.stopPropagation(); onInspect() })
  p.el.addEventListener('click', (e) => {
    if (e.target instanceof Node && inspect.contains(e.target)) return
    e.stopPropagation()
    onInspect()
  })
  append(p.body, [
    el('div', 'apb-st-head', [name, shiny, rarity, lv]),
    el('div', 'apb-st-tags', [tags, balls, inspect]),
    el('div', 'apb-st-hp', [el('span', { class: 'apb-st-label', text: t('battleui.hud.hp') }), hp.el]),
    exp ? el('div', 'apb-st-exp', [el('span', { class: 'apb-st-label', text: t('battleui.hud.exp') }), exp.el]) : null,
  ])

  let types: string[] = []
  let status: string | null = null
  let volatiles: string[] = []
  let stages: Partial<Record<BattleStatKey, number>> = {}
  let abilityId: string | null = null

  const snapshot = (): BattleStatusSnapshot | null => p.el.classList.contains('is-empty') ? null : ({
    name: name.textContent ?? '',
    abilityId,
    types: [...types],
    status,
    volatiles: [...volatiles],
    stages: { ...stages },
  })

  const paintTags = () => {
    const nodes: HTMLElement[] = []
    if (H.showTypes) for (const ty of types) nodes.push(typeChip(ty))
    const effects: HTMLElement[] = []
    if (status) effects.push(statusChip(status))
    for (const v of volatiles) {
      effects.push(el('span', { class: 'apb-tag', text: CONTENT.volatileById[v]?.nameZh ?? v }))
    }
    if (H.showStages) {
      for (const [k, n] of Object.entries(stages)) {
        if (!n) continue
        const text = t('battleui.hud.stage', {
          stat: CONTENT.statByKey[k]?.nameZh ?? k, sign: t(n > 0 ? 'battleui.hud.plus' : 'battleui.hud.minus'), n: Math.abs(n),
        })
        effects.push(el('span', { class: `apb-tag ${n > 0 ? 'is-up' : 'is-down'}`, text }))
      }
    }
    const visible = effects.slice(0, H.maxEffectTags)
    nodes.push(...visible)
    if (effects.length > visible.length) {
      nodes.push(el('span', { class: 'apb-tag is-more', text: `+${effects.length - visible.length}`, title: t('battleui.effects.more', { n: effects.length - visible.length }) }))
    }
    tags.replaceChildren(...nodes)
    const count = snapshot() ? effectCount(snapshot()!) : 0
    inspect.textContent = count ? t('battleui.hud.statusCount', { n: count }) : t('battleui.effects.open')
    inspect.setAttribute('aria-label', t('battleui.hud.statusLabel', { name: name.textContent ?? '' }))
  }

  return {
    el: p.el,
    setCreature(v, nextAbilityId) {
      const sp = CONTENT.species[v.speciesId]
      p.el.classList.remove('is-empty')
      const shownName = creatureName(v)
      name.textContent = shownName
      name.title = shownName
      name.setAttribute('aria-label', shownName)
      shiny.hidden = !v.shiny
      rarity.replaceChildren(sp ? rarityBadge(sp.rarity) : '')
      lv.textContent = t('battleui.hud.level', { level: v.level })
      types = sp ? [...sp.types] : []
      status = v.status
      volatiles = []
      stages = {}
      abilityId = nextAbilityId ?? null
      paintTags()
      hp.set(v.hp, v.maxHp, false)
    },
    setLevel(level) { lv.textContent = t('battleui.hud.level', { level }) },
    setHp(value, max, animate) {
      hp.set(value, max, animate)
      return animate ? hp.settled() : Promise.resolve()
    },
    setStatus(s) { status = s; paintTags() },
    setVolatiles(ids) { volatiles = [...ids]; paintTags() },
    setStages(s) { stages = { ...s }; paintTags() },
    getSnapshot: snapshot,
    setExp(ratio, animate) {
      if (!exp) return Promise.resolve()
      exp.set(ratio, 1, animate)
      return animate ? exp.settled() : Promise.resolve()
    },
    setSlots(slots, size) {
      if (!slots) { balls.replaceChildren(); return }
      const nodes: HTMLElement[] = []
      for (let i = 0; i < size; i++) {
        const s = slots[i]
        const b = el('span', `apb-ball${!s ? ' is-empty' : s.state === 'fainted' ? ' is-fainted' : ''}`)
        if (s?.state === 'status' && s.status) {
          const c = CONTENT.statusById[s.status]?.color
          if (c) b.style.setProperty('--ball-c', c)
        }
        nodes.push(b)
      }
      balls.replaceChildren(...nodes)
    },
    setAway(away) { p.el.classList.toggle('is-away', away) },
  }
}
