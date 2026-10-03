// Core-continent stage: causeways from the core coast straight out to the core rectangle's edge, where the
// frontier lanes (roads.ts gate edges) continue to the gateway hamlets. Stamped into the core draft so the
// finite core map and the provider's core chunks agree. Specs (side, position, landing zones, search range) are
// in content/world/frontier/gen.json `causeways`.
// Wired as the very last overworld stage: only open-sea tiles change (no path carving), so regions, items,
// anchors and story inputs are identical with or without causeways. The landing must already be reachable on
// foot; the lane tiles are added to walkReach. OverworldResult.gates feeds Fields/SiteGrid (gateway hamlets).
import { CONTENT } from '../../content/index.ts'
import { F_BORDER, F_ISLAND, F_KEEP, F_LAKE, F_LOCK, F_PATH, F_RESERVED, F_SEA, F_SITE, F_TOWN, addFlag, idx } from '../grid.ts'
import { tid, type OwCtx } from '../ctx.ts'
import { FRONTIER_CONTENT } from './config.ts'
import type { Gate } from './sites.ts'

interface Cand { k: number; run: number; land: number; score: number }

export function stampCauseways(ctx: OwCtx, walkReach: Uint8Array): Gate[] {
  const { d } = ctx
  const cw = FRONTIER_CONTENT.gen.causeways
  const causeT = tid(cw.terrain)
  const stairsT = tid(ctx.spec.stairsTerrain)
  const gates: Gate[] = []
  const W = d.w, H = d.h
  for (const spec of cw.specs) {
    const zones = new Set(spec.zones.map((z) => ctx.regionIdx.get(z)).filter((z): z is number => z !== undefined))
    const horizontal = spec.side === 'north' || spec.side === 'south'
    const along = horizontal ? W : H
    const dir = spec.side === 'south' ? { x: 0, y: 1 } : spec.side === 'north' ? { x: 0, y: -1 } : spec.side === 'east' ? { x: 1, y: 0 } : { x: -1, y: 0 }
    const edgeAt = (k: number) => horizontal ? { x: k, y: spec.side === 'south' ? H - 1 : 0 } : { x: spec.side === 'east' ? W - 1 : 0, y: k }
    const centre = Math.round(spec.at * along)
    const cands: Cand[] = []
    for (let off = -spec.search; off <= spec.search; off++) {
      const k = centre + off
      if (k < 2 || k >= along - 2) continue
      const e = edgeAt(k)
      let run = 0, land = -1
      for (let s = 0; s < (horizontal ? H : W); s++) {
        const x = e.x - dir.x * s, y = e.y - dir.y * s
        const i = idx(d, x, y)
        // The lane and both side tiles must be open sea without props.
        const sideA = horizontal ? i - 1 : i - W, sideB = horizontal ? i + 1 : i + W
        if ((d.flags[i] & F_SEA) !== 0 && (d.flags[i] & F_ISLAND) === 0) {
          if (d.occ[i] || d.occ[sideA] || d.occ[sideB]) break
          run++
          continue
        }
        const t = CONTENT.terrain[d.terrain[i]]
        if (!t?.walkable || t.liquid || t.stairs || d.occ[i]) break
        if (d.elevation[i] > cw.landLevelMax) break
        if ((d.flags[i] & (F_TOWN | F_SITE | F_LOCK | F_BORDER | F_LAKE | F_RESERVED)) !== 0) break
        if (!zones.has(ctx.macro.wild[i]) || !walkReach[i]) break
        land = i
        break
      }
      if (land < 0 || run < cw.minRun) continue
      cands.push({ k, run, land, score: run + Math.abs(off) * cw.offsetCost })
    }
    cands.sort((a, b) => a.score - b.score || a.k - b.k)
    let done = false
    for (const c of cands.slice(0, cw.candidates)) {
      if (gates.some((g) => (horizontal ? Math.abs(g.edge.x - c.k) : Math.abs(g.edge.y - c.k)) < cw.spacing && g.dir.x === dir.x && g.dir.y === dir.y)) continue
      const lx = c.land % W, ly = (c.land - lx) / W
      const e = edgeAt(c.k)
      for (let s = 0; s < c.run; s++) {
        const i = idx(d, e.x - dir.x * s, e.y - dir.y * s)
        d.terrain[i] = causeT
        d.elevation[i] = 0
        addFlag(d, i, F_PATH | F_KEEP)
        walkReach[i] = 1
      }
      // A one-level landing gets stairs on the last causeway tile.
      if (d.elevation[c.land] === 1) d.terrain[idx(d, lx + dir.x, ly + dir.y)] = stairsT
      addFlag(d, c.land, F_PATH | F_KEEP)
      const out = { x: e.x + dir.x, y: e.y + dir.y }
      const dist = cw.gateway.distance
      gates.push({ id: spec.id, edge: e, out, x: out.x + dir.x * dist, y: out.y + dir.y * dist, dir })
      done = true
      break
    }
    if (!done) ctx.problems.push(`causeway ${spec.id}: no landing found on the ${spec.side} coast`)
  }
  return gates
}
