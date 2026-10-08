// Content registry: loads every table from content/**/*.json, indexes it and validates references.
// This is the ONLY place game data enters the code. Everything else looks data up by id via CONTENT.
// World/story JSON (content/world/**) is loaded by src/shared/world/ itself.
import type {
  AbilityDef, AudioFile, BiomeDef, CharacterSheetDef, GameConfig, ItemDef, MoveDef, PropDef, RarityDef,
  DexResearchEntry, SpeciesDef, StatDef, StatusDef, TerrainDef, TextTable, TimeOfDay, TypeChart, TypeDef, TypeId, TypesFile,
  VolatileDef, WeatherDef,
} from '../types.ts'

import configJson from '../../../content/config.json' with { type: 'json' }
import typesJson from '../../../content/types.json' with { type: 'json' }
import raritiesJson from '../../../content/rarities.json' with { type: 'json' }
import statsJson from '../../../content/stats.json' with { type: 'json' }
import statusesJson from '../../../content/statuses.json' with { type: 'json' }
import volatilesJson from '../../../content/volatiles.json' with { type: 'json' }
import weathersJson from '../../../content/weathers.json' with { type: 'json' }
import abilitiesJson from '../../../content/abilities.json' with { type: 'json' }
import movesJson from '../../../content/moves.json' with { type: 'json' }
import itemsJson from '../../../content/items.json' with { type: 'json' }
import speciesJson from '../../../content/species.json' with { type: 'json' }
import dexResearchJson from '../../../content/dex-research.json' with { type: 'json' }
import biomesJson from '../../../content/biomes.json' with { type: 'json' }
import terrainJson from '../../../content/terrain.json' with { type: 'json' }
import propsJson from '../../../content/props.json' with { type: 'json' }
import charactersJson from '../../../content/characters.json' with { type: 'json' }
import audioJson from '../../../content/audio.json' with { type: 'json' }
import textCommon from '../../../content/text/zh-CN/common.json' with { type: 'json' }
import textBattle from '../../../content/text/zh-CN/battle.json' with { type: 'json' }
import textUi from '../../../content/text/zh-CN/ui.json' with { type: 'json' }
import textHud from '../../../content/text/zh-CN/hud.json' with { type: 'json' }
import textScreens from '../../../content/text/zh-CN/screens.json' with { type: 'json' }
import textWorld from '../../../content/text/zh-CN/world.json' with { type: 'json' }
import textNet from '../../../content/text/zh-CN/net.json' with { type: 'json' }
import textGame from '../../../content/text/zh-CN/game.json' with { type: 'json' }
import textItems from '../../../content/text/zh-CN/items.json' with { type: 'json' }
import textAudio from '../../../content/text/zh-CN/audio.json' with { type: 'json' }
import textBattleUi from '../../../content/text/zh-CN/battleui.json' with { type: 'json' }
import textMultiplayer from '../../../content/text/zh-CN/multiplayer.json' with { type: 'json' }
import textEvents from '../../../content/text/zh-CN/events.json' with { type: 'json' }
import textResearch from '../../../content/text/zh-CN/research.json' with { type: 'json' }
import textTutorial from '../../../content/text/zh-CN/tutorial.json' with { type: 'json' }
// Gameplay content (content/events/**, content/research.json) is loaded by src/shared/gameplay/data.ts; only its
// reference checks are hooked in here (both modules import JSON/types only, so there is no cycle).
import { GAMEPLAY } from '../gameplay/data.ts'
import { validateGameplay } from '../gameplay/validate.ts'

export interface Content {
  config: GameConfig
  types: TypeDef[]
  typeById: Record<TypeId, TypeDef>
  typeChart: TypeChart
  statusImmunities: Record<string, TypeId[]>
  rarities: RarityDef[]
  rarityById: Record<string, RarityDef>
  stats: StatDef[]
  statByKey: Record<string, StatDef>
  statuses: StatusDef[]
  statusById: Record<string, StatusDef>
  volatiles: VolatileDef[]
  volatileById: Record<string, VolatileDef>
  weathers: WeatherDef[]
  weatherById: Record<string, WeatherDef>
  abilities: Record<string, AbilityDef>
  moves: Record<string, MoveDef>
  moveList: MoveDef[]
  items: Record<string, ItemDef>
  itemList: ItemDef[]
  species: Record<string, SpeciesDef>
  /** Sorted by dexNo. */
  speciesList: SpeciesDef[]
  /** Research metadata matched to the playable Dex roster from local lineage/event dossiers. */
  dexResearch: Record<string, DexResearchEntry>
  dexResearchMeta: { source: string; lineageDate: string; eventsCheckedAt: string; entryCount: number }
  biomes: BiomeDef[]
  biomeById: Record<string, BiomeDef>
  /** Indexed by terrain numeric id (TerrainDef.id === index). */
  terrain: TerrainDef[]
  terrainByKey: Record<string, TerrainDef>
  props: Record<string, PropDef>
  characters: CharacterSheetDef[]
  characterById: Record<string, CharacterSheetDef>
  audio: AudioFile
  /** Flattened text table, keys are '<namespace>.<key>'. */
  text: TextTable
}

const byId = <T, K extends keyof T>(list: T[], key: K): Record<string, T> =>
  Object.fromEntries(list.map((x) => [String(x[key]), x]))

function flattenText(namespaces: Record<string, unknown>): TextTable {
  const out: TextTable = {}
  const walk = (prefix: string, v: unknown) => {
    if (typeof v === 'string') out[prefix] = v
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(`${prefix}.${k}`, x)
  }
  for (const [ns, table] of Object.entries(namespaces)) walk(ns, table)
  return out
}

function build(): Content {
  const types = typesJson as unknown as TypesFile
  const terrain = (terrainJson as unknown as TerrainDef[]).slice().sort((a, b) => a.id - b.id)
  const speciesList = (speciesJson as unknown as SpeciesDef[]).slice().sort((a, b) => a.dexNo - b.dexNo)
  const moveList = movesJson as unknown as MoveDef[]
  const itemList = itemsJson as unknown as ItemDef[]
  const rarities = (raritiesJson as unknown as RarityDef[]).slice().sort((a, b) => a.order - b.order)
  const statuses = statusesJson as unknown as StatusDef[]
  const volatiles = volatilesJson as unknown as VolatileDef[]
  const weathers = weathersJson as unknown as WeatherDef[]
  const biomes = biomesJson as unknown as BiomeDef[]
  const characters = charactersJson as unknown as CharacterSheetDef[]
  const stats = statsJson as unknown as StatDef[]
  const dexResearchFile = dexResearchJson as unknown as {
    meta: { source: string; lineageDate: string; eventsCheckedAt: string; entryCount: number }
    entries: Record<string, DexResearchEntry>
  }
  return {
    config: configJson as unknown as GameConfig,
    types: types.types,
    typeById: byId(types.types, 'id'),
    typeChart: types.chart,
    statusImmunities: types.statusImmunities ?? {},
    rarities,
    rarityById: byId(rarities, 'id'),
    stats,
    statByKey: byId(stats, 'key'),
    statuses,
    statusById: byId(statuses, 'id'),
    volatiles,
    volatileById: byId(volatiles, 'id'),
    weathers,
    weatherById: byId(weathers, 'id'),
    abilities: byId(abilitiesJson as unknown as AbilityDef[], 'id'),
    moves: byId(moveList, 'id'),
    moveList,
    items: byId(itemList, 'id'),
    itemList,
    species: byId(speciesList, 'id'),
    speciesList,
    dexResearch: dexResearchFile.entries,
    dexResearchMeta: dexResearchFile.meta,
    biomes,
    biomeById: byId(biomes, 'id'),
    terrain,
    terrainByKey: byId(terrain, 'key'),
    props: byId(propsJson as unknown as PropDef[], 'key'),
    characters,
    characterById: byId(characters, 'id'),
    audio: audioJson as unknown as AudioFile,
    text: flattenText({
      common: textCommon, battle: textBattle, ui: textUi, hud: textHud, screens: textScreens, world: textWorld,
      net: textNet, game: textGame, items: textItems, audio: textAudio, battleui: textBattleUi, multiplayer: textMultiplayer,
      events: textEvents, research: textResearch, tutorial: textTutorial,
    }),
  }
}

export const CONTENT: Content = build()

// ---------------------------------------------------------------------------
// Small pure helpers over content (logic only; data comes from CONTENT)
// ---------------------------------------------------------------------------

/** Damage multiplier of an attacking type against a defender's types. */
export function typeEffectiveness(atk: TypeId, defTypes: readonly TypeId[], c: Content = CONTENT): number {
  const row = c.typeChart[atk] ?? {}
  return defTypes.reduce((m, d) => m * (row[d] ?? 1), 1)
}

export function timeOfDayAt(minutes: number, c: Content = CONTENT): TimeOfDay {
  const m = ((minutes % 1440) + 1440) % 1440
  for (const p of c.config.time.phases) {
    const inside = p.from <= p.to ? m >= p.from && m < p.to : m >= p.from || m < p.to
    if (inside) return p.id
  }
  return 'day'
}

/** Numeric terrain id for a terrain key; throws on unknown keys so content typos surface early. */
export function terrainId(key: string, c: Content = CONTENT): number {
  const t = c.terrainByKey[key]
  if (!t) throw new Error(`unknown terrain key "${key}"`)
  return t.id
}

/**
 * Text lookup: t('battle.usedMove', { name: 'GPT-5', move: '思维链' }).
 * Placeholders are {name}. Missing keys return the key itself so gaps are visible, never crash.
 */
export function t(key: string, params?: Record<string, string | number>, c: Content = CONTENT): string {
  const raw = c.text[key]
  if (raw === undefined) return key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
}

// ---------------------------------------------------------------------------
// Validation — returns a list of human-readable problems (empty = consistent).
// Run by tests/content.test.ts and in dev builds at startup.
// ---------------------------------------------------------------------------

export function validateContent(c: Content = CONTENT): string[] {
  const errs: string[] = []
  const dup = (label: string, ids: string[]) => {
    const seen = new Set<string>()
    for (const id of ids) { if (seen.has(id)) errs.push(`${label}: duplicate id "${id}"`); seen.add(id) }
  }
  dup('types', c.types.map((x) => x.id))
  dup('moves', c.moveList.map((x) => x.id))
  dup('items', c.itemList.map((x) => x.id))
  dup('species', c.speciesList.map((x) => x.id))
  dup('species.dexNo', c.speciesList.map((x) => String(x.dexNo)))
  for (const [id, r] of Object.entries(c.dexResearch)) {
    if (!c.species[id]) errs.push(`dexResearch: unknown species "${id}"`)
    if (!r.officialName || !r.family || !r.generation || !r.kind || !r.access) errs.push(`dexResearch ${id}: missing identity fields`)
    if (!Array.isArray(r.eventTitles)) errs.push(`dexResearch ${id}: eventTitles must be an array`)
  }
  dup('characters', c.characters.map((x) => x.id))
  c.terrain.forEach((x, i) => { if (x.id !== i) errs.push(`terrain: id ${x.id} must equal its index ${i}`) })

  const isType = (t: string) => t in c.typeById
  for (const [a, row] of Object.entries(c.typeChart)) {
    if (!isType(a)) errs.push(`typeChart: unknown attacking type "${a}"`)
    for (const [d, m] of Object.entries(row)) {
      if (!isType(d)) errs.push(`typeChart: unknown defending type "${d}"`)
      if (![0, 0.5, 1, 2].includes(m)) errs.push(`typeChart: ${a}->${d} multiplier ${m} not in {0,0.5,1,2}`)
    }
  }
  for (const [s, ts] of Object.entries(c.statusImmunities)) {
    if (!c.statusById[s]) errs.push(`statusImmunities: unknown status "${s}"`)
    for (const t of ts) if (!isType(t)) errs.push(`statusImmunities: unknown type "${t}"`)
  }

  const checkStatusRef = (where: string, s: string) => { if (!c.statusById[s]) errs.push(`${where}: unknown status "${s}"`) }
  const checkVolatileRef = (where: string, v: string) => { if (!c.volatileById[v]) errs.push(`${where}: unknown volatile "${v}"`) }
  for (const w of c.weathers) for (const t of Object.keys(w.powerMul)) if (!isType(t)) errs.push(`weather ${w.id}: unknown type "${t}"`)
  for (const a of Object.values(c.abilities)) {
    for (const e of a.effects) {
      if (e.on === 'immune') { e.statuses?.forEach((s) => checkStatusRef(`ability ${a.id}`, s)); e.volatiles?.forEach((v) => checkVolatileRef(`ability ${a.id}`, v)) }
      if (e.on === 'dealDamage') { if (e.status) checkStatusRef(`ability ${a.id}`, e.status.id); if (e.volatile) checkVolatileRef(`ability ${a.id}`, e.volatile.id) }
      if ('if' in e && e.if?.moveTypes) e.if.moveTypes.forEach((t) => { if (!isType(t)) errs.push(`ability ${a.id}: unknown type "${t}"`) })
      if (e.on === 'absorbType') e.types.forEach((t) => { if (!isType(t)) errs.push(`ability ${a.id}: unknown type "${t}"`) })
    }
  }
  for (const m of c.moveList) {
    if (!isType(m.type)) errs.push(`move ${m.id}: unknown type "${m.type}"`)
    if ((m.category === 'status') !== (m.power === 0) && !m.effects.some((e) => e.kind === 'fixedDamage')) errs.push(`move ${m.id}: power must be 0 iff status`)
    if (m.accuracy < 0 || m.accuracy > 100) errs.push(`move ${m.id}: accuracy out of range`)
    if (m.pp <= 0) errs.push(`move ${m.id}: pp must be > 0`)
    for (const e of m.effects) {
      if (e.kind === 'status') checkStatusRef(`move ${m.id}`, e.status)
      if (e.kind === 'volatile') checkVolatileRef(`move ${m.id}`, e.volatile)
      if (e.kind === 'weather' && !c.weatherById[e.weather]) errs.push(`move ${m.id}: unknown weather "${e.weather}"`)
    }
  }
  for (const it of c.itemList) {
    if (it.effect.kind === 'chip' && !c.moves[it.effect.move]) errs.push(`item ${it.id}: chip move "${it.effect.move}" missing`)
    if (it.effect.kind === 'cure' && it.effect.status !== 'all') checkStatusRef(`item ${it.id}`, it.effect.status)
  }
  for (const id of Object.keys(c.config.economy.startItems)) if (!c.items[id]) errs.push(`config.economy.startItems: unknown item "${id}"`)
  for (const s of c.speciesList) {
    const w = `species ${s.id}`
    if (s.types.length < 1 || s.types.length > 2) errs.push(`${w}: must have 1-2 types`)
    s.types.forEach((t) => { if (!isType(t)) errs.push(`${w}: unknown type "${t}"`) })
    if (!c.rarityById[s.rarity]) errs.push(`${w}: unknown rarity "${s.rarity}"`)
    if (!c.config.growth[s.growth]) errs.push(`${w}: unknown growth "${s.growth}"`)
    s.habitats.forEach((b) => { if (!c.biomeById[b]) errs.push(`${w}: unknown biome "${b}"`) })
    s.abilities.forEach((a) => { if (!c.abilities[a]) errs.push(`${w}: unknown ability "${a}"`) })
    s.learnset.forEach((l) => { if (!c.moves[l.move]) errs.push(`${w}: learnset move "${l.move}" missing`) })
    s.teachable.forEach((m) => { if (!c.moves[m]) errs.push(`${w}: teachable move "${m}" missing`) })
    if (!s.learnset.some((l) => l.level <= 1)) errs.push(`${w}: needs at least one level-1 move`)
    if (s.evolvesTo && !c.species[s.evolvesTo.id]) errs.push(`${w}: evolvesTo "${s.evolvesTo.id}" missing`)
    if (s.evolvesFrom && !c.species[s.evolvesFrom]) errs.push(`${w}: evolvesFrom "${s.evolvesFrom}" missing`)
  }
  for (const p of Object.values(c.props)) if (p.footprint.length !== 2) errs.push(`prop ${p.key}: footprint must be [w,d]`)
  for (const k of Object.values(c.audio.battleMusic)) if (!c.audio.bgm.some((b) => b.id === k)) errs.push(`audio.battleMusic: unknown track "${k}"`)
  errs.push(...validateGameplay(GAMEPLAY, c))
  return errs
}
