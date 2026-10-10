// Pure shared gameplay operations over SaveData and Creature (no DOM, no CSS, no UI dependencies).
// Used by both client screens/flows and server authoritative validation (#22).
import type { Content } from '../content/index.ts'
import { CONTENT } from '../content/index.ts'
import { STAT_KEYS, expForLevel, legalMoves, maxHp, newUid } from '../creature.ts'
import { Rng, hashString } from '../rng.ts'
import type { Creature, ItemDef, SaveData, StatusId } from '../types.ts'

// ---------------------------------------------------------------------------
// Economy & Bag
// ---------------------------------------------------------------------------

export function sellPrice(item: ItemDef, c: Content = CONTENT): number {
  return Math.max(0, Math.floor(item.price * c.config.economy.sellRatio))
}

/** Buy price under a world-event multiplier (Screens.shop priceMul); never below 1. */
export function shopBuyPrice(item: ItemDef, mul = 1): number {
  return mul === 1 ? item.price : Math.max(1, Math.round(item.price * mul))
}

export const canSell = (item: ItemDef): boolean => item.category !== 'key' && item.price > 0

/** Largest quantity purchasable with `money` (0 when unaffordable). */
export function maxAffordable(price: number, money: number, cap: number): number {
  if (price <= 0) return Math.max(0, cap)
  return Math.max(0, Math.min(cap, Math.floor(money / price)))
}

export function addItem(save: SaveData, itemId: string, qty: number): void {
  const next = (save.bag[itemId] ?? 0) + Math.floor(qty)
  if (next > 0) save.bag[itemId] = next
  else delete save.bag[itemId]
}

// ---------------------------------------------------------------------------
// Creatures & Field Items
// ---------------------------------------------------------------------------

export const isConscious = (cr: Creature): boolean => cr.hp > 0

export type TeachState = 'ok' | 'known' | 'unable'

/** Whether a creature can learn `moveId` from a chip: own teachables, any learnset level, or legal pre-evolution moves. */
export function teachState(cr: Creature, moveId: string, c: Content = CONTENT): TeachState {
  if (cr.moves.some((m) => m.id === moveId)) return 'known'
  const sp = c.species[cr.speciesId]
  if (!sp || !c.moves[moveId]) return 'unable'
  const learnable = sp.teachable.includes(moveId) || sp.learnset.some((l) => l.move === moveId) ||
    legalMoves(cr.speciesId, c.config.party.maxLevel, c).has(moveId)
  return learnable ? 'ok' : 'unable'
}

export interface MedicineResult { hp: number; cured: StatusId | null; revived: boolean; pp: number }

/** null when the item would have an effect on this creature, else the reason (text key). */
export function medicineBlocker(cr: Creature, item: ItemDef, c: Content = CONTENT): string | null {
  const e = item.effect
  const max = maxHp(cr, c)
  const fainted = cr.hp <= 0
  switch (e.kind) {
    case 'heal':
      if (fainted) return 'screens.use.fainted'
      return cr.hp >= max ? 'screens.use.hpFull' : null
    case 'cure':
      if (fainted) return 'screens.use.fainted'
      return cr.status && (e.status === 'all' || e.status === cr.status) ? null : 'screens.use.noEffect'
    case 'healCure':
      if (fainted) return 'screens.use.fainted'
      return cr.hp < max || cr.status ? null : 'screens.use.noEffect'
    case 'revive':
      return fainted ? null : 'screens.use.notFainted'
    case 'pp':
      return cr.moves.some((m) => m.pp < m.ppMax) ? null : 'screens.use.ppFull'
    case 'levelUp':
      return cr.level >= c.config.party.maxLevel ? 'screens.use.maxLevel' : null
    case 'evolve':
      return c.species[cr.speciesId]?.evolvesTo && c.species[c.species[cr.speciesId].evolvesTo!.id] ? null : 'screens.use.cannotEvolve'
    case 'chip': {
      const s = teachState(cr, e.move, c)
      return s === 'ok' ? null : s === 'known' ? 'screens.use.known' : 'screens.use.cannotLearn'
    }
    case 'nature':
      return null
    default:
      return 'screens.use.noEffect'
  }
}

/** Effects that need a target creature when used from the bag. */
export const needsTarget = (item: ItemDef): boolean =>
  ['heal', 'cure', 'healCure', 'revive', 'pp', 'levelUp', 'evolve', 'chip', 'nature'].includes(item.effect.kind)

/** Single-move PP items need the player to pick a move. */
export const needsMovePick = (item: ItemDef): boolean => item.effect.kind === 'pp' && !item.effect.all

/** Applies a medicine (heal/cure/healCure/revive/pp). Mutates the creature. */
export function applyMedicine(cr: Creature, item: ItemDef, moveIndex = -1, c: Content = CONTENT): MedicineResult {
  const e = item.effect
  const max = maxHp(cr, c)
  const res: MedicineResult = { hp: 0, cured: null, revived: false, pp: 0 }
  const heal = (amount: number) => {
    const before = cr.hp
    cr.hp = Math.min(max, cr.hp + Math.max(0, Math.floor(amount)))
    res.hp = cr.hp - before
  }
  const cure = () => {
    if (cr.status) { res.cured = cr.status; cr.status = null; cr.statusTurns = 0 }
  }
  switch (e.kind) {
    case 'heal': heal(e.amount === 'full' ? max : e.amount); break
    case 'cure': if (cr.status && (e.status === 'all' || e.status === cr.status)) cure(); break
    case 'healCure': heal(max); cure(); break
    case 'revive':
      if (cr.hp <= 0) {
        cr.hp = Math.max(1, Math.floor(max * e.fraction))
        cure()
        res.revived = true
        res.hp = cr.hp
      }
      break
    case 'pp': {
      const slots = e.all ? cr.moves : cr.moves.filter((_, i) => i === moveIndex)
      for (const m of slots) {
        const before = m.pp
        m.pp = e.amount === 'full' ? m.ppMax : Math.min(m.ppMax, m.pp + e.amount)
        res.pp += m.pp - before
      }
      break
    }
    default: break
  }
  return res
}

// ---------------------------------------------------------------------------
// Capture & Box / Party Storage
// ---------------------------------------------------------------------------

export type CatchPlacement = { where: 'party' } | { where: 'box'; box: number } | null

/** Where a newly caught creature goes: the party while it has room, else the first box with space. */
export function catchPlacement(save: Pick<SaveData, 'party' | 'boxes'>, c: Content = CONTENT): CatchPlacement {
  const P = c.config.party
  if (save.party.length < P.maxParty) return { where: 'party' }
  for (let i = 0; i < P.boxCount; i++) {
    const box = save.boxes[i]
    if (!box || box.length < P.boxSize) return { where: 'box', box: i }
  }
  return null
}

export interface Slot { area: 'party' | 'box'; box: number; index: number }

export function slotList(save: SaveData, s: Slot): Creature[] {
  if (s.area === 'party') return save.party
  while (save.boxes.length <= s.box) save.boxes.push([])
  return save.boxes[s.box]
}

export function creatureAt(save: SaveData, s: Slot): Creature | undefined {
  return slotList(save, s)[s.index]
}

const partyOk = (party: Creature[]) => party.length > 0 && party.some(isConscious)

/**
 * Moves the creature at `from` onto `to`: occupied target swaps, empty target appends to that list.
 * Returns null on success or a text key explaining why the move is not allowed (state unchanged).
 */
export function moveCreature(save: SaveData, from: Slot, to: Slot, c: Content = CONTENT): string | null {
  const src = slotList(save, from)
  const dst = slotList(save, to)
  const a = src[from.index]
  if (!a) return 'screens.box.err.empty'
  if (src === dst && from.index === to.index) return null
  const b = dst[to.index]
  const party = save.party.slice()
  const boxes = save.boxes.map((x) => x.slice())
  const list = (s: Slot) => (s.area === 'party' ? party : boxes[s.box])
  const ls = list(from)
  const ld = list(to)
  if (b) {
    ls[from.index] = b
    ld[to.index] = a
  } else {
    const cap = to.area === 'party' ? c.config.party.maxParty : c.config.party.boxSize
    if (ls !== ld && ld.length >= cap) return to.area === 'party' ? 'screens.box.err.partyFull' : 'screens.box.err.boxFull'
    ls.splice(from.index, 1)
    ld.push(a)
  }
  if (!partyOk(party)) return party.length === 0 ? 'screens.box.err.lastMember' : 'screens.box.err.needConscious'
  save.party = party
  save.boxes = boxes
  return null
}

export function releaseCreature(save: SaveData, at: Slot): string | null {
  const src = slotList(save, at)
  if (!src[at.index]) return 'screens.box.err.empty'
  if (at.area === 'party') {
    const rest = save.party.filter((_, i) => i !== at.index)
    if (!partyOk(rest)) return rest.length === 0 ? 'screens.box.err.lastMember' : 'screens.box.err.needConscious'
  }
  src.splice(at.index, 1)
  return null
}

// ---------------------------------------------------------------------------
// Trade Rules
// ---------------------------------------------------------------------------

/** A creature may be offered only if the party keeps at least one other creature able to battle; a signed boss card is bound to its trainer. */
export function canOffer(party: readonly Creature[], cr: Creature): boolean {
  return cr.origin?.kind !== 'boss' && party.includes(cr) && party.some((o) => o !== cr && o.hp > 0)
}

export function offerableIndices(party: readonly Creature[]): number[] {
  return party.flatMap((cr, i) => (canOffer(party, cr) ? [i] : []))
}

export interface TradeApplied {
  where: 'party' | 'box'
  index: number
  given: Creature | null
  newSeen: boolean
  newCaught: boolean
}

/**
 * Applies trade.complete to a save: the given creature leaves (party slot is reused so the party never
 * shrinks), the received one joins the party or the first box with room, dex and stats update.
 */
export function applyTradeResult(save: SaveData, givenUid: string, received: Creature, c: Content = CONTENT): TradeApplied {
  const cr: Creature = structuredClone(received)
  let given: Creature | null = null
  let where: TradeApplied['where'] | null = null
  let index = -1
  const pi = save.party.findIndex((x) => x.uid === givenUid)
  if (pi >= 0) {
    given = save.party[pi]
    save.party.splice(pi, 1)
  } else {
    for (const box of save.boxes) {
      const bi = box.findIndex((x) => x.uid === givenUid)
      if (bi >= 0) { given = box.splice(bi, 1)[0]; break }
    }
  }
  const owned = (uid: string) => save.party.some((x) => x.uid === uid) || save.boxes.some((b) => b.some((x) => x.uid === uid))
  if (owned(cr.uid)) cr.uid = newUid(new Rng(hashString(`${cr.uid}/${givenUid}/${save.playerId}`)))
  if (pi >= 0) {
    save.party.splice(pi, 0, cr)
    where = 'party'
    index = pi
  } else if (save.party.length < c.config.party.maxParty) {
    save.party.push(cr)
    where = 'party'
    index = save.party.length - 1
  } else {
    let bi = save.boxes.findIndex((b) => b.length < c.config.party.boxSize)
    if (bi < 0) { if (!save.boxes.length) save.boxes.push([]); bi = save.boxes.length - 1 }
    save.boxes[bi].push(cr)
    where = 'box'
    index = bi
  }
  const newSeen = !save.dexSeen.includes(cr.speciesId)
  const newCaught = !save.dexCaught.includes(cr.speciesId)
  if (newSeen) save.dexSeen.push(cr.speciesId)
  if (newCaught) save.dexCaught.push(cr.speciesId)
  save.stats.trades += 1
  return { where, index, given, newSeen, newCaught }
}

export { expForLevel, STAT_KEYS }
