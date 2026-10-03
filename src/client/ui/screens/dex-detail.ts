// Dex detail page: sprite with shiny toggle, names, company / country / release / category, types, rarity,
// base-stat bars + radar, evolution chain, habitats, dex entry, cry. Seen-but-not-caught entries show the
// silhouette data only. ↑/↓ browse, ←/→ shiny, confirm = cry. Resolves the index the player ended on.
import type { SpeciesDef } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { button, el, rarityBadge, statRadar, typeChip } from '../widgets.ts'
import { backPressed, frame, infoRow, openScreen, pressed, sectionTitle, sfx, textOrKey, uiSfx, type ScreenEnv, setChildren , arrowButton } from './base.ts'
import { SCREENS } from './config.ts'
import { dexState, evolutionChain, statKeys } from './logic.ts'
import { creatureImg } from './sprites.ts'

const pad3 = (n: number) => String(n).padStart(3, '0')

export function dexDetailScreen(env: ScreenEnv, list: SpeciesDef[], start: number): Promise<number> {
  const { ctx } = env
  const cfg = SCREENS.dex
  return openScreen<number>(env, 'aps-dexd', (api) => {
    let index = Math.max(0, Math.min(list.length - 1, start))
    let shiny = false
    const f = frame(env, { title: '', glyph: 'dex', onClose: api.guard(() => api.close(index)) })
    const prev = arrowButton('left', t('screens.dex.prev'), api.guard(() => go(-1)))
    const next = arrowButton('right', t('screens.dex.next'), api.guard(() => go(1)))
    if (list.length > 1) f.right.append(prev, next)
    const left = el('div', 'aps-dexd-left ap-panel')
    const mid = el('div', 'aps-dexd-mid ap-panel')
    const right = el('div', 'aps-dexd-right ap-panel')
    f.body.append(el('div', 'aps-dexd-layout', [left, mid, right]))
    api.root.append(f.el)

    const render = () => {
      const sp = list[index]
      if (!sp) return
      const caught = dexState(ctx.save, sp.id) === 'caught'
      if (!caught) shiny = false
      f.setTitle(t('screens.dex.detailTitle', { n: pad3(sp.dexNo), name: sp.nameZh }))
      const cryBtn = button(t('screens.dex.cry'), api.guard(() => cry()), { className: 'aps-small-btn' })
      const shinyBtn = button(t(shiny ? 'screens.dex.shinyOn' : 'screens.dex.shinyOff'), api.guard(() => toggleShiny()), { className: `aps-small-btn${shiny ? ' is-on' : ''}` })
      shinyBtn.disabled = !caught
      left.replaceChildren(
        el('div', 'aps-dexd-stage', [el('div', 'aps-sum-pedestal'), creatureImg(ctx.assets, sp.id, { shiny, silhouette: !caught, className: 'aps-dexd-sprite' })]),
        el('div', { class: 'aps-dexd-name', text: sp.nameZh }),
        el('div', { class: 'ap-dim aps-dexd-en', text: sp.nameEn }),
        el('div', 'aps-chips', [...sp.types.map((ty) => typeChip(ty)), rarityBadge(sp.rarity, { label: 'name' })]),
        el('div', 'aps-dexd-btns', [cryBtn, shinyBtn]),
      )
      const habitats = el('div', 'aps-chips', sp.habitats.map((b) => el('span', { class: 'aps-tag', text: CONTENT.biomeById[b]?.nameZh ?? b })))
      setChildren(mid, [
        sectionTitle(t('screens.dex.profile')),
        infoRow(t('screens.dex.company'), sp.company),
        infoRow(t('screens.dex.countryLabel'), textOrKey(`screens.country.${sp.country}`)),
        infoRow(t('screens.dex.release'), sp.releaseDate),
        infoRow(t('screens.dex.category'), textOrKey(`screens.category.${sp.category}`)),
        infoRow(t('screens.dex.habitat'), habitats),
        sectionTitle(t('screens.dex.entry')),
        caught ? el('p', { class: 'aps-dexd-entry', text: sp.dexEntry }) : el('p', { class: 'aps-dexd-entry ap-dim', text: t('screens.dex.lockedEntry') }),
        caught ? el('p', 'aps-dexd-persona', [el('span', { class: 'ap-gold', text: t('screens.starter.personality') }), sp.personality]) : null,
      ])
      right.replaceChildren(sectionTitle(t('screens.dex.baseStats')), caught ? statsBlock(sp) : el('p', { class: 'ap-dim', text: t('screens.dex.lockedStats') }), sectionTitle(t('screens.dex.evolution')), evoBlock(sp))
      f.setHints([['ud', t('screens.dex.hint.browse')], ...(caught ? [['lr', t('screens.dex.hint.shiny')] as ['lr', string]] : []), ['confirm', t('screens.dex.hint.cry')], ['cancel', t('screens.hint.back')]])
    }

    const statsBlock = (sp: SpeciesDef): HTMLElement => {
      const keys = statKeys()
      const total = keys.reduce((s, k) => s + sp.baseStats[k], 0)
      const bars = keys.map((k) => el('div', 'aps-bstat', [
        el('span', { class: 'aps-bstat-k', text: CONTENT.statByKey[k]?.nameZh ?? k }),
        el('span', { class: 'aps-bstat-v', text: String(sp.baseStats[k]) }),
        el('span', { class: 'aps-bstat-bar', vars: { '--p': Math.min(1, sp.baseStats[k] / cfg.statBarMax) } }),
      ]))
      const radar = statRadar(sp.baseStats, Math.max(...keys.map((k) => sp.baseStats[k]), 1), { size: cfg.radarSize, values: false })
      return el('div', 'aps-bstats', [
        el('div', 'aps-bstat-list', [...bars, el('div', 'aps-bstat is-total', [el('span', { class: 'aps-bstat-k', text: t('screens.dex.total') }), el('span', { class: 'aps-bstat-v ap-gold', text: String(total) })])]),
        radar.el,
      ])
    }

    const evoBlock = (sp: SpeciesDef): HTMLElement => {
      const chain = evolutionChain(sp.id)
      if (chain.length < 2) return el('p', { class: 'ap-dim', text: t('screens.dex.noEvolution') })
      const parts: HTMLElement[] = []
      chain.forEach((s, i) => {
        if (i > 0) {
          const lv = chain[i - 1].evolvesTo?.level
          parts.push(el('div', 'aps-evo-arrow', [el('span', { text: lv ? t('screens.common.level', { level: lv }) : '' })]))
        }
        const st = dexState(ctx.save, s.id)
        parts.push(el('div', `aps-evo-node${s.id === sp.id ? ' is-current' : ''}`, [
          st === 'unseen' ? el('span', { class: 'aps-dex-unknown', text: t('screens.dex.unknownMark') }) : creatureImg(ctx.assets, s.id, { silhouette: st === 'seen', className: 'aps-evo-sprite' }),
          el('span', { class: 'aps-evo-name', text: st === 'unseen' ? t('screens.dex.unknownName') : s.nameZh }),
        ]))
      })
      return el('div', 'aps-evo', parts)
    }

    const cry = () => { const sp = list[index]; if (sp) ctx.audio.playCry(sp.id) }
    const toggleShiny = () => {
      const sp = list[index]
      if (!sp || dexState(ctx.save, sp.id) !== 'caught') { uiSfx(env, 'error'); return }
      shiny = !shiny
      sfx(env, 'shiny')
      render()
    }
    const go = (d: number) => {
      if (list.length < 2) return
      index = (index + d + list.length) % list.length
      uiSfx(env, 'move')
      render()
      if (cfg.cryOnOpen) cry()
    }

    render()
    if (cfg.cryOnOpen) cry()
    return {
      onInput(input) {
        if (backPressed(input)) { api.close(index); return }
        if (pressed(input, 'up', true)) go(-1)
        else if (pressed(input, 'down', true)) go(1)
        else if (pressed(input, 'left') || pressed(input, 'right')) toggleShiny()
        else if (pressed(input, 'confirm')) cry()
      },
    }
  })
}
