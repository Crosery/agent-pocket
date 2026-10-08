// Headless team-vs-team simulator on the shared battle engine.
// Both sides are piloted by the same policy (default: the in-game AI at its highest level), so a matchup measures
// the data (stats, moves, abilities, types) and not a player. Fully deterministic per (teamA, teamB, seed).
import type { BattleAction, BattleInit, Creature, SideIndex } from '../../src/shared/types.ts'
import { BattleEngine } from '../../src/shared/battle/engine.ts'
import { chooseAiAction } from '../../src/shared/battle/ai.ts'
import { Rng } from '../../src/shared/rng.ts'
import { createCreature, healFull } from '../../src/shared/creature.ts'
import { pilot } from './pilot.ts'
import { C, RULES, STATS, bst } from './lib.ts'

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
  /** Species that always leads (a weather setter opens the battle); the rest of the roster is shuffled. */
  lead?: string
}

export type Policy = (engine: BattleEngine, side: SideIndex, rng: Rng) => BattleAction

/** The in-game trainer AI at its top level. */
export const gameAi: Policy = (engine, side, rng) => chooseAiAction(engine, side, rng)
/** Default policy of the matrix: a competent player (tools/balance/pilot.ts). */
export const pilotPolicy: Policy = pilot

export function buildTeam(spec: TeamSpec, level = RULES.sim.level, seed = 1): Creature[] {
  const rng = new Rng(seed)
  return spec.members.map((m) => {
    const lv = m.level ?? level
    const cr = createCreature(m.species, lv, { rng, shiny: false, ...(m.moves ? { moves: m.moves } : {}) }, C)
    const sp = C.species[m.species]
    cr.abilityId = sp.abilities[m.ability ?? 0] ?? sp.abilities[0] ?? ''
    // IVs are rolled like in the game (uniform 0..ivMax) so speed ties and near-ties are genuinely random.
    for (const k of STATS) cr.ivs[k] = rng.int(0, C.config.creature.ivMax)
    healFull(cr, C)
    return cr
  })
}

function shuffled<T>(xs: T[], rng: Rng): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
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

export function playBattle(a: Creature[], b: Creature[], seed: number, policy: Policy = pilotPolicy): BattleOutcome {
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

/** Source of concrete team instances: archetype id + variant number -> team (variant 0 is the canonical team). */
export type TeamSource = (id: string, variant: number) => TeamSpec

const built = new Map<string, { party: Creature[]; lead?: string }>()
function partyOf(src: TeamSource, id: string, variant: number, level: number): { party: Creature[]; lead?: string } {
  const key = `${id}#${variant}@${level}`
  let p = built.get(key)
  if (!p) { const spec = src(id, variant); p = { party: buildTeam(spec, level, variant * 131 + 7), lead: spec.lead }; built.set(key, p) }
  return p
}

/** Shuffles a roster; a designated lead species is moved to the front. */
function arrange(t: { party: Creature[]; lead?: string }, rng: Rng): Creature[] {
  const out = shuffled(t.party, rng)
  const i = t.lead ? out.findIndex((c) => c.speciesId === t.lead) : -1
  if (i > 0) out.unshift(...out.splice(i, 1))
  return out
}

/**
 * Plays `n` battles between two archetypes. Game i fields variant i of each archetype (a fresh, legal team instance),
 * shuffles both rosters (lead order is part of play) and swaps seats on odd games.
 */
export function playPair(src: TeamSource, a: string, b: string, n: number, seed: number, policy: Policy = pilotPolicy, level = RULES.sim.level, variants = RULES.sim.variants): PairResult {
  const w: [number, number, number] = [0, 0, 0]
  let turns = 0
  let capped = 0
  for (let i = 0; i < n; i++) {
    const s = seed * 100003 + i * 7919 + 13
    const ta = partyOf(src, a, i % variants, level)
    const tb = partyOf(src, b, (i + 1 + Math.floor(i / variants)) % variants, level)
    const flip = i % 2 === 1
    const sh = new Rng(s ^ 0x5bd1e995)
    const xa = arrange(ta, sh)
    const xb = arrange(tb, sh)
    const r = flip ? playBattle(xb, xa, s, policy) : playBattle(xa, xb, s, policy)
    turns += r.turns
    if (r.capped) capped += 1
    const aWon = flip ? r.winner === 1 : r.winner === 0
    const bWon = flip ? r.winner === 0 : r.winner === 1
    if (aWon) w[0] += 1
    else if (bWon) w[1] += 1
    else w[2] += 1
  }
  return { a, b, n, w, rate: (w[0] + w[2] / 2) / n, meanTurns: turns / n, capped }
}

export interface Matrix {
  ids: string[]
  /** rate[i][j] = score of archetype i against archetype j. */
  rate: number[][]
  draws: number[][]
  meanTurns: number
  n: number
}

export function runMatrix(src: TeamSource, ids: string[], n: number, seed: number, policy: Policy = pilotPolicy, level = RULES.sim.level, variants = RULES.sim.variants): Matrix {
  const rate = ids.map(() => ids.map(() => 0.5))
  const draws = ids.map(() => ids.map(() => 0))
  let turns = 0
  let games = 0
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const r = playPair(src, ids[i], ids[j], n, seed + i * 31 + j * 17, policy, level, variants)
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


