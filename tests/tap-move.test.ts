import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import type { GameMap } from '../src/shared/types.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { INPUT_CONFIG } from '../src/client/core/input-config.ts'
import { GAME } from '../src/client/world/config.ts'
import { moveBody, type MotionGrid, type MotionOpts } from '../src/client/world/motion.ts'
import {
  createTravel, pickCandidate, planTapRoute, retravel, screenToGround, stepTravel,
  type TapCandidate, type TapTarget,
} from '../src/client/world/tap-move.ts'
import { RENDER } from '../src/client/render/config.ts'

const R = INPUT_CONFIG.touch.tapMove

/** '#' blocked, '.' free, '~' water, 'D' free tile with a door warp. */
function grid(rows: string[]): MotionGrid {
  const h = rows.length, w = rows[0].length
  const flat = CONTENT.terrain.findIndex((tr) => tr.walkable && !tr.stairs)
  const warps: GameMap['warps'] = []
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === 'D') warps.push({ x, y, toMap: 'x', toX: 0, toY: 0, facing: 'up', kind: 'door' } as GameMap['warps'][number]) }))
  const map = {
    id: 'test', nameZh: '', kind: 'overworld', width: w, height: h,
    terrain: new Uint8Array(w * h).fill(flat), elevation: new Uint8Array(w * h), region: new Uint8Array(w * h),
    regions: [], props: [], warps, npcs: [], signs: [], items: [], lights: [],
    spawn: { x: 0, y: 0, facing: 'down' }, outdoor: true, music: '',
  } as unknown as GameMap
  const col = new Uint8Array(w * h)
  rows.forEach((r, y) => [...r].forEach((ch, x) => { col[y * w + x] = ch === '#' ? 1 : ch === '~' ? 2 : 0 }))
  return { map, col }
}

const motion: MotionOpts = {
  radius: GAME.player.radius, surf: false, cornerSlip: GAME.player.cornerSlip,
  cornerSlipRate: GAME.player.cornerSlipRate, substep: GAME.player.substepTiles,
}
const ground = (x: number, y: number): TapTarget => ({ kind: 'ground', id: '', rect: { x, y, w: 1, h: 1 } })
const adjacent = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1

/** Walks a body along a plan with the same steering the controller uses; returns where it ended. */
function walk(g: MotionGrid, plan: NonNullable<ReturnType<typeof planTapRoute>>, target: TapTarget, seconds = 30) {
  const tr = createTravel(plan, target, { x: plan.path[0].x + 0.5, y: plan.path[0].y + 0.5 })
  let x = plan.path[0].x + 0.5, y = plan.path[0].y + 0.5
  const dt = 1 / 60
  const speed = 4
  for (let t = 0; t < seconds; t += dt) {
    const s = stepTravel(tr, { x, y }, dt, R)
    if (s.done) return { x, y, done: true, stuck: false }
    if (s.stuck) return { x, y, done: false, stuck: true }
    ;({ x, y } = moveBody(g, x, y, s.axis.x * speed * dt, s.axis.y * speed * dt, motion))
  }
  return { x, y, done: false, stuck: false }
}

test('tapMove content: fx kinds exist and numbers are sane', () => {
  assert.ok(RENDER.fx.kinds[R.markerFx], `fx ${R.markerFx}`)
  assert.ok(RENDER.fx.kinds[R.blockedFx], `fx ${R.blockedFx}`)
  assert.ok(R.pickRadiusPx >= 22, 'pick radius is a finger, not a pixel')
  assert.ok(R.waypointReach > R.finalReach && R.waypointReach < 1)
  for (const k of Object.keys(R.kindBiasPx)) assert.ok(['npc', 'item', 'sign', 'prop', 'warp'].includes(k), k)
})

test('screenToGround inverts the camera projection, also over raised ground', () => {
  const cam = new THREE.PerspectiveCamera(32, 390 / 844, 0.5, 180)
  const feet = new THREE.Vector3(512.5, 0, 878.5)
  cam.position.set(feet.x, 24 * Math.sin(0.63), feet.z + 24 * Math.cos(0.63))
  cam.lookAt(feet)
  cam.updateMatrixWorld()
  cam.updateProjectionMatrix()
  const size = { width: 390, height: 844 }
  const toPx = (p: THREE.Vector3) => { const v = p.clone().project(cam); return { x: (v.x * 0.5 + 0.5) * size.width, y: (0.5 - v.y * 0.5) * size.height } }
  for (const [x, z] of [[510, 876], [515.5, 880.25], [512.5, 872]]) {
    const hit = screenToGround(cam, toPx(new THREE.Vector3(x, 0, z)), size, 0, () => 0, 2)!
    assert.ok(Math.hypot(hit.x - x, hit.y - z) < 0.01, `flat ${x},${z} -> ${hit.x},${hit.y}`)
  }
  // a terrace 1.5 units high: the plane guess is off, the elevation passes pull it onto the terrace
  const terrace = (x: number) => (x >= 512 ? 1.5 : 0)
  const px = toPx(new THREE.Vector3(514, 1.5, 878))
  const naive = screenToGround(cam, px, size, 0, terrace, 0)!
  const fixed = screenToGround(cam, px, size, 0, terrace, R.elevationPasses)!
  assert.ok(Math.hypot(fixed.x - 514, fixed.y - 878) < 0.05, `fixed ${fixed.x},${fixed.y}`)
  assert.ok(Math.hypot(naive.x - 514, naive.y - 878) > Math.hypot(fixed.x - 514, fixed.y - 878))
})

test('pickCandidate takes the body nearest the finger, within the radius, with kind bias', () => {
  const project = (x: number, _e: number, y: number) => ({ x: x * 10, y: y * 10, visible: x >= 0 })
  const cand = (id: string, kind: TapCandidate['kind'], x: number, y: number): TapCandidate => ({ kind, id, rect: { x: Math.floor(x), y: Math.floor(y), w: 1, h: 1 }, x, y, elev: 0 })
  const list = [cand('a', 'prop', 10, 10), cand('b', 'npc', 12, 10), cand('far', 'npc', 40, 40), cand('hidden', 'npc', -1, 0)]
  assert.equal(pickCandidate(project, { x: 100, y: 100 }, list, R)?.id, 'a')
  // between a and b: npc bias wins the tie
  assert.equal(pickCandidate(project, { x: 110, y: 100 }, list, R)?.id, 'b')
  assert.equal(pickCandidate(project, { x: 250, y: 250 }, list, R), null)
  assert.equal(pickCandidate(project, { x: -10, y: 0 }, list, R), null)
})

test('ground tap routes through a one-tile gap and the body walks it', () => {
  const g = grid(['#########', '#...#...#', '#.#.#.#.#', '#.#...#.#', '#.#####.#', '#.......#', '#########'])
  const plan = planTapRoute(g, { x: 1.5, y: 1.5 }, ground(7, 1), false, R)!
  assert.ok(plan, 'a route exists')
  assert.deepEqual(plan.goal, { x: 7, y: 1 })
  plan.path.slice(1).forEach((p, i) => assert.ok(adjacent(plan.path[i], p), `step ${i}`))
  const end = walk(g, plan, ground(7, 1))
  assert.ok(end.done && !end.stuck, JSON.stringify(end))
  assert.ok(Math.floor(end.x) === 7 && Math.floor(end.y) === 1, `ended ${end.x},${end.y}`)
})

test('ground tap on a blocked tile snaps to a standable neighbour; fully walled-in taps fail', () => {
  const g = grid(['.....', '..#..', '.....', '#####', '..~..'])
  const plan = planTapRoute(g, { x: 0.5, y: 0.5 }, ground(2, 1), false, R)!
  assert.ok(plan && adjacent(plan.goal, { x: 2, y: 1 }))
  assert.equal(planTapRoute(g, { x: 0.5, y: 0.5 }, ground(2, 4), false, R), null, 'beyond the wall: unreachable')
  assert.equal(planTapRoute(g, { x: 0.5, y: 0.5 }, ground(2, 4), true, R), null, 'surf does not walk through walls')
  const water = grid(['..~..'])
  assert.equal(planTapRoute(water, { x: 0.5, y: 0.5 }, ground(4, 0), false, R), null, 'water needs surf')
  assert.ok(planTapRoute(water, { x: 0.5, y: 0.5 }, ground(4, 0), true, R))
})

test('npc tap ends beside the npc and asks to interact; already adjacent needs no walking', () => {
  const g = grid(['.......', '.......', '.......'])
  const npc: TapTarget = { kind: 'npc', id: 'n', rect: { x: 5, y: 1, w: 1, h: 1 } }
  g.blocked = (x, y) => x === 5 && y === 1
  const plan = planTapRoute(g, { x: 0.5, y: 1.5 }, npc, false, R)!
  assert.ok(adjacent(plan.goal, { x: 5, y: 1 }), JSON.stringify(plan.goal))
  assert.deepEqual(plan.interactAt, { x: 5.5, y: 1.5 })
  const end = walk(g, plan, npc)
  assert.ok(end.done)
  const near = planTapRoute(g, { x: 4.5, y: 1.5 }, npc, false, R)!
  assert.equal(near.path.length, 1)
  assert.deepEqual(near.interactAt, { x: 5.5, y: 1.5 })
})

test('door tap ends on the warp tile without an interaction; a talk target boxed in fails', () => {
  const g = grid(['.....', '.....', '..D..'])
  const door: TapTarget = { kind: 'warp', id: 'w', rect: { x: 2, y: 2, w: 1, h: 1 } }
  const plan = planTapRoute(g, { x: 0.5, y: 0.5 }, door, false, R)!
  assert.deepEqual(plan.goal, { x: 2, y: 2 })
  assert.equal(plan.interactAt, null)
  const boxed = grid(['#####', '#.#.#', '#####'])
  boxed.blocked = (x, y) => x === 1 && y === 1
  const npc: TapTarget = { kind: 'npc', id: 'n', rect: { x: 1, y: 1, w: 1, h: 1 } }
  assert.equal(planTapRoute(boxed, { x: 3.5, y: 1.5 }, npc, false, R), null)
})

test('a route does not cut through another door on the way', () => {
  const g = grid(['.D...', '.....'])
  const plan = planTapRoute(g, { x: 0.5, y: 0.5 }, ground(4, 0), false, R)!
  assert.ok(plan.path.every((p) => !(p.x === 1 && p.y === 0)), 'avoids the door tile')
})

test('stuck detection fires when the way closes, and a re-plan finds the other way', () => {
  const g = grid(['.......', '.......', '.......'])
  const target = ground(6, 1)
  const plan = planTapRoute(g, { x: 0.5, y: 1.5 }, target, false, R)!
  g.col![0 * 7 + 3] = 1; g.col![1 * 7 + 3] = 1 // two tiles of the wall appear in the way
  const first = walk(g, plan, target)
  assert.ok(first.stuck && !first.done, JSON.stringify(first))
  const again = planTapRoute(g, { x: first.x, y: first.y }, target, false, R)!
  assert.ok(again.path.some((p) => p.y === 2), 'goes around through the open row')
  const tr = retravel(createTravel(plan, target, { x: first.x, y: first.y }), again, { x: first.x, y: first.y })
  assert.equal(tr.replans, 1)
  const end = walk(g, again, target)
  assert.ok(end.done, JSON.stringify(end))
})
