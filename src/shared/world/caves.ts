// Caves (kind 'cave'): cellular-automata caverns with a guaranteed winding tunnel between their two
// ends, plus the matching cave mouths on the overworld (cave_entrance props + connector paths).
import type { Dir, PropPlacement } from '../types.ts'
import { CONTENT } from '../content/index.ts'
import { findPath } from './astar.ts'
import { propDoor, propRect, propSize, DIR_DX, DIR_DY } from './collision.ts'
import {
  F_BORDER, F_EDGE, F_GATE, F_KEEP, F_LAKE, F_LOCK, F_PATH, F_RESERVED, F_RIVER, F_ROAD, F_SEA, F_SITE, F_TOWN,
  addFlag, canPlace, fmt, idx, inside, newDraft, placeProp, type MapDraft,
} from './grid.ts'
import { noiseField, rngFor, seedFor, tileRand } from './random.ts'
import type { CaveEndSpec, CaveSpec } from './schema.ts'
import { addAnchor, tid, type AnchorMap, type OwCtx } from './ctx.ts'
import { connectToPaths } from './routes.ts'
import { placeSign } from './towns.ts'

export interface CaveEnd { spec: CaveEndSpec; exit: { x: number; y: number }; arrive: { x: number; y: number }; facing: Dir }
export interface BuiltCave { spec: CaveSpec; draft: MapDraft; ends: CaveEnd[]; spots: { x: number; y: number }[]; reach: Uint8Array }

const INWARD: Record<CaveEndSpec['side'], Dir> = { north: 'down', south: 'up', west: 'right', east: 'left' }

export function endTile(spec: CaveSpec, e: CaveEndSpec): CaveEnd {
  const along = (n: number) => 1 + Math.round(Math.max(0, Math.min(1, e.at)) * (n - 3))
  const exit = e.side === 'north' ? { x: along(spec.w), y: 0 }
    : e.side === 'south' ? { x: along(spec.w), y: spec.h - 1 }
    : e.side === 'west' ? { x: 0, y: along(spec.h) }
    : { x: spec.w - 1, y: along(spec.h) }
  const facing = INWARD[e.side]
  return { spec: e, exit, arrive: { x: exit.x + DIR_DX[facing], y: exit.y + DIR_DY[facing] }, facing }
}

export function buildCave(spec: CaveSpec, seed: number, parent: string): BuiltCave {
  const W = spec.w, H = spec.h, N = W * H
  const d = newDraft({ id: spec.id, nameZh: spec.nameZh, kind: 'cave', w: W, h: H, fill: tid(spec.wall), outdoor: false, music: spec.music, parent })
  const rng = rngFor(seed, `cave-${spec.id}`)
  let wall = new Uint8Array(N)
  if (spec.algo === 'walk' && spec.walk) {
    // Drunkard walks from the centre: winding corridors and chambers (ruins, mines).
    wall.fill(1)
    const wk = spec.walk
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    for (let k = 0; k < wk.walkers; k++) {
      let x = Math.floor(W / 2) + rng.int(-2, 2), y = Math.floor(H / 2) + rng.int(-2, 2)
      let dir = rng.int(0, 3)
      for (let st = 0; st < wk.steps; st++) {
        for (let oy = -wk.radius; oy <= wk.radius; oy++) for (let ox = -wk.radius; ox <= wk.radius; ox++) {
          const nx = x + ox, ny = y + oy
          if (nx > 0 && ny > 0 && nx < W - 1 && ny < H - 1) wall[ny * W + nx] = 0
        }
        if (rng.chance(wk.turn)) dir = rng.int(0, 3)
        const nx = x + dirs[dir][0], ny = y + dirs[dir][1]
        if (nx < 2 || ny < 2 || nx >= W - 2 || ny >= H - 2) { dir = rng.int(0, 3); continue }
        x = nx; y = ny
      }
    }
  } else {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1
      wall[y * W + x] = edge || rng.chance(spec.fill) ? 1 : 0
    }
    for (let it = 0; it < spec.iterations; it++) {
      const next = new Uint8Array(N)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { next[y * W + x] = 1; continue }
        let n = 0
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if ((ox || oy) && wall[(y + oy) * W + x + ox]) n++
        next[y * W + x] = n >= spec.birth || (wall[y * W + x] && n >= spec.survive) ? 1 : 0
      }
      wall = next
    }
  }
  const ends = spec.ends.map((e) => endTile(spec, e))
  // Guaranteed winding tunnel between consecutive ends.
  const tn = noiseField(spec.tunnelNoise, seed)
  const cost = (_a: number, b: number) => {
    const x = b % W, y = (b - x) / W
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) return Infinity
    return (wall[b] ? spec.tunnelCost.wall : spec.tunnelCost.open) + spec.tunnelCost.noise * tn.sample(x, y)
  }
  const tunnel = new Set<number>()
  for (let k = 0; k + 1 < ends.length; k++) {
    const a = ends[k].arrive, b = ends[k + 1].arrive
    const path = findPath(W, H, a.y * W + a.x, b.y * W + b.x, cost, Math.min(spec.tunnelCost.open, spec.tunnelCost.wall), 1)
    for (const i of path ?? []) {
      const x = i % W, y = (i - x) / W
      tunnel.add(i)
      for (let oy = -spec.tunnelRadius; oy <= spec.tunnelRadius; oy++) for (let ox = -spec.tunnelRadius; ox <= spec.tunnelRadius; ox++) {
        const nx = x + ox, ny = y + oy
        if (nx > 0 && ny > 0 && nx < W - 1 && ny < H - 1) wall[ny * W + nx] = 0
      }
    }
  }
  for (const e of ends) { wall[e.exit.y * W + e.exit.x] = 0; wall[e.arrive.y * W + e.arrive.x] = 0 }
  // Keep only floor connected to the first end.
  const flood = (from: number): { keep: Uint8Array; n: number } => {
    const keep = new Uint8Array(N)
    const stack = [from]
    keep[from] = 1
    let n = 1
    while (stack.length) {
      const i = stack.pop()!
      const x = i % W, y = (i - x) / W
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j >= 0 && !wall[j] && !keep[j]) { keep[j] = 1; n++; stack.push(j) }
      }
    }
    return { keep, n }
  }
  const start = ends[0].arrive.y * W + ends[0].arrive.x
  let { keep, n: kept } = flood(start)
  // A cave whose first end is sealed off from the carved chambers (a single-end last dungeon floor has no
  // guaranteed tunnel) gets one to the biggest chamber, so the floor is never just the entrance tile.
  if (spec.minFloor !== undefined && kept < spec.minFloor * N) {
    const seen = new Uint8Array(N)
    let best: number[] = []
    for (let i = 0; i < N; i++) {
      if (wall[i] || seen[i] || keep[i]) continue
      const comp: number[] = [i]
      seen[i] = 1
      for (let q = 0; q < comp.length; q++) {
        const c = comp[q], x = c % W, y = (c - x) / W
        for (const j of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, y > 0 ? c - W : -1, y < H - 1 ? c + W : -1]) {
          if (j >= 0 && !wall[j] && !seen[j]) { seen[j] = 1; comp.push(j) }
        }
      }
      if (comp.length > best.length) best = comp
    }
    // Target: the chamber tile nearest its centroid (or the map centre when nothing was carved at all).
    let tx = Math.floor(W / 2), ty = Math.floor(H / 2)
    if (best.length) {
      let sx = 0, sy = 0
      for (const c of best) { sx += c % W; sy += (c - (c % W)) / W }
      const mx = sx / best.length, my = sy / best.length
      let bd = Infinity
      for (const c of best) { const x = c % W, y = (c - x) / W, dd = (x - mx) ** 2 + (y - my) ** 2; if (dd < bd) { bd = dd; tx = x; ty = y } }
    }
    const path = findPath(W, H, start, ty * W + tx, cost, Math.min(spec.tunnelCost.open, spec.tunnelCost.wall), 1)
    for (const i of path ?? []) {
      const x = i % W, y = (i - x) / W
      tunnel.add(i)
      for (let oy = -spec.tunnelRadius; oy <= spec.tunnelRadius; oy++) for (let ox = -spec.tunnelRadius; ox <= spec.tunnelRadius; ox++) {
        const nx = x + ox, ny = y + oy
        if (nx > 0 && ny > 0 && nx < W - 1 && ny < H - 1) wall[ny * W + nx] = 0
      }
    }
    ;({ keep, n: kept } = flood(start))
  }
  const floorT = tid(spec.floor), wallT = tid(spec.wall), matT = tid(spec.mat)
  for (let i = 0; i < N; i++) {
    if (keep[i]) { d.terrain[i] = floorT; d.elevation[i] = 0 }
    else { d.terrain[i] = wallT; d.elevation[i] = spec.wallElev }
  }
  ends.forEach((e, k) => {
    d.terrain[e.exit.y * W + e.exit.x] = matT
    const ep = spec.endProps?.[k]
    if (ep) placeProp(d, { prop: ep, x: e.exit.x, y: e.exit.y, rot: 0 })
    for (const p of [e.exit, e.arrive]) addFlag(d, p.y * W + p.x, F_RESERVED | F_KEEP)
    for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
      const x = e.arrive.x + ox, y = e.arrive.y + oy
      if (inside(d, x, y)) addFlag(d, y * W + x, F_KEEP)
    }
  })
  for (const i of tunnel) addFlag(d, i, F_PATH)
  spec.accents.forEach((a, k) => {
    const nf = noiseField(a.noise, seedFor(seed, `${spec.id}-accent-${k}`))
    const t = tid(a.terrain)
    const solid = !CONTENT.terrain[t]?.walkable
    for (let i = 0; i < N; i++) {
      if (d.terrain[i] !== floorT) continue
      if (solid && (d.flags[i] & (F_PATH | F_KEEP | F_RESERVED)) !== 0) continue
      const x = i % W, y = (i - x) / W
      const v = nf.sample(x, y)
      if (v >= a.min && (a.max === undefined || v <= a.max)) d.terrain[i] = t
    }
  })
  spec.props.forEach((r, k) => {
    const s = seedFor(seed, `${spec.id}-prop-${k}`)
    const on = r.on ? new Set(r.on.map(tid)) : null
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      if (d.occ[i] || (d.flags[i] & (F_PATH | F_KEEP | F_RESERVED)) !== 0 || tileRand(s, x, y) >= r.density) continue
      const p: PropPlacement = { prop: r.prop, x, y, rot: 0 }
      if (!canPlace(d, p, { on, forbid: F_PATH | F_KEEP | F_RESERVED })) continue
      placeProp(d, p)
    }
  })
  d.spawn = { x: ends[0].arrive.x, y: ends[0].arrive.y, facing: ends[0].facing }
  // Spread anchor spots over reachable open floor (farthest-point sampling from the entrances).
  const reach = new Uint8Array(N)
  const st = [ends[0].arrive.y * W + ends[0].arrive.x]
  reach[st[0]] = 1
  const passable = (j: number) => {
    const t = CONTENT.terrain[d.terrain[j]]
    if (!t?.walkable) return false
    return !d.occ[j] || !CONTENT.props[d.props[d.occ[j] - 1].prop]?.collide
  }
  while (st.length) {
    const i = st.pop()!
    const x = i % W
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
      if (j >= 0 && j < N && !reach[j] && passable(j)) { reach[j] = 1; st.push(j) }
    }
  }
  const free: number[] = []
  for (let i = 0; i < N; i++) {
    if (reach[i] && !d.occ[i] && (d.flags[i] & (F_KEEP | F_RESERVED)) === 0 && CONTENT.terrain[d.terrain[i]]?.walkable) free.push(i)
  }
  const spots: { x: number; y: number }[] = []
  const taken = ends.map((e) => e.arrive.y * W + e.arrive.x)
  for (let k = 0; k < spec.spots && free.length; k++) {
    let best = -1, bestD = -1
    for (const i of free) {
      const x = i % W, y = (i - x) / W
      let m = Infinity
      for (const t of taken) { const tx = t % W, ty = (t - tx) / W; m = Math.min(m, Math.abs(tx - x) + Math.abs(ty - y)) }
      if (m > bestD) { bestD = m; best = i }
    }
    taken.push(best)
    spots.push({ x: best % W, y: Math.floor(best / W) })
    addFlag(d, best, F_RESERVED)
  }
  return { spec, draft: d, ends, spots, reach }
}

/** Mouth placements ranked best-first: a cliff behind the mouth, then proximity to the hint. */
function mouthCandidates(ctx: OwCtx, e: CaveEndSpec, region: number): PropPlacement[] {
  const { d, spec } = ctx
  const prop = spec.caveMouthProp
  const [W, D] = propSize(prop, 0)
  const forbid = F_TOWN | F_LOCK | F_PATH | F_BORDER | F_EDGE | F_RESERVED | F_GATE | F_SEA | F_LAKE | F_RIVER | F_KEEP | F_SITE | F_ROAD
  const found: { p: PropPlacement; key: number }[] = []
  const R = spec.caveSearch
  for (let y = e.near[1] - R; y <= e.near[1] + R; y++) for (let x = e.near[0] - R; x <= e.near[0] + R; x++) {
    const p: PropPlacement = { prop, x, y, rot: 0 }
    if (!canPlace(d, p, { forbid })) continue
    const door = propDoor(p)!
    if (!inside(d, door.front.x, door.front.y)) continue
    const fi = idx(d, door.front.x, door.front.y)
    const e0 = d.elevation[idx(d, x, y)]
    if (d.elevation[fi] !== e0 || (d.flags[fi] & forbid) !== 0 || d.occ[fi] || !CONTENT.terrain[d.terrain[fi]]?.walkable) continue
    let ok = true
    for (let yy = y; yy < y + D && ok; yy++) for (let xx = x; xx < x + W; xx++) if (ctx.macro.wild[idx(d, xx, yy)] !== region) { ok = false; break }
    if (!ok || ctx.macro.wild[fi] !== region) continue
    let cliff = 0
    for (let xx = x; xx < x + W; xx++) if (y > 0 && d.elevation[idx(d, xx, y - 1)] > e0) cliff++
    found.push({ p, key: Math.abs(x - e.near[0]) + Math.abs(y - e.near[1]) - cliff * R })
  }
  found.sort((a, b) => a.key - b.key)
  return found.map((f) => f.p)
}

function removeLastProp(d: MapDraft): void {
  const n = d.props.length
  const r = propRect(d.props.pop()!)
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (inside(d, x, y) && d.occ[idx(d, x, y)] === n) d.occ[idx(d, x, y)] = 0
}

/** Places the best mouth whose front can be joined to the region's path network. */
export function placeMouth(ctx: OwCtx, e: CaveEndSpec, region: number): PropPlacement | null {
  const { d } = ctx
  const candidates = mouthCandidates(ctx, e, region).slice(0, ctx.spec.caveMouthTries)
  for (const p of candidates) {
    placeProp(d, p)
    const door = propDoor(p)!
    if (connectToPaths(ctx, idx(d, door.front.x, door.front.y), region, ctx.spec.exitStubTerrain)) return p
    removeLastProp(d)
  }
  return null
}

/** Places the overworld mouths, links warps both ways and adds anchors. */
export function linkCaves(ctx: OwCtx, caves: BuiltCave[]): void {
  const { d } = ctx
  for (const cave of caves) {
    for (const end of cave.ends) {
      const region = ctx.regionIdx.get(end.spec.region)
      if (region === undefined) { ctx.problems.push(`cave ${cave.spec.id}: unknown region "${end.spec.region}"`); continue }
      const p = placeMouth(ctx, end.spec, region)
      if (!p) { ctx.problems.push(`cave ${cave.spec.id}/${end.spec.id}: no connectable mouth spot near ${end.spec.near}`); continue }
      const door = propDoor(p)!
      d.warps.push({ x: door.x, y: door.y, toMap: cave.spec.id, toX: end.arrive.x, toY: end.arrive.y, facing: end.facing, kind: 'cave' })
      cave.draft.warps.push({ x: end.exit.x, y: end.exit.y, toMap: d.id, toX: door.front.x, toY: door.front.y, facing: door.facing, kind: 'cave' })
      const fi = idx(d, door.front.x, door.front.y)
      addFlag(d, idx(d, door.x, door.y), F_RESERVED)
      addFlag(d, fi, F_RESERVED | F_KEEP)
      const other = cave.spec.ends.find((x) => x.id !== end.spec.id)
      const otherName = other ? ctx.wc.regions[ctx.regionIdx.get(other.region) ?? 0]?.nameZh ?? '' : ''
      const text = fmt(ctx.wc.world.text.caveSign, { cave: cave.spec.nameZh, region: otherName })
      const signForbid = F_PATH | F_RESERVED | F_KEEP | F_GATE
      const off = ctx.spec.caveSignOffset
      if (!placeSign(ctx, door.front.x - off, door.front.y, text, 'sign', signForbid)) placeSign(ctx, door.front.x + off, door.front.y, text, 'sign', signForbid)
      addAnchor(ctx.anchors, ctx.problems, `${cave.spec.id}:mouth-${end.spec.id}`, d.id, door.front.x, door.front.y)
    }
  }
}

export function caveAnchors(anchors: AnchorMap, problems: string[], cave: BuiltCave): void {
  for (const e of cave.ends) addAnchor(anchors, problems, `${cave.spec.id}:entrance-${e.spec.id}`, cave.spec.id, e.arrive.x, e.arrive.y)
  cave.spots.forEach((s, k) => addAnchor(anchors, problems, `${cave.spec.id}:${k + 1}`, cave.spec.id, s.x, s.y))
}
