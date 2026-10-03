import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { GameMap, RegionDef } from '../src/shared/types.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { RENDER } from '../src/client/render/config.ts'
import { createStreamer, type StreamFrame } from '../src/client/render/world/streamer.ts'
import { buildChunk, createTerrainSampler, sampleWalkHeight, type TerrainSampler } from '../src/client/render/world/terrain.ts'
import { climateAt, climateNoise, createClimate } from '../src/client/render/world/climate.ts'
import { walkHeight } from '../src/client/render/world/coords.ts'

const CHUNK = CONTENT.config.world.chunk
const world = buildWorld()
const overworld = world.maps[world.startMap]

/**
 * A finite copy of the infinite overworld's tiles in [x0, x0+w) x [y0, y0+h) (the reference renderer input). With
 * `absolute` the copy keeps world coordinates (map spans 0..x0+w, only the window filled) so noise tints and UV flips,
 * which hash world coords, are comparable too; otherwise the window starts at 0,0.
 */
function windowMap(src: GameMap, x0: number, y0: number, w: number, h: number, absolute: boolean): GameMap {
  const p = src.infinite!
  const ox = absolute ? x0 : 0, oy = absolute ? y0 : 0
  const W = ox + w, H = oy + h
  const terrain = new Uint8Array(W * H), elevation = new Uint8Array(W * H), region = new Uint8Array(W * H)
  const regions: RegionDef[] = []
  const index = new Map<string, number>()
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const tx = x0 + x, ty = y0 + y
    const ch = p.chunk(Math.floor(tx / p.size), Math.floor(ty / p.size))
    const i = (ty - ch.cy * p.size) * p.size + (tx - ch.cx * p.size)
    const o = (oy + y) * W + ox + x
    terrain[o] = ch.terrain[i]
    elevation[o] = ch.elevation[i]
    const id = ch.regionIds[ch.region[i]]
    let k = index.get(id)
    if (k === undefined) { k = regions.length; index.set(id, k); regions.push(p.region(id)!) }
    region[o] = k
  }
  return { ...src, id: src.id, infinite: undefined, width: W, height: H, terrain, elevation, region, regions, props: [], warps: [], npcs: [], signs: [], items: [], lights: [] }
}

const arr = (g: { getAttribute(n: string): { array: ArrayLike<number> } } | null, name: string) => (g ? Array.from(g.getAttribute(name).array) : [])

test('infinite sampler renders a frontier chunk exactly like the finite reference (no seams, any coords)', () => {
  // frontier spots with relief (waterfalls at -10,121; ledges + stairs at 4,95; negative coords) and one core chunk;
  // negative spots compare geometry only (the reference map cannot hold negative coords for the world-hashed tints)
  const spots = [{ cx: -10, cy: 121 }, { cx: 4, cy: 95 }, { cx: -48, cy: 26 }, { cx: 30, cy: 50 }, { cx: 5, cy: 96 }]
  let falls = 0, ledges = 0, ramps = 0
  for (const { cx, cy } of spots) {
    const pad = 2 * CHUNK
    const x0 = cx * CHUNK - pad, y0 = cy * CHUNK - pad
    const absolute = x0 >= 0 && y0 >= 0
    const win = windowMap(overworld, x0, y0, CHUNK + 2 * pad, CHUNK + 2 * pad, absolute)
    const sx = absolute ? 0 : x0, sy = absolute ? 0 : y0
    const inf = createTerrainSampler(overworld)
    const fin = createTerrainSampler(win)
    assert.equal(inf.bounds, null)
    const rect = { x0: cx * CHUNK - 12, y0: cy * CHUNK - 12, x1: (cx + 1) * CHUNK + 12, y1: (cy + 1) * CHUNK + 12 }
    assert.equal(inf.ensure(rect, Infinity), true)
    assert.equal(inf.ready(rect), true)
    const ctx = (s: TerrainSampler) => ({ sampler: s, rect: () => ({ u0: 0, v0: 0, u1: 1, v1: 1 }), climate: null })
    const a = buildChunk(ctx(inf), cx, cy, CHUNK)
    const b = buildChunk(ctx(fin), absolute ? cx : pad / CHUNK, absolute ? cy : pad / CHUNK, CHUNK)
    const pa = arr(a.solid, 'position'), pb = arr(b.solid, 'position')
    assert.ok(pa.length > 0, `chunk ${cx},${cy} has geometry`)
    assert.equal(pa.length, pb.length, `chunk ${cx},${cy}: vertex count`)
    for (let i = 0; i < pa.length; i += 3) {
      assert.ok(Math.abs(pa[i] - (pb[i] + sx)) < 1e-4 && Math.abs(pa[i + 1] - pb[i + 1]) < 1e-4 && Math.abs(pa[i + 2] - (pb[i + 2] + sy)) < 1e-4, `chunk ${cx},${cy}: vertex ${i / 3}`)
    }
    if (absolute) {
      for (const name of ['color', 'uv', 'normal']) {
        const ca = arr(a.solid, name), cb = arr(b.solid, name)
        for (let i = 0; i < ca.length; i++) assert.ok(Math.abs(ca[i] - cb[i]) < 1e-4, `chunk ${cx},${cy}: ${name} ${i}`)
      }
    }
    assert.equal(arr(a.water, 'position').length, arr(b.water, 'position').length)
    assert.deepEqual(arr(a.water, 'aShore'), arr(b.water, 'aShore'))
    assert.equal(arr(a.falls, 'position').length, arr(b.falls, 'position').length)
    falls += arr(a.falls, 'position').length
    for (let y = cy * CHUNK; y < (cy + 1) * CHUNK; y++) for (let x = cx * CHUNK; x < (cx + 1) * CHUNK; x++) {
      if (inf.terrain(x, y)?.ledge) ledges++
      if (inf.ramp(x, y)) ramps++
    }
    // walking height through the sampler agrees with the shared WorldApi path
    for (let k = 0; k < 20; k++) {
      const x = cx * CHUNK + 0.5 + k * 0.77, y = cy * CHUNK + 0.25 + k * 0.71
      assert.ok(Math.abs(sampleWalkHeight(inf, x, y) - walkHeight(overworld, x, y)) < 1e-6)
    }
  }
  assert.ok(falls > 0 && ledges > 0 && ramps > 0, `spots exercise waterfalls (${falls}), ledges (${ledges}) and stairs (${ramps})`)
})

test('infinite sampler only generates world chunks inside ensure() and prefetch()', () => {
  const p = overworld.infinite!
  const s = createTerrainSampler(overworld)
  // far from anything generated so far
  const tx = -9000, ty = 12000
  const cx = Math.floor(tx / p.size), cy = Math.floor(ty / p.size)
  assert.equal(p.peek(cx, cy), null)
  assert.equal(s.ready({ x0: tx, y0: ty, x1: tx + 1, y1: ty + 1 }), false)
  // one generation per call minimum, then the deadline stops it
  const big = { x0: tx - 200, y0: ty - 200, x1: tx + 200, y1: ty + 200 }
  assert.equal(s.ensure(big, 0), false)
  const made = s.prefetch(tx + 600, ty, 100, 1, 0, 2, Infinity)
  assert.ok(made >= 1 && made <= 2, `prefetch obeys its cap (${made})`)
  assert.equal(s.ensure(big, Infinity), true)
  assert.equal(s.ready(big), true)
  // retain drops blocks and provider chunks far from the focus; reading again regenerates the same tiles
  const before = s.terrainId(tx, ty)
  s.retain(0, 0, 64, 256)
  assert.equal(p.peek(cx, cy), null)
  assert.equal(s.terrainId(tx, ty), before)
})

test('rolling climate window: same values as the direct field, whatever the visiting order', () => {
  const s = createTerrainSampler(overworld)
  const noise = climateNoise(overworld)
  const pts = [[-3200.5, 5100.25], [140.75, 1730.5], [-3190.25, 5120.75], [-765.5, 420.5]]
  for (const [x, z] of pts) s.ensure({ x0: Math.floor(x) - 16, y0: Math.floor(z) - 16, x1: Math.floor(x) + 16, y1: Math.floor(z) + 16 }, Infinity)
  const a = createClimate(overworld, RENDER.fields, s, 64), b = createClimate(overworld, RENDER.fields, s, 64)
  const va = pts.map(([x, z]) => a.sampleAll(x, z, { dry: 0, autumn: 0, blossom: 0, snow: 0 }))
  const vb = [...pts].reverse().map(([x, z]) => b.sampleAll(x, z, { dry: 0, autumn: 0, blossom: 0, snow: 0 })).reverse()
  assert.deepEqual(va, vb)
  // at a cell centre the grid equals the per-point field
  const cell = RENDER.fields.cell
  const cxz = [Math.floor(-765 / cell) * cell + cell / 2, Math.floor(420 / cell) * cell + cell / 2]
  const direct = climateAt(s, noise, cxz[0], cxz[1])
  const grid = a.sampleAll(cxz[0], cxz[1])
  for (const k of ['dry', 'autumn', 'blossom', 'snow'] as const) assert.ok(Math.abs(direct[k] - grid[k]) < 1e-6, k)
  assert.equal(a.texture?.image.width, 64)
  a.dispose(); b.dispose()
})

test('streamer: unbounded grids stream negative chunk coords and stay bounded', () => {
  let made = 0, freed = 0
  const st = createStreamer<number>({
    cols: Infinity, rows: Infinity, chunk: CHUNK,
    create: () => ++made,
    stages: [() => true],
    dispose: () => { freed++ },
    clock: () => 0,
  })
  const frame = (x: number, z: number): StreamFrame => ({
    now: 0, focusX: x, focusZ: z, radius: 40, keepRadius: 60, maxChunks: 64, budgetMs: 100, catchUpBudgetMs: 100, disposePerFrame: 1000,
    offscreenPenalty: 0, moveLookAhead: 0, velX: 0, velZ: 0, inView: () => true,
  })
  st.update(frame(-4000, 6000))
  const keys = new Set([...st.slots.values()].map((s) => s.key))
  assert.equal(keys.size, st.slots.size)
  assert.ok([...st.slots.values()].every((s) => s.cx < 0 && s.cy > 0))
  assert.ok(st.stats.wanted > 10 && st.stats.pending === 0)
  st.update(frame(9000, -7000))
  assert.ok([...st.slots.values()].every((s) => s.cx > 0 && s.cy < 0), 'old area evicted')
  assert.ok(st.slots.size <= 64)
  assert.ok(freed > 0 && made - freed === st.slots.size)
})
