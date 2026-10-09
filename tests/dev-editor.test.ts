// The editor model against the real world content: provenance round trips (mirrored towns included), edits expressed in
// template coordinates, rebuild-and-validate, rollback on every kind of refusal, and exact undo / redo.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { applyPatch, getAt, type PatchOp } from '../src/shared/dev/editor.ts'
import { LAYOUT_DOCS } from '../src/shared/world/data.ts'
import { propSize } from '../src/shared/world/collision.ts'
import { buildWorld, worldBuildInfo } from '../src/shared/world/index.ts'
import { fromTemplate, toTemplate, type ProvEntry, type ProvRegion } from '../src/shared/world/provenance.ts'
import { validateWorldContent } from '../src/shared/world/validate.ts'
import { EditorSession, type Built, type WriteResult } from '../src/client/dev/editor/session.ts'
import type { World } from '../src/shared/types.ts'

const pristine = JSON.stringify(LAYOUT_DOCS)
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
let lastWorld: World | null = null

function build(): Built {
  const entries: ProvEntry[] = [], regions: ProvRegion[] = []
  lastWorld = buildWorld(undefined, { provenance: { add: (e) => entries.push(e), region: (r) => regions.push(r) } })
  return { entries, regions, problems: worldBuildInfo(lastWorld).problems, content: validateWorldContent() }
}

/** A stand-in endpoint: keeps its own copy of each document, like the file on disk. */
function endpoint() {
  const disk = new Map<string, unknown>(Object.entries(LAYOUT_DOCS).map(([f, d]) => [f, JSON.parse(JSON.stringify(d))]))
  const calls: { file: string; ops: PatchOp[] }[] = []
  let fail: { status: number; error: string } | null = null
  return {
    disk, calls,
    failNext(status: number, error: string) { fail = { status, error } },
    hash: async (file: string) => sha(disk.get(file)),
    write: async (file: string, baseHash: string, ops: PatchOp[]): Promise<WriteResult> => {
      calls.push({ file, ops })
      if (fail) { const f = fail; fail = null; return { ok: false, ...f } }
      if (baseHash !== sha(disk.get(file))) return { ok: false, status: 409, error: 'conflict' }
      applyPatch(disk.get(file), ops)
      return { ok: true, hash: sha(disk.get(file)) }
    },
  }
}

const newSession = (ep = endpoint()) => ({ ep, s: new EditorSession({ docs: LAYOUT_DOCS, build, size: propSize, hash: ep.hash, write: ep.write, undoDepth: 20 }) })
const doc = () => JSON.parse(JSON.stringify(LAYOUT_DOCS)) as typeof LAYOUT_DOCS
const key = (e: ProvEntry) => `${e.file}#${e.pointer}`

before(() => { assert.equal(JSON.stringify(LAYOUT_DOCS), pristine) })
after(() => { assert.equal(JSON.stringify(LAYOUT_DOCS), pristine, 'every test left the documents as it found them') })

test('provenance: every recorded template object maps back to its JSON coordinates (mirrored towns included) and matches the built world', { timeout: 120000 }, () => {
  const { entries, regions } = build()
  const world = lastWorld!
  const kinds = new Set(entries.map((e) => e.kind))
  assert.deepEqual([...kinds].sort(), ['anchor', 'building', 'prop', 'sign'])
  assert.ok(entries.some((e) => e.transform.mirror && e.kind === 'building'), 'mirrored towns are recorded')
  assert.ok(entries.some((e) => e.file.endsWith('interiors.json')) && entries.some((e) => e.file.endsWith('gyms.json')), 'interiors and gyms are recorded')
  assert.ok(regions.some((r) => r.mirror) && regions.some((r) => !r.mirror))
  for (const e of entries) {
    const v = getAt(LAYOUT_DOCS[e.file], e.pointer) as { x: number; y: number } | [number, number]
    const [bx, by] = Array.isArray(v) ? v : [v.x, v.y]
    const t = toTemplate(e.transform, e.x, e.y)
    assert.deepEqual([t.x, t.y], [bx, by], `${e.file}${e.pointer} (${e.transform.mirror ? 'mirrored' : 'plain'})`)
    assert.deepEqual(fromTemplate(e.transform, t.x, t.y), { x: e.x, y: e.y }, 'the forward stamp inverts it')
    const map = world.maps[e.map]
    assert.ok(map, `map ${e.map}`)
    assert.ok(e.x >= 0 && e.y >= 0 && e.x + e.w <= map.width && e.y + e.h <= map.height || map.infinite !== undefined, `${e.label} inside ${e.map}`)
    if (e.kind === 'prop') assert.ok(map.props.some((p) => p.prop === e.label && p.x === e.x && p.y === e.y && p.rot === e.rot), `${e.label} is where provenance says (${e.x},${e.y})`)
    if (e.kind === 'building') assert.ok(map.props.some((p) => p.x === e.x && p.y === e.y), `building ${e.label} stands at (${e.x},${e.y})`)
  }
})

test('move a building in a mirrored town: template-space patch, rebuilt in place, no new problems, undo gives back the exact document', { timeout: 180000 }, async () => {
  const { ep, s } = newSession()
  await s.open()
  const before = doc()
  const buildings = s.entries.filter((e) => e.kind === 'building' && e.transform.mirror)
  assert.ok(buildings.length > 0, 'buildings of mirrored towns are recorded')
  let b = buildings[0]
  let moved: ProvEntry | undefined
  let attempts = 0
  search: for (const cand of buildings) {
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      if (++attempts > 14) break search
      s.select(cand)
      const res = await s.move(cand.x + dx, cand.y + dy)
      if (res.ok) { b = cand; moved = s.selected!; assert.deepEqual([moved.x, moved.y], [cand.x + dx, cand.y + dy], 'the rebuilt world has it at the requested tile'); break search }
      assert.equal(res.reason, 'problems')
      assert.deepEqual(JSON.parse(JSON.stringify(LAYOUT_DOCS)), before, 'a refused move leaves the document alone')
    }
  }
  assert.ok(moved, 'some neighbouring tile accepts a building')
  const t = toTemplate(moved!.transform, moved!.x, moved!.y)
  assert.deepEqual([getAt(LAYOUT_DOCS[b.file], `${b.pointer}/x`), getAt(LAYOUT_DOCS[b.file], `${b.pointer}/y`)], [t.x, t.y], 'the document holds template coordinates, not map coordinates')
  assert.equal(ep.calls.length, 1)
  assert.deepEqual(ep.calls[0].ops.map((o) => o.path), [`${b.pointer}/x`, `${b.pointer}/y`])
  assert.equal(sha(ep.disk.get(b.file)), sha(LAYOUT_DOCS[b.file]), 'the endpoint holds what the editor holds')
  assert.ok(s.written)
  const undone = await s.undo()
  assert.ok(undone.ok)
  assert.deepEqual(JSON.parse(JSON.stringify(LAYOUT_DOCS)), before, 'undo restores every byte of the document')
  assert.deepEqual(JSON.parse(JSON.stringify(Object.fromEntries(ep.disk))), before, 'and of the written copy')
  assert.deepEqual([s.selected!.x, s.selected!.y], [b.x, b.y])
  const redone = await s.redo()
  assert.ok(redone.ok && s.selected!.x === moved!.x && s.selected!.y === moved!.y)
  assert.ok((await s.undo()).ok)
})

test('refusals roll back: a building onto another one, a write the endpoint rejects, a stale file', { timeout: 180000 }, async () => {
  const { ep, s } = newSession()
  await s.open()
  const before = doc()
  const town = s.entries.filter((e) => e.kind === 'building' && !e.transform.mirror && e.template === 'town_start')
  const [a, b] = town
  s.select(a)
  const clash = await s.move(b.x, b.y)
  assert.equal(clash.ok, false)
  assert.equal((clash as { reason: string }).reason, 'problems')
  assert.ok(((clash as { problems: string[] }).problems).some((p) => /does not fit/.test(p)), 'the refusal names the problem')
  assert.equal(ep.calls.length, 0, 'nothing was sent for a world that does not validate')
  assert.deepEqual(JSON.parse(JSON.stringify(LAYOUT_DOCS)), before)

  const prop = s.entries.find((e) => e.kind === 'sign' && !e.transform.mirror)!
  s.select(prop)
  ep.failNext(422, 'validation')
  const rejected = await s.move(prop.x, prop.y + 1)
  assert.deepEqual([rejected.ok, (rejected as { reason: string }).reason, (rejected as { status: number }).status], [false, 'write', 422])
  assert.deepEqual(JSON.parse(JSON.stringify(LAYOUT_DOCS)), before, 'a rejected write reverts the in-memory edit')
  assert.equal(s.canUndo, false, 'and leaves nothing to undo')

  ep.disk.set(prop.file, { changedElsewhere: true })
  const stale = await s.move(prop.x, prop.y + 1)
  assert.equal((stale as { status: number }).status, 409)
  assert.deepEqual(JSON.parse(JSON.stringify(LAYOUT_DOCS)), before)
  const nothing = newSession().s
  assert.deepEqual(await nothing.move(1, 1), { ok: false, reason: 'nothing' })
})

test('rotate a prop of a mirrored town and delete / place in a template, each undone exactly', { timeout: 240000 }, async () => {
  const { ep, s } = newSession()
  await s.open()
  const before = doc()
  const p = s.entries.find((e) => e.kind === 'prop' && e.transform.mirror && e.w === 2 && e.h === 1 && e.template === 'town_gym_a')
  assert.ok(p, 'a 2x1 prop in a mirrored town (rotation swaps its footprint)')
  s.select(p!)
  const r = await s.rotate()
  assert.ok(r.ok, JSON.stringify(r))
  const rot = s.selected!
  assert.deepEqual([rot.rot, rot.w, rot.h, rot.x, rot.y], [(p!.rot + 1) % 4, 1, 2, p!.x, p!.y], 'one quarter turn, footprint swapped, top-left tile kept')
  assert.ok((await s.undo()).ok)
  assert.deepEqual(JSON.parse(JSON.stringify(LAYOUT_DOCS)), before)

  const lamp = s.entries.find((e) => e.kind === 'prop' && e.w === 1 && e.h === 1 && !e.transform.mirror && e.file.endsWith('towns.json'))!
  s.select(lamp)
  const count = s.entries.length, shared = s.sharedBy(lamp)
  assert.ok((await s.remove()).ok)
  assert.equal(s.selected, null)
  assert.equal(s.entries.length, count - shared, 'every stamp of the deleted template object is gone')
  assert.ok(!s.entries.some((e) => e.map === lamp.map && e.x === lamp.x && e.y === lamp.y && e.kind === 'prop'), 'nothing stands on its tile any more')
  const put = await s.place(lamp.map, lamp.label, lamp.x, lamp.y, lamp.rot)
  assert.ok(put.ok, JSON.stringify(put))
  assert.ok(s.entries.some((e) => e.kind === 'prop' && e.label === lamp.label && e.x === lamp.x && e.y === lamp.y && e.map === lamp.map), 'placed where asked')
  assert.ok((await s.undo()).ok && (await s.undo()).ok)
  assert.deepEqual(JSON.parse(JSON.stringify(LAYOUT_DOCS)), before, 'two undos give back the document')
  assert.deepEqual(JSON.parse(JSON.stringify(Object.fromEntries(ep.disk))), before)
  assert.ok((await s.redo()).ok && s.canRedo)
  assert.ok((await s.undo()).ok)
  const outside = await s.place('overworld', 'bench', 5, 5)
  assert.deepEqual([outside.ok, (outside as { reason: string }).reason], [false, 'readonly'], 'generated land has no template to put a prop into')
  assert.deepEqual(JSON.parse(JSON.stringify(LAYOUT_DOCS)), before)
})
