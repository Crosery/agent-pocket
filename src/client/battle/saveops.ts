// Save mutations performed by the battle client (dex, bag, money, captured creatures, stats). Every change emits
// the matching GameEvents. Pure over a GameContext subset so it is testable without DOM.
import type { Creature } from '../../shared/types.ts'
import type { GameContext } from '../contracts.ts'
import { catchPlacement, type CatchPlacement } from './model.ts'

export type SaveCtx = Pick<GameContext, 'save' | 'events' | 'data'>

/** Adds to dexSeen; true when it is a new entry. */
export function markSeen(ctx: SaveCtx, speciesId: string): boolean {
  if (!ctx.data.species[speciesId] || ctx.save.dexSeen.includes(speciesId)) return false
  ctx.save.dexSeen.push(speciesId)
  ctx.events.emit('dex:seen', { speciesId })
  return true
}

/** Adds to dexCaught (and dexSeen); true when it is a new caught entry. */
export function markCaught(ctx: SaveCtx, speciesId: string): boolean {
  markSeen(ctx, speciesId)
  if (!ctx.data.species[speciesId] || ctx.save.dexCaught.includes(speciesId)) return false
  ctx.save.dexCaught.push(speciesId)
  ctx.events.emit('dex:caught', { speciesId })
  return true
}

/** Removes one of an item from the bag; false when none was there. */
export function consumeItem(ctx: SaveCtx, itemId: string): boolean {
  const have = ctx.save.bag[itemId] ?? 0
  if (have <= 0) return false
  if (have > 1) ctx.save.bag[itemId] = have - 1
  else delete ctx.save.bag[itemId]
  ctx.events.emit('bag:changed', {})
  return true
}

/** Applies a money delta (never below zero); returns the delta actually applied. */
export function changeMoney(ctx: SaveCtx, delta: number): number {
  const before = ctx.save.money
  ctx.save.money = Math.max(0, Math.floor(before + delta))
  const d = ctx.save.money - before
  if (d !== 0) ctx.events.emit('money:changed', { money: ctx.save.money, delta: d })
  return d
}

/** Stores a captured creature (party, else first box with room), registers it and counts it. */
export function storeCaught(ctx: SaveCtx, cr: Creature): CatchPlacement {
  const where = catchPlacement(ctx.save, ctx.data)
  if (!where) return null
  if (!cr.otName) cr.otName = ctx.save.name
  if (!cr.otId) cr.otId = ctx.save.playerId
  if (where.where === 'party') {
    ctx.save.party.push(cr)
    ctx.events.emit('party:changed', {})
  } else {
    while (ctx.save.boxes.length <= where.box) ctx.save.boxes.push([])
    ctx.save.boxes[where.box].push(cr)
  }
  ctx.save.stats.caught += 1
  if (cr.shiny) ctx.save.stats.shiniesFound += 1
  return where
}
