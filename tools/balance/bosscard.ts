// Boss-card guard (docs/design/0003 §4.2): a signed boss card kept at its badge cap must not carry the player through the
// next gym on its own. The card (every IV maxed to rules.bossCard.ivs, its signature ability and move) fights the whole
// leader team of gym `badges + 1` alone, on the real engine with the trainer's own AI level, over rules.bossCard.seeds seeds.
import type { Creature, TrainerDef } from '../../src/shared/types.ts'
import { Rng } from '../../src/shared/rng.ts'
import { createCreature, defaultMoves, healFull } from '../../src/shared/creature.ts'
import { bossCardCap } from '../../src/shared/gameplay/bosscard.ts'
import { BattleEngine } from '../../src/shared/battle/engine.ts'
import { chooseAiAction } from '../../src/shared/battle/ai.ts'
import { buildWorld } from '../../src/shared/world/index.ts'
import { C, RULES, STATS, pct, table } from './lib.ts'
import { gymRows } from './curve.ts'
import { pilot } from './pilot.ts'

export interface BossCardRow { badges: number; cap: number; gym: string; leader: string; leaderTop: number; win: number; seeds: number }

let worldCache: ReturnType<typeof buildWorld> | null = null

/** The boss card at `level`: opening moves with the signature move in the last slot, signature ability, all IVs maxed. */
export function cardAt(level: number, rng: Rng, ability: string | null = C.bosses[RULES.bossCard.boss].signature?.ability ?? null): Creature {
  const R = RULES.bossCard
  const def = C.bosses[R.boss]
  const moves = defaultMoves(def.species, level, C)
  const sig = def.signature?.move
  if (sig && !moves.includes(sig)) moves[Math.min(moves.length, C.config.party.maxMoves) - 1] = sig
  const cr = createCreature(def.species, level, { rng, shiny: false, moves }, C)
  for (const k of STATS) cr.ivs[k] = R.ivs
  if (ability) cr.abilityId = ability
  healFull(cr, C)
  return cr
}

function leaderTeam(tr: TrainerDef, rng: Rng): Creature[] {
  return tr.party.map((e) => {
    const cr = createCreature(e.species ?? '', e.level, { rng, otName: tr.nameZh, otId: tr.id, ...(e.moves?.length ? { moves: e.moves } : {}) }, C)
    healFull(cr, C)
    return cr
  })
}

/** One solo fight: a competent player (pilot) with the card against the leader's team under the trainer's AI. true = the card won. */
export function cardWins(tr: TrainerDef, level: number, seed: number, ability?: string | null): boolean {
  const rng = new Rng(seed)
  const foes = leaderTeam(tr, rng)
  const me = cardAt(level, rng, ability)
  const engine = new BattleEngine({
    seed: seed * 7919 + 13,
    sides: [{ kind: 'player', name: 'card', party: [me] }, { kind: 'trainer', name: tr.nameZh, party: foes, aiLevel: tr.aiLevel }],
    isWild: false, canRun: false, canCatch: false, biome: C.biomes[0].id, timeOfDay: 'day', expGain: false,
  }, C)
  engine.start()
  for (let guard = 0; !engine.finished && guard < RULES.sim.maxTurns * 3; guard++) {
    if (engine.request(0).kind === 'wait') { if (!engine.ready()) break; engine.step(); continue }
    if (engine.choose(0, pilot(engine, 0, rng)) !== null) engine.choose(0, chooseAiAction(engine, 0, rng, C))
    engine.step()
  }
  return engine.result === 'win'
}

export function bossCardRows(seeds = RULES.bossCard.seeds): BossCardRow[] {
  const world = (worldCache ??= buildWorld())
  const gyms = gymRows()
  return RULES.bossCard.badges.map((badges) => {
    const cap = bossCardCap(badges, C)
    const gym = gyms[badges]
    const tr = world.trainers[gym.leader]
    let wins = 0
    for (let i = 0; i < seeds; i++) if (cardWins(tr, cap, 1 + i * 131)) wins++
    return { badges, cap, gym: gym.gym, leader: gym.leader, leaderTop: gym.top, win: wins / seeds, seeds }
  })
}

export function bossCardViolations(rows: BossCardRow[] = bossCardRows()): string[] {
  return rows.filter((r) => r.win > RULES.bossCard.maxWin).map((r) => `${r.badges} badges: the Lv${r.cap} card beats the ${r.gym} gym alone ${pct(r.win)} of the time (max ${pct(RULES.bossCard.maxWin)})`)
}

export function report(): string {
  const rows = bossCardRows()
  const lines = [`== boss card at its badge cap vs the next gym's whole leader team (solo, ${RULES.bossCard.seeds} seeds, IVs ${RULES.bossCard.ivs}, signature ability) ==`]
  lines.push(table(['badges', 'card', 'next gym', 'leader top', 'card wins'], rows.map((r) => [r.badges, `Lv${r.cap}`, r.gym, `Lv${r.leaderTop}`, pct(r.win)])))
  const bad = bossCardViolations(rows)
  lines.push('', bad.length ? bad.map((b) => `!! ${b}`).join('\n') : `all within ${pct(RULES.bossCard.maxWin)}`)
  return lines.join('\n')
}
