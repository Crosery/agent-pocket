// Entry points for boss fights: builds a BattleInit for a BossDef and starts the engine. The overworld calls
// buildBossInit() for legend / story encounters; dungeons and co-op raids (#28) call startBossBattle() with the
// party of each player (one engine instance per player, boss state shared through extractBossState()/applyBossState()).
import type { BattleEvent, BattleInit, BattleSideInit, Creature, TimeOfDay, WeatherId } from '../types.ts'
import { CONTENT, type Content } from '../content/index.ts'
import { Rng } from '../rng.ts'
import { createCreature, maxHp } from '../creature.ts'
import { BattleEngine } from './engine.ts'

export interface BossBattleOpts {
  seed: number
  /** Boss level (default: BossDef.level). */
  level?: number
  playerName?: string
  playerSprite?: string
  biome?: string
  timeOfDay?: TimeOfDay
  weather?: WeatherId
  /** Items the player side carries (only the AI-driven player side of simulations reads them; humans own their bag). */
  items?: Record<string, number>
  /** Let the player side be driven by the shared AI (simulations, raid auto-pilot). */
  autoPlayer?: boolean
  expGain?: boolean
  /** Existing boss creature (e.g. the roaming legend); default: a fresh one with max IVs and the opening form's moves. */
  boss?: Creature
  c?: Content
}

/** The boss creature of a BossDef: the species at `level`, max IVs, never shiny. */
export function createBossCreature(bossId: string, level: number, rng: Rng, c: Content = CONTENT): Creature {
  const def = c.bosses[bossId]
  if (!def) throw new Error(`unknown boss "${bossId}"`)
  const cr = createCreature(def.species, level, { rng, shiny: false, nature: c.quality.npcNature, moves: def.forms[def.initialForm]?.moves }, c)
  for (const k of Object.keys(cr.ivs) as (keyof Creature['ivs'])[]) cr.ivs[k] = c.config.creature.ivMax
  cr.hp = Math.max(1, maxHp(cr, c))
  return cr
}

export function buildBossInit(bossId: string, party: Creature[], o: BossBattleOpts): BattleInit {
  const c = o.c ?? CONTENT
  const def = c.bosses[bossId]
  if (!def) throw new Error(`unknown boss "${bossId}"`)
  const boss = o.boss ?? createBossCreature(bossId, o.level ?? def.level, new Rng(o.seed ^ 0x5bd1e995), c)
  const player: BattleSideInit = {
    kind: 'player', name: o.playerName ?? '', party,
    ...(o.playerSprite ? { sprite: o.playerSprite } : {}),
    ...(o.autoPlayer ? { aiLevel: 3 as const } : {}),
    ...(o.items ? { items: { ...o.items } } : {}),
  }
  return {
    seed: o.seed,
    sides: [player, { kind: 'wild', name: boss.nickname ?? '', party: [boss], aiLevel: 3, boss: bossId }],
    isWild: true,
    canRun: def.canRun,
    canCatch: true,
    biome: o.biome ?? c.biomes[0]?.id ?? '',
    timeOfDay: o.timeOfDay ?? 'day',
    ...(o.weather ? { weather: o.weather } : {}),
    expGain: o.expGain ?? true,
  }
}

/** Builds the fight and plays the intro. The caller drives it with choose()/step(). */
export function startBossBattle(bossId: string, party: Creature[], o: BossBattleOpts): { engine: BattleEngine; init: BattleInit; intro: BattleEvent[] } {
  const init = buildBossInit(bossId, party, o)
  const engine = new BattleEngine(init, o.c ?? CONTENT)
  return { engine, init, intro: engine.start() }
}
