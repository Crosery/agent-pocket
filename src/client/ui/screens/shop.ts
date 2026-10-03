// Shop: buy the given item ids / sell bag items (sell price = floor(price * config.economy.sellRatio)).
// Quantity picker with running total; money changes go through events + HUD.
import { CONTENT, t } from '../../../shared/content/index.ts'
import type { ItemDef } from '../../../shared/types.ts'
import { createRowMenu, type RowMenu } from '../menu.ts'
import { el, tabs } from '../widgets.ts'
import { backPressed, frame, infoRow, isCompact, moneyEl, openScreen, pressed, quantityPicker, sfx, type ScreenEnv, setChildren } from './base.ts'
import { SCREENS } from './config.ts'
import { addItem, canSell, maxAffordable, sellPrice, shopBuyPrice } from './logic.ts'
import { moveDetail } from './summary.ts'

interface ShopRow { item: ItemDef; price: number; owned: number }

export function shopScreen(env: ScreenEnv, itemIds: string[], opts: { priceMul?: Record<string, number> } = {}): Promise<void> {
  const { ctx } = env
  const stock = [...new Set(itemIds)].map((id) => CONTENT.items[id]).filter((it): it is ItemDef => !!it && it.price > 0)
  const mulOf = (it: ItemDef) => opts.priceMul?.[it.id] ?? 1
  const muls = stock.map(mulOf)
  const greetKey = muls.some((m) => m < 1) ? 'screens.shop.greetingSale' : muls.some((m) => m > 1) ? 'screens.shop.greetingSurge' : 'screens.shop.greeting'
  return openScreen<void>(env, 'aps-shop', (api) => {
    let tab = 0
    let rows: ShopRow[] = []
    let menu: RowMenu | null = null
    let dirty = false
    const money = el('div', 'aps-head-money')
    const f = frame(env, { title: t('screens.shop.title'), glyph: 'bag', onClose: api.guard(() => close()) })
    f.right.append(money)
    const tabBar = tabs(SCREENS.shop.tabs.map((x) => t(x.label)), { audio: ctx.audio, onChange: (i) => { tab = i; rebuild(0) } })
    const listBox = el('div', 'aps-bag-list ap-panel')
    const detail = el('div', 'aps-bag-detail ap-panel')
    const greeting = el('div', { class: 'aps-shop-greet', text: t(greetKey) })
    f.body.append(el('div', 'aps-bag-layout', [el('div', 'aps-bag-left', [tabBar.el, listBox]), el('div', 'aps-shop-side', [greeting, detail])]))
    f.setHints([['lr', t('screens.hint.tabs')], ['ud', t('screens.hint.choose')], ['confirm', t('screens.hint.confirm')], ['cancel', t('screens.hint.back')]])
    api.root.append(f.el)

    const selling = () => SCREENS.shop.tabs[tab]?.id === 'sell'
    const close = () => {
      if (dirty) ctx.persist('shop')
      api.close()
    }
    const rebuild = (keep: number) => {
      rows = selling()
        ? CONTENT.itemList.filter((it) => (ctx.save.bag[it.id] ?? 0) > 0 && canSell(it)).map((item) => ({ item, price: sellPrice(item), owned: ctx.save.bag[item.id] ?? 0 }))
        : stock.map((item) => ({ item, price: shopBuyPrice(item, mulOf(item)), owned: ctx.save.bag[item.id] ?? 0 }))
      const visible = isCompact() ? SCREENS.shop.compactVisibleRows : SCREENS.shop.visibleRows
      menu = createRowMenu(rows.map((r) => ({
        label: selling() ? t('screens.shop.sellLabel', { item: r.item.nameZh, n: r.owned }) : r.item.nameZh,
        sub: t('screens.common.money', { n: r.price.toLocaleString(t('ui.locale')) }),
        icon: ctx.assets.itemIconUrl(r.item.id),
        disabled: !selling() && r.price > ctx.save.money,
      })), {
        visibleRows: visible,
        initial: Math.min(keep, Math.max(0, rows.length - 1)),
        wrap: true,
        audio: ctx.audio,
        onChange: (i) => paint(i),
        onPick: api.guard((i: number) => void deal(i)),
      })
      listBox.replaceChildren(menu.el)
      money.replaceChildren(moneyEl(ctx.save.money))
      paint(menu.index)
    }
    const paint = (i: number) => {
      const r = rows[i]
      if (!r) { detail.replaceChildren(el('div', { class: 'aps-empty', text: t(selling() ? 'screens.shop.nothingToSell' : 'screens.shop.soldOut') })); return }
      const it = r.item
      setChildren(detail, [
        el('div', 'aps-item-head', [
          el('div', 'aps-item-icon', [el('img', { attrs: { src: ctx.assets.itemIconUrl(it.id), alt: '', draggable: 'false' } })]),
          el('div', 'aps-item-title', [el('div', { class: 'aps-item-name ap-gold', text: it.nameZh }), el('div', { class: 'ap-dim', text: t(`items.category.${it.category}`) })]),
        ]),
        el('p', { class: 'aps-item-desc', text: it.description }),
        infoRow(t(selling() ? 'screens.shop.sellPrice' : 'screens.shop.price'), moneyEl(r.price)),
        !selling() && r.price !== it.price ? infoRow(t('screens.shop.listPrice'), t(r.price < it.price ? 'screens.shop.eventSale' : 'screens.shop.eventSurge', { n: it.price.toLocaleString(t('ui.locale')) })) : null,
        infoRow(t('screens.bag.owned'), t('screens.bag.qty', { n: r.owned })),
        it.effect.kind === 'chip' ? moveDetail(CONTENT.moves[it.effect.move]) : null,
      ])
    }
    const changeMoney = (delta: number) => {
      ctx.save.money = Math.max(0, ctx.save.money + delta)
      ctx.events.emit('money:changed', { money: ctx.save.money, delta })
      ctx.events.emit('bag:changed', {})
      ctx.hud.setMoney(ctx.save.money)
      dirty = true
    }
    const deal = (i: number) => api.run(async () => {
      const r = rows[i]
      if (!r) return
      const row = menu?.el.querySelectorAll<HTMLElement>('.ap-row')[i] ?? null
      const name = r.item.nameZh
      if (selling()) {
        const n = await quantityPicker(env, { title: t('screens.shop.sellTitle', { item: name }), max: r.owned, price: r.price, note: t('screens.shop.ownedNote', { n: r.owned }), anchor: row })
        if (n <= 0) return
        const total = n * r.price
        if (!await ctx.ui.confirm(t('screens.shop.sellConfirm', { item: name, n, total: total.toLocaleString(t('ui.locale')) }))) return
        addItem(ctx.save, r.item.id, -n)
        changeMoney(total)
        sfx(env, 'sell')
        ctx.ui.toast(t('screens.shop.sold', { item: name, n, total: total.toLocaleString(t('ui.locale')) }), 'success')
        rebuild(i)
        return
      }
      const max = maxAffordable(r.price, ctx.save.money, SCREENS.shop.qtyMax)
      if (max <= 0) { sfx(env, 'error'); ctx.ui.toast(t('screens.shop.noMoney'), 'warn'); return }
      const n = await quantityPicker(env, { title: t('screens.shop.buyTitle', { item: name }), max, price: r.price, note: t('screens.shop.ownedNote', { n: r.owned }), anchor: row })
      if (n <= 0) return
      const total = n * r.price
      if (!await ctx.ui.confirm(t('screens.shop.buyConfirm', { item: name, n, total: total.toLocaleString(t('ui.locale')) }))) return
      addItem(ctx.save, r.item.id, n)
      changeMoney(-total)
      sfx(env, 'buy')
      ctx.ui.toast(t('screens.shop.bought', { item: name, n }), 'success')
      rebuild(i)
    })

    rebuild(0)
    return {
      onInput(input) {
        if (backPressed(input)) { close(); return }
        if (pressed(input, 'left', true)) { tabBar.prev(); return }
        if (pressed(input, 'right', true)) { tabBar.next(); return }
        if (menu?.handleInput(input) === 'confirm') void deal(menu.index)
      },
    }
  })
}
