// Procedural story content layered on the population rules (story.ts):
//   - SpotIndex: overworld position, region, level band, danger tier and site name of any anchor (interiors and
//     dungeon floors map to the door / mouth that leads to them).
//   - HintIndex: per-spot text params naming the nearest nest / dungeon / landmark / treasure / hamlet / town /
//     legend start as name + compass direction + distance band (+ its level and rare species).
//   - Legend chains: 3-5 tablet keepers across landmarks, read in order (quest-tracked), unlocking a hidden seer
//     at a final landmark who starts a one-time secret wildBattle.
//   - Bounties: side quests (deliver / visit / defeat / catch / fetch features) handed out in hamlets and at
//     landmarks, with partner NPCs or target trainers placed on other spots.
// Every text, script, id pattern and number comes from content/world/story/{population,legends,bounties}.json; this
// module only selects spots deterministically (per-seed hashes) and fills template params. Spots are claimed
// through the host, which applies the same occupancy / spacing / no-sealing checks as the population rules.
import type { GameMap, RegionDef, SpeciesDef, World } from '../types.ts'
import { CONTENT } from '../content/index.ts'
import type { WorldFeatures } from './index.ts'
import { seedFor } from './random.ts'
import type { NpcSpec, PartySpec, QuestSpec, StepSpec, TrainerDefaults, TrainerSpec } from './story.ts'

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

export interface HintTargetSpec {
  /** POI template ids (pois.json templates). */
  pois?: string[]
  /** Every POI flagged `landmark`. */
  landmarks?: boolean
  dungeons?: boolean
  hamlets?: boolean
  /** Story towns. */
  towns?: boolean
  /** First tablet of every placed legend chain. */
  legends?: boolean
}

export interface HintConfig {
  /** Compass words N, NE, E, SE, S, SW, W, NW. */
  directions: string[]
  /** First band whose `max` (tiles) covers the distance. */
  distances: { max: number; text: string }[]
  /** Targets closer than this (or of the speaker's own site) are skipped. */
  minDistance: number
  /** Used for every param of a target kind with nothing on this seed, and for missing rare species. */
  unknown: string
  /** Param prefix -> what it points at. Params: <key>Name <key>Dir <key>Dist <key>Lv <key>Rare. */
  targets: Record<string, HintTargetSpec>
}

export interface Archetype {
  sprite: string
  names: string[]
  /** One list of lines is chosen per NPC (registered as a script and included by the templates). */
  lines: string[][]
  biomes?: string[]
}

/** Legend keeper / seer: no free lines (the chain's templates speak for them). */
export interface LegendPerson { sprite: string; names: string[]; lines?: string[][] }

export interface LegendChain {
  id: string
  nameZh: string
  /** POI ids that may hold a tablet (regex). */
  sites: string
  /** POI ids that may hold the final seer (regex). */
  final: string
  steps: [number, number]
  keeper: LegendPerson
  seer: LegendPerson
  /** Inscription per tablet (cycled); narration lines. */
  lore: string[][]
  /** Extra text params for this chain's templates. */
  texts: Record<string, string>
  /** Encounter script (wildBattle with a pick); `{level}` = final region top level + levelBonus. */
  encounter: StepSpec[]
  levelBonus: number
}

export interface LegendsFile {
  /** [min, max] distance (tiles) from one tablet to the next (and from the last tablet to the final seer). */
  spacing: [number, number]
  idPatterns: { tablet: string; final: string; flag: string; done: string }
  quest: { stage: string; final: string }
  scripts: { first: StepSpec[]; next: StepSpec[]; final: StepSpec[] }
  chains: LegendChain[]
}

export interface TrainerArch {
  classZh: string
  sprite: string
  names: string[]
  types: string[]
  introText: string[][]
  defeatText: string[][]
  after: string[]
}

export interface BountyKind {
  weight: number
  /** Quest name templates. */
  names: string[]
  /** 'npc' = a partner NPC on a target spot, 'trainer' = a talk-only target trainer there; omitted = no target. */
  target?: 'npc' | 'trainer'
  /** Anchor names a target may use (regex). */
  targets?: string
  stages: { text: string; target?: 'giver' | 'partner' }[]
  giver: Archetype[]
  partner?: Archetype[]
  trainer?: TrainerArch[]
  party?: [number, number]
  levelBonus?: number
  rarityShift?: number
  /** Item handed over by the giver ({parcel}). */
  parcels?: string[]
  /** {type} {count}: a type with at least `count` catchable species (preferring the giver's biome). */
  catchCount?: [number, number]
  /** {item} {qty}: an item from the first band covering the giver's level. */
  fetch?: { bands: { maxLevel: number; items: string[] }[]; qty: [number, number] }
  /** One value per bounty for each key (text params). */
  texts: Record<string, string[]>
  scripts: { giver: StepSpec[]; partner?: StepSpec[]; target?: StepSpec[] }
  rewardMul: number
}

export interface BountiesFile {
  count: [number, number]
  idPatterns: { quest: string; giver: string; partner: string; target: string; intro: string; idle: string }
  /** Giver spot patterns (regex with a `site` group) in priority order; one bounty per site. */
  givers: string[]
  /** Giver -> target distance band (tiles). */
  distance: [number, number]
  /** A target's region may start at most this many levels above the giver's top level. */
  levelSlack: number
  reward: { moneyPerLevel: number; round: number; items: { maxLevel: number; pool: Record<string, number>[] }[] }
  kinds: Record<string, BountyKind>
}

// ---------------------------------------------------------------------------
// Host (implemented by StoryBuilder)
// ---------------------------------------------------------------------------

export interface PartyOpts {
  size: [number, number]
  types: string[]
  levelBonus?: number
  rarityShift?: number
  /** Prefer species living in the spot's biome. */
  habitat?: boolean
  /** Hash key of this party's rolls. */
  salt: string
  /** Pick salt prefix (member index appended); defaults to `salt`. */
  pickSalt?: string
}

export interface PopHost {
  readonly world: World
  readonly anchorNames: readonly string[]
  readonly problems: string[]
  readonly spots: SpotIndex
  readonly hints: HintIndex
  /** True when an NPC may stand on the anchor (pure check). */
  canClaim(name: string): boolean
  /** Reserves the anchor for an NPC that is added right away; false = unusable. */
  claim(name: string): boolean
  addNpc(spec: NpcSpec, params: Record<string, string>, source: string): void
  addTrainer(spec: TrainerSpec, d: TrainerDefaults, source: string, rivalStarter?: SpeciesDef, params?: Record<string, string>): void
  addQuest(spec: QuestSpec, params: Record<string, string>, source: string): void
  registerScript(id: string, steps: StepSpec[]): void
  party(spot: SpotInfo, o: PartyOpts): PartySpec[]
  /** Reward money of a trainer at `spot` whose ace has `level`. */
  trainerReward(spot: SpotInfo, level: number, perLevel?: number): number
  place(): void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fill(s: string, params: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? params[k] : m))
}

const hashOf = (world: World, salt: string) => seedFor(world.seed, salt)
const pickBy = <T>(list: readonly T[], h: number): T => list[h % list.length]
const inRange = (r: [number, number], h: number) => r[0] + (h % (Math.max(r[0], r[1]) - r[0] + 1))
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y))

function shuffled<T>(list: readonly T[], key: (t: T) => number): T[] {
  return list.map((t) => [key(t), t] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1])
}

/** One archetype for a spot: biome-matching ones first. */
function archetypeFor(list: readonly Archetype[], biome: string, h: number): Archetype {
  const fit = list.filter((a) => !a.biomes || a.biomes.includes(biome))
  return pickBy(fit.length ? fit : list, h)
}

/** Most likely rare species of a region (highest weight, then id), or null. */
function rareOf(region: RegionDef | undefined): string | null {
  const rare = (region?.encounters ?? []).filter((e) => e.rare).sort((a, b) => b.weight - a.weight || (a.species < b.species ? -1 : 1))
  return rare.length ? CONTENT.species[rare[0].species]?.nameZh ?? null : null
}

// ---------------------------------------------------------------------------
// Spots
// ---------------------------------------------------------------------------

export interface SpotInfo {
  name: string
  map: GameMap
  x: number
  y: number
  region: RegionDef | undefined
  biome: string
  levelRange: [number, number]
  danger: number
  /** Overworld tile the spot belongs to: its own tile, or the door / mouth that leads to its map. */
  ow: { x: number; y: number }
  /** Reachable on foot from spawn (gates open); overworld spots only, other maps count as reachable. */
  onFoot: boolean
  /** Hamlet / POI / dungeon id, or the region (town) id. */
  siteId: string
  siteName: string
}

const SITE_ANCHOR = /^(?:hamlet|poi|dungeon):([^:]+)/
const WILD_ANCHOR = /^wild:([^:]+):/

export class SpotIndex {
  private readonly owPos = new Map<string, { x: number; y: number }>()
  private readonly names = new Map<string, string>()
  private readonly cache = new Map<string, SpotInfo | null>()
  private readonly world: World
  private readonly anchors: Record<string, { map: string; x: number; y: number }>
  private readonly walkReach: Uint8Array

  constructor(world: World, anchors: Record<string, { map: string; x: number; y: number }>, features: WorldFeatures, walkReach: Uint8Array) {
    this.world = world
    this.anchors = anchors
    this.walkReach = walkReach
    const ow = world.maps[world.startMap]
    // Breadth-first over warps: a map inherits the overworld tile of the first door / mouth / stairs reaching it.
    const queue = [ow.id]
    for (let k = 0; k < queue.length; k++) {
      const m = world.maps[queue[k]]
      for (const w of m.warps) {
        if (w.toMap === ow.id || this.owPos.has(w.toMap) || !world.maps[w.toMap]) continue
        this.owPos.set(w.toMap, m.id === ow.id ? { x: w.x, y: w.y } : this.owPos.get(m.id)!)
        queue.push(w.toMap)
      }
    }
    for (const t of world.towns) this.names.set(t.id, t.nameZh)
    for (const p of features.pois) if (!this.names.has(p.id)) this.names.set(p.id, p.nameZh)
    for (const d of features.dungeons) if (!this.names.has(d.id)) this.names.set(d.id, d.nameZh)
  }

  siteName(id: string): string | undefined { return this.names.get(id) }

  /** Overworld position of a map tile. */
  overworldOf(map: GameMap, x: number, y: number): { x: number; y: number } {
    if (map.id === this.world.startMap) return { x, y }
    const ow = this.world.maps[this.world.startMap]
    return this.owPos.get(map.id) ?? { x: ow.spawn.x, y: ow.spawn.y }
  }

  info(name: string): SpotInfo | null {
    if (this.cache.has(name)) return this.cache.get(name)!
    const a = this.anchors[name]
    const map = a ? this.world.maps[a.map] : undefined
    let out: SpotInfo | null = null
    if (a && map && a.x >= 0 && a.y >= 0 && a.x < map.width && a.y < map.height) {
      const region = map.regions[map.region[a.y * map.width + a.x]]
      const site = SITE_ANCHOR.exec(name)?.[1] ?? WILD_ANCHOR.exec(name)?.[1] ?? region?.townId ?? region?.id ?? map.id
      const danger = region?.danger
      out = {
        name, map, x: a.x, y: a.y, region,
        biome: region?.biome ?? '',
        levelRange: region?.levelRange ? [region.levelRange[0], region.levelRange[1]] : [1, 1],
        danger: typeof danger === 'number' ? danger : 0,
        ow: this.overworldOf(map, a.x, a.y),
        onFoot: map.id !== this.world.startMap || this.walkReach[a.y * map.width + a.x] === 1,
        siteId: site,
        siteName: this.names.get(site) ?? region?.nameZh ?? map.nameZh,
      }
    }
    this.cache.set(name, out)
    return out
  }
}

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

export interface HintPoint { id: string; name: string; x: number; y: number; level: number; rare: string | null }

export class HintIndex {
  readonly cfg: HintConfig
  private readonly points = new Map<string, HintPoint[]>()
  private readonly cache = new Map<string, Record<string, string>>()

  constructor(cfg: HintConfig, world: World, features: WorldFeatures) {
    this.cfg = cfg
    const ow = world.maps[world.startMap]
    const regionAt = (x: number, y: number) => ow.regions[ow.region[y * ow.width + x]]
    const at = (id: string, name: string, x: number, y: number, region = regionAt(x, y)): HintPoint =>
      ({ id, name, x, y, level: region?.levelRange?.[0] ?? 1, rare: rareOf(region) })
    for (const [key, t] of Object.entries(cfg.targets)) {
      const list: HintPoint[] = []
      for (const p of features.pois) {
        if ((t.pois?.includes(p.template)) || (t.landmarks && p.landmark)) list.push(at(p.id, p.nameZh, p.x, p.y))
      }
      if (t.dungeons) {
        for (const d of features.dungeons) {
          if (!d.mouth) continue
          const floor = world.maps[d.floors[0]]
          list.push(at(d.id, d.nameZh, d.mouth.x, d.mouth.y, floor?.regions[0]))
        }
      }
      if (t.hamlets) for (const h of features.hamlets) list.push(at(h.id, h.nameZh, h.x, h.y))
      if (t.towns) for (const tw of world.towns) if ((tw.kind ?? 'town') === 'town' && tw.map === ow.id) list.push(at(tw.id, tw.nameZh, tw.x, tw.y))
      this.points.set(key, list)
    }
  }

  /** Adds points (e.g. legend starts) to every target kind that asks for them. */
  addLegendStarts(points: HintPoint[]): void {
    for (const [key, t] of Object.entries(this.cfg.targets)) if (t.legends) this.points.get(key)!.push(...points)
    this.cache.clear()
  }

  direction(from: { x: number; y: number }, to: { x: number; y: number }): string {
    const dx = to.x - from.x, dy = to.y - from.y
    const ax = Math.abs(dx), ay = Math.abs(dy)
    // tan(22.5°): within it of an axis the bearing is a cardinal direction, otherwise a diagonal.
    const T = 0.41421356
    const d = this.cfg.directions
    if (ax <= ay * T) return dy < 0 ? d[0] : d[4]
    if (ay <= ax * T) return dx > 0 ? d[2] : d[6]
    if (dy < 0) return dx > 0 ? d[1] : d[7]
    return dx > 0 ? d[3] : d[5]
  }

  distance(from: { x: number; y: number }, to: { x: number; y: number }): string {
    const dd = dist(from, to)
    const bands = this.cfg.distances
    return (bands.find((b) => dd <= b.max) ?? bands[bands.length - 1]).text
  }

  /** <key>Name/Dir/Dist/Lv/Rare for every hint target kind, plus rareHere, seen from the spot. */
  params(spot: SpotInfo): Record<string, string> {
    const ck = `${spot.map.id}:${spot.x},${spot.y}`
    const hit = this.cache.get(ck)
    if (hit) return hit
    const out: Record<string, string> = { rareHere: rareOf(spot.region) ?? this.cfg.unknown }
    for (const [key, list] of this.points) {
      let best: HintPoint | null = null
      let bd = Infinity
      for (const p of list) {
        if (p.id === spot.siteId) continue
        const d = dist(spot.ow, p)
        if (d < this.cfg.minDistance || d >= bd) continue
        best = p
        bd = d
      }
      out[`${key}Name`] = best?.name ?? this.cfg.unknown
      out[`${key}Dir`] = best ? this.direction(spot.ow, best) : this.cfg.unknown
      out[`${key}Dist`] = best ? this.distance(spot.ow, best) : this.cfg.unknown
      out[`${key}Lv`] = String(best?.level ?? spot.levelRange[0])
      out[`${key}Rare`] = best?.rare ?? this.cfg.unknown
    }
    this.cache.set(ck, out)
    return out
  }
}

// ---------------------------------------------------------------------------
// Legend chains
// ---------------------------------------------------------------------------

export interface PlacedLegend { id: string; tablets: string[]; final: string }

interface Site { id: string; name: string; x: number; y: number; spots: string[] }

/** Non-island POIs with their NPC spot anchors. */
function poiSites(h: PopHost, features: WorldFeatures): Site[] {
  const spots = new Map<string, string[]>()
  for (const name of h.anchorNames) {
    const m = /^poi:([^:]+):spot:\d+$/.exec(name)
    if (!m) continue
    const l = spots.get(m[1])
    if (l) l.push(name)
    else spots.set(m[1], [name])
  }
  return features.pois.filter((p) => !p.island && spots.has(p.id)).map((p) => ({ id: p.id, name: p.nameZh, x: p.x, y: p.y, spots: spots.get(p.id)! }))
}

export function placeLegends(h: PopHost, lf: LegendsFile, features: WorldFeatures): PlacedLegend[] {
  const w = h.world
  const ow = w.maps[w.startMap]
  const start = { x: ow.spawn.x, y: ow.spawn.y }
  const sites = poiSites(h, features)
  const used = new Set<string>()
  const out: PlacedLegend[] = []
  const freeSpot = (s: Site) => s.spots.find((n) => h.canClaim(n)) ?? null
  for (const chain of lf.chains) {
    let siteRe: RegExp, finalRe: RegExp
    try { siteRe = new RegExp(chain.sites); finalRe = new RegExp(chain.final) } catch { continue }
    const order = shuffled(sites, (s) => hashOf(w, `legend|${chain.id}|${s.id}`))
    const want = inRange(chain.steps, hashOf(w, `legend|${chain.id}|steps`))
    const hop = (a: Site, b: Site) => { const d = dist(a, b); return d >= lf.spacing[0] && d <= lf.spacing[1] }
    // A trail of tablets, each one hop (spacing band) from the previous; tried from every start in hash order.
    let tablets: { site: Site; spot: string }[] = []
    let final: { site: Site; spot: string } | null = null
    for (const s0 of order) {
      if (used.has(s0.id) || !siteRe.test(s0.id)) continue
      const spot0 = freeSpot(s0)
      if (!spot0) continue
      const trail = [{ site: s0, spot: spot0 }]
      while (trail.length < want) {
        const prev = trail[trail.length - 1].site
        const next = order.find((s) => !used.has(s.id) && siteRe.test(s.id) && !trail.some((t) => t.site.id === s.id || dist(t.site, s) < lf.spacing[0]) && hop(prev, s) && freeSpot(s))
        if (!next) break
        trail.push({ site: next, spot: freeSpot(next)! })
      }
      if (trail.length < chain.steps[0]) continue
      // Lead outward: the end farther from the start town is the last tablet.
      if (dist(start, trail[0].site) > dist(start, trail[trail.length - 1].site)) trail.reverse()
      const last = trail[trail.length - 1].site
      const fin = order
        .filter((s) => !used.has(s.id) && finalRe.test(s.id) && hop(last, s) && !trail.some((t) => t.site.id === s.id || dist(t.site, s) < lf.spacing[0] / 2))
        .sort((a, b) => dist(start, b) - dist(start, a) || (a.id < b.id ? -1 : 1))
        .find((s) => freeSpot(s))
      if (!fin) continue
      tablets = trail
      final = { site: fin, spot: freeSpot(fin)! }
      break
    }
    if (!final) continue
    const all = [...tablets, final]
    if (!all.every((t) => h.claim(t.spot))) { h.problems.push(`legends ${chain.id}: spot claim failed`); continue }
    for (const t of all) used.add(t.site.id)
    const n = tablets.length
    const ids = { chain: chain.id }
    const flag = (k: number) => fill(lf.idPatterns.flag, { ...ids, k: String(k) })
    const rel = (from: Site, to: Site, p: string) => ({ [`${p}Site`]: to.name, [`${p}Dir`]: h.hints.direction(from, to), [`${p}Dist`]: h.hints.distance(from, to) })
    const finalSpot = h.spots.info(final.spot)!
    const level = Math.min(CONTENT.config.party.maxLevel, finalSpot.levelRange[1] + chain.levelBonus)
    const encounterId = `${chain.id}:encounter`
    h.registerScript(encounterId, chain.encounter)
    const source = `legends/${chain.id}`
    // Stage j points from site j to site j + 1 (the last stage to the final seer).
    h.addQuest({
      id: chain.id, nameZh: chain.nameZh, kind: 'side',
      stages: all.slice(1).map((t, j) => ({
        text: fill(j + 1 < n ? lf.quest.stage : lf.quest.final, { site: all[j].site.name, next: t.site.name, dir: h.hints.direction(all[j].site, t.site), dist: h.hints.distance(all[j].site, t.site) }),
        target: t.spot,
      })),
    }, {}, source)
    tablets.forEach((t, k) => {
      const spot = h.spots.info(t.spot)!
      const loreId = `${chain.id}:lore:${k}`
      h.registerScript(loreId, chain.lore[k % chain.lore.length].map((text) => ({ op: 'say', text, speaker: '' })))
      const id = fill(lf.idPatterns.tablet, { ...ids, k: String(k) })
      const params: Record<string, string> = {
        ...h.hints.params(spot), ...chain.texts, chain: chain.id, chainName: chain.nameZh, quest: chain.id, id,
        flag: flag(k), prevFlag: k > 0 ? flag(k - 1) : '', stage: String(k), lore: loreId, site: t.site.name,
        ...rel(t.site, all[k + 1].site, 'next'), ...rel(t.site, tablets[0].site, 'first'),
      }
      h.addNpc({
        id, at: t.spot, sprite: chain.keeper.sprite, nameZh: pickBy(chain.keeper.names, hashOf(w, `legend|${chain.id}|keeper${k}`)), role: 'villager',
        script: k === 0 ? lf.scripts.first : lf.scripts.next,
      }, params, source)
      h.place()
    })
    const id = fill(lf.idPatterns.final, ids)
    const params: Record<string, string> = {
      ...h.hints.params(finalSpot), ...chain.texts, chain: chain.id, chainName: chain.nameZh, quest: chain.id, id,
      doneFlag: fill(lf.idPatterns.done, ids), lastFlag: flag(n - 1), lastStage: String(n - 1), level: String(level), encounter: encounterId,
      site: final.site.name,
    }
    h.addNpc({
      id, at: final.spot, sprite: chain.seer.sprite, nameZh: pickBy(chain.seer.names, hashOf(w, `legend|${chain.id}|seer`)),
      role: 'villager', hiddenUnlessFlag: flag(n - 1), script: lf.scripts.final,
    }, params, source)
    h.place()
    out.push({ id: chain.id, tablets: tablets.map((t) => t.spot), final: final.spot })
  }
  h.hints.addLegendStarts(out.map((l) => {
    const s = h.spots.info(l.tablets[0])!
    return { id: s.siteId, name: s.siteName, x: s.ow.x, y: s.ow.y, level: s.levelRange[0], rare: null }
  }))
  return out
}

// ---------------------------------------------------------------------------
// Bounties
// ---------------------------------------------------------------------------

export interface PlacedBounty { quest: string; kind: string; giver: string; target?: string }

export function placeBounties(h: PopHost, bf: BountiesFile): PlacedBounty[] {
  const w = h.world
  const owId = w.startMap
  const out: PlacedBounty[] = []
  const kinds = Object.entries(bf.kinds)
  if (!kinds.length) return out
  // Kind cycle: each kind `weight` times, shuffled per seed, so every kind appears once enough bounties exist.
  const cycle = shuffled(kinds.flatMap(([k, v]) => Array.from({ length: Math.max(0, v.weight) }, (_, i) => `${k}#${i}`)), (s) => hashOf(w, `bounty|cycle|${s}`)).map((s) => s.split('#')[0])
  const want = inRange(bf.count, hashOf(w, 'bounty|count'))
  // Giver sites in priority order, sites shuffled per seed inside each pattern.
  const giverSites: { site: string; spots: string[] }[] = []
  const seenSites = new Set<string>()
  for (const pattern of bf.givers) {
    let re: RegExp
    try { re = new RegExp(pattern) } catch { continue }
    const bySite = new Map<string, string[]>()
    for (const name of h.anchorNames) {
      const m = re.exec(name)
      const site = m?.groups?.site
      if (!m || !site || seenSites.has(site) || h.spots.info(name)?.map.id !== owId) continue
      const l = bySite.get(site)
      if (l) l.push(name)
      else bySite.set(site, [name])
    }
    for (const site of shuffled([...bySite.keys()], (s) => hashOf(w, `bounty|site|${s}`))) {
      seenSites.add(site)
      giverSites.push({ site, spots: shuffled(bySite.get(site)!, (s) => hashOf(w, `bounty|spot|${s}`)) })
    }
  }
  const cap = CONTENT.config.party.maxLevel
  const catchable = (type: string, biome?: string) =>
    CONTENT.speciesList.filter((s) => s.types.includes(type) && s.rarity !== 'MYTHIC' && (!biome || s.habitats.includes(biome))).length
  let n = 0
  for (const gs of giverSites) {
    if (out.length >= want) break
    const giverSpot = gs.spots.find((s) => h.spots.info(s)?.onFoot && h.canClaim(s))
    if (!giverSpot) continue
    const giver = h.spots.info(giverSpot)!
    const questId = fill(bf.idPatterns.quest, { n: String(n + 1) })
    const salt = (s: string) => hashOf(w, `bounty|${questId}|${s}`)
    const first = cycle[n % cycle.length]
    const order = [first, ...kinds.map(([k]) => k).filter((k) => k !== first)]
    for (const kindId of order) {
      const kind = bf.kinds[kindId]
      const params: Record<string, string> = {
        ...h.hints.params(giver), quest: questId, giverSite: giver.siteName, place: giver.siteName,
        level: String(giver.levelRange[1]), intro: fill(bf.idPatterns.intro, { quest: questId }), idle: fill(bf.idPatterns.idle, { quest: questId }),
      }
      for (const [k, vals] of Object.entries(kind.texts)) if (vals.length) params[k] = pickBy(vals, salt(`text:${k}`))
      if (kind.parcels?.length) params.parcel = pickBy(kind.parcels, salt('parcel'))
      if (kind.catchCount) {
        const count = inRange(kind.catchCount, salt('count'))
        const types = CONTENT.types.map((t) => t.id)
        const local = types.filter((t) => catchable(t, giver.biome) >= count)
        const from = local.length ? local : types.filter((t) => catchable(t) >= count)
        if (!from.length) continue
        params.type = pickBy(from, salt('type'))
        params.count = String(count)
      }
      if (kind.fetch) {
        const bands = kind.fetch.bands
        const band = bands.find((b) => giver.levelRange[1] <= b.maxLevel) ?? bands[bands.length - 1]
        if (!band?.items.length) continue
        params.item = pickBy(band.items, salt('item'))
        params.qty = String(inRange(kind.fetch.qty, salt('qty')))
      }
      // Target spot: in the distance band, on the overworld, not much above the giver's level, another site.
      let target: string | null = null
      if (kind.target) {
        let re: RegExp
        try { re = new RegExp(kind.targets ?? '$^') } catch { continue }
        const cands = h.anchorNames.filter((name) => {
          if (!re.test(name)) return false
          const s = h.spots.info(name)
          if (!s || s.map.id !== owId || !s.onFoot || s.siteId === giver.siteId) return false
          const d = dist(giver.ow, s.ow)
          return d >= bf.distance[0] && d <= bf.distance[1] && s.levelRange[0] <= giver.levelRange[1] + bf.levelSlack
        })
        target = shuffled(cands, (s) => salt(`target:${s}`)).find((s) => h.canClaim(s)) ?? null
        if (!target) continue
      }
      const tgt = target ? h.spots.info(target)! : null
      if (tgt) {
        params.destName = tgt.siteName
        params.destDir = h.hints.direction(giver.ow, tgt.ow)
        params.destDist = h.hints.distance(giver.ow, tgt.ow)
      }
      // Names first: every template may mention both sides.
      const gArch = archetypeFor(kind.giver, giver.biome, salt('giver'))
      params.giverName = pickBy(gArch.names, salt('giverName'))
      const pArch = kind.target === 'npc' && kind.partner?.length && tgt ? archetypeFor(kind.partner, tgt.biome, salt('partner')) : null
      if (pArch) params.partnerName = pickBy(pArch.names, salt('partnerName'))
      const tArch = kind.target === 'trainer' && kind.trainer?.length ? pickBy(kind.trainer, salt('trainer')) : null
      const targetId = fill(bf.idPatterns.target, { quest: questId })
      if (tArch) {
        params.trainerId = targetId
        params.trainerClass = tArch.classZh
        params.trainerName = pickBy(tArch.names, salt('trainerName'))
      }
      if (target && !h.claim(target)) continue
      h.registerScript(params.intro, gArch.lines[salt('lines') % gArch.lines.length].map((text) => ({ op: 'say', text })))
      const source = `bounties/${kindId}`
      if (pArch && tgt) {
        h.registerScript(params.idle, pArch.lines[salt('idleLines') % pArch.lines.length].map((text) => ({ op: 'say', text })))
        h.addNpc({
          id: fill(bf.idPatterns.partner, { quest: questId }), at: target!, sprite: pArch.sprite, nameZh: params.partnerName,
          role: 'villager', script: kind.scripts.partner ?? [],
        }, { ...h.hints.params(tgt), ...params }, source)
      } else if (tArch && tgt) {
        const party = h.party(tgt, { size: kind.party ?? [1, 1], types: tArch.types, levelBonus: kind.levelBonus, rarityShift: kind.rarityShift, habitat: true, salt: questId })
        const ace = party.reduce((m, p) => Math.max(m, p.level), 0)
        h.addTrainer({
          id: targetId, at: target!, nameZh: params.trainerName, classZh: tArch.classZh, sprite: tArch.sprite, party,
          introText: pickBy(tArch.introText, salt('intro')), defeatText: pickBy(tArch.defeatText, salt('defeat')), after: pickBy(tArch.after, salt('after')),
          sightRange: 0, reward: h.trainerReward(tgt, ace), script: kind.scripts.target,
        }, {}, source, undefined, { ...h.hints.params(tgt), ...params })
      }
      h.place()
      if (!h.claim(giverSpot)) h.problems.push(`bounties ${questId}: giver spot ${giverSpot} became unusable`)
      h.addNpc({
        id: fill(bf.idPatterns.giver, { quest: questId }), at: giverSpot, sprite: gArch.sprite, nameZh: params.giverName,
        role: 'questGiver', script: kind.scripts.giver,
      }, params, source)
      h.place()
      // Reward from the giver's level band.
      const lv = Math.min(cap, Math.round((giver.levelRange[0] + giver.levelRange[1]) / 2))
      const r = bf.reward
      const band = r.items.find((b) => lv <= b.maxLevel) ?? r.items[r.items.length - 1]
      const money = Math.round((r.moneyPerLevel * lv * kind.rewardMul) / r.round) * r.round
      const items = band?.pool.length ? { ...pickBy(band.pool, salt('reward')) } : undefined
      h.addQuest({
        id: questId, nameZh: pickBy(kind.names, salt('name')), kind: 'side',
        stages: kind.stages.map((s) => ({ text: s.text, target: s.target === 'partner' ? target ?? giverSpot : giverSpot })),
        reward: items ? { money, items } : { money },
      }, params, source)
      out.push({ quest: questId, kind: kindId, giver: giverSpot, ...(target ? { target } : {}) })
      n++
      break
    }
  }
  return out
}
