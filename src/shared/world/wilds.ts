// Procedural wilderness regions: every non-core land tile belongs to (zone, warped Worley cell); each such
// region is named from the biome word pools in wilds.json, takes its majority climate biome, and gets a danger
// tier from its distance to the authored core (deep wilds = higher levels, richer rare spawns, more roaming).
// Level ranges also grow with the distance from the start town. Encounter tables come from CONTENT.speciesList.
import type { FieldWeatherKind, RegionDef } from '../types.ts'
import { CONTENT } from '../content/index.ts'
import { fbm, latticeSize, worley, type WorleyOut } from '../noise.ts'
import { computeEncounters } from './encounters.ts'
import { fmt } from './grid.ts'
import { fbmOpts, noiseFor } from './macro.ts'
import { rngFor, seedFor } from './random.ts'
import type { OwCtx } from './ctx.ts'
import type { Vec2 } from './schema.ts'

export interface WildRegion {
  def: RegionDef
  zone: number
  tiles: number
  /** Tile closest to the region's centroid (inside the region). */
  center: { x: number; y: number }
  danger: number
  biome: string
  /** True when the region lies on surf-only islands. */
  island: boolean
}

export interface WildResult {
  regions: WildRegion[]
  /** Index into `regions` per tile, -1 = not wilderness (core, sea, merged fragment). */
  tileWild: Int16Array
}

interface Acc { key: number; zone: number; count: number; sx: number; sy: number; dist: number; hist: Int32Array; island: number }

export function computeWilds(ctx: OwCtx, start: { x: number; y: number }, used: Set<string>): WildResult {
  const { d, macro, wc, seed } = ctx
  const wl = wc.wilds
  const W = d.w, H = d.h, N = W * H
  const C = Math.max(1, ctx.spec.coarse)
  const { gw, gh } = latticeSize(W, H, C)
  const wxN = noiseFor(seed, wl.warp.noise, '-x'), wyN = noiseFor(seed, wl.warp.noise, '-y'), wo = fbmOpts(wl.warp.noise)
  const cellSeed = seedFor(seed, 'wild-cells')
  const out: WorleyOut = { f1: 0, f2: 0, id: 0, cx: 0, cy: 0 }
  const cellLat = new Int32Array(gw * gh)
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const x = gx * C, y = gy * C
    const px = x + fbm(wxN, x, y, wo) * 1.4 * wl.warp.amplitude, py = y + fbm(wyN, x, y, wo) * 1.4 * wl.warp.amplitude
    worley(cellSeed, px / wl.cell, py / wl.cell, wl.jitter, out)
    cellLat[gy * gw + gx] = ((out.cy + 512) & 0x3ff) * 1024 + ((out.cx + 512) & 0x3ff)
  }
  const nb = CONTENT.biomes.length
  const accs = new Map<number, Acc>()
  const keyOf = new Int32Array(N).fill(-1)
  let last: Acc | null = null
  for (let y = 0; y < H; y++) {
    const gy = Math.min(gh - 1, Math.round(y / C))
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (macro.core[i] || (macro.sea[i] && !macro.island[i])) continue
      const zone = macro.wild[i]
      const cell = cellLat[gy * gw + Math.min(gw - 1, Math.round(x / C))]
      const key = zone * 0x100000 + cell
      if (!last || last.key !== key) {
        last = accs.get(key) ?? null
        if (!last) {
          last = { key, zone, count: 0, sx: 0, sy: 0, dist: 0, hist: new Int32Array(nb), island: 0 }
          accs.set(key, last)
        }
      }
      keyOf[i] = key
      last.count++
      last.sx += x; last.sy += y
      last.dist += macro.coreDist[i]
      last.hist[macro.biome[i]]++
      if (macro.island[i]) last.island++
    }
  }
  let list = [...accs.values()].filter((a) => a.count >= wl.minArea || (a.island > 0 && a.count >= Math.min(wl.minArea, 60)))
  list.sort((a, b) => b.count - a.count || a.key - b.key)
  list = list.slice(0, wl.maxRegions)
  list.sort((a, b) => a.key - b.key)
  const index = new Map(list.map((a, k) => [a.key, k]))
  const tileWild = new Int16Array(N).fill(-1)
  for (let i = 0; i < N; i++) {
    if (keyOf[i] < 0) continue
    const k = index.get(keyOf[i])
    if (k !== undefined) tileWild[i] = k
  }
  // Region centre: member tile nearest to the centroid.
  const centers = list.map((a) => ({ cx: a.sx / a.count, cy: a.sy / a.count, best: -1, bd: Infinity }))
  for (let i = 0; i < N; i++) {
    const k = tileWild[i]
    if (k < 0) continue
    const c = centers[k]
    const x = i % W, y = (i - x) / W
    const dd = (x - c.cx) * (x - c.cx) + (y - c.cy) * (y - c.cy)
    if (dd < c.bd) { c.bd = dd; c.best = i }
  }
  const zoneCount = new Map<number, number>()
  const maxLevel = CONTENT.config.party.maxLevel
  const regions: WildRegion[] = list.map((a, k) => {
    const zoneSpec = wc.regions[a.zone]
    let bi = 0
    for (let b = 1; b < nb; b++) if (a.hist[b] > a.hist[bi]) bi = b
    const biome = CONTENT.biomes[bi].id
    const meanDist = a.dist / a.count
    let tier = 0
    wl.tiers.forEach((t, ti) => { if (meanDist >= t.minDist) tier = ti })
    const T = wl.tiers[tier]
    const ci = centers[k].best
    const center = { x: ci % W, y: Math.floor(ci / W) }
    const dStart = Math.sqrt((center.x - start.x) * (center.x - start.x) + (center.y - start.y) * (center.y - start.y))
    const extra = Math.min(wl.levels.maxOver, Math.max(0, Math.floor((dStart - wl.levels.startDistance) * wl.levels.perTile)))
    const lo = Math.max(1, Math.min(maxLevel, zoneSpec.levelRange[0] + T.levelBonus + extra))
    const hi = Math.max(lo, Math.min(maxLevel, Math.max(zoneSpec.levelRange[1] + T.levelBonus + extra, lo + wl.levels.span)))
    const levelRange: Vec2 = [lo, hi]
    const n = (zoneCount.get(a.zone) ?? 0) + 1
    zoneCount.set(a.zone, n)
    const id = fmt(wl.idPattern, { zone: zoneSpec.id, n })
    const rng = rngFor(seed, `wild-name-${id}`)
    const pool = wl.names[biome] ?? wl.names[zoneSpec.biome]
    let nameZh = ''
    for (let t = 0; t < 30 && (!nameZh || used.has(nameZh)); t++) nameZh = rng.pick(pool.prefix) + rng.pick(pool.suffix)
    if (used.has(nameZh)) { let c = 2; while (used.has(fmt(wl.dupPattern, { name: nameZh, n: c }))) c++; nameZh = fmt(wl.dupPattern, { name: nameZh, n: c }) }
    used.add(nameZh)
    const def: RegionDef = {
      id, nameZh, biome,
      music: wl.biomeMusic[biome] ?? zoneSpec.music,
      weather: (wl.biomeWeather[biome] ?? zoneSpec.weather) as FieldWeatherKind,
      encounters: computeEncounters({ key: id, biomes: [biome], fallback: [zoneSpec.biome], levelRange, rareBoost: T.rareBoost }, wc.world.encounters, seed),
      encounterRate: T.encounterRate,
      roamingDensity: T.roamingDensity,
      levelRange,
    }
    Object.assign(def, { danger: tier })
    return { def, zone: a.zone, tiles: a.count, center, danger: tier, biome, island: a.island * 2 > a.count }
  })
  return { regions, tileWild }
}
