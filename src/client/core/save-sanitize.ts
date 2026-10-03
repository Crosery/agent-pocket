// Strict validation / repair of untrusted save data (localStorage, import codes, older versions).
// Pure: no DOM. Data comes from CONTENT; the world (maps, badges) and the creature sanitizer are injected.
// Positions on the infinite overworld may be any integer tile (bounded by explore.json save.maxCoord); lazily
// generated frontier interiors / dungeon floors (fx:… ids) are resolved through WorldApi.getMap.
import type { Creature, Dir, SaveData, Settings, World } from '../../shared/types.ts'
import type { Content } from '../../shared/content/index.ts'
import { sanitizeEventState } from '../../shared/gameplay/events.ts'
import { sanitizeResearch } from '../../shared/gameplay/research.ts'
import { sanitizeLegendState } from '../../shared/gameplay/spawns.ts'
import { frontierQuest } from '../../shared/world/frontier/content/index.ts'
import { parseFrontierId } from '../../shared/world/frontier/sites.ts'
import { getMap, isInfinite } from '../../shared/world/worldapi.ts'
import { FogPages } from '../ui/fog.ts'
import { EXPLORE } from '../world/explore-config.ts'

/** Schema literals (mirrors types.ts unions — structure, not data). */
const DIRS: readonly Dir[] = ['down', 'left', 'right', 'up']
const TEXT_SPEEDS: readonly Settings['textSpeed'][] = ['slow', 'normal', 'fast', 'instant']
const TOUCH_MODES: readonly Settings['touchControls'][] = ['auto', 'on', 'off']
const SAVE_STAT_KEYS: readonly (keyof SaveData['stats'])[] = ['battlesWon', 'caught', 'steps', 'pvpWins', 'pvpLosses', 'trades', 'shiniesFound']

export type Place = SaveData['position']

export interface SanitizeContext {
  content: Content
  /** Present when the generated world is available; enables map / coordinate / badge checks. */
  world: World | null
  sanitizeCreature: (raw: unknown) => Creature | null
  defaultName: string
  now: () => number
  newId: () => string
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const nonNegInt = (v: unknown, fallback = 0): number => {
  const n = num(v)
  return n === null || n < 0 ? fallback : Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER)
}
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const clamp01 = (v: unknown, fallback: number): number => {
  const n = num(v)
  return n === null ? fallback : Math.min(1, Math.max(0, n))
}
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback)

function uniqueStrings(v: unknown, accept: (s: string) => boolean = () => true): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of v) if (typeof x === 'string' && x && !seen.has(x) && accept(x)) { seen.add(x); out.push(x) }
  return out
}

export function playableAvatars(c: Content): string[] {
  const playable = c.characters.filter((ch) => ch.playable).map((ch) => ch.id)
  return playable.length ? playable : c.characters.map((ch) => ch.id)
}

export function sanitizeName(raw: unknown, c: Content, fallback: string): string {
  const s = (str(raw) ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  const cut = [...s].slice(0, Math.max(1, c.config.net.nameMaxLen)).join('')
  return cut || fallback
}

export function sanitizeSettings(raw: unknown, c: Content): Settings {
  const d = c.config.defaultSettings
  const r = isObj(raw) ? raw : {}
  const qualities = Object.keys(c.config.render.internalHeight) as Settings['quality'][]
  const pixelScale = num(r.pixelScale)
  return {
    bgmVolume: clamp01(r.bgmVolume, d.bgmVolume),
    sfxVolume: clamp01(r.sfxVolume, d.sfxVolume),
    quality: oneOf(r.quality, qualities, d.quality),
    pixelScale: pixelScale !== null && pixelScale >= 1 ? pixelScale : d.pixelScale,
    dof: bool(r.dof, d.dof),
    bloom: bool(r.bloom, d.bloom),
    shadows: bool(r.shadows, d.shadows),
    textSpeed: oneOf(r.textSpeed, TEXT_SPEEDS, d.textSpeed),
    showMinimap: bool(r.showMinimap, d.showMinimap),
    showNames: bool(r.showNames, d.showNames),
    autoRun: bool(r.autoRun, d.autoRun),
    touchControls: oneOf(r.touchControls, TOUCH_MODES, d.touchControls),
  }
}

/** Spawn of the world's start map, else of the first map. */
export function worldSpawn(world: World | null): Place {
  if (world) {
    const map = world.maps[world.startMap] ?? Object.values(world.maps)[0]
    if (map) return { map: map.id, x: map.spawn.x, y: map.spawn.y, facing: map.spawn.facing }
  }
  return { map: '', x: 0, y: 0, facing: DIRS[0] }
}

export function sanitizePlace(raw: unknown, world: World | null, fallback: Place): Place {
  if (!isObj(raw)) return { ...fallback }
  const map = str(raw.map)
  const x = num(raw.x)
  const y = num(raw.y)
  if (!map || x === null || y === null) return { ...fallback }
  const place: Place = { map, x: Math.floor(x), y: Math.floor(y), facing: oneOf(raw.facing, DIRS, fallback.facing) }
  if (world) {
    const m = getMap(world, map)
    if (!m) return { ...fallback }
    if (isInfinite(m)) {
      const lim = EXPLORE.save.maxCoord
      if (Math.abs(place.x) > lim || Math.abs(place.y) > lim) return { ...fallback }
    } else if (place.x < 0 || place.y < 0 || place.x >= m.width || place.y >= m.height) return { ...fallback }
  }
  return place
}

/** A place id of the world (story town / hamlet / landmark) or a frontier site id ('fx:<kind>:<sx>:<sy>'). */
function placeIdOk(id: string, townIds: Set<string> | null): boolean {
  if (!townIds || townIds.has(id)) return true
  const fx = parseFrontierId(id)
  return !!fx && fx.part === null
}

/** Optional exploration / gameplay state: only keys present in the raw save are emitted (stable round trips). */
function sanitizeExtras(raw: Obj, townIds: Set<string> | null, c: Content): Partial<SaveData> {
  const out: Partial<SaveData> = {}
  if ('discoveredPlaces' in raw) out.discoveredPlaces = uniqueStrings(raw.discoveredPlaces, (id) => placeIdOk(id, townIds)).slice(0, EXPLORE.discover.maxSaved)
  const dist = num(raw.maxDistance)
  if (dist !== null && dist >= 0) out.maxDistance = Math.floor(dist)
  if (typeof raw.explored === 'string' && FogPages.decode(raw.explored, c.config.world.chunk, EXPLORE.fog.pageCells, EXPLORE.fog.maxPages)) out.explored = raw.explored
  if ('events' in raw) out.events = sanitizeEventState(raw.events)
  if ('legends' in raw) out.legends = sanitizeLegendState(raw.legends)
  if ('research' in raw) out.research = sanitizeResearch(raw.research, undefined, c)
  return out
}

function sanitizeBag(raw: unknown, c: Content): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isObj(raw)) return out
  for (const [id, qty] of Object.entries(raw)) {
    const n = nonNegInt(qty)
    if (c.items[id] && n > 0) out[id] = n
  }
  return out
}

function sanitizeFlags(raw: unknown): SaveData['flags'] {
  const out: SaveData['flags'] = {}
  if (!isObj(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v
  }
  return out
}

function sanitizeQuests(raw: unknown, world: World | null): SaveData['quests'] {
  const out: SaveData['quests'] = {}
  if (!isObj(raw)) return out
  const known = world ? new Map(world.quests.map((q) => [q.id, q])) : null
  for (const [id, v] of Object.entries(raw)) {
    if (!isObj(v)) continue
    // frontier bounties ('<hamletSiteId>:bounty-<k>') are rebuilt from their id and registered into world.quests
    const def = known?.get(id) ?? (world ? frontierQuest(world, id) ?? undefined : undefined)
    if (known && !def) continue
    let stage = nonNegInt(v.stage)
    if (def && def.stages.length) stage = Math.min(stage, def.stages.length - 1)
    out[id] = { stage, done: bool(v.done, false) }
  }
  return out
}

function sanitizeStringRecord(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isObj(raw)) return out
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v
  return out
}

function sanitizeStats(raw: unknown): SaveData['stats'] {
  const r = isObj(raw) ? raw : {}
  const out = {} as SaveData['stats']
  for (const k of SAVE_STAT_KEYS) out[k] = nonNegInt(r[k])
  return out
}

/** Party + boxes: invalid creatures dropped, duplicate uids dropped, party overflow moved into free box slots. */
function sanitizeCreatures(rawParty: unknown, rawBoxes: unknown, ctx: SanitizeContext): { party: Creature[]; boxes: Creature[][] } {
  const { maxParty, boxCount, boxSize } = ctx.content.config.party
  const seen = new Set<string>()
  const take = (raw: unknown): Creature | null => {
    const cr = ctx.sanitizeCreature(raw)
    if (!cr || seen.has(cr.uid)) return null
    seen.add(cr.uid)
    return cr
  }
  const party: Creature[] = []
  const overflow: Creature[] = []
  for (const raw of Array.isArray(rawParty) ? rawParty : []) {
    const cr = take(raw)
    if (cr) (party.length < maxParty ? party : overflow).push(cr)
  }
  const boxes: Creature[][] = Array.from({ length: boxCount }, () => [])
  const srcBoxes = Array.isArray(rawBoxes) ? rawBoxes : []
  srcBoxes.forEach((box, bi) => {
    if (!Array.isArray(box)) return
    for (const raw of box) {
      const cr = take(raw)
      if (!cr) continue
      if (bi < boxCount && boxes[bi].length < boxSize) boxes[bi].push(cr)
      else overflow.push(cr)
    }
  })
  for (const cr of overflow) {
    const box = boxes.find((b) => b.length < boxSize)
    if (!box) break
    box.push(cr)
  }
  return { party, boxes }
}

/** Returns a well-formed SaveData or null when the input is not recognisably a save. */
export function sanitizeSaveData(raw: unknown, ctx: SanitizeContext): SaveData | null {
  if (!isObj(raw)) return null
  const c = ctx.content
  // A save must at least carry its identity and progression containers.
  if (typeof raw.version !== 'number' || !('party' in raw) || !('position' in raw)) return null

  const avatars = playableAvatars(c)
  const avatar = str(raw.avatar)
  const spawn = worldSpawn(ctx.world)
  const position = sanitizePlace(raw.position, ctx.world, spawn)
  const respawn = sanitizePlace(raw.respawn, ctx.world, position)
  const { party, boxes } = sanitizeCreatures(raw.party, raw.boxes, ctx)

  const speciesOk = (id: string) => id in c.species
  const dexCaught = uniqueStrings(raw.dexCaught, speciesOk)
  const dexSeen = uniqueStrings([...(Array.isArray(raw.dexSeen) ? raw.dexSeen : []), ...dexCaught], speciesOk)
  const badgeIds = ctx.world ? new Set(ctx.world.badges.map((b) => b.id)) : null
  const townIds = ctx.world ? new Set(ctx.world.towns.map((t) => t.id)) : null
  const quests = sanitizeQuests(raw.quests, ctx.world)
  const tracked = str(raw.trackedQuest)
  const clock = num(raw.clockMinutes)

  const save: SaveData = {
    version: c.config.save.version,
    playerId: str(raw.playerId) || ctx.newId(),
    name: sanitizeName(raw.name, c, ctx.defaultName),
    avatar: avatar && avatars.includes(avatar) ? avatar : avatars[0] ?? '',
    createdAt: nonNegInt(raw.createdAt, ctx.now()),
    playTimeSec: nonNegInt(raw.playTimeSec),
    money: nonNegInt(raw.money),
    badges: uniqueStrings(raw.badges, (b) => !badgeIds || badgeIds.has(b)),
    party,
    boxes,
    bag: sanitizeBag(raw.bag, c),
    dexSeen,
    dexCaught,
    position,
    respawn,
    flags: sanitizeFlags(raw.flags),
    quests,
    visitedTowns: uniqueStrings(raw.visitedTowns, (id) => placeIdOk(id, townIds)),
    exploredChunks: sanitizeStringRecord(raw.exploredChunks),
    repelSteps: nonNegInt(raw.repelSteps),
    clockMinutes: clock !== null && clock >= 0 ? clock : c.config.time.startMinutes,
    stats: sanitizeStats(raw.stats),
    settings: sanitizeSettings(raw.settings, c),
    ...sanitizeExtras(raw, townIds, c),
  }
  if (tracked && tracked in quests) save.trackedQuest = tracked
  return save
}
