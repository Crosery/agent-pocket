// Item exchange (物品兑换): desks of barter offers from content/exchange.json. Pure rules shared by the exchange
// screen, the `exchange` script op and tests; all numbers and ids are data.
import type { SaveData } from '../types.ts'
import exchangeJson from '../../../content/exchange.json' with { type: 'json' }

export interface ExchangeOffer {
  id: string
  give: Record<string, number>
  get: Record<string, number>
  /** Badges needed before the offer unlocks (default 0). */
  atLeastBadges?: number
  /** Most times one save may take it (default unlimited). */
  limit?: number
}

export interface ExchangeFile {
  flagPrefix: string
  desks: Record<string, { offers: ExchangeOffer[] }>
}

export const EXCHANGE = exchangeJson as unknown as ExchangeFile

export const offersOf = (desk: string, x: ExchangeFile = EXCHANGE): ExchangeOffer[] => x.desks[desk]?.offers ?? []

export function unlocked(offer: ExchangeOffer, save: Pick<SaveData, 'badges'>): boolean {
  return save.badges.length >= (offer.atLeastBadges ?? 0)
}

export function timesTaken(offer: ExchangeOffer, save: Pick<SaveData, 'flags'>, x: ExchangeFile = EXCHANGE): number {
  const v = save.flags[`${x.flagPrefix}${offer.id}`]
  return typeof v === 'number' ? v : 0
}

/** How many times the offer can be taken right now (materials, limit and badge gate). */
export function timesAffordable(offer: ExchangeOffer, save: Pick<SaveData, 'bag' | 'badges' | 'flags'>, x: ExchangeFile = EXCHANGE): number {
  if (!unlocked(offer, save)) return 0
  let n = Infinity
  for (const [item, qty] of Object.entries(offer.give)) n = Math.min(n, Math.floor((save.bag[item] ?? 0) / qty))
  if (offer.limit !== undefined) n = Math.min(n, offer.limit - timesTaken(offer, save, x))
  return Number.isFinite(n) ? Math.max(0, n) : 0
}

/** Takes the offer `times` times: removes the materials, adds the goods, counts it. False when not affordable. */
export function takeOffer(offer: ExchangeOffer, save: Pick<SaveData, 'bag' | 'badges' | 'flags'>, times = 1, x: ExchangeFile = EXCHANGE): boolean {
  if (times < 1 || timesAffordable(offer, save, x) < times) return false
  for (const [item, qty] of Object.entries(offer.give)) {
    const left = (save.bag[item] ?? 0) - qty * times
    if (left > 0) save.bag[item] = left
    else delete save.bag[item]
  }
  for (const [item, qty] of Object.entries(offer.get)) save.bag[item] = (save.bag[item] ?? 0) + qty * times
  save.flags[`${x.flagPrefix}${offer.id}`] = timesTaken(offer, save, x) + times
  return true
}

/** Problems with the data against the item table (ids exist, no money-printing: goods never out-price the materials). */
export function validateExchange(items: Record<string, { price: number; category?: string }>, x: ExchangeFile = EXCHANGE): string[] {
  const errs: string[] = []
  const ids = new Set<string>()
  const value = (m: Record<string, number>) => Object.entries(m).reduce((sum, [id, qty]) => sum + (items[id]?.price ?? 0) * qty, 0)
  for (const [desk, d] of Object.entries(x.desks)) {
    if (!d.offers.length) errs.push(`desk ${desk}: no offers`)
    for (const o of d.offers) {
      const where = `offer ${o.id}`
      if (ids.has(o.id)) errs.push(`${where}: duplicate id`)
      ids.add(o.id)
      for (const side of [o.give, o.get]) {
        if (!Object.keys(side).length) errs.push(`${where}: empty side`)
        for (const [id, qty] of Object.entries(side)) {
          if (!items[id]) errs.push(`${where}: unknown item "${id}"`)
          if (!Number.isInteger(qty) || qty < 1) errs.push(`${where}: bad quantity for "${id}"`)
        }
      }
      for (const id of Object.keys(o.give)) if (items[id]?.category === 'key') errs.push(`${where}: key item "${id}" cannot be given`)
      if (value(o.get) > value(o.give)) errs.push(`${where}: goods (${value(o.get)}) worth more than materials (${value(o.give)})`)
    }
  }
  return errs
}
