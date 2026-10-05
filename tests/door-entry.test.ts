import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { GameMap, PropDef, PropPlacement } from '../src/shared/types.ts'
import { buildWorld, validateWorldContent, worldBuildInfo } from '../src/shared/world/index.ts'
import { COLLISION_BLOCKED, propCenter, propDoor, propDoors, propRect } from '../src/shared/world/collision.ts'
import { collisionField, getMap, warpAt } from '../src/shared/world/worldapi.ts'
import type { FrontierProvider } from '../src/shared/world/frontier/provider.ts'
import { DIR_VEC, moveBody, type MotionOpts } from '../src/client/world/motion.ts'
import { GAME } from '../src/client/world/config.ts'

const world = buildWorld()
const map = world.maps[world.startMap]
const field = collisionField(map)
const opts: MotionOpts = {
  radius: GAME.player.radius, surf: false, cornerSlip: GAME.player.cornerSlip,
  cornerSlipRate: GAME.player.cornerSlipRate, substep: GAME.player.substepTiles,
}

function walkInto(m: GameMap, p: PropPlacement, lane: ReturnType<typeof propDoors>[number], step = 0.05) {
  const v = DIR_VEC[lane.facing]
  let x = lane.front.x + 0.5, y = lane.front.y + 0.5
  const grid = { map: m, field: collisionField(m) }
  for (let i = 0; i < 40; i++) {
    ;({ x, y } = moveBody(grid, x, y, -v.x * step, -v.y * step, opts))
    const entered = warpAt(m, Math.floor(x), Math.floor(y))
    if (entered) return entered
  }
  assert.fail(`${p.prop} rot ${p.rot}: body stopped at ${x},${y} instead of entering from ${lane.front.x},${lane.front.y}`)
}

// These GLBs have a 1.8-tile opening centred on the boundary between the two facade tiles.
for (const key of ['lab', 'center', 'gym', 'datacenter', 'temple']) {
  for (const offset of [-0.45, 0, 0.45]) {
    test(`${key}: walking into the visible door at lateral offset ${offset} triggers its interior warp`, () => {
      const p = map.props.find(p => p.prop === key && p.rot === 0)!
      assert.ok(p, `${key}: missing building fixture`)
      const door = propDoor(p)!
      const target = warpAt(map, door.x, door.y)!
      assert.ok(target, `${key}: missing canonical warp`)
      let x = propCenter(p).x + offset
      let y = door.front.y + 0.5
      let entered = null
      for (let i = 0; i < 40; i++) {
        ;({ x, y } = moveBody({ map, field }, x, y, 0, -0.05, opts))
        entered = warpAt(map, Math.floor(x), Math.floor(y))
        if (entered) break
      }
      assert.equal(entered?.toMap, target.toMap,
        `${key}: stopped at ${x},${y} instead of entering ${target.toMap}`)
    })
  }
}

for (const [rot, expected] of [
  [0, [[16, 16, 16, 17], [15, 16, 15, 17]]],
  [1, [[16, 15, 17, 15], [16, 16, 17, 16]]],
  [2, [[15, 12, 15, 11], [16, 12, 16, 11]]],
  [3, [[12, 16, 11, 16], [12, 15, 11, 15]]],
] as const) {
  test(`double doors rotate their complete opening at rotation ${rot} without opening other walls`, () => {
    const p: PropPlacement = { prop: 'lab', x: 12, y: 12, rot }
    const lanes = propDoors(p)
    assert.deepEqual(lanes.map(d => [d.x, d.y, d.front.x, d.front.y]), expected)
    assert.deepEqual(lanes[0], propDoor(p), 'return anchor must not shift')
    const w = 32, h = 32
    const m: GameMap = {
      ...map, infinite: undefined, id: 'rotated-door', width: w, height: h,
      terrain: new Uint8Array(w * h).fill(CONTENT.terrainByKey.cobble.id),
      elevation: new Uint8Array(w * h), region: new Uint8Array(w * h),
      props: [p], npcs: [], signs: [], items: [], lights: [],
      warps: lanes.map(d => ({ x: d.x, y: d.y, toMap: 'inside', toX: 1, toY: 1, facing: 'up', kind: 'door' })),
    }
    for (const lane of lanes) {
      assert.equal(walkInto(m, p, lane).toMap, 'inside')
      assert.equal(walkInto(m, p, lane, CONTENT.config.movement.runSpeed / 60).toMap, 'inside')
    }
    const f = collisionField(m), r = propRect(p)
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (!lanes.some(d => d.x === x && d.y === y)) assert.equal(f.at(x, y), COLLISION_BLOCKED)
    }
  })
}

test('all generated building lanes reach the same interior on finite and streamed maps, including chunk seams', t => {
  const finite: GameMap = { ...map, infinite: undefined }
  let lanes = 0, seams = 0
  for (const p of map.props) {
    const entries = propDoors(p)
    if (!entries.length) continue
    const main = warpAt(map, entries[0].x, entries[0].y)!
    assert.ok(main)
    const back = world.maps[main.toMap].warps.find(w => w.toMap === map.id &&
      w.toX === entries[0].front.x && w.toY === entries[0].front.y)!
    assert.ok(back)
    assert.deepEqual([back.toX, back.toY], [entries[0].front.x, entries[0].front.y])
    for (const lane of entries) {
      lanes++
      for (const m of [finite, map]) {
        const f = collisionField(m)
        assert.equal(f.at(lane.front.x, lane.front.y), 0, 'approach must stay clear')
        assert.deepEqual(walkInto(m, p, lane), { ...main, x: lane.x, y: lane.y })
      }
      const size = map.infinite!.size
      if (Math.floor(lane.x / size) !== Math.floor(entries[0].x / size) ||
        Math.floor(lane.y / size) !== Math.floor(entries[0].y / size)) seams++
    }
  }
  assert.ok(lanes > map.props.filter(p => propDoor(p)).length, 'multi-lane entries must be exercised')
  assert.ok(seams > 0, 'the sample must include doors spanning different chunks')
  t.diagnostic(`${lanes} entry lanes exercised on both collision fields; ${seams} cross-chunk lanes`)
})

test('lazy frontier hamlets preserve every rotated entry lane and the original return anchor', t => {
  const provider = map.infinite as FrontierProvider
  let wide = 0, lanes = 0
  for (const gate of worldBuildInfo(world).features.gates) {
    const [sx, sy] = provider.grid.cellOf(gate.x, gate.y)
    const site = provider.grid.siteAt(sx, sy)
    if (site?.type !== 'hamlet') continue
    const layout = provider.decorSite(site).layout
    for (const p of layout.props) {
      const entries = propDoors(p)
      if (!entries.length) continue
      const main = warpAt(map, entries[0].x, entries[0].y)!
      assert.ok(main)
      const inner = getMap(world, main.toMap)!
      assert.ok(inner)
      const back = inner.warps.find(w => w.toMap === map.id)!
      assert.deepEqual([back.toX, back.toY], [entries[0].front.x, entries[0].front.y])
      if (entries.length > 1) wide++
      for (const lane of entries) {
        lanes++
        assert.equal(collisionField(map).at(lane.front.x, lane.front.y), 0)
        assert.equal(walkInto(map, p, lane).toMap, inner.id)
      }
    }
  }
  assert.ok(wide > 0, 'the sample must include a frontier double door')
  t.diagnostic(`${lanes} lazy frontier entry lanes, ${wide} double-door buildings`)
})

test('door spans reject missing doors, fractional offsets and lanes outside the footprint', () => {
  const invalid: Partial<PropDef>[] = [
    { door: undefined, doorSpan: [-1, 0] },
    { doorSpan: [-0.5, 0] },
    { doorSpan: [-1, -1] },
    { doorSpan: [1, 1] },
    { doorSpan: [-5, 0] },
    { doorSpan: [0, 4] },
  ]
  for (const patch of invalid) {
    const lab = { ...CONTENT.props.lab, ...patch }
    const c = { ...CONTENT, props: { ...CONTENT.props, lab } }
    assert.ok(validateWorldContent(undefined, c).some(e => e.startsWith('prop lab: doorSpan')))
  }
})
