// Battle screen composition (issue #32): the solver keeps creatures clear of the HUD windows and the screen edge.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STAGE } from '../src/client/render/battle/config.ts'
import { framed, overlapArea, solveFraming, union, type Box } from '../src/client/render/battle/framing.ts'

const F = STAGE.camera.framing
const own: Box = { left: 0.2456, top: 0.396, right: 0.3586, bottom: 0.736 }
const foe: Box = { left: 0.5228, top: 0.1343, right: 0.7617, bottom: 0.5879 }

/** The HUD of a 1280x720 screen: foe card top-left, bottom bar full width. */
const hud = (w: number, h: number, unit: number, cardH: number): Box[] => [
  { left: 8 * unit / w, top: 8 * unit / h, right: 196 * unit / w, bottom: (8 + cardH) * unit / h },
  { left: 8 * unit / w, top: 1 - 80 * unit / h, right: 1 - 8 * unit / w, bottom: 1 - 8 * unit / h },
]

test('the solver clears every window with the configured padding', () => {
  for (const [w, h, unit] of [[1280, 720, 2], [1920, 1080, 3], [1440, 900, 2], [2000, 1300, 3], [1024, 768, 2]] as const) {
    const windows = hud(w, h, unit, 120)
    const sol = solveFraming([own, foe], windows, { w, h, unit }, F)
    assert.equal(sol.clear, true, `${w}x${h}`)
    const padX = F.padU * unit / w, padY = F.padU * unit / h
    for (const s of [own, foe]) for (const win of windows) assert.equal(overlapArea(framed(s, sol.framing), win, padX, padY), 0, `${w}x${h}`)
  }
})

test('a taller card pushes the creatures away instead of sitting under it', () => {
  const small = solveFraming([own, foe], hud(1280, 720, 2, 60), { w: 1280, h: 720, unit: 2 }, F)
  const tall = solveFraming([own, foe], hud(1280, 720, 2, 160), { w: 1280, h: 720, unit: 2 }, F)
  assert.equal(tall.clear, true)
  const moved = (a: typeof small, b: typeof tall) => Math.abs(a.framing.dx - b.framing.dx) + Math.abs(a.framing.dy - b.framing.dy) + Math.abs(a.framing.zoom - b.framing.zoom)
  assert.ok(moved(small, tall) > 0)
})

test('creatures stay inside the screen and portrait screens zoom in up to the portrait fill', () => {
  const sol = solveFraming([own, foe], hud(390, 844, 1, 120), { w: 390, h: 844, unit: 1 }, F)
  assert.equal(sol.clear, true)
  const u = framed(union([own, foe]), sol.framing)
  assert.ok(u.left >= 0 && u.right <= 1 && u.top >= 0, JSON.stringify(u))
  assert.ok(u.right - u.left <= F.fill[1] + 1e-6)
  assert.ok(sol.framing.zoom > 1, 'a tall screen gets bigger creatures than the 16:9 shot')
})

test('windows that leave no room make the solver report it and fall back to the smallest zoom', () => {
  const wall: Box[] = [{ left: 0, top: 0, right: 1, bottom: 1 }]
  const sol = solveFraming([own, foe], wall, { w: 1280, h: 720, unit: 2 }, F)
  assert.equal(sol.clear, false)
  assert.equal(sol.framing.zoom, F.minZoom)
  assert.ok(sol.overlap > 0)
})

test('no creature at all leaves the framing alone', () => {
  const sol = solveFraming([], hud(1280, 720, 2, 60), { w: 1280, h: 720, unit: 2 }, F)
  assert.deepEqual(sol.framing, { zoom: 1, dx: 0, dy: 0 })
})
