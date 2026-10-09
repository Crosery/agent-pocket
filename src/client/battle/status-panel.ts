// Creature status window (name, shiny mark, rarity, Lv, types, status, volatiles, stat stages, animated HP, own
// EXP bar) and the party ball indicators. Built from ui-kit widgets.
import type { BattleStatKey, CreatureView } from '../../shared/types.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { creatureName } from '../../shared/creature.ts'
import { effectBalance, hudEffects, type BattleStatusSnapshot } from './effect-details.ts'
import { actionKeyLabel, append, el, expBar, hpBar, panel, rarityBadge, type BarHandle } from '../ui/widgets.ts'
import { effectIcon, meterTile, typeBadge } from './badges.ts'
import { BATTLE_UI } from './config.ts'
import type { BossPanelInfo, SlotInfo } from './model.ts'

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
  /** Foe window only: boss title, phase pips and mechanic chips (null clears them). */
  setBoss(info: BossPanelInfo | null): void
  /** Draws the eye to the boss strip (telegraphed attack, phase change). */
  pulseBoss(): void
}

export function createStatusPanel(own: boolean, onInspect: () => void, speed?: () => number): StatusPanel {
  const H = BATTLE_UI.hud
  const p = panel(null, { className: `apb-win apb-status ${own ? 'is-own' : 'is-foe'} is-away is-empty` })
  const name = el('span', 'apb-st-name ap-model-name')
  const shiny = el('span', { class: 'apb-st-shiny', text: t('ui.shiny') })
  shiny.hidden = true
  const rarity = el('span')
  const lv = el('span', 'apb-st-lv')
  const tags = el('span', 'apb-st-taglist')
  const effects = el('div', 'apb-st-effects')
  const hp = hpBar({ width: H.hpBarWidth, numbers: own ? H.ownHpNumbers : H.foeHpNumbers, speed })
  const exp: BarHandle | null = own ? expBar({ width: H.expBarWidth, speed }) : null
  const balls = el('div', 'apb-balls')
  const more = el('span', 'apb-tag is-more is-folded')
  const inspect = el('button', {
    class: 'apb-st-details-btn',
    attrs: { type: 'button', title: t('battleui.effects.openHint', { key: actionKeyLabel('menu') }) },
  })
  inspect.addEventListener('click', (e) => { e.stopPropagation(); onInspect() })
  p.el.addEventListener('click', (e) => {
    if (e.target instanceof Node && inspect.contains(e.target)) return
    e.stopPropagation()
    onInspect()
  })
  const tagRow = el('div', 'apb-st-tags', [tags, balls, inspect])
  const bossBox = el('div', 'apb-st-boss')
  bossBox.hidden = true
  append(p.body, [
    el('div', 'apb-st-head', [name, el('span', 'apb-st-badges', [shiny, rarity, lv])]),
    bossBox,
    tagRow,
    effects,
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

  // Effect tags that do not fit their row (one on the own corner, two on the floating foe window) are folded whole
  // into a "+N" tag; the inspector button always carries the full count.
  let foldable: HTMLElement[] = []
  const fold = () => {
    for (const n of foldable) n.classList.remove('is-folded')
    more.classList.add('is-folded')
    if (!foldable.length || !effects.isConnected) return
    const room = effects.getBoundingClientRect()
    const fits = (n: HTMLElement) => {
      const r = n.getBoundingClientRect()
      return r.right <= room.right + 1 && r.bottom <= room.bottom + 1
    }
    let first = foldable.findIndex((n) => !fits(n))
    if (first < 0) return
    more.classList.remove('is-folded')
    for (;;) {
      for (let i = 0; i < foldable.length; i++) foldable[i].classList.toggle('is-folded', i >= first)
      const hidden = foldable.length - first
      more.textContent = `+${hidden}`
      more.title = t('battleui.effects.more', { n: hidden })
      if (first === 0 || fits(more)) return
      first--
    }
  }
  new ResizeObserver(fold).observe(effects)

  const paintTags = () => {
    const snap = snapshot()
    const nodes: HTMLElement[] = []
    if (H.showTypes) for (const ty of types) nodes.push(typeBadge(ty))
    foldable = []
    for (const row of snap ? hudEffects(snap) : []) {
      if (row.group === 'stage' && !H.showStages) continue
      const tip = t('battleui.effects.tip', { label: row.label, description: row.description })
      const icon = row.group === 'stage' ? null : effectIcon(row.id.slice(row.id.indexOf(':') + 1), tip, row.polarity)
      const tag = icon ?? el('span', { class: `apb-tag ${row.polarity === 'buff' ? 'is-up' : 'is-down'}`, text: row.short })
      tag.title = tip
      foldable.push(tag)
    }
    tags.replaceChildren(...nodes)
    effects.replaceChildren(...(foldable.length ? [...foldable, more] : []))
    const { buff, debuff } = snap ? effectBalance(snap) : { buff: 0, debuff: 0 }
    inspect.replaceChildren()
    append(inspect, [
      el('span', { text: t('battleui.effects.open') }),
      buff ? el('span', { class: 'apb-st-up', text: t('battleui.hud.up', { n: buff }) }) : null,
      debuff ? el('span', { class: 'apb-st-down', text: t('battleui.hud.down', { n: debuff }) }) : null,
    ])
    const who = name.textContent ?? ''
    inspect.setAttribute('aria-label', t('battleui.hud.statusLabel', { name: who }) + (buff || debuff ? ` ${t('battleui.effects.balance', { buff, debuff })}` : ''))
    fold()
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
    setBoss(info) {
      p.el.classList.toggle('is-boss', info !== null)
      bossBox.hidden = info === null
      if (!info) { bossBox.replaceChildren(); return }
      const pips = el('span', 'apb-boss-pips', Array.from({ length: info.phases }, (_, i) => el('span', `apb-pip${i < info.phase ? ' is-on' : ''}`)))
      pips.title = t('battleui.boss.phase', { n: info.phase })
      const title = el('span', { class: 'apb-boss-title', text: info.title })
      let readoutTimer = 0
      const readout = (text: string) => {
        title.textContent = text
        title.classList.add('is-readout')
        clearTimeout(readoutTimer)
        readoutTimer = window.setTimeout(() => { title.textContent = info.title; title.classList.remove('is-readout') }, H.meterReadoutMs)
      }
      const head = el('div', 'apb-boss-head', [el('span', { class: 'apb-boss-tag', text: t('battleui.boss.tag') }), title, pips])
      const tiles = info.chips.map((c) => meterTile(c, readout))
      bossBox.replaceChildren(head, ...(tiles.length ? [el('div', 'apb-boss-tiles', tiles)] : []))
    },
    pulseBoss() {
      bossBox.classList.remove('is-pulse')
      void bossBox.offsetWidth
      bossBox.classList.add('is-pulse')
    },
  }
}
