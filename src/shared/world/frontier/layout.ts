// Site layouts of the frontier. Each site is stamped once in a small local window (a MapDraft filled from the
// base terrain) by the same grammars the core continent uses (hamlets.ts / pois.ts), then translated to world
// coordinates: terrain overrides, props, door warps, signs, ground items, NPC spots, nest tiles, the place entry
// and (for dungeons) the floor plans whose maps are generated lazily by provider.interior().
import type { GroundItemDef, PropPlacement, SignDef, TownDef, Warp } from '../../types.ts'
import { CONTENT } from '../../content/index.ts'
import { WORLD_CONTENT, type WorldContent } from '../data.ts'
import { propDoor } from '../collision.ts'
import { endTile } from '../caves.ts'
import { F_BRIDGE, F_KEEP, F_LAKE, F_PATH, F_RESERVED, F_RIVER, F_SEA, canPlace, fmt, newDraft, placeProp, type MapDraft } from '../grid.ts'
import type { AnchorMap, DoorLink, OwCtx } from '../ctx.ts'
import { stampHamlets } from '../hamlets.ts'
import { stampPois } from '../pois.ts'
import { uniqueName } from '../lore.ts'
import { bandFor, pickItem } from '../items.ts'
import { rngFor, type Rng } from '../random.ts'
import type { CaveEndSpec, CaveSpec, DungeonStyle, HamletSpec, PoisFile, Vec2 } from '../schema.ts'
import type { Site } from '../sites.ts'
import { B_BRIDGE, B_ROAD, B_SHOULDER, baseArea, type BaseDeps } from './base.ts'
import { W_LAKE, W_RIVER, W_SEA } from './fields.ts'
import type { FrontierSite } from './sites.ts'

export interface SiteDoor { slot: string; mapId: string; template: string; nameZh?: string; front: { x: number; y: number }; facing: Warp['facing']; doorX: number; doorY: number }

export interface DungeonPlan {
  style: DungeonStyle
  floors: CaveSpec[]
  /** Overworld tile in front of the mouth. */
  mouth: { x: number; y: number }
}

export interface SiteLayout {
  site: FrontierSite
  nameZh: string
  description: string
  /** Walkable centre tile (plaza / POI centre / tile in front of a dungeon mouth). */
  center: { x: number; y: number }
  /** Window rect (world tiles) the layout may touch. */
  x0: number; y0: number; x1: number; y1: number
  /** Terrain overrides (world tiles). */
  tx: Int32Array; ty: Int32Array; tt: Uint8Array
  props: PropPlacement[]
  warps: Warp[]
  signs: SignDef[]
  items: GroundItemDef[]
  /** NPC spots (villagers / POI keepers). */
  spots: { x: number; y: number }[]
  doors: SiteDoor[]
  services: boolean
  /** Nest grass tiles (own boosted encounter region = site id). */
  nest: { x: number; y: number }[]
  dungeon: DungeonPlan | null
  levelRange: Vec2
}

const SIDES: CaveEndSpec['side'][] = ['north', 'south', 'east', 'west']

let WC: WorldContent | null = null
/** World content view with the frontier hamlet overrides, merged POI templates and merged lore. */
export function frontierWorldContent(deps: BaseDeps): WorldContent {
  if (WC) return WC
  const sc = deps.fields.cf.fc.sites
  const pois: PoisFile = {
    ...WORLD_CONTENT.pois,
    hamlets: { ...WORLD_CONTENT.pois.hamlets, ...sc.hamlet } as HamletSpec,
    templates: { ...WORLD_CONTENT.pois.templates, ...sc.templates },
    lore: deps.fields.cf.lore,
  }
  WC = { ...WORLD_CONTENT, pois }
  return WC
}

function windowCtx(deps: BaseDeps, d: MapDraft, anchors: AnchorMap, problems: string[]): OwCtx {
  return {
    seed: deps.fields.seed, wc: frontierWorldContent(deps), spec: WORLD_CONTENT.world.overworld, d,
    macro: null as never, regionIdx: new Map(), anchors, doors: [], problems,
  }
}

/** Builds the layout of one site (callers cache it). `levelRange` is the site's region level band. */
export function buildSiteLayout(deps: BaseDeps, site: FrontierSite, levelRange: Vec2, regionName: string, overworldId: string): SiteLayout {
  const F = deps.fields
  const sc = F.cf.fc.sites
  const win = site.type === 'hamlet' ? sc.hamlet.window : sc.poiWindow
  const R = Math.ceil(site.radius) + win
  const x0 = site.x - R, y0 = site.y - R, W = 2 * R + 1
  const base = baseArea(deps, x0, y0, W, W)
  const d = newDraft({ id: overworldId, nameZh: '', kind: 'overworld', w: W, h: W, fill: 0, outdoor: true, music: '' })
  for (let i = 0; i < W * W; i++) {
    d.terrain[i] = base.terrain[i]
    d.elevation[i] = base.level[i]
    const wk = base.water[i]
    if (wk === W_SEA) d.flags[i] |= F_SEA
    else if (wk === W_RIVER) d.flags[i] |= F_RIVER
    else if (wk === W_LAKE) d.flags[i] |= F_LAKE
    if (base.flags[i] & B_ROAD) d.flags[i] |= F_PATH
    if (base.flags[i] & B_BRIDGE) d.flags[i] |= F_BRIDGE
    if (base.flags[i] & B_SHOULDER) d.flags[i] |= F_KEEP
  }
  const before = d.terrain.slice()
  const anchors: AnchorMap = {}
  const problems: string[] = []
  const ctx = windowCtx(deps, d, anchors, problems)
  const local: Site = {
    id: site.id, kind: site.type, template: site.template, x: site.x - x0, y: site.y - y0, radius: site.radius,
    pad: true, level: site.level, zone: 0, island: 0, biome: site.biome,
  }
  const biomeId = CONTENT.biomes[site.biome]?.id ?? 'meadow'
  const used = new Set<string>()
  const rng = rngFor(F.seed, `fx-layout-${site.id}`)
  const out: SiteLayout = {
    site, nameZh: '', description: '', center: { x: site.x, y: site.y }, x0, y0, x1: x0 + W, y1: y0 + W,
    tx: new Int32Array(0), ty: new Int32Array(0), tt: new Uint8Array(0),
    props: [], warps: [], signs: [], items: [], spots: [], doors: [], services: false, nest: [], dungeon: null, levelRange,
  }
  const wc = frontierWorldContent(deps)
  if (site.type === 'hamlet') {
    const hs = wc.pois.hamlets
    const spec = site.gate ? { ...hs, names: sc.gateway.names, services: sc.gateway.services } : hs
    const ctxH = { ...ctx, wc: { ...wc, pois: { ...wc.pois, hamlets: spec } } } as OwCtx
    const links: DoorLink[] = []
    const [h] = stampHamlets(ctxH, [local], used, links)
    if (h) {
      out.nameZh = h.nameZh
      out.description = h.description
      out.center = { x: h.center.x + x0, y: h.center.y + y0 }
      out.spots = h.spots.map((p) => ({ x: p.x + x0, y: p.y + y0 }))
      out.services = h.services
      for (const l of links) {
        const mapId = `${site.id}:${l.slot}`
        out.doors.push({ slot: l.slot, mapId, template: l.floors[0], nameZh: l.nameZh, front: { x: l.door.front.x + x0, y: l.door.front.y + y0 }, facing: l.door.facing, doorX: l.door.x + x0, doorY: l.door.y + y0 })
      }
      for (const w of d.warps) {
        const link = links.find((l) => l.mapIds[0] === w.toMap)
        out.warps.push({ ...w, x: w.x + x0, y: w.y + y0, toMap: link ? `${site.id}:${link.slot}` : w.toMap })
      }
    }
  } else if (site.type === 'poi') {
    const [p] = stampPois(ctx, [local], used)
    if (p) {
      out.nameZh = p.nameZh
      out.center = { x: p.center.x + x0, y: p.center.y + y0 }
      out.spots = p.spots.map((s) => ({ x: s.x + x0, y: s.y + y0 }))
      out.nest = p.nest.map((i) => ({ x: (i % W) + x0, y: Math.floor(i / W) + y0 }))
      out.description = d.signs[0]?.text ?? p.nameZh
      const items = p.tpl.items
      if (items) placeItems(d, rng, x0, y0, site, levelRange, items.visible, items.hidden, out, p.center, sc.itemsMinDist)
    }
  } else if (site.type === 'dungeon') {
    out.dungeon = stampDungeon(deps, d, site, x0, y0, rng, biomeId, used, levelRange, out)
  }
  if (!out.nameZh) out.nameZh = regionName
  for (const sg of d.signs) out.signs.push({ ...sg, x: sg.x + x0, y: sg.y + y0 })
  for (const pr of d.props) out.props.push({ ...pr, x: pr.x + x0, y: pr.y + y0 })
  const tx: number[] = [], ty: number[] = [], tt: number[] = []
  for (let i = 0; i < W * W; i++) {
    if (d.terrain[i] === before[i]) continue
    tx.push((i % W) + x0); ty.push(Math.floor(i / W) + y0); tt.push(d.terrain[i])
  }
  out.tx = Int32Array.from(tx); out.ty = Int32Array.from(ty); out.tt = Uint8Array.from(tt)
  return out
}

function freeTile(d: MapDraft, i: number, level: number): boolean {
  const t = CONTENT.terrain[d.terrain[i]]
  return !d.occ[i] && (d.flags[i] & (F_RESERVED | F_PATH | F_KEEP)) === 0 && !!t?.walkable && !t.liquid && !t.stairs && d.elevation[i] === level
}

function placeItems(d: MapDraft, rng: Rng, x0: number, y0: number, site: FrontierSite, levelRange: Vec2, visible: number, hidden: number, out: SiteLayout, c: { x: number; y: number }, minDist: number): void {
  const rules = WORLD_CONTENT.items
  const levelMid = Math.round((levelRange[0] + levelRange[1]) / 2)
  const R = Math.ceil(site.radius) + 1
  const cands: number[] = []
  for (let y = c.y - R; y <= c.y + R; y++) for (let x = c.x - R; x <= c.x + R; x++) {
    if (x < 0 || y < 0 || x >= d.w || y >= d.h) continue
    const i = y * d.w + x
    if (freeTile(d, i, site.level) && Math.abs(x - c.x) + Math.abs(y - c.y) >= minDist) cands.push(i)
  }
  rng.shuffle(cands)
  let n = 0
  for (const hid of [...Array(visible).fill(false), ...Array(hidden).fill(true)] as boolean[]) {
    const i = cands.shift()
    if (i === undefined) break
    const item = pickItem(rules, levelMid, hid, rng)
    if (!item) break
    const band = bandFor(rules, levelMid)
    out.items.push({ id: `${site.id}:item:${n++}`, x: (i % d.w) + x0, y: Math.floor(i / d.w) + y0, item: item.id, qty: rng.int(band.qty[0], band.qty[1]), hidden: hid })
    d.flags[i] |= F_RESERVED
  }
}

function stampDungeon(deps: BaseDeps, d: MapDraft, site: FrontierSite, x0: number, y0: number, rng: Rng, biomeId: string, used: Set<string>, levelRange: Vec2, out: SiteLayout): DungeonPlan | null {
  const F = deps.fields
  const sc = F.cf.fc.sites
  const dg = WORLD_CONTENT.dungeons
  const like = [biomeId, ...(CONTENT.biomeById[biomeId]?.encounterHabitats ?? [])]
  const styles = dg.styles.filter((s) => s.biomes === 'any' || s.biomes.some((b) => like.includes(b)))
  const style = styles.length ? rng.pick(styles) : dg.styles[0]
  const nameZh = uniqueName(style.names, F.cf.lore, biomeId, rng, used)
  out.nameZh = nameZh
  const cx = site.x - x0, cy = site.y - y0
  // Mouth: the cave-entrance prop centred on the pad, facing south; its door front must be walkable.
  const padT = deps.fields.cf.fc.sites.dungeon.padTerrain
  const padId = CONTENT.terrainByKey[padT]?.id
  const pr = sc.dungeon.padRadius, pc = Math.ceil(pr)
  for (let y = cy - pc; y <= cy + pc; y++) for (let x = cx - pc; x <= cx + pc; x++) {
    const i = y * d.w + x
    if (padId !== undefined && d.elevation[i] === site.level && (d.flags[i] & (F_PATH | F_SEA)) === 0 && (x - cx) * (x - cx) + (y - cy) * (y - cy) <= pr * pr) d.terrain[i] = padId
  }
  const mouthProp = sc.dungeon.mouthProp
  const def = CONTENT.props[mouthProp]
  const p: PropPlacement = { prop: mouthProp, x: cx - Math.floor(def.footprint[0] / 2), y: cy - Math.floor(def.footprint[1] / 2), rot: 0 }
  if (!canPlace(d, p, { forbid: F_PATH | F_SEA })) return null
  const door = propDoor(p)
  if (!door) return null
  const fi = door.front.y * d.w + door.front.x
  if (!CONTENT.terrain[d.terrain[fi]]?.walkable || d.elevation[fi] !== site.level) return null
  placeProp(d, p)
  // Floor plans (maps are carved lazily by provider.interior()).
  const nFloors = rng.int(sc.dungeon.floors[0], sc.dungeon.floors[1])
  const floors: CaveSpec[] = []
  for (let k = 1; k <= nFloors; k++) {
    const w = rng.int(style.size[0][0], style.size[0][1]), h = rng.int(style.size[1][0], style.size[1][1])
    const upSide = rng.pick(SIDES)
    const downSide = rng.pick(SIDES.filter((s) => s !== upSide))
    const [a0, a1] = sc.dungeon.endAt
    const ends: CaveEndSpec[] = [{ id: 'up', side: upSide, at: a0 + rng.next() * (a1 - a0), region: '', near: [site.x, site.y] }]
    if (k < nFloors) ends.push({ id: 'down', side: downSide, at: a0 + rng.next() * (a1 - a0), region: '', near: [site.x, site.y] })
    const bonus = k * dg.levelPerFloor
    const maxLevel = CONTENT.config.party.maxLevel
    floors.push({
      id: `${site.id}:${k}`, nameZh: fmt(dg.floorName, { name: nameZh, floor: k }), w, h, algo: style.algo, walk: style.walk,
      biome: style.habitats[0] ?? biomeId, habitats: style.habitats, music: style.music, weather: style.weather,
      levelRange: [Math.min(maxLevel, levelRange[0] + bonus), Math.min(maxLevel, levelRange[1] + bonus)],
      encounterRate: dg.encounterRate, roamingDensity: dg.roamingDensity,
      floor: style.floor, wall: style.wall, wallElev: style.wallElev, mat: style.mat,
      fill: style.fill, iterations: style.iterations, birth: style.birth, survive: style.survive, tunnelRadius: style.tunnelRadius,
      tunnelNoise: { ...dg.tunnelNoise, salt: `${dg.tunnelNoise.salt}-${site.id}-${k}` }, tunnelCost: style.tunnelCost,
      accents: style.accents, props: style.props, ends, endProps: ends.map((e) => (e.id === 'down' ? dg.stairsProp : null)),
      spots: dg.spotsPerFloor + (k === nFloors ? 1 : 0), items: dg.items, minFloor: dg.minFloor,
    })
  }
  const arrive = endTile(floors[0], floors[0].ends[0])
  out.warps.push({ x: door.x + x0, y: door.y + y0, toMap: floors[0].id, toX: arrive.arrive.x, toY: arrive.arrive.y, facing: arrive.facing, kind: 'cave' })
  d.flags[door.y * d.w + door.x] |= F_RESERVED
  d.flags[fi] |= F_RESERVED | F_KEEP
  out.center = { x: door.front.x + x0, y: door.front.y + y0 }
  const text = fmt(WORLD_CONTENT.world.text.dungeonSign, { dungeon: nameZh, floors: nFloors, level: floors[0].levelRange[0] })
  out.description = text
  const off = sc.dungeon.signOffset
  for (const sx of [door.front.x - off, door.front.x + off]) {
    const sp: PropPlacement = { prop: WORLD_CONTENT.world.overworld.signProps.sign, x: sx, y: door.front.y, rot: 0 }
    if (!canPlace(d, sp, { forbid: F_PATH | F_RESERVED | F_KEEP })) continue
    placeProp(d, sp)
    d.signs.push({ x: sx, y: door.front.y, text, kind: 'sign' })
    break
  }
  return { style, floors, mouth: { x: door.front.x + x0, y: door.front.y + y0 } }
}

/** Place entry for the world map / fly list. */
export function siteTown(layout: SiteLayout, overworldId: string, format: Record<string, string>, regionName: string): TownDef | null {
  const s = layout.site
  if (!s.kind.place) return null
  const fmtKey = s.type === 'dungeon' ? 'dungeon' : s.kind.place
  const tpl = format[fmtKey] ?? '{name}'
  const description = s.type === 'dungeon' || s.type === 'poi' ? layout.description || fmt(tpl, { name: layout.nameZh, region: regionName })
    : fmt(tpl, { name: layout.nameZh, region: regionName })
  return { id: s.id, nameZh: layout.nameZh, map: overworldId, x: layout.center.x, y: layout.center.y, description, kind: s.kind.place, levelRange: layout.levelRange }
}
