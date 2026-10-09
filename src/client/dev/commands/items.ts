// Bag, money, badges and the dex.
import { CONTENT } from '../../../shared/content/index.ts'
import { addItem, changeMoney, markCaught, markSeen, removeItem } from '../../world/save-ops.ts'
import { DevError, type CommandRun } from '../registry.ts'

export const itemCommands: Record<string, CommandRun> = {
  /** Adds (or, with a negative quantity, removes) items. */
  'item.give': ({ ctx }, a) => {
    const id = String(a.item)
    if (!CONTENT.items[id]) throw new DevError('dev.err.unknownItem', { item: id })
    const qty = Math.floor((a.qty as number | undefined) ?? 1)
    if (qty >= 0) addItem(ctx, id, qty)
    else removeItem(ctx, id, -qty)
    return { item: id, have: ctx.save.bag[id] ?? 0 }
  },
  'money.set': ({ ctx }, a) => {
    const target = Math.max(0, Math.floor(a.money as number))
    changeMoney(ctx, target - ctx.save.money)
    return { money: ctx.save.money }
  },
  'badge.set': ({ ctx, world }, a) => {
    const id = String(a.badge)
    if (!world.badges.some((b) => b.id === id)) throw new DevError('dev.err.unknownBadge', { badge: id })
    const has = ctx.save.badges.includes(id)
    const on = a.on !== false
    if (on && !has) { ctx.save.badges.push(id); ctx.events.emit('badge:earned', { badgeId: id }) }
    if (!on && has) ctx.save.badges = ctx.save.badges.filter((b) => b !== id)
    return { badges: ctx.save.badges.length }
  },
  /** Dex: every species, only the species of one type, or nothing. */
  'dex.fill': (host, a) => {
    const { ctx } = host
    const mode = String(a.mode ?? 'all')
    if (!['all', 'type', 'none'].includes(mode)) throw new DevError('dev.err.badArg', { arg: 'mode', why: 'all / type / none' })
    if (mode === 'none') { ctx.save.dexSeen = []; ctx.save.dexCaught = [] }
    else {
      const type = a.type as string | undefined
      if (mode === 'type' && !type) throw new DevError('dev.err.missingArg', { arg: 'type' })
      for (const sp of CONTENT.speciesList) {
        if (mode === 'type' && !sp.types.includes(type as never)) continue
        markSeen(ctx, sp.id)
        markCaught(ctx, sp.id)
      }
    }
    return { seen: ctx.save.dexSeen.length, caught: ctx.save.dexCaught.length }
  },
}
