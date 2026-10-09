// Save v1 -> v2 (natures and origins): three real v1 saves lose nothing, the one-time gift is handed out once,
// migration is idempotent and a current save passes through untouched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CONTENT } from '../src/shared/content/index.ts'
import type { Creature, SaveData } from '../src/shared/types.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { migrateSave } from '../src/client/core/save-migrate.ts'
import { encodeSaveCode } from '../src/client/core/save-codec.ts'

const world = buildWorld()
const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) } }
}
const saves = createSaveManager({ world, storage: memory(), now: () => 1_700_000_000_000, newId: () => '00000000-0000-4000-8000-000000000001' })
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/save-v1-${name}.json`, import.meta.url), 'utf8'))
const NAMES = ['starter', '3badges', 'champion']
const all = (s: { party: Creature[]; boxes: Creature[][] }) => [...s.party, ...s.boxes.flat()]
const Q = CONTENT.quality

test('fixtures really are v1: no natures, no origins, version 1', () => {
  for (const n of NAMES) {
    const raw = fixture(n) as unknown as SaveData
    assert.equal(raw.version, 1, n)
    assert.ok(all(raw).length >= 1)
    for (const cr of all(raw)) assert.ok(!('nature' in cr) && !('origin' in cr) && !('finetuned' in cr), `${n} ${cr.speciesId}`)
  }
})

test('v1 saves migrate to v2: levels, exp, IVs and moves unchanged; every creature balanced and legacy', () => {
  for (const n of NAMES) {
    const raw = fixture(n) as unknown as SaveData
    const migrated = migrateSave(raw) as SaveData
    assert.equal(migrated.version, 2, n)
    const out = saves.sanitize(migrated)!
    assert.equal(out.version, 2)
    const before = all(raw)
    const after = all(out)
    assert.equal(after.length, before.length, n)
    before.forEach((b, i) => {
      const a = after[i]
      assert.equal(a.speciesId, b.speciesId)
      assert.equal(a.level, b.level, `${n} ${b.speciesId} level`)
      assert.equal(a.exp, b.exp, `${n} ${b.speciesId} exp`)
      assert.deepEqual(a.ivs, b.ivs, `${n} ${b.speciesId} ivs`)
      assert.deepEqual(a.moves, b.moves, `${n} ${b.speciesId} moves`)
      assert.equal(a.hp, b.hp)
      assert.equal(a.nature, Q.legacyNature)
      assert.equal(a.origin?.kind, 'legacy')
      assert.equal(a.finetuned, 0)
    })
    assert.deepEqual(out.badges, raw.badges)
    assert.equal(out.money, raw.money)
    assert.deepEqual(out.position, raw.position)
  }
})

test('a boss species caught before natures keeps its boss in origin (party and boxes)', () => {
  const champ = saves.sanitize(migrateSave(fixture('champion')))!
  const v4 = champ.party.find((c) => c.speciesId === 'deepseek-v4')!
  assert.equal(v4.origin?.boss, 'deepseek')
  const kimi = champ.boxes.flat().find((c) => c.speciesId === 'kimi-k3')!
  assert.equal(kimi.origin?.boss, 'kimi')
  const plain = champ.party.find((c) => !CONTENT.bossBySpecies[c.speciesId])!
  assert.deepEqual(plain.origin, { kind: 'legacy' })
})

test('the one-time gift: persona cards in the bag, flag set, nothing handed out twice', () => {
  for (const n of NAMES) {
    const raw = fixture(n) as unknown as SaveData
    const out = saves.sanitize(migrateSave(raw))!
    for (const [id, qty] of Object.entries(Q.legacyGift)) assert.equal(out.bag[id], (raw.bag[id] ?? 0) + qty, `${n} ${id}`)
    assert.equal(out.flags[Q.flags.legacyGift], true)
    assert.equal(out.flags[Q.flags.legacyToast], undefined, 'the toast is still to be shown')
    const again = saves.sanitize(migrateSave(out))!
    assert.deepEqual(again.bag, out.bag)
  }
})

test('migration is idempotent and does not mutate its input', () => {
  for (const n of NAMES) {
    const raw = fixture(n)
    const frozen = JSON.stringify(raw)
    const once = migrateSave(raw)
    assert.equal(JSON.stringify(raw), frozen, 'input untouched')
    assert.deepEqual(migrateSave(once), once)
    assert.deepEqual(saves.sanitize(migrateSave(saves.sanitize(once))), saves.sanitize(once))
  }
})

test('a v2 save passes through unchanged (same object)', () => {
  const v2 = saves.newGame({ name: 'x', avatar: '' })
  assert.equal(v2.version, 2)
  assert.equal(migrateSave(v2), v2)
  assert.equal(v2.flags[Q.flags.legacyGift], undefined)
})

test('non-saves are left for the sanitizer to reject', () => {
  assert.equal(migrateSave(null), null)
  assert.equal(migrateSave('x'), 'x')
  const noVersion = { party: [] }
  assert.equal(migrateSave(noVersion), noVersion)
})

test('load and importCode migrate before sanitizing', () => {
  const store = memory()
  const mgr = createSaveManager({ world, storage: store, now: () => 1_700_000_000_000, newId: () => 'id-1' })
  const raw = fixture('3badges')
  store.setItem(`${CONTENT.config.save.storagePrefix}0`, JSON.stringify(raw))
  const loaded = mgr.load(0)!
  assert.equal(loaded.version, 2)
  assert.ok(loaded.party.every((c) => c.nature === Q.legacyNature && c.origin?.kind === 'legacy'))
  assert.equal(loaded.bag['persona-card'], 2)
  const imported = mgr.importCode(encodeSaveCode(raw as unknown as SaveData, 1))!
  assert.equal(imported.bag['persona-card'], 2)
  assert.ok(imported.party.every((c) => c.nature === Q.legacyNature))
})
