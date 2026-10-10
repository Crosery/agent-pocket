// Boss cards: creatures signed after a boss instance (origin.kind === 'boss'). They start low, are taught up by the rest
// of the party, and stop at a cap that follows the badge count; exp past the cap is banked and paid out by the next
// badge. All numbers live in content/quality.json (bossCard) and content/world/instances.json. Pure functions.
import type { BattleModifiers, Creature, InstanceTierDef } from '../types.ts'
import type { IRng } from '../contracts.ts'
import { CONTENT, type Content } from '../content/index.ts'
import { createCreature, defaultMoves, expForLevel, settleLevels } from '../creature.ts'
import { hashString } from '../rng.ts'

export const isBossCard = (cr: Pick<Creature, 'origin'>): boolean => cr.origin?.kind === 'boss'

/** Highest level a boss card may reach with this many badges. */
export function bossCardCap(badges: number, c: Content = CONTENT): number {
  const caps = c.quality.bossCard.capByBadges
  return caps[Math.min(Math.max(0, Math.floor(badges)), caps.length - 1)]
}

/** Exp multiplier of a card `gap` levels behind the rest of the party (1 when it is not behind). */
export function catchUpMul(gap: number, c: Content = CONTENT): number {
  const u = c.quality.bossCard.catchUp
  return gap < 1 ? 1 : Math.min(u.max, 1 + u.perLevel * gap)
}

/** The most exp a card may hold under `cap`: the cap level plus the bank. */
export function expCap(cr: Pick<Creature, 'speciesId'>, cap: number, c: Content = CONTENT): number {
  const growth = c.species[cr.speciesId]?.growth ?? 'medium'
  return expForLevel(growth, Math.min(c.config.party.maxLevel, cap + c.quality.bossCard.bankMaxLevels), c)
}

/** Whole levels of banked exp a card holds past its level. */
export function bankLevels(cr: Creature, c: Content = CONTENT): number {
  const growth = c.species[cr.speciesId]?.growth
  if (!growth || !isBossCard(cr)) return 0
  let n = 0
  while (cr.level + n < c.config.party.maxLevel && cr.exp >= expForLevel(growth, cr.level + n + 1, c)) n++
  return n
}

export interface PartyExpMods { expByParty: number[]; benchExp: number[]; levelCapByParty: number[]; expCapByParty: number[] }

/**
 * Per party slot: the exp multiplier, the bench share and the level / exp caps of BattleModifiers. Only boss cards are
 * touched (catch-up against the best of the others, badge cap, bank); everyone else gets 1 / 0 / 0 (0 = no cap).
 */
export function partyExpMods(party: readonly Creature[], badges: number, c: Content = CONTENT): PartyExpMods {
  const cap = bossCardCap(badges, c)
  const out: PartyExpMods = { expByParty: [], benchExp: [], levelCapByParty: [], expCapByParty: [] }
  party.forEach((cr, i) => {
    if (!isBossCard(cr)) {
      out.expByParty.push(1); out.benchExp.push(0); out.levelCapByParty.push(0); out.expCapByParty.push(0)
      return
    }
    const best = party.reduce((m, o, j) => (j === i ? m : Math.max(m, o.level)), 0)
    const mul = catchUpMul(best - cr.level, c)
    out.expByParty.push(mul)
    out.benchExp.push(c.quality.bossCard.catchUp.benchShare * mul)
    out.levelCapByParty.push(cap)
    out.expCapByParty.push(expCap(cr, cap, c))
  })
  return out
}

/** True when `m` changes anything compared with no modifier at all. */
export const hasExpMods = (m: PartyExpMods): boolean =>
  m.expByParty.some((v) => v !== 1) || m.benchExp.some((v) => v > 0) || m.levelCapByParty.some((v) => v > 0)

export function toBattleMods(m: PartyExpMods): Pick<BattleModifiers, 'expByParty' | 'benchExp' | 'levelCapByParty' | 'expCapByParty'> {
  return { expByParty: m.expByParty, benchExp: m.benchExp, levelCapByParty: m.levelCapByParty, expCapByParty: m.expCapByParty }
}

/** Pays out the bank under a (new) cap: levels the card up from the exp it already holds. */
export function settleBank(cr: Creature, cap: number, c: Content = CONTENT): ReturnType<typeof settleLevels> & { from: number; to: number } {
  const from = cr.level
  const r = settleLevels(cr, cap, c)
  return { ...r, from, to: cr.level }
}

/** Seed of one contract roll: fixed by the save's rollSeed and the run counter, so reloading the room repeats it. */
export const captureSeed = (rollSeed: number, instanceId: string, tier: string, runSeq: number): number =>
  hashString(`${rollSeed >>> 0}:${instanceId}:${tier}:${runSeq}`)

export interface BossCardOpts {
  /** First clear of the tier: the guaranteed grade floor and the signature ability apply. */
  first: boolean
  run?: string
  at?: number
  otName?: string
  otId?: string
  ballId?: string
  caughtMap?: string
}

/** A freshly signed card: level `bossCard.startLevel`, the species' opening moves with the last slot given to the signature move. */
export function rollBossCard(rng: IRng, bossId: string, tierId: string, tier: InstanceTierDef, o: BossCardOpts, c: Content = CONTENT): Creature {
  const boss = c.bosses[bossId]
  if (!boss) throw new Error(`unknown boss "${bossId}"`)
  const cap = tier.capture
  const level = c.quality.bossCard.startLevel
  const moves = defaultMoves(boss.species, level, c)
  const sig = boss.signature?.move
  if (sig && c.moves[sig] && !moves.includes(sig)) {
    if (moves.length >= c.config.party.maxMoves) moves[moves.length - 1] = sig
    else moves.push(sig)
  }
  const cr = createCreature(boss.species, level, {
    rng, moves, perfectIvs: cap.perfectIvs, ivMin: cap.ivMin, ...(o.first ? { gradeFloor: cap.firstGradeFloor } : {}),
    ...(o.otName !== undefined ? { otName: o.otName } : {}), ...(o.otId !== undefined ? { otId: o.otId } : {}),
    ...(o.ballId ? { ballId: o.ballId } : {}), ...(o.caughtMap ? { caughtMap: o.caughtMap } : {}),
    origin: { kind: 'boss', boss: bossId, tier: tierId, ...(o.run ? { run: o.run } : {}), ...(o.at !== undefined ? { at: o.at } : {}) },
  }, c)
  const species = c.species[boss.species]
  const pool: { id: string; w: number }[] = []
  for (const [k, w] of Object.entries(cap.ability)) {
    const id = k === 'signature' ? boss.signature?.ability : species.abilities[Number(k.slice('slot'.length))]
    if (id && w > 0) pool.push({ id, w })
  }
  if (o.first && cap.firstAbility === 'signature' && boss.signature?.ability) cr.abilityId = boss.signature.ability
  else if (pool.length) cr.abilityId = rng.weighted(pool, (e) => e.w).id
  return cr
}
