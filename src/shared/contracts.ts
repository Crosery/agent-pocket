// Contracts for the shared (isomorphic) modules. Implementations must export exactly these names.
//
// ALL game data comes from content/**/*.json through src/shared/content/index.ts (CONTENT, t(), helpers).
// Code must never embed data tables, names, numbers to tune, or player-facing strings.
//
//   src/shared/rng.ts            -> export class Rng implements IRng ; export function hashString(s): number
//   src/shared/creature.ts       -> functions in CreatureApi (named exports); optional last param c: Content = CONTENT
//   src/shared/battle/engine.ts  -> export class BattleEngine implements IBattleEngine (constructor(init, c: Content = CONTENT)) ; export function perspective(...)
//   src/shared/battle/ai.ts      -> export function chooseAiAction(engine: IBattleEngine, side: SideIndex, rng: IRng): BattleAction
//   src/shared/world/index.ts    -> export function buildWorld(seed = CONTENT.config.world.seed): World  (layout/story data in content/world/**)
//   src/shared/world/collision.ts-> functions in CollisionApi (named exports) — finite maps only (legacy)
//   src/shared/world/worldapi.ts -> functions in WorldApi (named exports) — works for finite AND infinite maps; prefer it everywhere
import type {
  BattleAction, BattleEvent, BattleInit, BattleRequest, BattleResult, Creature, CreatureView,
  GameMap, SideIndex, Stats, TypeId, WeatherId, GrowthRate,
} from './types.ts'

export interface IRng {
  /** float in [0,1) */
  next(): number
  /** integer in [min, max] inclusive */
  int(min: number, max: number): number
  chance(p: number): boolean
  pick<T>(arr: readonly T[]): T
  weighted<T>(items: readonly T[], weight: (t: T) => number): T
  readonly seed: number
}

export interface CreatureApi {
  /** Standard formula (constants from CONTENT.config): hp = floor((2B+IV)*L/100)+L+10 ; other = floor((2B+IV)*L/100)+5 */
  calcStats(c: Pick<Creature, 'speciesId' | 'level' | 'ivs'>): Stats
  maxHp(c: Creature): number
  expForLevel(growth: GrowthRate, level: number): number
  /** Creates a creature with level-appropriate moves (last 4 learnable), random IVs, full HP. */
  createCreature(speciesId: string, level: number, opts: {
    rng: IRng; shiny?: boolean; otName?: string; otId?: string; ballId?: string; caughtMap?: string; moves?: string[]
  }): Creature
  /** Adds exp; returns level-ups and moves learnt/learnable along the way (does not evolve). */
  gainExp(c: Creature, amount: number): { levels: number[]; learned: string[]; learnable: string[] }
  /** Species id it can evolve into right now (level reached), or null. */
  evolutionTarget(c: Creature): string | null
  /** Mutates into the new species, keeps hp ratio, recalculates stats, learns stage moves. */
  evolve(c: Creature, toSpeciesId: string): void
  healFull(c: Creature): void
  toView(c: Creature): CreatureView
  /** Exp yielded by defeating `defeated` (trainer battles x1.5). */
  expYield(defeated: Creature, trainer: boolean): number
  /** Validate & repair a creature from untrusted input (server/import). Returns null if unrecoverable. */
  sanitizeCreature(raw: unknown): Creature | null
  /** Shiny rate from CONTENT.config.battle.shinyRate. */
  rollShiny(rng: IRng): boolean
  newUid(rng: IRng): string
}

export interface IBattleEngine {
  readonly init: BattleInit
  readonly turn: number
  readonly finished: boolean
  readonly result: BattleResult | null
  readonly weather: WeatherId
  /** The creature caught this battle, if any. */
  readonly caught: Creature | null
  /** Live party arrays (mutated in place: hp, status, pp, exp, level, moves). */
  party(side: SideIndex): Creature[]
  activeIndex(side: SideIndex): number
  activeView(side: SideIndex): CreatureView
  /** Stage modifiers of the active creature (-6..6). */
  stages(side: SideIndex): Record<string, number>
  /** Intro events (send-outs, entry abilities). Call once. */
  start(): BattleEvent[]
  request(side: SideIndex): BattleRequest
  /** Queue an action. Returns null if accepted, otherwise a Chinese error message. AI sides (wild/trainer) choose automatically. */
  choose(side: SideIndex, action: BattleAction): string | null
  /** True when every side that must act has an action queued. */
  ready(): boolean
  /** Resolve the queued turn (or forced switches). Events are in absolute side indices. */
  step(): BattleEvent[]
}

export interface CollisionApi {
  /** Precompute per-tile blocking from terrain + props + elevation. 1 = blocked. */
  buildCollision(map: GameMap): Uint8Array
  /** Can an entity move from tile (fx,fy) to adjacent/diagonal tile (tx,ty)? Honors elevation (only via stairs), water (needs surf). */
  canStep(map: GameMap, collision: Uint8Array, fx: number, fy: number, tx: number, ty: number, opts: { surf: boolean }): boolean
  terrainAt(map: GameMap, x: number, y: number): number
  elevationAt(map: GameMap, x: number, y: number): number
  regionAt(map: GameMap, x: number, y: number): number
}

export type { TypeId }

/** Tile/object access that works for both finite maps and the infinite (ChunkProvider) overworld. */
export interface CollisionField {
  readonly map: GameMap
  /** 0 free, 1 blocked, 2 water (enterable while surfing). Generates chunks on demand for infinite maps. */
  at(x: number, y: number): number
}

export interface WorldApi {
  /** world.maps[id] or a lazily generated frontier interior/dungeon (cached into world.maps). */
  getMap(world: import('./types.ts').World, id: string): GameMap | null
  isInfinite(map: GameMap): boolean
  terrainAt(map: GameMap, x: number, y: number): number
  elevationAt(map: GameMap, x: number, y: number): number
  regionAt(map: GameMap, x: number, y: number): import('./types.ts').RegionDef | null
  collisionField(map: GameMap): CollisionField
  /** 8-dir step rules: same level, stairs (±1 along stairs axis), ledge drop (exactly -1, one-way), surf for water. */
  canStep(map: GameMap, field: CollisionField, fx: number, fy: number, tx: number, ty: number, opts: { surf: boolean }): boolean
  /** All objects anchored inside the tile rect [x0,x1) x [y0,y1) (chunks generated on demand). */
  objectsInRect(map: GameMap, x0: number, y0: number, x1: number, y1: number): {
    props: import('./types.ts').PropPlacement[]; npcs: import('./types.ts').NpcDef[]; signs: import('./types.ts').SignDef[]
    items: import('./types.ts').GroundItemDef[]; warps: import('./types.ts').Warp[]; lights: import('./types.ts').LightDef[]
    places: import('./types.ts').TownDef[]
  }
  warpAt(map: GameMap, x: number, y: number): import('./types.ts').Warp | null
  /** Distance in tiles from the world origin (start town) — drives frontier difficulty & rarity. */
  distanceFromOrigin(world: import('./types.ts').World, x: number, y: number): number
}
