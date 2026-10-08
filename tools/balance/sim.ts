// Headless team-vs-team simulator on the shared battle engine.
// Both sides are piloted by the same policy (default: the in-game AI at its highest level), so a matchup measures
// the data (stats, moves, abilities, types) and not a player. Fully deterministic per (teamA, teamB, seed).
import type { BattleAction, BattleInit, Creature, SideIndex } from '../../src/shared/types.ts'
import { BattleEngine } from '../../src/shared/battle/engine.ts'
import { chooseAiAction } from '../../src/shared/battle/ai.ts'
import { Rng } from '../../src/shared/rng.ts'
import { createCreature, healFull } from '../../src/shared/creature.ts'
import { C, RULES, STATS, bst } from './lib.ts'
import archetypesJson from './archetypes.json' with { type: 'json' }

export interface MemberSpec {
  species: string
  /** Up to `party.maxMoves` move ids; defaults to the species' default moves at the battle level. */
  moves?: string[]
  /** Index into the species' ability list (default 0). */
  ability?: number
  level?: number
}

export interface TeamSpec {
  id: string
  nameZh: string
  /** One-line plan: how the team is meant to win (shown in reports and docs). */
  plan: string
  members: MemberSpec[]
}

export interface ArchetypeFile {
  /** Team-building law (checked by the framework tests): a shared BST budget keeps the comparison fair. */
  budget: { members: [number, number]; maxTeamBst: number; maxMemberBst: number; maxRarityOrder: number }
  teams: TeamSpec[]
}

export const ARCHETYPES: ArchetypeFile = archetypesJson as unknown as ArchetypeFile

export type Policy = (engine: BattleEngine, side: SideIndex, rng: Rng) => BattleAction

/** The in-game trainer AI at its top level. */
export const gameAi: Policy = (engine, side, rng) => chooseAiAction(engine, side, rng)

export function buildTeam(spec: TeamSpec, level = RULES.sim.level, iv = RULES.sim.iv): Creature[] {
  const rng = new Rng(1)
  return spec.members.map((m) => {
    const lv = m.level ?? level
    const cr = createCreature(m.species, lv, { rng, shiny: false, ...(m.moves ? { moves: m.moves } : {}) }, C)
    const sp = C.species[m.species]
    cr.abilityId = sp.abilities[m.ability ?? 0] ?? sp.abilities[0] ?? ''
    for (const k of STATS) cr.ivs[k] = iv
    healFull(cr, C)
    return cr
  })
}

const cloneParty = (p: Creature[]): Creature[] => p.map((c) => structuredClone(c))

export interface BattleOutcome {
  /** 0 = first team won, 1 = second, -1 = draw (mutual KO or turn cap). */
  winner: 0 | 1 | -1
  turns: number
  /** Creatures left standing per side. */
  left: [number, number]
  capped: boolean
}

export function playBattle(a: Creature[], b: Creature[], seed: number, policy: Policy = gameAi): BattleOutcome {
  const init: BattleInit = {
    seed,
    sides: [
      { kind: 'player', name: 'A', party: cloneParty(a), aiLevel: 3 },
      { kind: 'player', name: 'B', party: cloneParty(b), aiLevel: 3 },
    ],
    isWild: false, canRun: false, canCatch: false, biome: C.biomes[0].id, timeOfDay: 'day', expGain: false,
  }
  const engine = new BattleEngine(init, C)
  const rng = new Rng(seed * 2654435761 + 97)
  engine.start()
  const cap = RULES.sim.maxTurns
  for (let guard = 0; !engine.finished && guard < cap * 3; guard++) {
    if (engine.turn >= cap) break
    for (const s of [0, 1] as const) {
      if (engine.request(s).kind === 'wait') continue
      const pick = policy(engine, s, rng)
      if (engine.choose(s, pick) !== null) {
        // The policy must never stall the battle: fall back to the first legal action.
        const req = engine.request(s)
        const party = engine.party(s)
        if (req.kind === 'switch') engine.choose(s, { kind: 'switch', partyIndex: party.findIndex((c, i) => i !== engine.activeIndex(s) && c.hp > 0) })
        else engine.choose(s, { kind: 'move', moveIndex: Math.max(0, party[engine.activeIndex(s)].moves.findIndex((m) => m.pp > 0)) })
      }
    }
    engine.step()
  }
  const alive = (s: SideIndex) => engine.party(s).filter((c) => c.hp > 0).length
  const left: [number, number] = [alive(0), alive(1)]
  const res = engine.result
  const winner: BattleOutcome['winner'] = res === 'win' ? 0 : res === 'lose' ? 1 : -1
  return { winner, turns: engine.turn, left, capped: !engine.finished }
}

export interface PairResult {
  a: string
  b: string
  n: number
  /** Wins of a, wins of b, draws. */
  w: [number, number, number]
  /** a's score: wins + half draws, over n. */
  rate: number
  meanTurns: number
  capped: number
}

/** Plays `n` battles; sides swap each game so neither team gets a fixed first-slot advantage (there is none, but the pairing stays symmetric). */
export function playPair(a: TeamSpec, b: TeamSpec, n: number, seed: number, policy: Policy = gameAi, level = RULES.sim.level): PairResult {
  const ta = buildTeam(a, level)
  const tb = buildTeam(b, level)
  const w: [number, number, number] = [0, 0, 0]
  let turns = 0
  let capped = 0
  for (let i = 0; i < n; i++) {
    const s = seed * 100003 + i * 7919 + 13
    const flip = i % 2 === 1
    const r = flip ? playBattle(tb, ta, s, policy) : playBattle(ta, tb, s, policy)
    turns += r.turns
    if (r.capped) capped += 1
    const aWon = flip ? r.winner === 1 : r.winner === 0
    const bWon = flip ? r.winner === 0 : r.winner === 1
    if (aWon) w[0] += 1
    else if (bWon) w[1] += 1
    else w[2] += 1
  }
  return { a: a.id, b: b.id, n, w, rate: (w[0] + w[2] / 2) / n, meanTurns: turns / n, capped }
}

export interface Matrix {
  ids: string[]
  /** rate[i][j] = score of team i against team j. */
  rate: number[][]
  draws: number[][]
  meanTurns: number
  n: number
}

export function runMatrix(teams: TeamSpec[], n: number, seed: number, policy: Policy = gameAi, level = RULES.sim.level): Matrix {
  const ids = teams.map((t) => t.id)
  const rate = ids.map(() => ids.map(() => 0.5))
  const draws = ids.map(() => ids.map(() => 0))
  let turns = 0
  let games = 0
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const r = playPair(teams[i], teams[j], n, seed + i * 31 + j * 17, policy, level)
      rate[i][j] = r.rate
      rate[j][i] = 1 - r.rate
      draws[i][j] = draws[j][i] = r.w[2] / n
      turns += r.meanTurns * n
      games += n
    }
  }
  return { ids, rate, draws, meanTurns: games ? turns / games : 0, n }
}

export interface MatrixVerdict {
  fieldWin: number[]
  /** Archetypes whose worst matchup is still above maxAllOpponentsWin. */
  dominant: string[]
  /** Archetypes with no favourable matchup / no unfavourable matchup (no counter-cycle role). */
  noPrey: string[]
  noCounter: string[]
  /** Archetypes whose field average is outside [minFieldWin, maxFieldWin]. */
  offBand: string[]
  maxDraw: number
  /** True when the "beats" graph (rate >= favourableWin) contains a cycle. */
  cycle: boolean
  ok: boolean
}

export function judgeMatrix(m: Matrix): MatrixVerdict {
  const R = RULES.sim
  const k = m.ids.length
  const others = (i: number) => m.rate[i].filter((_, j) => j !== i)
  const fieldWin = m.ids.map((_, i) => others(i).reduce((a, b) => a + b, 0) / (k - 1))
  const dominant = m.ids.filter((_, i) => Math.min(...others(i)) > R.maxAllOpponentsWin)
  const noPrey = m.ids.filter((_, i) => Math.max(...others(i)) < R.favourableWin)
  const noCounter = m.ids.filter((_, i) => Math.min(...others(i)) > R.unfavourableWin)
  const offBand = m.ids.filter((_, i) => fieldWin[i] < R.minFieldWin || fieldWin[i] > R.maxFieldWin)
  const maxDraw = Math.max(...m.draws.flat())
  const beats = m.ids.map((_, i) => m.ids.map((_, j) => i !== j && m.rate[i][j] >= R.favourableWin))
  // Cycle detection (DFS over the "beats" digraph).
  const state = new Array(k).fill(0)
  const dfs = (u: number): boolean => {
    state[u] = 1
    for (let v = 0; v < k; v++) {
      if (!beats[u][v]) continue
      if (state[v] === 1 || (state[v] === 0 && dfs(v))) return true
    }
    state[u] = 2
    return false
  }
  const cycle = m.ids.some((_, i) => state[i] === 0 && dfs(i))
  const ok = dominant.length === 0 && noPrey.length === 0 && noCounter.length === 0 && offBand.length === 0 && maxDraw <= R.maxDrawRate && cycle
  return { fieldWin, dominant, noPrey, noCounter, offBand, maxDraw, cycle, ok }
}

export const teamBst = (t: TeamSpec): number => t.members.reduce((a, m) => a + bst(C.species[m.species]), 0)

/** Team-building law: legal movesets, unique members, shared BST budget. Returns problems (empty = valid). */
export function validateArchetypes(file: ArchetypeFile = ARCHETYPES, legal: (speciesId: string, level: number) => Set<string>): string[] {
  const out: string[] = []
  const b = file.budget
  const ids = new Set<string>()
  for (const t of file.teams) {
    if (ids.has(t.id)) out.push(`${t.id}: duplicate team id`)
    ids.add(t.id)
    if (t.members.length < b.members[0] || t.members.length > b.members[1]) out.push(`${t.id}: ${t.members.length} members (allowed ${b.members})`)
    const seen = new Set<string>()
    for (const m of t.members) {
      const sp = C.species[m.species]
      if (!sp) { out.push(`${t.id}: unknown species ${m.species}`); continue }
      if (seen.has(m.species)) out.push(`${t.id}: ${m.species} twice`)
      seen.add(m.species)
      if (bst(sp) > b.maxMemberBst) out.push(`${t.id}: ${m.species} BST ${bst(sp)} above member cap ${b.maxMemberBst}`)
      if ((C.rarityById[sp.rarity]?.order ?? 99) > b.maxRarityOrder) out.push(`${t.id}: ${m.species} rarity ${sp.rarity} above the cap`)
      const pool = legal(m.species, m.level ?? RULES.sim.level)
      for (const mv of m.moves ?? []) if (!pool.has(mv)) out.push(`${t.id}: ${m.species} cannot learn ${mv}`)
      if ((m.moves ?? []).length > C.config.party.maxMoves) out.push(`${t.id}: ${m.species} has more than ${C.config.party.maxMoves} moves`)
    }
    const total = teamBst(t)
    if (total > b.maxTeamBst || total < b.minTeamBst) out.push(`${t.id}: team BST ${total} outside [${b.minTeamBst}, ${b.maxTeamBst}]`)
  }
  return out
}
