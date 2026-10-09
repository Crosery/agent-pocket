// Wilderness teleport anchors of the frontier: a jittered lattice (content/world/anchors.json frontier.fill) of
// candidate points; the chunk that contains a point plants an anchor on the nearest free ground inside that
// chunk, unless a site anchor is already close, and only where the ground opens into a sizeable walkable area.
// Pure function of (seed, chunk): the spot search never leaves the chunk, so neighbours cannot disagree.
import { anchorFootprint, findAnchorSpot, type AnchorField } from '../anchor-place.ts'
import { WORLD_CONTENT } from '../data.ts'
import { rngFor } from '../random.ts'
import type { ChunkDecorContext } from './decorate.ts'

const A = WORLD_CONTENT.anchors

/** Number of walkable free tiles (capped at `cap`) connected to (x, y) on one level inside the chunk. */
function openArea(ctx: ChunkDecorContext, x: number, y: number, cap: number): number {
  const seen = new Set<number>()
  const key = (px: number, py: number) => (py - ctx.y0) * ctx.size + (px - ctx.x0)
  const queue: number[] = [x, y]
  seen.add(key(x, y))
  const level = ctx.levelAt(x, y)
  for (let h = 0; h < queue.length && seen.size < cap; h += 2) {
    const px = queue[h], py = queue[h + 1]
    for (let k = 0; k < 4; k++) {
      const nx = k === 0 ? px + 1 : k === 1 ? px - 1 : px
      const ny = k === 2 ? py + 1 : k === 3 ? py - 1 : py
      if (!ctx.isFree(nx, ny) || ctx.levelAt(nx, ny) !== level || seen.has(key(nx, ny))) continue
      seen.add(key(nx, ny))
      queue.push(nx, ny)
    }
  }
  return seen.size
}

export function fillAnchors(ctx: ChunkDecorContext): void {
  const F = A.frontier.fill
  const spec = A.kinds[F.kind]
  const cell = F.cell
  const core = { w: WORLD_CONTENT.world.overworld.width, h: WORLD_CONTENT.world.overworld.height }
  const field: AnchorField = {
    foot: (x, y) => ctx.isFree(x, y) && ctx.isWild(x, y),
    ring: (x, y) => ctx.isFree(x, y),
    level: (x, y) => ctx.levelAt(x, y),
  }
  const [fw, fh] = anchorFootprint(F.kind)
  const lookCell = ctx.lookup.cell
  for (let ly = Math.floor(ctx.y0 / cell); ly <= Math.floor((ctx.y0 + ctx.size - 1) / cell); ly++) {
    for (let lx = Math.floor(ctx.x0 / cell); lx <= Math.floor((ctx.x0 + ctx.size - 1) / cell); lx++) {
      const rng = rngFor(ctx.seed, `${F.salt}-${lx}-${ly}`)
      const lo = (1 - F.jitter) / 2
      const tx = lx * cell + Math.floor((lo + rng.next() * F.jitter) * cell)
      const ty = ly * cell + Math.floor((lo + rng.next() * F.jitter) * cell)
      if (!ctx.inChunk(tx, ty)) continue
      if (tx > -F.coreClearance && ty > -F.coreClearance && tx < core.w + F.coreClearance && ty < core.h + F.coreClearance) continue
      let crowded = false
      for (let sy = Math.floor((ty - F.siteClearance) / lookCell); sy <= Math.floor((ty + F.siteClearance) / lookCell) && !crowded; sy++) {
        for (let sx = Math.floor((tx - F.siteClearance) / lookCell); sx <= Math.floor((tx + F.siteClearance) / lookCell); sx++) {
          const s = ctx.lookup.siteAt(sx, sy)
          if (s && (s.gate || A.frontier.sites[s.kind.id]) && Math.max(Math.abs(s.x - tx), Math.abs(s.y - ty)) < F.siteClearance) { crowded = true; break }
        }
      }
      if (crowded) continue
      const spot = findAnchorSpot(field, F.kind, tx, ty, 0, F.search)
      if (!spot || openArea(ctx, spot.x, spot.y + fh, F.reachTiles) < F.reachTiles) continue
      ctx.chunk.props.push({ prop: spec.prop, x: spot.x, y: spot.y, rot: 0 })
      for (let y = spot.y; y < spot.y + fh; y++) for (let x = spot.x; x < spot.x + fw; x++) ctx.occupy(x, y)
    }
  }
}
