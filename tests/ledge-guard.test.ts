// Ledge trap guard (src/client/world/ledge-guard.ts): one-way ledge drops into closed frontier pockets are refused,
// verified against an exhaustive search on the real infinite overworld, and enforced by moveBody via stepGuard.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorld } from '../src/shared/world/index.ts'
import type { FrontierProvider } from '../src/shared/world/frontier/index.ts'
import { canStep, collisionField, isLedgeDrop } from '../src/shared/world/worldapi.ts'
import { createLedgeGuard, ledgePocket } from '../src/client/world/ledge-guard.ts'
import { moveBody, type MotionGrid } from '../src/client/world/motion.ts'
import { EXPLORE, validateExploreContent } from '../src/client/world/explore-config.ts'

const world = buildWorld()
const ow = world.maps[world.startMap]
const field = collisionField(ow)
const P = ow.infinite as unknown as FrontierProvider
const G = EXPLORE.ledge.guard
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const

interface Drop { fx: number; fy: number; tx: number; ty: number }

/** Ledge drops onto free ground in a few frontier chunks (rugged biomes + chunks known to hold pockets). */
function drops(): Drop[] {
  const out: Drop[] = []
  for (const [cx, cy] of [[-26, 22], [28, 25], [-26, -22], [-19, -24], [14, -39], [7, 37], [-4, 8], [18, 10], [-5, 12], [22, 6]]) {
    const S = P.size
    for (let y = cy * S; y < (cy + 1) * S; y++) for (let x = cx * S; x < (cx + 1) * S; x++) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (isLedgeDrop(ow, x, y, x + dx, y + dy) && field.at(x + dx, y + dy) === 0 && field.at(x, y) === 0) out.push({ fx: x, fy: y, tx: x + dx, ty: y + dy })
      }
    }
  }
  return out
}

/** Every tile reachable from the landing (no early exit), up to `cap` tiles away. */
function reach(d: Drop, surf: boolean, cap: number): { size: number; top: boolean; far: boolean } {
  const seen = new Set([`${d.tx},${d.ty}`])
  const q: [number, number][] = [[d.tx, d.ty]]
  let top = false, far = false
  while (q.length) {
    const [x, y] = q.pop()!
    for (const [dx, dy] of STEPS) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`
      if (seen.has(k) || !canStep(ow, field, x, y, nx, ny, { surf })) continue
      if (nx === d.fx && ny === d.fy) top = true
      if (Math.max(Math.abs(nx - d.tx), Math.abs(ny - d.ty)) > cap) { far = true; continue }
      seen.add(k)
      q.push([nx, ny])
    }
  }
  return { size: seen.size, top, far }
}

test('explore.json ledge.guard validates', () => {
  assert.deepEqual(validateExploreContent().filter((e) => e.includes('ledge')), [])
})

test('closed pockets found by the guard are truly closed; small ones exist in the frontier', () => {
  const all = drops()
  assert.ok(all.length > 50, `found ${all.length} ledge drops`)
  let closed = 0
  for (const d of all) {
    const r = ledgePocket(ow, field, d.fx, d.fy, d.tx, d.ty, true, G)
    if (!r.closed) continue
    closed++
    const ex = reach(d, true, G.radius * 3)
    assert.ok(!ex.top && !ex.far, `pocket at ${d.tx},${d.ty} is not closed`)
    assert.equal(ex.size, r.size)
  }
  assert.ok(closed > 0, 'the sample holds at least one dead-end pocket (else this test proves nothing)')
})

test('the guard refuses drops into pockets (fly lets big ones through) and moveBody honours it', () => {
  const all = drops()
  const trap = all.find((d) => { const r = ledgePocket(ow, field, d.fx, d.fy, d.tx, d.ty, true, G); return r.closed && r.size < G.flyMinSize })
  const open = all.find((d) => !ledgePocket(ow, field, d.fx, d.fy, d.tx, d.ty, false, G).closed)
  assert.ok(trap && open)
  let fly = false
  const guard = createLedgeGuard(() => G, { surf: () => true, fly: () => fly })
  assert.equal(guard.allow(ow, field, trap.fx, trap.fy, trap.tx, trap.ty), false)
  assert.equal(guard.refusals, 1)
  fly = true
  assert.equal(guard.allow(ow, field, trap.fx, trap.fy, trap.tx, trap.ty), false, 'tiny dead ends stay blocked even with fly')
  assert.equal(guard.allow(ow, field, open.fx, open.fy, open.tx, open.ty), true)
  // a non-ledge step is never vetoed
  assert.equal(guard.allow(ow, field, open.tx, open.ty, open.fx, open.fy), true)

  const grid: MotionGrid = { map: ow, field, stepGuard: (fx, fy, tx, ty) => guard.allow(ow, field, fx, fy, tx, ty) }
  const walk = (d: Drop) => {
    let x = d.fx + 0.5, y = d.fy + 0.5
    const dx = Math.sign(d.tx - d.fx) * 0.1, dy = Math.sign(d.ty - d.fy) * 0.1
    for (let i = 0; i < 12; i++) ({ x, y } = moveBody(grid, x, y, dx, dy, { radius: 0.27, surf: false, cornerSlip: 0, cornerSlipRate: 0, substep: 0.2 }))
    return { x: Math.floor(x), y: Math.floor(y) }
  }
  assert.deepEqual(walk(trap), { x: trap.fx, y: trap.fy }, 'the body stays on the ledge above the pocket')
  assert.deepEqual(walk(open), { x: open.tx, y: open.ty }, 'an ordinary ledge is still jumped')
})
