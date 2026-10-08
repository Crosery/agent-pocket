// Procedural hamlets (pois.json `hamlets`): a layout grammar on a flattened pad instead of fixed stamps —
// plaza with a centre piece, 3-8 houses (optionally a center + shop) on a ring facing the plaza, each joined
// to the plaza by a carved lane, fenced fields with crops, decor, a lore sign and villager spots. Buildings
// get door warps into ordinary interior templates (map id `<hamletId>-<slot>`).
import type { PropPlacement } from '../types.ts'
import { CONTENT } from '../content/index.ts'
import { opposite, propDoors, propRect, propSize } from './collision.ts'
import {
  F_KEEP, F_LAKE, F_PATH, F_RESERVED, F_ROAD, F_SEA, F_SITE, F_TOWN, addFlag, canPlace, hasFlag, inside, placeProp, type MapDraft,
} from './grid.ts'
import { loreText, uniqueName } from './lore.ts'
import { rngFor, type Rng } from './random.ts'
import type { Site } from './sites.ts'
import { addAnchor, tid, type DoorLink, type OwCtx } from './ctx.ts'
import { interiorTemplate, placeSign } from './towns.ts'

export interface StampedHamlet {
  site: Site
  id: string
  nameZh: string
  biome: string
  /** Walkable plaza tile (anchor `hamlet:<id>`). */
  center: { x: number; y: number }
  doors: { slot: string; front: { x: number; y: number } }[]
  spots: { x: number; y: number }[]
  services: boolean
  description: string
}

const walkableDry = (t: number) => { const d = CONTENT.terrain[t]; return d?.walkable === true && !d.liquid && !d.stairs }

/** True when the prop footprint grown by one tile touches no other prop (keeps every prop cluster passable). */
export function marginFree(d: MapDraft, p: PropPlacement, margin = 1): boolean {
  const r = propRect(p)
  for (let y = r.y - margin; y < r.y + r.h + margin; y++) for (let x = r.x - margin; x < r.x + r.w + margin; x++) {
    if (!inside(d, x, y)) return false
    if (d.occ[y * d.w + x]) return false
  }
  return true
}

/**
 * Tiles reachable on foot from (cx, cy) inside radius r without leaving `level` (props and liquids block).
 * NPC spots are drawn from this set so none ends up in a pocket sealed by the site's own props.
 */
export function localReach(d: MapDraft, cx: number, cy: number, r: number, level: number): Set<number> {
  const out = new Set<number>()
  const ok = (x: number, y: number) => {
    if (!inside(d, x, y) || (x - cx) * (x - cx) + (y - cy) * (y - cy) > r * r) return false
    const i = y * d.w + x
    const t = CONTENT.terrain[d.terrain[i]]
    return !d.occ[i] && d.elevation[i] === level && !!t?.walkable && !t.liquid
  }
  if (!ok(cx, cy)) return out
  const q = [cy * d.w + cx]
  out.add(q[0])
  for (let k = 0; k < q.length; k++) {
    const x = q[k] % d.w, y = (q[k] - x) / d.w
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const j = ny * d.w + nx
      if (out.has(j) || !ok(nx, ny)) continue
      out.add(j)
      q.push(j)
    }
  }
  return out
}

/** Random point in the annulus [r0, r1] around (cx, cy) (rejection sampling, no trigonometry). */
export function annulusPoint(rng: Rng, cx: number, cy: number, r0: number, r1: number): { x: number; y: number } {
  const R = Math.ceil(r1)
  for (let t = 0; t < 64; t++) {
    const dx = rng.int(-R, R), dy = rng.int(-R, R)
    const dd = dx * dx + dy * dy
    if (dd >= r0 * r0 && dd <= r1 * r1) return { x: cx + dx, y: cy + dy }
  }
  return { x: cx, y: cy + Math.round(r0) }
}

export function stampHamlets(ctx: OwCtx, sites: Site[], used: Set<string>, doorLinks: DoorLink[]): StampedHamlet[] {
  const { d } = ctx
  const hs = ctx.wc.pois.hamlets
  const lore = ctx.wc.pois.lore
  const out: StampedHamlet[] = []
  const roadT = tid(hs.road), plazaT = tid(hs.plaza.terrain), fieldT = tid(hs.fields.terrain)
  for (const site of sites) {
    if (site.kind !== 'hamlet') continue
    const rng = rngFor(ctx.seed, `hamlet-${site.id}`)
    const biome = CONTENT.biomes[site.biome]?.id ?? 'meadow'
    const nameZh = uniqueName(hs.names, lore, biome, rng, used)
    const cx = site.x, cy = site.y, R = site.radius, level = site.level
    const disc = (x: number, y: number, r: number) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r
    const usable = (i: number) => d.elevation[i] === level && (d.flags[i] & (F_TOWN | F_SEA | F_LAKE)) === 0 && walkableDry(d.terrain[i])
    for (let y = cy - R; y <= cy + R; y++) for (let x = cx - R; x <= cx + R; x++) {
      if (inside(d, x, y) && disc(x, y, R) && usable(y * d.w + x)) addFlag(d, y * d.w + x, F_SITE)
    }
    const inPad = (x: number, y: number, shrink = 1) => inside(d, x, y) && disc(x, y, R - shrink) && hasFlag(d, y * d.w + x, F_SITE) && d.elevation[y * d.w + x] === level
    // Plaza and its centre piece.
    const pr = hs.plaza.radius
    for (let y = cy - Math.ceil(pr); y <= cy + Math.ceil(pr); y++) for (let x = cx - Math.ceil(pr); x <= cx + Math.ceil(pr); x++) {
      if (!inPad(x, y, 0) || !disc(x, y, pr)) continue
      const i = y * d.w + x
      if (!hasFlag(d, i, F_PATH)) d.terrain[i] = plazaT
      addFlag(d, i, F_ROAD | F_KEEP)
    }
    const cp = rng.pick(hs.plaza.centerProps)
    {
      const [w, h] = propSize(cp, 0)
      const p: PropPlacement = { prop: cp, x: cx - Math.floor(w / 2), y: cy - Math.floor(h / 2), rot: 0 }
      if (canPlace(d, p, { forbid: F_PATH | F_RESERVED })) placeProp(d, p)
    }
    const footprintOk = (p: PropPlacement) => {
      const r = propRect(p)
      for (let y = r.y - 1; y < r.y + r.h + 1; y++) for (let x = r.x - 1; x < r.x + r.w + 1; x++) {
        if (!inPad(x, y)) return false
        const i = y * d.w + x
        if (d.occ[i]) return false
        const inner = x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h
        if (inner && (d.flags[i] & (F_PATH | F_ROAD | F_RESERVED | F_KEEP)) !== 0) return false
      }
      return true
    }
    /** BFS lane from the door front to the plaza / existing lanes, avoiding the footprint `p`. */
    const lane = (from: { x: number; y: number }, p: PropPlacement): number[] | null => {
      const r = propRect(p)
      const inFoot = (x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h
      const start = from.y * d.w + from.x
      const prev = new Map<number, number>([[start, -1]])
      const q = [start]
      for (let h = 0; h < q.length && h < 1200; h++) {
        const i = q[h]
        if (hasFlag(d, i, F_ROAD) && i !== start) {
          const path: number[] = []
          for (let k = i; k !== -1; k = prev.get(k)!) path.push(k)
          return path.reverse()
        }
        const x = i % d.w, y = (i - x) / d.w
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (!inPad(nx, ny, 0) || inFoot(nx, ny)) continue
          const j = ny * d.w + nx
          if (prev.has(j) || d.occ[j] || !walkableDry(d.terrain[j])) continue
          prev.set(j, i)
          q.push(j)
        }
      }
      return null
    }
    // Buildings on a ring, facing the plaza.
    const slots: { slot: string; prop: string; interior: string }[] = []
    const services = rng.chance(hs.services)
    if (services) {
      slots.push({ slot: 'center', prop: hs.buildings.center.prop, interior: hs.buildings.center.interior })
      slots.push({ slot: 'shop', prop: hs.buildings.shop.prop, interior: hs.buildings.shop.interior })
    }
    const nHouses = rng.int(hs.houses[0], hs.houses[1])
    for (let k = 1; k <= nHouses; k++) {
      const kind = rng.weighted(hs.buildings.house, (b) => b.weight)
      slots.push({ slot: `house${k}`, prop: kind.prop, interior: rng.pick(kind.interiors) })
    }
    const doors: StampedHamlet['doors'] = []
    let houseNo = 0
    for (const s of slots) {
      for (let t = 0; t < 80; t++) {
        const at = annulusPoint(rng, cx, cy, hs.ring[0], hs.ring[1])
        const dx = cx - at.x, dy = cy - at.y
        const rot = (Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? 0 : 2) : (dx > 0 ? 1 : 3)) as 0 | 1 | 2 | 3
        const [w, h] = propSize(s.prop, rot)
        const p: PropPlacement = { prop: s.prop, x: at.x - Math.floor(w / 2), y: at.y - Math.floor(h / 2), rot }
        if (!footprintOk(p)) continue
        const entries = propDoors(p)
        const door = entries[0]
        if (!door || entries.some(({ front }) => {
          if (!inPad(front.x, front.y, 0)) return true
          const fi = front.y * d.w + front.x
          return d.occ[fi] || hasFlag(d, fi, F_RESERVED) || !walkableDry(d.terrain[fi])
        })) continue
        const path = lane(door.front, p)
        if (!path) continue
        placeProp(d, p)
        for (const i of path) {
          if (!hasFlag(d, i, F_PATH | F_ROAD)) d.terrain[i] = roadT
          addFlag(d, i, F_ROAD | F_KEEP)
        }
        const slot = s.slot.startsWith('house') ? `house${++houseNo}` : s.slot
        const mapId = `${site.id}-${slot}`
        const first = interiorTemplate(ctx, s.interior)
        doorLinks.push({ townId: site.id, townNameZh: nameZh, slot, floors: [s.interior], mapIds: [mapId], door, biome })
        for (const entry of entries) {
          d.warps.push({ x: entry.x, y: entry.y, toMap: mapId, toX: first.arrive[0], toY: first.arrive[1], facing: opposite(entry.facing), kind: 'door' })
          addFlag(d, entry.y * d.w + entry.x, F_RESERVED)
          const fi = entry.front.y * d.w + entry.front.x
          if (!hasFlag(d, fi, F_PATH | F_ROAD)) d.terrain[fi] = roadT
          addFlag(d, fi, F_RESERVED | F_KEEP | F_ROAD)
        }
        addAnchor(ctx.anchors, ctx.problems, `hamlet:${site.id}:${slot}-door`, d.id, door.front.x, door.front.y)
        doors.push({ slot, front: { ...door.front } })
        break
      }
    }
    if (!doors.length) ctx.problems.push(`hamlet ${site.id}: no building fits`)
    // Fenced fields with crop rows.
    const fs = hs.fields
    const nFields = rng.int(fs.count[0], fs.count[1])
    for (let f = 0; f < nFields; f++) {
      for (let t = 0; t < 40; t++) {
        const fw = rng.int(fs.size[0][0], fs.size[0][1]), fh = rng.int(fs.size[1][0], fs.size[1][1])
        const at = annulusPoint(rng, cx, cy, hs.ring[0], R - 2)
        const x0 = at.x - Math.floor(fw / 2), y0 = at.y - Math.floor(fh / 2)
        let ok = true
        for (let y = y0 - 1; y < y0 + fh + 1 && ok; y++) for (let x = x0 - 1; x < x0 + fw + 1; x++) {
          if (!inPad(x, y)) { ok = false; break }
          const i = y * d.w + x
          if (d.occ[i] || (d.flags[i] & (F_PATH | F_ROAD | F_RESERVED | F_KEEP)) !== 0) { ok = false; break }
        }
        if (!ok) continue
        // Gate gap in the middle of the side facing the plaza.
        const gx = cx < x0 ? x0 : cx >= x0 + fw ? x0 + fw - 1 : x0 + Math.floor(fw / 2)
        const gy = cy < y0 ? y0 : cy >= y0 + fh ? y0 + fh - 1 : -1
        const gate = gy >= 0 ? { x: x0 + Math.floor(fw / 2), y: gy } : { x: gx, y: y0 + Math.floor(fh / 2) }
        for (let y = y0; y < y0 + fh; y++) for (let x = x0; x < x0 + fw; x++) {
          const i = y * d.w + x
          d.terrain[i] = fieldT
          addFlag(d, i, F_KEEP)
          const edge = x === x0 || y === y0 || x === x0 + fw - 1 || y === y0 + fh - 1
          if (edge) {
            if (x === gate.x && y === gate.y) continue
            placeProp(d, { prop: fs.fence, x, y, rot: (x === x0 || x === x0 + fw - 1) && !(y === y0 || y === y0 + fh - 1) ? 1 : 0 })
          } else if ((y - y0) % 2 === 1 && (x - x0) % 2 === 1) {
            placeProp(d, { prop: fs.crops[(x + y) % fs.crops.length], x, y, rot: 0 })
          }
        }
        break
      }
    }
    // Decor: never touching another prop, never on lanes.
    for (const dec of hs.decor) {
      const n = rng.int(dec.count[0], dec.count[1])
      for (let k = 0, t = 0; k < n && t < 60; t++) {
        const at = annulusPoint(rng, cx, cy, pr + 1.5, R - 2)
        const p: PropPlacement = { prop: dec.prop, x: at.x, y: at.y, rot: 0 }
        const r = propRect(p)
        let ok = true
        for (let y = r.y; y < r.y + r.h && ok; y++) for (let x = r.x; x < r.x + r.w; x++) {
          if (!inPad(x, y) || (d.flags[y * d.w + x] & (F_PATH | F_ROAD | F_RESERVED | F_KEEP)) !== 0) { ok = false; break }
        }
        if (!ok || !marginFree(d, p) || !canPlace(d, p)) continue
        placeProp(d, p)
        k++
      }
    }
    // Centre anchor, sign and villager spots.
    const free = (x: number, y: number) => {
      if (!inside(d, x, y)) return false
      const i = y * d.w + x
      return !d.occ[i] && !hasFlag(d, i, F_RESERVED) && walkableDry(d.terrain[i]) && d.elevation[i] === level
    }
    let center = { x: cx, y: cy }
    for (let r = 0, found = false; r <= R && !found; r++) {
      for (let y = cy - r; y <= cy + r && !found; y++) for (let x = cx - r; x <= cx + r; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r || !free(x, y) || !hasFlag(d, y * d.w + x, F_ROAD)) continue
        center = { x, y }; found = true; break
      }
    }
    addFlag(d, center.y * d.w + center.x, F_RESERVED)
    addAnchor(ctx.anchors, ctx.problems, `hamlet:${site.id}`, d.id, center.x, center.y)
    const description = loreText(hs.sign, lore, biome, rng, { name: nameZh }) ?? nameZh
    let signed = false
    for (let t = 0; t < 80 && !signed; t++) {
      const at = annulusPoint(rng, cx, cy, pr + 1, pr + 3)
      if (!inPad(at.x, at.y) || !free(at.x, at.y) || hasFlag(d, at.y * d.w + at.x, F_ROAD | F_PATH | F_KEEP)) continue
      if (!marginFree(d, { prop: ctx.spec.signProps.sign, x: at.x, y: at.y, rot: 0 })) continue
      signed = placeSign(ctx, at.x, at.y, description, 'sign')
    }
    const spots: { x: number; y: number }[] = []
    const around = localReach(d, center.x, center.y, pr + 6, d.elevation[center.y * d.w + center.x])
    for (let t = 0; t < 200 && spots.length < hs.npcSpots; t++) {
      const at = annulusPoint(rng, cx, cy, pr, pr + 5)
      if (!inPad(at.x, at.y) || !free(at.x, at.y) || !around.has(at.y * d.w + at.x)) continue
      if (spots.some((s) => Math.abs(s.x - at.x) + Math.abs(s.y - at.y) < 3)) continue
      if (doors.some((dr) => Math.abs(dr.front.x - at.x) + Math.abs(dr.front.y - at.y) < 2)) continue
      spots.push(at)
      addFlag(d, at.y * d.w + at.x, F_RESERVED)
      addAnchor(ctx.anchors, ctx.problems, `hamlet:${site.id}:npc-${spots.length}`, d.id, at.x, at.y)
    }
    out.push({ site, id: site.id, nameZh, biome, center, doors, spots, services, description })
  }
  return out
}
