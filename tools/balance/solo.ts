// One-versus-one analysis on the real engine: power by rarity, by type, by species, and the level value of a type edge.
// Every creature fights with a standard moveset built from its own legal moves (teams.ts), so the numbers describe the
// data (stats, moves, abilities), not a hand-picked kit. Seeds make every table reproducible.
import type { Creature, SpeciesDef } from '../../src/shared/types.ts'
import { Rng } from '../../src/shared/rng.ts'
import { createCreature, healFull } from '../../src/shared/creature.ts'
import { typeEffectiveness } from '../../src/shared/content/index.ts'
import { C, RULES, STATS, bst, mean, pct, r1, stdev, table } from './lib.ts'
import { playBattle, pilotPolicy } from './sim.ts'
import { movesetFor, type RoleDef } from './teams.ts'

/** The standard kit: three attacks and one utility move (heal / boost). */
const STANDARD: RoleDef = { id: 'solo', nameZh: '单挑', plan: '', where: [], score: {}, slots: [['attack'], ['attack'], ['attack'], ['heal', 'boost', 'attack']] }

const kits = new Map<string, string[]>()
export function standardKit(sp: SpeciesDef): string[] {
  let k = kits.get(sp.id)
  if (!k) { k = movesetFor(sp, STANDARD, undefined, false); kits.set(sp.id, k) }
  return k
}

export function fighter(id: string, level: number, seed: number): Creature {
  const rng = new Rng(seed)
  const cr = createCreature(id, level, { rng, shiny: false, moves: standardKit(C.species[id]) }, C)
  cr.abilityId = C.species[id].abilities[0] ?? ''
  for (const k of STATS) cr.ivs[k] = rng.int(0, C.config.creature.ivMax)
  healFull(cr, C)
  return cr
}

/** Score of `a` against `b` over `n` games (seat-swapped, seeded): wins + half draws. */
export function duel(a: string, la: number, b: string, lb: number, n: number, seed: number): number {
  let score = 0
  for (let i = 0; i < n; i++) {
    const s = seed * 7919 + i * 104729 + 13
    const ca = fighter(a, la, s)
    const cb = fighter(b, lb, s + 1)
    const flip = i % 2 === 1
    const r = flip ? playBattle([cb], [ca], s, pilotPolicy) : playBattle([ca], [cb], s, pilotPolicy)
    const aWon = flip ? r.winner === 1 : r.winner === 0
    if (aWon) score += 1
    else if (r.winner === -1) score += 0.5
  }
  return score / n
}

const speciesOfRarities = (rs: string[]): SpeciesDef[] => C.speciesList.filter((s) => rs.includes(s.rarity))

/** Deterministic sample of `k` species from a list (stride sampling keeps coverage of the dex order). */
function sample<T>(xs: T[], k: number, seed: number): T[] {
  if (xs.length <= k) return xs
  const rng = new Rng(seed)
  const pool = [...xs]
  const out: T[] = []
  while (out.length < k) out.push(pool.splice(rng.int(0, pool.length - 1), 1)[0])
  return out
}

export interface RarityCell { a: string; b: string; levelGap: number; rate: number }

/** Win rate of rarity `a` over rarity `b` when a fights `levelGap` levels below b (0 = even level). */
export function rarityCell(a: string, b: string, levelGap: number, per: number, games: number, seed: number, level = RULES.sim.level): RarityCell {
  const A = sample(speciesOfRarities([a]), per, seed)
  const B = sample(speciesOfRarities([b]), per, seed + 1)
  const rng = new Rng(seed + 2)
  const rates: number[] = []
  for (let i = 0; i < per; i++) {
    const x = A[i % A.length]
    const y = B[rng.int(0, B.length - 1)]
    rates.push(duel(x.id, level - levelGap, y.id, level, games, seed + i))
  }
  return { a, b, levelGap, rate: mean(rates) }
}

export interface TypeRow { type: string; species: number; rate: number }

/** Mean win rate against a mixed field, per type (a species counts for each of its types). */
export function typePower(opponentsPerSpecies: number, games: number, seed: number, rarities = ['SR', 'SSR'], level = RULES.sim.level): { rows: TypeRow[]; bySpecies: { id: string; rate: number }[] } {
  const pool = speciesOfRarities(rarities)
  const rng = new Rng(seed)
  const bySpecies: { id: string; rate: number }[] = []
  for (const sp of pool) {
    const rates: number[] = []
    for (let i = 0; i < opponentsPerSpecies; i++) {
      const foe = pool[rng.int(0, pool.length - 1)]
      if (foe.id === sp.id) continue
      rates.push(duel(sp.id, level, foe.id, level, games, seed + i + sp.dexNo * 31))
    }
    bySpecies.push({ id: sp.id, rate: mean(rates) })
  }
  const rows: TypeRow[] = C.types.map((t) => {
    const xs = bySpecies.filter((b) => C.species[b.id].types.includes(t.id)).map((b) => b.rate)
    return { type: t.id, species: xs.length, rate: mean(xs) }
  })
  return { rows, bySpecies }
}

/**
 * Levels a type edge is worth: the lowest level gap d at which species A (with a super-effective STAB move on B,
 * B without one on A) still wins at least half of the games against B at the base level.
 */
export function typeEdgeLevels(pairs: number, games: number, seed: number, rarity = 'SR', level = RULES.sim.level): { gap: number; rate: number }[] {
  const pool = speciesOfRarities([rarity])
  const rng = new Rng(seed)
  const found: [string, string][] = []
  for (let guard = 0; found.length < pairs && guard < 4000; guard++) {
    const a = pool[rng.int(0, pool.length - 1)]
    const b = pool[rng.int(0, pool.length - 1)]
    if (a.id === b.id) continue
    const aHits = a.types.some((t) => typeEffectiveness(t, b.types, C) > 1)
    const bHits = b.types.some((t) => typeEffectiveness(t, a.types, C) > 1)
    if (aHits && !bHits && Math.abs(bst(a) - bst(b)) <= 25) found.push([a.id, b.id])
  }
  const gaps = [0, 3, 6, 9, 12, 15]
  return gaps.map((gap) => ({ gap, rate: mean(found.map(([a, b], i) => duel(a, level - gap, b, level, games, seed + i))) }))
}

export function report(per = 6, games = 4, seed = 1): string {
  const lines: string[] = []
  const rs = C.rarities.map((r) => r.id).filter((r) => ['N', 'R', 'SR', 'SSR', 'UR'].includes(r))
  lines.push('== rarity ladder: win rate of the row rarity over the next rarity (even level / 5 levels below / 10 levels below) ==')
  const rows: (string | number)[][] = []
  for (let i = 0; i + 1 < rs.length; i++) {
    rows.push([`${rs[i + 1]} vs ${rs[i]}`, ...[0, 5, 10].map((g) => pct(rarityCell(rs[i + 1], rs[i], g, per, games, seed + i).rate))])
  }
  lines.push(table(['higher vs lower', 'even', '-5 lv', '-10 lv'], rows))
  const tp = typePower(5, 2, seed)
  lines.push('', '== type power: mean 1v1 win rate of SR+SSR species holding the type ==')
  lines.push(table(['type', 'species', 'win'], tp.rows.map((r) => [r.type, r.species, pct(r.rate)])))
  lines.push(`spread: ${pct(Math.min(...tp.rows.map((r) => r.rate)))}..${pct(Math.max(...tp.rows.map((r) => r.rate)))}, stdev ${r1(stdev(tp.rows.map((r) => r.rate)) * 100)} pts`)
  const edge = typeEdgeLevels(24, 4, seed)
  lines.push('', '== value of a type edge: win rate of the side with a super-effective STAB move (same rarity, BST within 25) when it fights N levels below ==')
  lines.push(table(['levels below', ...edge.map((e) => String(e.gap))], [['win', ...edge.map((e) => pct(e.rate))]]))
  return lines.join('\n')
}
