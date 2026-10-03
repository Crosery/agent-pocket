// Site selection for procedural hamlets, points of interest and dungeon mouths. Runs inside the macro stage
// (before hydrology) so pads can be flattened and rivers route around them. Candidates come from a jittered
// lattice (pois.json siteStep), shuffled per seed; each kind takes the first candidates satisfying its biome,
// wildness, coast, flatness, spacing and town-distance rules (pois.json / dungeons.json).
import { CONTENT } from '../content/index.ts'
import { hash3, rngFor, seedFor } from './random.ts'
import type { IslandInfo, TownPad } from './macro.ts'
import type { WorldContent } from './data.ts'

export interface Site {
  id: string
  kind: 'hamlet' | 'poi' | 'dungeon'
  /** POI template id, dungeon style id or 'hamlet'. */
  template: string
  x: number
  y: number
  radius: number
  /** Flattened pad (hamlets and POIs). */
  pad: boolean
  level: number
  zone: number
  /** island index + 1 (macro.islands) or 0. */
  island: number
  biome: number
}

export interface SiteInput {
  seed: number
  wc: WorldContent
  W: number
  H: number
  hf: Float32Array
  sea: Uint8Array
  island: Uint8Array
  islands: IslandInfo[]
  wild: Uint8Array
  zoneRaw: Uint8Array
  wildness: Float32Array
  seaDist: Uint16Array
  borderDist: Uint16Array
  lake: Uint8Array
  /** Chebyshev distance to authored lakes and their rims (capped). */
  lakeDist: Uint16Array
  pads: TownPad[]
  walled: boolean[]
  cliffZone: boolean[]
  biomeAt: (i: number) => number
}

interface Cand { x: number; y: number; i: number }

export function chooseSites(s: SiteInput): Site[] {
  const { W, H, wc } = s
  const pois = wc.pois
  const dg = wc.dungeons
  const step = Math.max(4, pois.siteStep)
  const seed = seedFor(s.seed, 'sites')
  const cands: Cand[] = []
  const margin = 24
  for (let gy = 0; gy * step < H; gy++) for (let gx = 0; gx * step < W; gx++) {
    const h = hash3(seed, gx, gy)
    const x = gx * step + (h & 0xff) % step, y = gy * step + ((h >>> 8) & 0xff) % step
    if (x < margin || y < margin || x >= W - margin || y >= H - margin) continue
    const i = y * W + x
    if (s.sea[i] || s.lake[i]) continue
    cands.push({ x, y, i })
  }
  rngFor(s.seed, 'sites-order').shuffle(cands)
  const chosen: Site[] = []
  const authoredIslands = s.islands.filter((x) => x.authored).length

  const townDist = (x: number, y: number) => {
    let best = Infinity
    for (const p of s.pads) {
      const dx = Math.max(p.rect.x - x, 0, x - (p.rect.x + p.rect.w)), dy = Math.max(p.rect.y - y, 0, y - (p.rect.y + p.rect.h))
      best = Math.min(best, Math.sqrt(dx * dx + dy * dy))
    }
    return best
  }
  const spaced = (x: number, y: number, r: number, sp: number) => chosen.every((o) => {
    const need = Math.max(sp, o.radius + r + 8)
    return (o.x - x) * (o.x - x) + (o.y - y) * (o.y - y) >= need * need
  })
  const flatness = (x: number, y: number, r: number) => {
    let lo = Infinity, hi = -Infinity
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const xx = Math.min(W - 1, Math.max(0, x + ox * r)), yy = Math.min(H - 1, Math.max(0, y + oy * r))
      const i = yy * W + xx
      if (s.sea[i] || s.lake[i]) return Infinity
      const v = s.hf[i]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    return hi - lo
  }
  const landOk = (c: Cand) => !s.island[c.i] && s.walled[s.wild[c.i]] && s.walled[s.zoneRaw[c.i]]
  // Away from walled zone borders and authored lakes (a pad next to a lake rim would form a cliff).
  const borderOk = (c: Cand, r: number) => s.borderDist[c.i] >= Math.min(r + 4, s.wc.world.overworld.landforms.borderRidge.width) && s.lakeDist[c.i] >= r + 4
  const biomeId = (c: Cand) => CONTENT.biomes[s.biomeAt(c.i)]?.id ?? ''
  const allowed = (list: string[] | 'any', c: Cand) => list === 'any' || list.includes(biomeId(c))

  const take = (n: number, make: (c: Cand) => Site | null) => {
    for (const c of cands) {
      if (n <= 0) break
      const site = make(c)
      if (!site) continue
      chosen.push(site)
      n--
    }
  }
  const rng = rngFor(s.seed, 'site-counts')
  const pick = (r: [number, number]) => rng.int(r[0], r[1])

  // Hamlets: spread out, flat, away from towns, in the wilds.
  const hs = pois.hamlets
  let hn = 0
  const hWant = pick(hs.count)
  for (const relax of [1, 2]) {
    take(hWant - hn, (c) => {
      if (!landOk(c) || s.wildness[c.i] < hs.wildMin / relax || !borderOk(c, hs.radius)) return null
      if (townDist(c.x, c.y) < hs.minTownDist || !spaced(c.x, c.y, hs.radius, hs.spacing / relax)) return null
      if (flatness(c.x, c.y, hs.radius) > pois.flatMax * relax) return null
      hn++
      return { id: `h${hn}`, kind: 'hamlet', template: 'hamlet', x: c.x, y: c.y, radius: hs.radius, pad: true, level: 0, zone: s.wild[c.i], island: 0, biome: s.biomeAt(c.i) }
    })
    if (hn >= hs.count[0]) break
  }

  // Dungeon mouths: in the wilds, prefer rugged ground (a cliff to dig into).
  let dn = 0
  const dWant = pick(dg.count)
  for (const relax of [1, 2]) {
    take(dWant - dn, (c) => {
      if (!landOk(c) || !borderOk(c, 6) || townDist(c.x, c.y) < dg.minTownDist || !spaced(c.x, c.y, 6, dg.spacing / relax)) return null
      const rough = flatness(c.x, c.y, 6)
      if (rough === Infinity || (relax === 1 && rough < 1)) return null
      const styles = dg.styles.filter((st) => allowed(st.biomes, c))
      if (!styles.length) return null
      const style = styles[hash3(seed, c.x, c.y) % styles.length]
      dn++
      return { id: `dg${dn}`, kind: 'dungeon', template: style.id, x: c.x, y: c.y, radius: 6, pad: false, level: 0, zone: s.wild[c.i], island: 0, biome: s.biomeAt(c.i) }
    })
  }

  // Points of interest, in JSON order.
  const counters = new Map<string, number>()
  for (const [tid, t] of Object.entries(pois.templates)) {
    const want = pick(t.count)
    for (const relax of [1, 2]) {
      const have = counters.get(tid) ?? 0
      if (have >= want) break
      take(want - have, (c) => {
        const site = t.site ?? 'land'
        if (site === 'island') {
          if (s.island[c.i] <= authoredIslands) return null
        } else if (!landOk(c)) return null
        if (site === 'shore' && (s.seaDist[c.i] < t.radius + 2 || s.seaDist[c.i] > t.radius + 10 || s.cliffZone[s.zoneRaw[c.i]])) return null
        if (s.wildness[c.i] < (t.wildMin ?? 0) / relax || !allowed(t.biomes, c)) return null
        if (site !== 'island' && !borderOk(c, t.radius)) return null
        if (townDist(c.x, c.y) < t.radius + 24 || !spaced(c.x, c.y, t.radius, t.spacing / relax)) return null
        if (flatness(c.x, c.y, t.radius) > pois.flatMax * relax) return null
        const k = (counters.get(tid) ?? 0) + 1
        counters.set(tid, k)
        return { id: `${tid}-${k}`, kind: 'poi', template: tid, x: c.x, y: c.y, radius: t.radius, pad: true, level: 0, zone: s.wild[c.i], island: s.island[c.i], biome: s.biomeAt(c.i) }
      })
    }
  }
  return chosen
}
