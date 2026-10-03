// Global jittered site grid of the frontier: every cell (sx, sy) of sites.json `cell` tiles deterministically
// hosts at most one site (hamlet / dungeon / POI landmark / nothing), chosen from the cell hash, the climate at
// the jittered point and the distance from the origin. Causeway gateways force a hamlet into their cell.
import type { SiteKindSpec } from './schema.ts'
import { CONTENT } from '../../content/index.ts'
import { WORLD_CONTENT } from '../data.ts'
import { hash3, rngFor, type Rng } from '../random.ts'
import type { PoiTemplate } from '../schema.ts'
import { curve } from './config.ts'
import { Fields, newColumn, W_SEA } from './fields.ts'
import { Lru } from './lru.ts'

/** Causeway landing point in the frontier (computed from the core map). */
export interface Gate {
  id: string
  /** Core-edge tile where the causeway leaves the core rectangle. */
  edge: { x: number; y: number }
  /** First tile outside the core (start of the frontier lane). */
  out: { x: number; y: number }
  /** Gateway hamlet centre. */
  x: number
  y: number
  dir: { x: number; y: number }
}

export interface FrontierSite {
  id: string
  sx: number
  sy: number
  kind: SiteKindSpec
  type: 'hamlet' | 'poi' | 'dungeon'
  /** POI template id, 'hamlet' or 'dungeon'. */
  template: string
  x: number
  y: number
  radius: number
  /** Pad elevation level. */
  level: number
  /** CONTENT.biomes index at the centre. */
  biome: number
  roads: boolean
  shore: boolean
  /** Distance from the world origin (tiles). */
  dist: number
  gate: Gate | null
}

// 16 probe directions from small integer vectors (no trigonometry: bit-identical on every engine).
const DIRS: [number, number][] = [[1, 0], [2, 1], [1, 1], [1, 2], [0, 1], [-1, 2], [-1, 1], [-2, 1], [-1, 0], [-2, -1], [-1, -1], [-1, -2], [0, -1], [1, -2], [1, -1], [2, -1]]
  .map(([x, y]) => { const l = Math.sqrt(x * x + y * y); return [x / l, y / l] as [number, number] })

export function siteId(kindId: string, sx: number, sy: number): string { return `fx:${kindId}:${sx}:${sy}` }

/** Parses 'fx:<kind>:<sx>:<sy>[:<part>]'. */
export function parseFrontierId(id: string): { kind: string; sx: number; sy: number; part: string | null } | null {
  if (!id.startsWith('fx:')) return null
  const p = id.split(':')
  if (p.length < 4) return null
  const sx = Number(p[2]), sy = Number(p[3])
  if (!Number.isInteger(sx) || !Number.isInteger(sy)) return null
  return { kind: p[1], sx, sy, part: p.length > 4 ? p.slice(4).join(':') : null }
}

export class SiteGrid {
  readonly fields: Fields
  readonly cell: number
  readonly gates: Gate[]
  private readonly cache: Lru<string, FrontierSite | null>
  private readonly gateCell = new Map<string, Gate>()
  readonly maxRadius: number
  readonly templates: Record<string, PoiTemplate>

  constructor(fields: Fields, gates: Gate[]) {
    this.fields = fields
    const sc = fields.cf.fc.sites
    this.cell = sc.cell
    this.gates = gates
    this.cache = new Lru(fields.cf.fc.gen.cache.sites)
    for (const g of gates) this.gateCell.set(`${Math.floor(g.x / this.cell)},${Math.floor(g.y / this.cell)}`, g)
    this.templates = { ...WORLD_CONTENT.pois.templates, ...sc.templates }
    let r = Math.max(sc.hamlet.radius, sc.dungeon.radius)
    for (const id of sc.landmarkPool) r = Math.max(r, this.templates[id]?.radius ?? 0)
    for (const k of sc.kinds) if (k.template && k.template !== '*') r = Math.max(r, this.templates[k.template]?.radius ?? 0)
    this.maxRadius = r
  }

  cellOf(x: number, y: number): [number, number] { return [Math.floor(x / this.cell), Math.floor(y / this.cell)] }

  siteAt(sx: number, sy: number): FrontierSite | null {
    const key = `${sx},${sy}`
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    const s = this.compute(sx, sy)
    this.cache.set(key, s)
    return s
  }

  /** Sites whose centre lies within `pad` tiles of the rect [x0, x1) x [y0, y1). */
  sitesNear(x0: number, y0: number, x1: number, y1: number, pad: number): FrontierSite[] {
    const out: FrontierSite[] = []
    const C = this.cell
    for (let sy = Math.floor((y0 - pad) / C); sy <= Math.floor((y1 + pad) / C); sy++) {
      for (let sx = Math.floor((x0 - pad) / C); sx <= Math.floor((x1 + pad) / C); sx++) {
        const s = this.siteAt(sx, sy)
        if (s && s.x >= x0 - pad && s.x < x1 + pad && s.y >= y0 - pad && s.y < y1 + pad) out.push(s)
      }
    }
    return out
  }

  private eligible(tpl: PoiTemplate | undefined, biome: number, shore: boolean): boolean {
    if (!tpl) return false
    if ((tpl.site === 'shore' || tpl.site === 'island') && !shore) return false
    if (tpl.biomes === 'any') return true
    const b = CONTENT.biomes[biome]
    if (!b) return false
    if (tpl.biomes.includes(b.id)) return true
    return (b.encounterHabitats ?? []).some((h) => (tpl.biomes as string[]).includes(h))
  }

  private compute(sx: number, sy: number): FrontierSite | null {
    const F = this.fields
    const sc = F.cf.fc.sites
    const C = this.cell
    const col = newColumn()
    const gate = this.gateCell.get(`${sx},${sy}`)
    let x: number, y: number
    const rng = rngFor(F.seed, `fx-site-${sx}-${sy}`)
    if (gate) { x = gate.x; y = gate.y }
    else {
      const m = Math.floor(C * sc.margin)
      x = sx * C + m + Math.floor(rng.next() * (C - 2 * m))
      y = sy * C + m + Math.floor(rng.next() * (C - 2 * m))
      for (const g of this.gates) {
        const dx = g.x - x, dy = g.y - y
        const ex = 2 * sc.hamlet.radius + sc.gateway.exclusion
        if (dx * dx + dy * dy < ex * ex) return null
      }
    }
    if (!gate && F.coreDist(x, y) < this.maxRadius + sc.hamlet.window + F.cf.fc.gen.continent.moat.near) return null
    F.columnAt(x, y, col)
    if (col.water !== 0 && !gate) return null
    const biome = col.biome
    const level = col.level
    // Land probe: the pad ring must be land; `shore` when the sea is within twice the probe radius.
    let land = 0, shore = false
    for (const [dx, dy] of DIRS) {
      F.columnAt(Math.round(x + dx * sc.probe.radius), Math.round(y + dy * sc.probe.radius), col)
      if (col.water !== W_SEA) land++
      F.columnAt(Math.round(x + dx * sc.probe.radius * sc.probe.shoreFactor), Math.round(y + dy * sc.probe.radius * sc.probe.shoreFactor), col)
      if (col.water === W_SEA) shore = true
    }
    const dist = F.originDist(x, y)
    if (gate) {
      const kind = sc.kinds.find((k) => k.type === 'hamlet')!
      return { id: siteId(kind.id, sx, sy), sx, sy, kind, type: 'hamlet', template: 'hamlet', x, y, radius: sc.hamlet.radius, level, biome, roads: true, shore, dist, gate }
    }
    if (land < sc.probe.minLand) return null
    const bid = CONTENT.biomes[biome]?.id ?? ''
    const options: { kind: SiteKindSpec; template: string; w: number }[] = []
    for (const kind of sc.kinds) {
      if (kind.minDistance !== undefined && dist < kind.minDistance) continue
      let w = kind.weight * (kind.distance ? curve(kind.distance as [number, number][], dist) : 1) * (kind.biomes?.[bid] ?? 1)
      if (w <= 0) continue
      let template = kind.type === 'hamlet' ? 'hamlet' : kind.type === 'dungeon' ? 'dungeon' : kind.type === 'none' ? 'none' : kind.template ?? '*'
      if (kind.type === 'poi') {
        if (template === '*') {
          const pool = sc.landmarkPool.filter((id) => this.eligible(this.templates[id], biome, shore))
          if (!pool.length) continue
          template = pool[Math.floor(rng.next() * pool.length)]
        } else if (!this.eligible(this.templates[template], biome, shore)) w *= 0
      }
      if (w > 0) options.push({ kind, template, w })
    }
    if (!options.length) return null
    const pick = rng.weighted(options, (o) => o.w)
    if (pick.kind.type === 'none') return null
    const radius = pick.kind.type === 'hamlet' ? sc.hamlet.radius : pick.kind.type === 'dungeon' ? sc.dungeon.radius : this.templates[pick.template]?.radius ?? sc.dungeon.radius
    return {
      id: siteId(pick.kind.id, sx, sy), sx, sy, kind: pick.kind, type: pick.kind.type as FrontierSite['type'], template: pick.template,
      x, y, radius, level, biome, roads: pick.kind.roads, shore, dist, gate: null,
    }
  }
}

/** Deterministic per-site generator. */
export function siteRng(seed: number, site: FrontierSite, salt: string): Rng { return rngFor(seed, `${site.id}-${salt}`) }

/** Uniform [0,1) from a site + integer salt (no Rng allocation). */
export function siteHash(seed: number, sx: number, sy: number, salt: number): number { return hash3(seed ^ salt, sx, sy) / 4294967296 }
