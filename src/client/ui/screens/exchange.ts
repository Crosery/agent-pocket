// Exchange (物品兑换): barter materials for goods at a desk of content/exchange.json (rules: shared/gameplay/exchange.ts).
// Layout and widgets mirror the shop; every string is t('screens.exchange.*').
import { CONTENT, t } from '../../../shared/content/index.ts'
import { offersOf, takeOffer, timesAffordable, unlocked, type ExchangeOffer } from '../../../shared/gameplay/exchange.ts'
import { createRowMenu, type RowMenu } from '../menu.ts'
import { el } from '../widgets.ts'
import { backPressed, frame, isCompact, openScreen, quantityPicker, sectionTitle, setChildren, sfx, type ScreenEnv } from './base.ts'
import { SCREENS } from './config.ts'

const names = (m: Record<string, number>): string => Object.entries(m).map(([id, n]) => t('screens.exchange.stack', { item: CONTENT.items[id]?.nameZh ?? id, n })).join(t('screens.exchange.join'))

export function exchangeScreen(env: ScreenEnv, desk: string): Promise<void> {
  const { ctx } = env
  const offers = offersOf(desk)
  return openScreen<void>(env, 'aps-exchange', (api) => {
    let menu: RowMenu | null = null
    let dirty = false
    const f = frame(env, { title: t('screens.exchange.title'), glyph: 'bag', onClose: api.guard(() => close()) })
    const listBox = el('div', 'aps-bag-list ap-panel')
    const detail = el('div', 'aps-bag-detail ap-panel')
    const greeting = el('div', { class: 'aps-shop-greet', text: t('screens.exchange.greeting') })
    f.body.append(el('div', 'aps-bag-layout', [el('div', 'aps-bag-left', [listBox]), el('div', 'aps-shop-side', [greeting, detail])]))
    f.setHints([['ud', t('screens.hint.choose')], ['confirm', t('screens.exchange.hint')], ['cancel', t('screens.hint.back')]])
    api.root.append(f.el)

    const close = () => {
      if (dirty) ctx.persist('exchange')
      api.close()
    }
    const state = (o: ExchangeOffer) => (!unlocked(o, ctx.save) ? 'locked' : timesAffordable(o, ctx.save) > 0 ? 'ready' : 'short')
    const rebuild = (keep: number) => {
      menu = createRowMenu(offers.map((o) => ({
        label: t('screens.exchange.row', { give: names(o.give), get: names(o.get) }),
        sub: t(`screens.exchange.state.${state(o)}`, { n: timesAffordable(o, ctx.save), badges: o.atLeastBadges ?? 0 }),
        disabled: state(o) !== 'ready',
      })), {
        visibleRows: isCompact() ? SCREENS.shop.compactVisibleRows : SCREENS.shop.visibleRows,
        initial: Math.min(keep, Math.max(0, offers.length - 1)),
        wrap: true,
        audio: ctx.audio,
        onChange: (i) => paint(i),
        onPick: api.guard((i: number) => void deal(i)),
      })
      listBox.replaceChildren(menu.el)
      paint(menu.index)
    }
    const stackRows = (m: Record<string, number>, own: boolean) => Object.entries(m).map(([id, n]) => {
      const have = ctx.save.bag[id] ?? 0
      return el('div', { class: `aps-ex-line${own && have < n ? ' is-short' : ''}`, text: own ? t('screens.exchange.need', { item: CONTENT.items[id]?.nameZh ?? id, n, have }) : t('screens.exchange.stack', { item: CONTENT.items[id]?.nameZh ?? id, n }) })
    })
    const paint = (i: number) => {
      const o = offers[i]
      if (!o) { detail.replaceChildren(el('div', { class: 'aps-empty', text: t('screens.exchange.empty') })); return }
      const st = state(o)
      setChildren(detail, [
        sectionTitle(t('screens.exchange.give')),
        ...stackRows(o.give, true),
        sectionTitle(t('screens.exchange.get')),
        ...stackRows(o.get, false),
        el('p', { class: 'aps-item-desc ap-dim', text: st === 'locked' ? t('screens.exchange.locked', { badges: o.atLeastBadges ?? 0 }) : st === 'short' ? t('screens.exchange.short') : t('screens.exchange.ready', { n: timesAffordable(o, ctx.save) }) }),
      ])
    }
    const deal = (i: number) => api.run(async () => {
      const o = offers[i]
      if (!o) return
      const max = timesAffordable(o, ctx.save)
      if (max <= 0) { sfx(env, 'error'); ctx.ui.toast(t('screens.exchange.cannot'), 'warn'); return }
      const n = max === 1 ? 1 : await quantityPicker(env, { title: t('screens.exchange.pick'), max, note: t('screens.exchange.row', { give: names(o.give), get: names(o.get) }) })
      if (n <= 0) return
      if (!await ctx.ui.confirm(t('screens.exchange.confirm', { give: names(scale(o.give, n)), get: names(scale(o.get, n)) }))) return
      if (!takeOffer(o, ctx.save, n)) return
      dirty = true
      ctx.events.emit('bag:changed', {})
      sfx(env, 'buy')
      ctx.ui.toast(t('screens.exchange.done', { get: names(scale(o.get, n)) }), 'success')
      rebuild(i)
    })

    rebuild(0)
    return {
      onInput(input) {
        if (backPressed(input)) { close(); return }
        if (menu?.handleInput(input) === 'confirm') void deal(menu.index)
      },
    }
  })
}

const scale = (m: Record<string, number>, n: number): Record<string, number> => Object.fromEntries(Object.entries(m).map(([id, q]) => [id, q * n]))
