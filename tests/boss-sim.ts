// Boss battle simulator shared by tests/boss.test.ts and scripts/boss-sim.ts: plays a whole fight with a scripted
// player (the shared level-3 AI, optionally with the boss's counter strategy on top) and reports the outcome.
import type { BattleAction, BattleRequest, Creature, MoveDef, SideIndex } from '../src/shared/types.ts'
import { CONTENT, type Content } from '../src/shared/content/index.ts'
import { Rng } from '../src/shared/rng.ts'
import { createCreature, maxHp } from '../src/shared/creature.ts'
import { BattleEngine } from '../src/shared/battle/engine.ts'
import { chooseAiAction } from '../src/shared/battle/ai.ts'
import { estimateDamage, isDamaging, toStages, type Fighter } from '../src/shared/battle/formulas.ts'
import { startBossBattle } from '../src/shared/battle/boss-battle.ts'

export interface SimResult { won: boolean; result: string | null; turns: number; baits: number; bossForms: string[] }

/** A "reasonable" late-game team: four 4-star creatures with mixed types, countries and coverage. */
export const SIM_PARTY = ['gpt-5-6', 'kling-4', 'google-antigravity', 'qwen-audio']
/** Medicine every simulated player carries (the AI heals when low). */
export const SIM_BAG: Record<string, number> = { 'hyper-cache': 5, 'full-cache': 2, 'full-restore': 2 }

export function makeParty(ids: readonly string[], level: number, seed: number, c: Content = CONTENT): Creature[] {
  const rng = new Rng(seed ^ 0x9e3779b1)
  return ids.map((id) => {
    const cr = createCreature(id, level, { rng, shiny: false }, c)
    for (const k of Object.keys(cr.ivs) as (keyof Creature['ivs'])[]) cr.ivs[k] = c.config.creature.ivMax
    cr.hp = maxHp(cr, c)
    return cr
  })
}

export interface Helpers {
  engine: BattleEngine
  rng: Rng
  req: Extract<BattleRequest, { kind: 'action' }>
  bag: Record<string, number>
  state: NonNullable<ReturnType<BattleEngine['extractBossState']>>
  active: Creature
  /** Damaging move slots of the active creature, best expected damage first. */
  attacks(): { index: number; move: MoveDef; dmg: number }[]
  /** Uses a bait item if the stock lasts. */
  bait(id: string): BattleAction | null
  moveOfKind(pred: (m: MoveDef) => boolean): number
}

export type Policy = (h: Helpers) => BattleAction | null

const SIDE: SideIndex = 0

function fighter(e: BattleEngine, side: SideIndex): Fighter {
  const cr = e.party(side)[e.activeIndex(side)]
  return { creature: cr, level: cr.level, stats: e.fighterStats(side), stages: toStages(e.stages(side)), critStageAdd: 0 }
}

function helpers(engine: BattleEngine, rng: Rng, req: Extract<BattleRequest, { kind: 'action' }>, bag: Record<string, number>, c: Content): Helpers {
  const active = engine.party(SIDE)[engine.activeIndex(SIDE)]
  const state = engine.extractBossState()
  if (!state) throw new Error('not a boss battle')
  return {
    engine, rng, req, bag, state, active,
    attacks() {
      const me = fighter(engine, 0)
      const foe = fighter(engine, 1)
      const out: { index: number; move: MoveDef; dmg: number }[] = []
      active.moves.forEach((slot, index) => {
        const move = c.moves[slot.id]
        if (!move || slot.pp <= 0 || !isDamaging(move)) return
        out.push({ index, move, dmg: estimateDamage(me, foe, move, engine.weather, c).avg * (move.accuracy === 0 ? 1 : move.accuracy / 100) })
      })
      return out.sort((a, b) => b.dmg - a.dmg)
    },
    bait(id) {
      if (!req.canItem || (bag[id] ?? 0) <= 0) return null
      bag[id] -= 1
      return { kind: 'item', itemId: id, partyIndex: engine.activeIndex(SIDE) }
    },
    moveOfKind(pred) {
      return active.moves.findIndex((slot) => slot.pp > 0 && c.moves[slot.id] && pred(c.moves[slot.id]))
    },
  }
}

export interface SimOpts {
  bossId: string
  seed: number
  partyIds?: readonly string[]
  level?: number
  bossLevel?: number
  /** Counter strategy on top of the shared AI (undefined = plain AI). */
  policy?: Policy
  bag?: Record<string, number>
  maxTurns?: number
  c?: Content
}

export function simulate(o: SimOpts): SimResult {
  const c = o.c ?? CONTENT
  const def = c.bosses[o.bossId]
  const level = o.level ?? (o.bossLevel ?? def.level) - 2
  const party = makeParty(o.partyIds ?? SIM_PARTY, level, o.seed, c)
  const bag = { ...SIM_BAG, ...(o.bag ?? {}) }
  const { engine } = startBossBattle(o.bossId, party, { seed: o.seed, autoPlayer: true, items: SIM_BAG, expGain: false, c, ...(o.bossLevel ? { level: o.bossLevel } : {}) })
  const rng = new Rng(o.seed ^ 0x2545f491)
  const forms: string[] = [engine.extractBossState()?.form ?? '']
  let baits = 0
  for (let guard = 0; !engine.finished && guard < (o.maxTurns ?? 120) * 3; guard++) {
    const req = engine.request(SIDE)
    if (req.kind === 'wait') {
      if (!engine.ready()) break
      engine.step()
      continue
    }
    let action: BattleAction | null = null
    if (req.kind === 'action' && o.policy) {
      action = o.policy(helpers(engine, rng, req, bag, c))
      if (action?.kind === 'item') baits += 1
    }
    action ??= chooseAiAction(engine, SIDE, rng, c)
    if (engine.choose(SIDE, action) !== null) engine.choose(SIDE, chooseAiAction(engine, SIDE, rng, c))
    engine.step()
    const f = engine.extractBossState()?.form
    if (f && forms[forms.length - 1] !== f) forms.push(f)
    if (engine.turn >= (o.maxTurns ?? 120)) break
  }
  return { won: engine.result === 'win', result: engine.result, turns: engine.turn, baits, bossForms: forms }
}

export function winRate(o: Omit<SimOpts, 'seed'>, seeds: number, from = 1): { rate: number; turns: number; wins: number; baits: number } {
  let wins = 0
  let turns = 0
  let baits = 0
  for (let i = 0; i < seeds; i++) {
    const r = simulate({ ...o, seed: from + i * 7919 })
    if (r.won) wins += 1
    turns += r.turns
    baits += r.baits
  }
  return { rate: wins / seeds, turns: turns / seeds, wins, baits: baits / seeds }
}
