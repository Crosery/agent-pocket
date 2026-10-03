// Points of interest from pois.json `templates`: each site gets noisy ground blobs (ruin floor, crystal
// floor, oasis water, hot-spring shallows...), props placed by a small grammar (centre / ring / scatter /
// grid / on water), a lore sign, reserved spots for story NPCs, optional rare-spawn nest grass and ground-item
// quotas. Props never touch each other (1-tile margin) so a POI can never seal itself off.
import type { PropPlacement } from '../types.ts'
import { CONTENT } from '../content/index.ts'
import { propRect, propSize } from './collision.ts'
import {
  F_BRIDGE, F_KEEP, F_LAKE, F_NEST, F_PATH, F_RESERVED, F_ROAD, F_SEA, F_SITE, F_TOWN, addFlag, canPlace, hasFlag, inside, placeProp,
} from './grid.ts'
import { loreText, uniqueName } from './lore.ts'
import { noiseField, rngFor } from './random.ts'
import type { PoiPart, PoiTemplate } from './schema.ts'
import type { Site } from './sites.ts'
import { addAnchor, tid, type OwCtx } from './ctx.ts'
import { placeSign } from './towns.ts'
import { annulusPoint, localReach, marginFree } from './hamlets.ts'

export interface StampedPoi {
  site: Site
  id: string
  nameZh: string
  template: string
  tpl: PoiTemplate
  biome: string
  center: { x: number; y: number }
  spots: { x: number; y: number }[]
  /** Nest grass tiles (own encounter region). */
  nest: number[]
  island: boolean
}

const dry = (t: number) => { const d = CONTENT.terrain[t]; return d?.walkable === true && !d.liquid && !d.stairs }

export function stampPois(ctx: OwCtx, sites: Site[], used: Set<string>): StampedPoi[] {
  const { d } = ctx
  const pois = ctx.wc.pois
  const blobNoise = noiseField(ctx.spec.lakeNoise, ctx.seed ^ 0x9e37)
  const out: StampedPoi[] = []
  const forbid = F_PATH | F_RESERVED | F_ROAD | F_TOWN | F_BRIDGE
  for (const site of sites) {
    if (site.kind !== 'poi') continue
    const tpl = pois.templates[site.template]
    if (!tpl) { ctx.problems.push(`poi ${site.id}: unknown template "${site.template}"`); continue }
    const rng = rngFor(ctx.seed, `poi-${site.id}`)
    const biome = CONTENT.biomes[site.biome]?.id ?? 'meadow'
    const nameZh = uniqueName(tpl.names, pois.lore, biome, rng, used)
    const cx = site.x, cy = site.y, R = site.radius, level = site.level
    const dist2 = (x: number, y: number) => (x - cx) * (x - cx) + (y - cy) * (y - cy)
    const ownable = (i: number) => d.elevation[i] === level && (d.flags[i] & (F_TOWN | F_SEA | F_LAKE | F_PATH | F_BRIDGE)) === 0 && !d.occ[i]
    for (let y = cy - R; y <= cy + R; y++) for (let x = cx - R; x <= cx + R; x++) {
      if (inside(d, x, y) && dist2(x, y) <= R * R && ownable(y * d.w + x) && CONTENT.terrain[d.terrain[y * d.w + x]]?.walkable) addFlag(d, y * d.w + x, F_SITE)
    }
    const mine = (x: number, y: number) => inside(d, x, y) && hasFlag(d, y * d.w + x, F_SITE) && dist2(x, y) <= (R + 0.5) * (R + 0.5)
    for (const b of tpl.ground ?? []) {
      const t = tid(b.terrain)
      const def = CONTENT.terrain[t]
      const water = !def.walkable && def.swim
      const r0 = Math.ceil(b.radius * (1 + b.noise))
      for (let y = cy - r0; y <= cy + r0; y++) for (let x = cx - r0; x <= cx + r0; x++) {
        if (!mine(x, y)) continue
        const i = y * d.w + x
        if (d.occ[i] || hasFlag(d, i, F_RESERVED | F_ROAD)) continue
        const rr = b.radius * (1 + (blobNoise.sample(x, y) - 0.5) * 2 * b.noise)
        const dd = Math.sqrt(dist2(x, y))
        if (dd > rr || (b.ring && (dd < b.ring[0] || dd > b.ring[1]))) continue
        d.terrain[i] = t
        if (water) addFlag(d, i, F_LAKE)
      }
    }
    if (tpl.nest) {
      const key = tpl.nest.byBiome?.[biome] ?? tpl.nest.terrain
      const t = tid(key)
      const r0 = Math.ceil(tpl.nest.radius * 1.4)
      for (let y = cy - r0; y <= cy + r0; y++) for (let x = cx - r0; x <= cx + r0; x++) {
        if (!mine(x, y)) continue
        const i = y * d.w + x
        const rr = tpl.nest.radius * (1 + (blobNoise.sample(x, y) - 0.5) * 0.8)
        if (Math.sqrt(dist2(x, y)) > rr || d.occ[i] || !dry(d.terrain[i])) continue
        d.terrain[i] = t
        addFlag(d, i, F_NEST)
      }
    }
    for (const part of tpl.parts) placeParts(ctx, part, rng, cx, cy, R, level, mine, forbid)
    const free = (x: number, y: number) => {
      if (!inside(d, x, y)) return false
      const i = y * d.w + x
      return !d.occ[i] && !hasFlag(d, i, F_RESERVED | F_PATH) && dry(d.terrain[i]) && d.elevation[i] === level
    }
    let center = { x: cx, y: cy }
    for (let r = 0, found = false; r <= R + 2 && !found; r++) {
      for (let y = cy - r; y <= cy + r && !found; y++) for (let x = cx - r; x <= cx + r; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r || !free(x, y)) continue
        center = { x, y }; found = true; break
      }
    }
    addFlag(d, center.y * d.w + center.x, F_RESERVED | F_KEEP)
    addAnchor(ctx.anchors, ctx.problems, `poi:${site.id}:center`, d.id, center.x, center.y)
    if (tpl.sign) {
      const text = loreText(tpl.sign, pois.lore, biome, rng, { name: nameZh })
      let signed = !text
      for (let t = 0; t < 80 && !signed; t++) {
        const at = annulusPoint(rng, center.x, center.y, 1, Math.min(3, R))
        if (!mine(at.x, at.y) || !free(at.x, at.y)) continue
        if (!marginFree(ctx.d, { prop: ctx.spec.signProps.sign, x: at.x, y: at.y, rot: 0 })) continue
        signed = placeSign(ctx, at.x, at.y, text!, 'sign')
      }
    }
    const spots: { x: number; y: number }[] = []
    const around = localReach(d, center.x, center.y, R + 2, level)
    for (let t = 0; t < 200 && spots.length < tpl.spots; t++) {
      const at = annulusPoint(rng, cx, cy, 1.5, R + 1)
      if (!free(at.x, at.y) || !inside(d, at.x, at.y) || !around.has(at.y * d.w + at.x)) continue
      if (spots.some((s) => Math.abs(s.x - at.x) + Math.abs(s.y - at.y) < 3) || Math.abs(center.x - at.x) + Math.abs(center.y - at.y) < 2) continue
      spots.push(at)
      addFlag(d, at.y * d.w + at.x, F_RESERVED | F_KEEP)
      addAnchor(ctx.anchors, ctx.problems, `poi:${site.id}:spot:${spots.length}`, d.id, at.x, at.y)
    }
    const nest: number[] = []
    if (tpl.nest) for (let y = cy - R - 2; y <= cy + R + 2; y++) for (let x = cx - R - 2; x <= cx + R + 2; x++) {
      if (inside(d, x, y) && hasFlag(d, y * d.w + x, F_NEST) && mine(x, y)) nest.push(y * d.w + x)
    }
    out.push({ site, id: site.id, nameZh, template: site.template, tpl, biome, center, spots, nest, island: site.island > 0 })
  }
  return out
}

function placeParts(ctx: OwCtx, part: PoiPart, rng: ReturnType<typeof rngFor>, cx: number, cy: number, R: number, level: number, mine: (x: number, y: number) => boolean, forbid: number): void {
  const { d } = ctx
  const def = CONTENT.props[part.prop]
  if (!def) { ctx.problems.push(`poi: unknown prop "${part.prop}"`); return }
  const on = part.on ? new Set(part.on.map(tid)) : null
  const n = rng.int(part.count[0], part.count[1])
  const square = def.footprint[0] === def.footprint[1]
  const fits = (p: PropPlacement) => {
    const r = propRect(p)
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (!mine(x, y) || d.elevation[y * d.w + x] !== level) return false
    return marginFree(d, p) && canPlace(d, p, { on, forbid })
  }
  const place = part.place
  if (place.mode === 'water') {
    for (let k = 0; k < n; k++) {
      let best: PropPlacement | null = null, bd = Infinity
      const S = R + 12
      for (let y = cy - S; y <= cy + S; y++) for (let x = cx - S; x <= cx + S; x++) {
        for (const rot of [0, 1] as const) {
          const p: PropPlacement = { prop: part.prop, x, y, rot }
          const r = propRect(p)
          if (r.x < 1 || r.y < 1 || r.x + r.w >= d.w - 1 || r.y + r.h >= d.h - 1) continue
          let ok = true, shore = false
          for (let yy = r.y - 1; yy <= r.y + r.h && ok; yy++) for (let xx = r.x - 1; xx <= r.x + r.w; xx++) {
            const i = yy * d.w + xx
            const inner = xx >= r.x && yy >= r.y && xx < r.x + r.w && yy < r.y + r.h
            const t = CONTENT.terrain[d.terrain[i]]
            if (inner) { if (!t?.swim || t.walkable || d.occ[i] || hasFlag(d, i, F_RESERVED | F_PATH | F_BRIDGE)) { ok = false; break } }
            else if (d.occ[i]) { ok = false; break }
            else if (t?.walkable && !t.liquid && (xx === r.x - 1 || xx === r.x + r.w || yy === r.y - 1 || yy === r.y + r.h)) shore = true
          }
          if (!ok || !shore) continue
          const dd = (x - cx) * (x - cx) + (y - cy) * (y - cy)
          if (dd < bd) { bd = dd; best = p }
        }
      }
      if (best) placeProp(d, best)
    }
    return
  }
  if (place.mode === 'grid') {
    const s = Math.max(2, place.spacing)
    let k = 0
    for (let y = cy - place.radius; y <= cy + place.radius && k < n; y += s) for (let x = cx - place.radius; x <= cx + place.radius && k < n; x += s) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > place.radius * place.radius) continue
      const p: PropPlacement = { prop: part.prop, x, y, rot: 0 }
      if (fits(p)) { placeProp(d, p); k++ }
    }
    return
  }
  for (let k = 0, t = 0; k < n && t < 40 * n; t++) {
    let at: { x: number; y: number }
    if (place.mode === 'center') at = { x: cx, y: cy }
    else if (place.mode === 'ring') at = annulusPoint(rng, cx, cy, place.radius[0], place.radius[1])
    else at = annulusPoint(rng, cx, cy, 0, place.radius)
    const rot = (part.rot ?? (square ? rng.int(0, 3) : rng.int(0, 1) * 2)) as 0 | 1 | 2 | 3
    const [w, h] = propSize(part.prop, rot)
    const p: PropPlacement = { prop: part.prop, x: at.x - Math.floor(w / 2), y: at.y - Math.floor(h / 2), rot }
    if (fits(p)) { placeProp(d, p); k++ }
    if (place.mode === 'center' && t > 4) break
  }
}
