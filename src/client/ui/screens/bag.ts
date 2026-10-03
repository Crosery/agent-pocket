// Bag: category tabs (content/screens.json -> ItemCategory), item list with icons and counts, detail pane.
// field: use (item-use.ts) / toss; battle: resolves { itemId, partyIndex? } for items usable in battle.
import type { ItemDef } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { createRowMenu, type RowMenu } from '../menu.ts'
import { el, tabs } from '../widgets.ts'
import { backPressed, frame, infoRow, isCompact, keepTabVisible, moneyEl, openScreen, popupMenu, pressed, quantityPicker, sfx, type ScreenEnv, setChildren } from './base.ts'
import { SCREENS } from './config.ts'
import { addItem, bagEntries, needsTarget, teachState, type BagEntry } from './logic.ts'
import { pickBattleTarget, useItemInField } from './item-use.ts'
import { moveDetail } from './summary.ts'

export type BagResult = { itemId: string; partyIndex?: number } | null

const lastTab: Record<'field' | 'battle', string> = { field: '', battle: '' }

export function bagScreen(env: ScreenEnv, mode: 'field' | 'battle'): Promise<BagResult> {
  const { ctx } = env
  const tabDefs = SCREENS.bag.tabs.filter((tb) => mode === 'field' || tb.battle)
  return openScreen<BagResult>(env, `aps-bag is-${mode}`, (api) => {
    let tabIndex = Math.max(0, tabDefs.findIndex((tb) => tb.id === lastTab[mode]))
    let entries: BagEntry[] = []
    let menu: RowMenu | null = null
    let dirty = false
    const money = el('div', 'aps-head-money')
    const f = frame(env, { title: t(`screens.bag.title.${mode}`), glyph: 'bag', onClose: api.guard(() => close(null)) })
    f.right.append(money)
    const tabBar = tabs(tabDefs.map((tb) => t(tb.label)), { initial: tabIndex, audio: ctx.audio, className: 'aps-tabs-scroll', onChange: (i) => { tabIndex = i; lastTab[mode] = tabDefs[i].id; keepTabVisible(tabBar.el, i); rebuild(0) } })
    const listBox = el('div', 'aps-bag-list ap-panel')
    const detail = el('div', 'aps-bag-detail ap-panel')
    f.body.append(el('div', 'aps-bag-layout', [el('div', 'aps-bag-left', [tabBar.el, listBox]), detail]))
    f.setHints([['lr', t('screens.hint.tabs')], ['ud', t('screens.hint.choose')], ['confirm', t(`screens.bag.hint.${mode}`)], ['cancel', t('screens.hint.back')]])
    api.root.append(f.el)

    const close = (v: BagResult) => {
      if (dirty) ctx.persist('bag')
      api.close(v)
    }

    const rebuild = (keepIndex: number) => {
      entries = bagEntries(ctx.save, tabDefs[tabIndex], mode)
      const rows = isCompact() ? SCREENS.bag.compactVisibleRows : SCREENS.bag.visibleRows
      menu = createRowMenu(entries.map((e) => ({ label: e.item.nameZh, sub: t('screens.bag.qty', { n: e.qty }), icon: ctx.assets.itemIconUrl(e.item.id) })), {
        visibleRows: rows,
        initial: Math.min(keepIndex, Math.max(0, entries.length - 1)),
        wrap: true,
        audio: ctx.audio,
        onChange: (i) => paintDetail(i),
        onPick: api.guard((i: number) => void activate(i)),
      })
      menu.el.style.setProperty('--rows', String(rows))
      listBox.replaceChildren(menu.el)
      money.replaceChildren(moneyEl(ctx.save.money))
      paintDetail(menu.index)
    }

    const paintDetail = (i: number) => {
      const e = entries[i]
      if (!e) {
        detail.replaceChildren(el('div', { class: 'aps-empty', text: t('screens.bag.emptyTab') }))
        return
      }
      const it = e.item
      const cat = t(`items.category.${it.category}`)
      const parts: (HTMLElement | null)[] = [
        el('div', 'aps-item-head', [
          el('div', 'aps-item-icon', [el('img', { attrs: { src: ctx.assets.itemIconUrl(it.id), alt: '', draggable: 'false' } })]),
          el('div', 'aps-item-title', [el('div', { class: 'aps-item-name ap-gold', text: it.nameZh }), el('div', { class: 'ap-dim', text: cat })]),
        ]),
        el('p', { class: 'aps-item-desc', text: it.description }),
        infoRow(t('screens.bag.owned'), t('screens.bag.qty', { n: e.qty })),
      ]
      if (it.effect.kind === 'chip') parts.push(chipBlock(it))
      setChildren(detail, parts)
    }

    const chipBlock = (it: ItemDef): HTMLElement | null => {
      if (it.effect.kind !== 'chip') return null
      const m = CONTENT.moves[it.effect.move]
      const party = ctx.save.party.map((c) => {
        const s = teachState(c, it.effect.kind === 'chip' ? it.effect.move : '')
        return el('div', `aps-teach is-${s}`, [
          el('img', { class: 'aps-teach-icon', attrs: { src: ctx.assets.creatureImageUrl(c.speciesId), alt: '' } }),
          el('span', { text: t(`screens.use.teach.${s}`) }),
        ])
      })
      return el('div', 'aps-chip-block', [m ? moveDetail(m) : null, party.length ? el('div', 'aps-teach-row', party) : null])
    }

    const activate = (i: number) => api.run(async () => {
      const e = entries[i]
      if (!e) return
      const it = e.item
      if (mode === 'battle') {
        if (needsTarget(it)) {
          const p = await pickBattleTarget(env, it)
          if (p >= 0) close({ itemId: it.id, partyIndex: p })
          return
        }
        close({ itemId: it.id })
        return
      }
      const keyAction = it.effect.kind === 'key' ? SCREENS.bag.keyItems[it.effect.key] : undefined
      const opts = SCREENS.bag.itemMenu.filter((m) => {
        if (m.id === 'use') return it.usableInField || !!keyAction
        if (m.id === 'toss') return it.category !== 'key'
        return true
      })
      const row = menu?.el.querySelectorAll<HTMLElement>('.ap-row')[i] ?? null
      const pick = await popupMenu(env, opts.map((m) => ({ label: t(m.label) })), { anchor: row, title: it.nameZh })
      const id = opts[pick]?.id
      if (id === 'use') {
        if (await useItemInField(env, it)) dirty = true
        rebuild(i)
      } else if (id === 'toss') {
        const n = await quantityPicker(env, { title: t('screens.bag.tossTitle', { item: it.nameZh }), max: Math.min(e.qty, SCREENS.bag.tossMax), anchor: row })
        if (n > 0 && await ctx.ui.confirm(t('screens.bag.tossConfirm', { item: it.nameZh, n }))) {
          addItem(ctx.save, it.id, -n)
          dirty = true
          sfx(env, 'toss')
          ctx.events.emit('bag:changed', {})
          ctx.ui.toast(t('screens.bag.tossed', { item: it.nameZh, n }), 'info')
          rebuild(i)
        }
      }
    })

    rebuild(0)
    requestAnimationFrame(() => keepTabVisible(tabBar.el, tabIndex))
    return {
      onInput(input) {
        if (backPressed(input)) { close(null); return }
        if (pressed(input, 'left', true)) { tabBar.prev(); return }
        if (pressed(input, 'right', true)) { tabBar.next(); return }
        if (!menu) return
        const r = menu.handleInput(input)
        if (r === 'confirm') void activate(menu.index)
      },
    }
  }, () => null)
}
