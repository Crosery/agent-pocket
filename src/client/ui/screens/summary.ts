// Creature summary: portrait column (sprite, level, types, HP/EXP) + tabbed pages from content/screens.json:
// info (dex/OT/catch data), stats (values, IV stars, radar, EXP to next), moves (detail + reorder), ability
// (description + defensive type matchups). ←/→ pages, ↑/↓ cycles creatures (selects moves on the moves page).
import type { Creature, MoveDef } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { calcStats, creatureName, maxHp } from '../../../shared/creature.ts'
import { getMap } from '../../../shared/world/worldapi.ts'
import { button, el, expBar, hpBar, rarityBadge, statRadar, statusChip, tabs, typeChip } from '../widgets.ts'
import { backPressed, frame, icon, infoRow, meterIcons, openScreen, pressed, sectionTitle, sfx, textOrKey, uiSfx, type ScreenEnv, setChildren , arrowButton } from './base.ts'
import { SCREENS } from './config.ts'
import { defensiveProfile, expProgress, ivStars, statKeys } from './logic.ts'
import { creatureImg } from './sprites.ts'

export function moveDetail(m: MoveDef | undefined, pp?: { pp: number; ppMax: number }): HTMLElement {
  if (!m) return el('div', 'aps-move-detail')
  const acc = m.accuracy === 0 ? t('screens.move.never') : String(m.accuracy)
  const power = m.power > 0 ? String(m.power) : t('screens.move.none')
  return el('div', 'aps-move-detail', [
    el('div', 'aps-move-dhead', [typeChip(m.type), el('span', { class: `aps-cat is-${m.category}`, text: t(`screens.move.category.${m.category}`), vars: { '--cat': SCREENS.moveCategoryColors[m.category] } }), el('span', { class: 'aps-move-dname', text: m.nameZh })]),
    el('div', 'aps-move-stats', [
      infoRow(t('screens.move.power'), power),
      infoRow(t('screens.move.accuracy'), acc),
      infoRow(t('screens.move.pp'), pp ? t('screens.move.ppValue', { pp: pp.pp, max: pp.ppMax }) : String(m.pp)),
      m.priority ? infoRow(t('screens.move.priority'), t(m.priority > 0 ? 'screens.move.priorityUp' : 'screens.move.priorityDown', { n: Math.abs(m.priority) })) : null,
    ]),
    el('p', { class: 'aps-move-desc', text: m.description }),
  ])
}

/** Type chips grouped by defensive multiplier. */
export function matchupBlock(types: readonly string[]): HTMLElement {
  const groups = defensiveProfile(types)
  const box = el('div', 'aps-matchups')
  if (!groups.length) box.append(el('div', { class: 'ap-dim', text: t('screens.summary.matchNone') }))
  for (const g of groups) {
    const label = g.mul === 0 ? t('screens.summary.matchImmune') : g.mul > 1 ? t('screens.summary.matchWeak', { mul: g.mul }) : t('screens.summary.matchResist', { mul: g.mul })
    box.append(el('div', `aps-match-row ${g.mul > 1 ? 'is-weak' : 'is-resist'}`, [el('span', { class: 'aps-match-k', text: label }), el('span', 'aps-chips', g.types.map((ty) => typeChip(ty)))]))
  }
  return box
}

export function summaryScreen(env: ScreenEnv, list: Creature[], start: number): Promise<void> {
  const { ctx } = env
  const pages = SCREENS.summary.pages
  return openScreen<void>(env, 'aps-summary', (api) => {
    let index = Math.max(0, Math.min(list.length - 1, start))
    let page = 0
    let moveIndex = 0
    let moveSwap = -1
    let dirty = false
    const cur = () => list[index]

    const prevBtn = arrowButton('left', t('screens.summary.prev'), api.guard(() => switchCreature(-1)))
    const nextBtn = arrowButton('right', t('screens.summary.next'), api.guard(() => switchCreature(1)))
    const counter = el('span', 'aps-counter')
    const f = frame(env, { title: t('screens.summary.title'), onClose: api.guard(() => back()) })
    if (list.length > 1) f.right.append(prevBtn, counter, nextBtn)
    const left = el('div', 'aps-sum-left ap-panel')
    const tabBar = tabs(pages.map((p) => t(p.label)), { audio: ctx.audio, onChange: (i) => { page = i; moveSwap = -1; renderPage() } })
    const pageEl = el('div', 'aps-sum-page')
    const right = el('div', 'aps-sum-right', [tabBar.el, el('div', 'aps-sum-pagewrap ap-panel', [pageEl])])
    f.body.append(el('div', 'aps-sum-layout', [left, right]))
    api.root.append(f.el)

    const renderLeft = () => {
      const c = cur()
      const sp = CONTENT.species[c.speciesId]
      const hp = hpBar({ numbers: true, label: t('screens.common.hp') })
      hp.set(c.hp, maxHp(c))
      const prog = expProgress(c)
      const exp = expBar({ label: t('screens.common.exp') })
      exp.set(prog.into, prog.need)
      setChildren(left, [
        el('div', 'aps-sum-stage', [el('div', 'aps-sum-pedestal'), creatureImg(ctx.assets, c.speciesId, { shiny: c.shiny, className: 'aps-sum-sprite' }), c.shiny ? icon('shine', { className: 'aps-sum-shine' }) : null]),
        el('div', 'aps-sum-name', [
          el('span', { class: 'ap-model-name', text: creatureName(c), title: creatureName(c), attrs: { 'aria-label': creatureName(c) } }),
          el('span', { class: 'aps-party-lv', text: t('screens.common.level', { level: c.level }) }),
        ]),
        c.nickname && sp ? el('div', { class: 'ap-dim ap-model-name aps-sum-species', text: sp.nameZh, title: sp.nameZh }) : null,
        el('div', 'aps-chips', [...(sp?.types ?? []).map((ty) => typeChip(ty)), sp ? rarityBadge(sp.rarity, { label: 'name' }) : null, c.status ? statusChip(c.status) : null]),
        hp.el,
        exp.el,
        el('div', { class: 'aps-sum-tonext ap-dim', text: prog.max ? t('screens.summary.maxLevel') : t('screens.summary.toNext', { n: prog.toNext }) }),
      ])
      counter.textContent = t('screens.summary.counter', { i: index + 1, n: list.length })
    }

    const infoPage = (c: Creature): HTMLElement[] => {
      const sp = CONTENT.species[c.speciesId]
      const ball = CONTENT.items[c.ballId]
      const caught = c.caughtMap ? getMap(ctx.data.world, c.caughtMap)?.nameZh : undefined
      const fs = SCREENS.summary
      const hearts = Math.round((Math.min(fs.friendshipMax, c.friendship) / fs.friendshipMax) * fs.friendshipHearts)
      return [
        infoRow(t('screens.summary.dexNo'), sp ? t('screens.common.dexNo', { n: String(sp.dexNo).padStart(3, '0') }) : t('screens.common.dash')),
        infoRow(t('screens.summary.species'), sp ? t('screens.common.nameBoth', { zh: sp.nameZh, en: sp.nameEn }) : c.speciesId),
        infoRow(t('screens.summary.company'), sp ? t('screens.common.companyCountry', { company: sp.company, country: textOrKey(`screens.country.${sp.country}`) }) : t('screens.common.dash')),
        infoRow(t('screens.summary.ot'), t('screens.summary.otValue', { name: c.otName || t('screens.common.dash'), id: (c.otId || '').slice(0, 6).toUpperCase() || t('screens.common.dash') })),
        infoRow(t('screens.summary.caughtAt'), caught ?? t('screens.summary.unknownPlace')),
        infoRow(t('screens.summary.ball'), ball ? [el('img', { class: 'aps-inline-icon', attrs: { src: ctx.assets.itemIconUrl(ball.id), alt: '' } }), ball.nameZh] : t('screens.common.dash')),
        infoRow(t('screens.summary.friendship'), meterIcons(hearts, fs.friendshipHearts, 'heart', 'heartOff')),
        infoRow(t('screens.summary.personality'), sp?.personality ?? t('screens.common.dash')),
        infoRow(t('screens.summary.held'), c.heldItem && CONTENT.items[c.heldItem] ? CONTENT.items[c.heldItem].nameZh : t('screens.summary.none')),
      ]
    }

    const statsPage = (c: Creature): HTMLElement[] => {
      const stats = calcStats(c)
      const keys = statKeys()
      const top = Math.max(1, ...keys.map((k) => stats[k]))
      const radar = statRadar(stats, top, { size: SCREENS.summary.radarSize, values: false })
      const ivMax = CONTENT.config.creature.ivMax
      const rows = keys.map((k) => el('div', 'aps-stat-row', [
        el('span', { class: 'aps-stat-k', text: CONTENT.statByKey[k]?.nameZh ?? k, title: CONTENT.statByKey[k]?.desc }),
        el('span', { class: 'aps-stat-v', text: k === 'hp' ? t('screens.summary.hpValue', { hp: c.hp, max: stats.hp }) : String(stats[k]) }),
        meterIcons(ivStars(c.ivs[k] ?? 0, ivMax, SCREENS.summary.ivStars), SCREENS.summary.ivStars, 'star', 'starOff'),
      ]))
      return [el('div', 'aps-stats-layout', [el('div', 'aps-stat-table', [el('div', 'aps-stat-row is-head', [el('span', { text: t('screens.summary.stat') }), el('span', { text: t('screens.summary.value') }), el('span', { text: t('screens.summary.potential') })]), ...rows]), radar.el])]
    }

    let moveRows: HTMLElement[] = []
    const movesPage = (c: Creature): HTMLElement[] => {
      moveIndex = Math.min(moveIndex, Math.max(0, c.moves.length - 1))
      moveRows = c.moves.map((slot, i) => {
        const m = CONTENT.moves[slot.id]
        const row = el('div', { class: `aps-move-row ap-row ap-cursor-host${i === moveIndex ? ' is-active' : ''}${i === moveSwap ? ' is-swap' : ''}`, attrs: { role: 'option' } }, [
          m ? typeChip(m.type) : null,
          el('span', { class: 'ap-row-label', text: m?.nameZh ?? slot.id }),
          el('span', { class: 'ap-row-sub', text: t('screens.move.ppValue', { pp: slot.pp, max: slot.ppMax }) }),
        ])
        row.addEventListener('mouseenter', api.guard(() => { if (moveIndex !== i) { moveIndex = i; uiSfx(env, 'move'); renderPage() } }))
        row.addEventListener('click', api.guard(() => { moveIndex = i; moveConfirm() }))
        return row
      })
      const slot = c.moves[moveIndex]
      return [
        el('div', { class: 'aps-move-list', attrs: { role: 'listbox' } }, moveRows.length ? moveRows : [el('div', { class: 'ap-dim', text: t('screens.summary.noMoves') })]),
        moveDetail(slot ? CONTENT.moves[slot.id] : undefined, slot),
        el('div', { class: 'aps-sum-tip ap-dim', text: moveSwap >= 0 ? t('screens.summary.reorderHint') : t('screens.summary.reorderTip') }),
      ]
    }

    const abilityPage = (c: Creature): HTMLElement[] => {
      const ab = CONTENT.abilities[c.abilityId]
      const sp = CONTENT.species[c.speciesId]
      return [
        sectionTitle(t('screens.summary.ability')),
        el('div', 'aps-ability', [el('div', { class: 'aps-ability-name ap-gold', text: ab?.nameZh ?? t('screens.common.dash') }), el('p', { class: 'aps-ability-desc', text: ab?.description ?? '' })]),
        sectionTitle(t('screens.summary.matchups')),
        matchupBlock(sp?.types ?? []),
      ]
    }

    const renderPage = () => {
      const c = cur()
      const id = pages[page]?.id
      pageEl.dataset.page = id ?? ''
      pageEl.replaceChildren(...(id === 'info' ? infoPage(c) : id === 'stats' ? statsPage(c) : id === 'moves' ? movesPage(c) : abilityPage(c)))
      f.setHints([
        ['lr', t('screens.hint.pages')],
        id === 'moves' ? ['ud', t('screens.summary.hint.moves')] : ['ud', t('screens.summary.hint.creatures')],
        ...(id === 'moves' ? [['confirm', moveSwap >= 0 ? t('screens.summary.hint.swapHere') : t('screens.summary.hint.reorder')] as ['confirm', string]] : []),
        ['cancel', t('screens.hint.back')],
      ])
    }
    const render = () => { renderLeft(); renderPage() }

    const switchCreature = (d: number) => {
      if (list.length < 2) return
      index = (index + d + list.length) % list.length
      moveSwap = -1
      moveIndex = 0
      uiSfx(env, 'move')
      ctx.audio.playCry(cur().speciesId)
      render()
    }
    const moveConfirm = () => {
      const c = cur()
      if (c.moves.length < 2) return
      if (moveSwap < 0) { moveSwap = moveIndex; sfx(env, 'pick') }
      else {
        if (moveSwap !== moveIndex) {
          ;[c.moves[moveSwap], c.moves[moveIndex]] = [c.moves[moveIndex], c.moves[moveSwap]]
          dirty = true
          ctx.events.emit('party:changed', {})
        }
        moveSwap = -1
        sfx(env, 'drop')
      }
      renderPage()
    }
    const back = () => {
      if (moveSwap >= 0) { moveSwap = -1; uiSfx(env, 'cancel'); renderPage(); return }
      if (dirty) ctx.persist('summary')
      api.close()
    }

    render()
    ctx.audio.playCry(cur().speciesId)
    return {
      onInput(input) {
        if (backPressed(input)) { back(); return }
        const onMoves = pages[page]?.id === 'moves'
        if (pressed(input, 'left', true)) { tabBar.prev(); return }
        if (pressed(input, 'right', true)) { tabBar.next(); return }
        if (pressed(input, 'up', true)) {
          if (onMoves) { const n = cur().moves.length; if (n) { moveIndex = (moveIndex - 1 + n) % n; uiSfx(env, 'move'); renderPage() } } else switchCreature(-1)
          return
        }
        if (pressed(input, 'down', true)) {
          if (onMoves) { const n = cur().moves.length; if (n) { moveIndex = (moveIndex + 1) % n; uiSfx(env, 'move'); renderPage() } } else switchCreature(1)
          return
        }
        if (pressed(input, 'confirm') && onMoves) moveConfirm()
      },
    }
  })
}
