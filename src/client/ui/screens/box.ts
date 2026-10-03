// Storage boxes: config.party.boxCount boxes of boxSize slots + the party column. Pick up / place / swap between
// any slots (party must keep at least one conscious creature), summary, release. Box header switches boxes.
import type { Creature } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { creatureName, maxHp } from '../../../shared/creature.ts'
import { button, creatureIcon, el, hpBar, rarityBadge, statusChip, typeChip } from '../widgets.ts'
import { backPressed, frame, isCompact, openScreen, popupMenu, pressed, sfx, uiSfx, type ScreenEnv, setChildren , arrowButton } from './base.ts'
import { SCREENS } from './config.ts'
import { creatureAt, moveCreature, releaseCreature, type Slot } from './logic.ts'
import { creatureImg } from './sprites.ts'

type Zone = 'party' | 'head' | 'box'

let lastBox = 0

export function boxScreen(env: ScreenEnv): Promise<void> {
  const { ctx } = env
  const P = CONTENT.config.party
  const cols = SCREENS.box.cols
  const rows = Math.ceil(P.boxSize / cols)
  return openScreen<void>(env, 'aps-box', (api) => {
    const save = ctx.save
    while (save.boxes.length < P.boxCount) save.boxes.push([])
    let box = Math.min(lastBox, P.boxCount - 1)
    let zone: Zone = 'box'
    let pIndex = 0
    let bIndex = 0
    let held: Slot | null = null
    let dirty = false

    const total = el('div', 'aps-box-total')
    const f = frame(env, { title: t('screens.box.title'), glyph: 'party', onClose: api.guard(() => back()) })
    f.right.append(total)
    const partyCells = Array.from({ length: P.maxParty }, (_, i) => {
      const c = el('button', { class: 'aps-box-pslot', attrs: { type: 'button' } })
      c.addEventListener('mouseenter', api.guard(() => { if (zone !== 'party' || pIndex !== i) { zone = 'party'; pIndex = i; uiSfx(env, 'move'); paint() } }))
      c.addEventListener('click', api.guard(() => { zone = 'party'; pIndex = i; paint(); void activate() }))
      return c
    })
    const boxCells = Array.from({ length: P.boxSize }, (_, i) => {
      const c = el('button', { class: 'aps-box-cell', attrs: { type: 'button' } })
      c.addEventListener('mouseenter', api.guard(() => { if (zone !== 'box' || bIndex !== i) { zone = 'box'; bIndex = i; uiSfx(env, 'move'); paint() } }))
      c.addEventListener('click', api.guard(() => { zone = 'box'; bIndex = i; paint(); void activate() }))
      return c
    })
    const prevBtn = arrowButton('left', t('screens.box.prev'), api.guard(() => switchBox(-1)))
    const nextBtn = arrowButton('right', t('screens.box.next'), api.guard(() => switchBox(1)))
    const boxName = el('div', 'aps-box-name')
    const head = el('div', 'aps-box-head', [prevBtn, boxName, nextBtn])
    head.addEventListener('mouseenter', api.guard(() => { if (zone !== 'head') { zone = 'head'; paint() } }))
    const grid = el('div', { class: 'aps-box-grid', vars: { '--cols': cols, '--rows': rows }, attrs: { role: 'grid' } }, boxCells)
    const partyCol = el('div', 'aps-box-party ap-panel', [el('div', { class: 'aps-sec', text: t('screens.box.party') }), el('div', 'aps-box-plist', partyCells)])
    const main = el('div', 'aps-box-main', [head, grid])
    const side = el('div', 'aps-box-side ap-panel')
    f.body.append(el('div', 'aps-box-layout', [partyCol, main, side]))
    api.root.append(f.el)

    const curSlot = (): Slot => (zone === 'party' ? { area: 'party', box, index: pIndex } : { area: 'box', box, index: bIndex })
    const sameSlot = (a: Slot | null, b: Slot) => !!a && a.area === b.area && a.index === b.index && (a.area === 'party' || a.box === b.box)

    const fill = (cell: HTMLElement, c: Creature | undefined, slot: Slot, withName: boolean) => {
      cell.classList.toggle('is-empty', !c)
      cell.classList.toggle('is-held', sameSlot(held, slot))
      cell.classList.toggle('is-fainted', !!c && c.hp <= 0)
      cell.setAttribute('aria-label', c ? creatureName(c) : t('screens.box.emptySlot'))
      setChildren(cell, c ? [
        creatureIcon(ctx.assets.creatureImageUrl(c.speciesId), c.shiny, withName ? SCREENS.box.partyIconSize : SCREENS.box.cellIconSize),
        withName ? el('span', 'aps-box-pinfo', [el('span', { class: 'aps-box-pname', text: creatureName(c) }), el('span', { class: 'aps-party-lv', text: t('screens.common.level', { level: c.level }) })]) : null,
      ] : [])
    }

    const paint = () => {
      const wp = SCREENS.box.wallpapers[box % SCREENS.box.wallpapers.length]
      grid.style.setProperty('--wp1', wp[0])
      grid.style.setProperty('--wp2', wp[1])
      const items = save.boxes[box] ?? []
      boxName.textContent = t('screens.box.name', { n: box + 1, count: items.length, size: P.boxSize })
      head.classList.toggle('is-active', zone === 'head')
      partyCells.forEach((cell, i) => {
        fill(cell, save.party[i], { area: 'party', box, index: i }, !isCompact())
        cell.classList.toggle('is-active', zone === 'party' && i === pIndex)
      })
      boxCells.forEach((cell, i) => {
        fill(cell, items[i], { area: 'box', box, index: i }, false)
        cell.classList.toggle('is-active', zone === 'box' && i === bIndex)
      })
      const stored = save.boxes.reduce((s, b) => s + b.length, 0)
      total.textContent = t('screens.box.total', { n: stored, max: P.boxCount * P.boxSize })
      paintSide()
      f.setHints(held
        ? [['confirm', t('screens.box.hint.place')], ['cancel', t('screens.box.hint.putBack')]]
        : zone === 'head'
          ? [['lr', t('screens.box.hint.switchBox')], ['down', t('screens.box.hint.toBox')], ['cancel', t('screens.hint.back')]]
          : [['confirm', t('screens.hint.select')], ['up', t('screens.box.hint.toHead')], ['cancel', t('screens.hint.back')]])
    }

    const paintSide = () => {
      const show = zone === 'head' ? undefined : creatureAt(save, curSlot())
      const heldC = held ? creatureAt(save, held) : undefined
      const parts: (HTMLElement | null)[] = []
      if (heldC) parts.push(el('div', 'aps-box-holding', [el('span', { class: 'ap-gold', text: t('screens.box.holding') }), creatureIcon(ctx.assets.creatureImageUrl(heldC.speciesId), heldC.shiny, SCREENS.box.partyIconSize), el('span', { text: creatureName(heldC) })]))
      if (show) {
        const sp = CONTENT.species[show.speciesId]
        const bar = hpBar({ numbers: true })
        bar.set(show.hp, maxHp(show))
        parts.push(
          el('div', 'aps-box-stage', [el('div', 'aps-sum-pedestal'), creatureImg(ctx.assets, show.speciesId, { shiny: show.shiny, className: 'aps-box-sprite' })]),
          el('div', 'aps-sum-name', [el('span', { text: creatureName(show) }), el('span', { class: 'aps-party-lv', text: t('screens.common.level', { level: show.level }) })]),
          el('div', 'aps-chips', [...(sp?.types ?? []).map((ty) => typeChip(ty)), sp ? rarityBadge(sp.rarity) : null, show.status ? statusChip(show.status) : null]),
          bar.el,
        )
      } else if (!heldC) parts.push(el('div', { class: 'aps-empty', text: zone === 'head' ? t('screens.box.headNote') : t('screens.box.emptySlot') }))
      setChildren(side, parts)
    }

    const switchBox = (d: number) => {
      box = (box + d + P.boxCount) % P.boxCount
      lastBox = box
      uiSfx(env, 'move')
      paint()
    }

    const place = (target: Slot) => {
      if (!held) return
      const err = moveCreature(save, held, target)
      if (err) { sfx(env, 'error'); ctx.ui.toast(t(err), 'warn'); return }
      held = null
      dirty = true
      sfx(env, 'drop')
      ctx.events.emit('party:changed', {})
      paint()
    }

    const activate = () => api.run(async () => {
      if (zone === 'head') return
      const slot = curSlot()
      if (held) { place(slot); return }
      const c = creatureAt(save, slot)
      if (!c) return
      const anchor = zone === 'party' ? partyCells[pIndex] : boxCells[bIndex]
      const menu = SCREENS.box.menu
      const pick = await popupMenu(env, menu.map((m) => ({ label: t(m.label) })), { anchor, title: creatureName(c) })
      const id = menu[pick]?.id
      if (id === 'move') { held = slot; sfx(env, 'pick'); paint() }
      else if (id === 'summary') {
        const list = slot.area === 'party' ? save.party : save.boxes[box]
        await env.internal.summaryOf(list, slot.index)
        paint()
      } else if (id === 'release') {
        const name = creatureName(c)
        if (!await ctx.ui.confirm(t('screens.box.releaseConfirm', { name }))) return
        if (!await ctx.ui.confirm(t('screens.box.releaseConfirm2', { name }))) return
        const err = releaseCreature(save, slot)
        if (err) { sfx(env, 'error'); ctx.ui.toast(t(err), 'warn'); return }
        dirty = true
        sfx(env, 'release')
        ctx.events.emit('party:changed', {})
        ctx.ui.toast(t('screens.box.released', { name }), 'info')
        paint()
      }
    })

    const back = () => {
      if (held) { held = null; uiSfx(env, 'cancel'); paint(); return }
      lastBox = box
      if (dirty) ctx.persist('box')
      api.close()
    }

    const moveIn = (dx: number, dy: number) => {
      const compact = isCompact()
      if (zone === 'head') {
        if (dx) { switchBox(dx); return }
        if (dy > 0) { zone = 'box'; bIndex = Math.min(bIndex % cols, P.boxSize - 1) }
        else if (compact) { zone = 'party' }
        else return
      } else if (zone === 'party') {
        if (compact) {
          if (dx) pIndex = (pIndex + dx + P.maxParty) % P.maxParty
          else if (dy > 0) zone = 'head'
          else return
        } else {
          if (dy) pIndex = (pIndex + dy + P.maxParty) % P.maxParty
          else if (dx > 0) { zone = 'box'; bIndex = Math.min(P.boxSize - 1, Math.min(rows - 1, pIndex) * cols) }
          else return
        }
      } else {
        const col = bIndex % cols
        const row = Math.floor(bIndex / cols)
        if (dx < 0 && col === 0) {
          if (compact) bIndex = Math.min(P.boxSize - 1, row * cols + cols - 1)
          else { zone = 'party'; pIndex = Math.min(P.maxParty - 1, row) }
        } else if (dx > 0 && col === cols - 1) bIndex = row * cols
        else if (dx) bIndex = Math.min(P.boxSize - 1, bIndex + dx)
        else if (dy < 0 && row === 0) zone = 'head'
        else if (dy > 0 && row === rows - 1) bIndex = col
        else if (dy) bIndex = Math.min(P.boxSize - 1, bIndex + dy * cols)
      }
      uiSfx(env, 'move')
      paint()
    }

    paint()
    return {
      onInput(input) {
        if (backPressed(input)) { back(); return }
        if (pressed(input, 'left', true)) moveIn(-1, 0)
        else if (pressed(input, 'right', true)) moveIn(1, 0)
        else if (pressed(input, 'up', true)) moveIn(0, -1)
        else if (pressed(input, 'down', true)) moveIn(0, 1)
        else if (pressed(input, 'confirm')) void activate()
      },
    }
  })
}
