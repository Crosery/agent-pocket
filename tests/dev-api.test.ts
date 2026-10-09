// Developer API (ADR 0002 §2, §4.1): state diff / matchers, the command registry, the event log, waits, and the
// consistency of content/dev/console.json with the registered handlers and the dev text table.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import type { EventBus, GameEvents } from '../src/client/contracts.ts'
import { CONTENT, t } from '../src/shared/content/index.ts'
import { canonical, diff, digest, getPointer, matches, partialMatch, pointer } from '../src/client/dev/diff.ts'
import { createEventLog } from '../src/client/dev/events.ts'
import { createRegistry, CONSOLE, DevError, tokenize, type CommandMeta, type CommandRun } from '../src/client/dev/registry.ts'
import { COMMANDS } from '../src/client/dev/commands/index.ts'
import { ENUMS } from '../src/client/dev/enums.ts'
import { installDevText } from '../src/client/dev/text.ts'
import { poll } from '../src/client/dev/wait.ts'
import { createApiV1 } from '../src/client/dev/api.ts'
import type { DevHost } from '../src/client/dev/kit.ts'
import { RngHub } from '../src/client/core/rng-hub.ts'
import { createDevClock } from '../src/client/dev/clock.ts'

const root = new URL('../', import.meta.url)
before(() => installDevText())

// ----------------------------------------------------------------------------- diff

test('canonical / digest: key order and undefined do not matter, values do', () => {
  assert.equal(digest({ a: 1, b: { c: [1, 2], d: undefined } }), digest({ b: { c: [1, 2] }, a: 1 }))
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }))
  assert.deepEqual(canonical({ n: NaN, f: () => 1, s: 's' }), { n: null, s: 's' }, 'non-finite numbers become null, functions drop out')
  assert.equal(digest(1).length, 14)
})

test('diff: only the leaves that changed, arrays per index when the length is stable', () => {
  const a = { save: { money: 100, bag: { potion: 1, ball: 5 }, party: [{ hp: 10 }, { hp: 20 }], flags: {} } }
  const b = { save: { money: 70, bag: { potion: 2, ball: 5 }, party: [{ hp: 10 }, { hp: 20 }], flags: {} } }
  assert.deepEqual(diff(a, b), [
    { op: 'replace', path: '/save/bag/potion', before: 1, after: 2 },
    { op: 'replace', path: '/save/money', before: 100, after: 70 },
  ])
  assert.deepEqual(diff(a, a), [])
  const c = { save: { ...a.save, bag: { ball: 5, elixir: 1 }, party: [{ hp: 10 }] } }
  assert.deepEqual(diff(a, c).map((o) => [o.op, o.path]), [['remove', '/save/bag/potion'], ['add', '/save/bag/elixir'], ['replace', '/save/party']])
  assert.deepEqual(diff({ 'a/b': { '~': 1 } }, { 'a/b': { '~': 2 } }).map((o) => o.path), ['/a~1b/~0'])
})

test('pointer helpers: lookup incl. escapes, arrays and misses', () => {
  const doc = { a: { 'x/y': [10, { z: 5 }] } }
  assert.deepEqual(getPointer(doc, pointer('a', 'x/y', 1, 'z')), { found: true, value: 5 })
  assert.equal(getPointer(doc, '/a/x~1y/0').value, 10)
  assert.equal(getPointer(doc, '/a/missing').found, false)
  assert.equal(getPointer(doc, '/a/x~1y/9').found, false)
  assert.equal(getPointer(doc, '').found, true)
})

test('matchers: bare value is eq; operators; missing paths only satisfy exists:false', () => {
  assert.ok(matches(true, 3, 3))
  assert.ok(matches(true, 'boss', { eq: 'boss' }))
  assert.ok(matches(true, 3, { gt: 2 }) && !matches(true, 3, { gt: 3 }) && matches(true, 3, { gte: 3 }))
  assert.ok(matches(true, 'x', { in: ['x', 'y'] }) && !matches(true, 'z', { in: ['x', 'y'] }))
  assert.ok(matches(true, ['a', 'b'], { includes: 'b' }) && matches(true, 'abc', { includes: 'bc' }))
  assert.ok(matches(true, [1, 2], { length: 2 }) && matches(true, 'rain-3', { match: '^rain' }))
  assert.ok(matches(false, undefined, { exists: false }) && !matches(false, undefined, { eq: undefined }) && matches(true, 0, { exists: true }))
  assert.ok(matches(true, { a: 1, b: 2 }, { eq: { b: 2, a: 1 } }))
  assert.ok(partialMatch({ kind: 'boss', result: { won: true } }, { kind: 'boss' }) && !partialMatch({ kind: 'wild' }, { kind: 'boss' }))
})

// ----------------------------------------------------------------------------- registry

const meta: Record<string, CommandMeta> = {
  add: { titleKey: 'dev.cmd.fly', group: 't', mutates: true, needs: 'live', args: [{ name: 'a', type: 'integer' }, { name: 'b', type: 'number', optional: true }] },
  peek: { titleKey: 'dev.cmd.fly', group: 't', mutates: false, needs: 'live', args: [{ name: 'on', type: 'boolean' }, { name: 'who', type: 'string', enumRef: 'who', optional: true }, { name: 'blob', type: 'json', optional: true }] },
}
const seen: unknown[] = []
const impls: Record<string, CommandRun> = {
  add: (_h, a) => { seen.push(a); return { sum: (a.a as number) + ((a.b as number | undefined) ?? 0), bad: undefined } },
  peek: (_h, a) => { seen.push(a) },
}
const rejects = (p: Promise<unknown>, key: string, params?: Record<string, string | number>) => assert.rejects(p, (e: Error) => e instanceof DevError && e.message === t(key, params))

test('registry: coercion, optional args, enums, positional command lines, taint only for mutating commands', async () => {
  seen.length = 0
  let clock = 1000
  const reg = createRegistry({} as DevHost, impls, { meta, enums: { who: () => ['ann', 'bob'] }, now: () => clock++ })
  assert.deepEqual(await reg.run('add', { a: '2', b: 3 }), { sum: 5 }, 'strings are coerced, undefined results drop out')
  assert.deepEqual(seen[0], { a: 2, b: 3 })
  assert.deepEqual(reg.taint, { count: 1, firstAt: 1000 })
  assert.equal(await reg.run('peek', { on: 'false', who: 'ann', blob: '{"k":[1]}' }), null)
  assert.deepEqual(seen[1], { on: false, who: 'ann', blob: { k: [1] } })
  assert.equal(reg.taint.count, 1, 'peek does not mutate')
  assert.deepEqual(await reg.runLine('add 7'), { sum: 7 })
  assert.deepEqual(await reg.runLine('peek true "bob"'), null)
  assert.equal(reg.taint.count, 2)
  assert.deepEqual(tokenize('give  "special sauce" 3'), ['give', 'special sauce', '3'])

  await rejects(reg.run('nope'), 'dev.err.unknownCmd', { id: 'nope' })
  await rejects(reg.run('add', {}), 'dev.err.missingArg', { arg: 'a' })
  await rejects(reg.run('add', { a: 1.5 }), 'dev.err.badArg', { arg: 'a', why: t('dev.err.notInteger') })
  await rejects(reg.run('add', { a: 'x' }), 'dev.err.badArg', { arg: 'a', why: t('dev.err.notNumber') })
  await rejects(reg.run('add', { a: 1, c: 2 }), 'dev.err.extraArgs', { args: 'c' })
  await rejects(reg.run('peek', { on: 'maybe' }), 'dev.err.badArg', { arg: 'on', why: t('dev.err.notBoolean') })
  await rejects(reg.run('peek', { on: true, who: 'cy' }), 'dev.err.badArg', { arg: 'who', why: t('dev.err.notOneOf', { list: 'ann / bob' }) })
  await rejects(reg.runLine('add 1 2 3'), 'dev.err.extraArgs', { args: '3' })
  await rejects(reg.runLine('   '), 'dev.err.emptyLine')
  assert.equal(reg.taint.count, 2, 'failed commands taint nothing')
  assert.deepEqual(reg.describe().map((c) => c.id), ['add', 'peek'])
  assert.deepEqual(reg.describe()[1].args[1].options, ['ann', 'bob'])
})

// ----------------------------------------------------------------------------- content consistency

test('console.json: handlers and metadata line up one to one, enum refs exist, texts resolve', () => {
  const ids = Object.keys(CONSOLE.commands).sort()
  assert.deepEqual(ids, Object.keys(COMMANDS).sort(), 'every command has a handler and every handler is declared')
  for (const [id, m] of Object.entries(CONSOLE.commands)) {
    assert.ok(['live', 'rebuildWorld', 'reload'].includes(m.needs), `${id}.needs`)
    assert.equal(typeof m.mutates, 'boolean', `${id}.mutates`)
    assert.notEqual(t(m.titleKey), m.titleKey, `${id}: missing text ${m.titleKey}`)
    const names = new Set<string>()
    for (const a of m.args) {
      assert.ok(['string', 'number', 'integer', 'boolean', 'json'].includes(a.type), `${id}.${a.name}.type`)
      assert.ok(!names.has(a.name), `${id}: duplicate arg ${a.name}`)
      names.add(a.name)
      if (a.labelKey) assert.notEqual(t(a.labelKey), a.labelKey, `${id}.${a.name}: missing text ${a.labelKey}`)
      if (a.enumRef) assert.ok(ENUMS[a.enumRef]?.().length, `${id}.${a.name}: unknown enumRef ${a.enumRef}`)
    }
  }
  assert.ok(Object.values(CONSOLE.legacy).every((v) => v.length > 0))
  for (const k of ['eventBuffer', 'logLines', 'waitTimeoutMs', 'waitPollMs', 'dumpMaxChars'] as const) assert.ok(CONSOLE.limits[k] > 0, k)
})

test('every dev.* text key referenced by src/client/dev exists', () => {
  const files: string[] = []
  const walk = (rel: string) => {
    for (const name of readdirSync(new URL(rel, root))) {
      const p = `${rel}${name}`
      if (statSync(new URL(p, root)).isDirectory()) walk(`${p}/`)
      else if (name.endsWith('.ts')) files.push(p)
    }
  }
  walk('src/client/dev/')
  const missing: string[] = []
  for (const f of files) {
    for (const m of readFileSync(new URL(f, root), 'utf8').matchAll(/'(dev\.[A-Za-z0-9_.]+)'/g)) {
      if (!m[1].endsWith('.') && CONTENT.text[m[1]] === undefined) missing.push(`${f}: ${m[1]}`)
    }
  }
  assert.deepEqual(missing, [])
})

// ----------------------------------------------------------------------------- event log and waits

function fakeBus(): EventBus<GameEvents> & { received: string[] } {
  const received: string[] = []
  return { received, on: () => () => {}, once: () => () => {}, emit: (type) => { received.push(String(type)) } }
}

test('event log: records every emit, keeps delivery intact, cursors, ring overflow, dispose', () => {
  const bus = fakeBus()
  let now = 10
  const log = createEventLog(bus, 3, () => now++)
  bus.emit('money:changed', { money: 5, delta: 5 })
  bus.emit('party:changed', {})
  assert.deepEqual(bus.received, ['money:changed', 'party:changed'], 'the original emit still runs')
  assert.equal(log.cursor(), 2)
  const first = log.since(0)
  assert.deepEqual(first.events.map((e) => [e.seq, e.type, e.at]), [[1, 'money:changed', 10], [2, 'party:changed', 11]])
  assert.deepEqual(first.events[0].payload, { money: 5, delta: 5 })
  bus.emit('bag:changed', {})
  bus.emit('toast', { text: 'x' })
  bus.emit('toast', { text: 'y' })
  const later = log.since(2)
  assert.deepEqual(later.events.map((e) => e.seq), [3, 4, 5])
  assert.equal(later.dropped, 0)
  const stale = log.since(0)
  assert.equal(stale.dropped, 2, 'events 1 and 2 were pushed out of the 3-slot buffer')
  log.dispose()
  bus.emit('party:changed', {})
  assert.equal(log.cursor(), 5, 'dispose stops recording')
})

test('poll: resolves with the first truthy value, times out with the reason and a dump, surfaces errors', async () => {
  let n = 0
  assert.equal(await poll(() => (++n >= 3 ? 'ok' : null), 'three', { timeoutMs: 500, pollMs: 5 }), 'ok')
  await assert.rejects(poll(() => false, 'never', { timeoutMs: 500, pollMs: 5 }, { timeoutMs: 40 }, () => 'DUMP'), (e: Error) =>
    e.message.includes(t('dev.wait.timeout', { what: 'never', ms: 40 })) && e.message.endsWith('DUMP'))
  await assert.rejects(poll(() => { throw new Error('boom') }, 'x', { timeoutMs: 100, pollMs: 5 }), /boom/)
})

// ----------------------------------------------------------------------------- api over a fake host

function fakeHost() {
  const save = { money: 100, bag: { potion: 1 }, party: [{ speciesId: 'a', hp: 5 }], flags: {} as Record<string, unknown> }
  const events = fakeBus()
  const classes = new Set<string>()
  const g = globalThis as Record<string, unknown>
  g.document = { documentElement: { classList: { contains: (c: string) => classes.has(c) } }, querySelectorAll: () => [], querySelector: () => null }
  g.window = { __AP_LOG: [] as string[] }
  const host = {
    ctx: {
      save, events, clock: { minutes: 600.0004, label: () => '10:00', timeOfDay: 'day' },
      ui: { isBlocking: () => false }, net: { status: 'offline', online: 0, selfId: null },
    },
    overworld: {
      mapId: 'origin-home', free: true, battleActive: false, mode: 'walk', weather: 'clear', questNavigation: null,
      player: { x: 8.50004, y: 2.5, elev: 0, facing: 'down', map: 'origin-home' },
    },
    world: { seed: 1, maps: {}, towns: [], startMap: 'origin' },
    onboarding: { objectiveId: 'obj-1' },
    flyTo: async () => {},
    tick: () => {},
    rng: new RngHub(7),
    clock: createDevClock(),
  } as unknown as DevHost
  return { host, save, events, classes, g }
}

test('api v1: dump sections, digest, the "buy a potion" diff, expect.state, noErrors, wait.event', async () => {
  const { host, save, events, classes, g } = fakeHost()
  const log = createEventLog(events, 50)
  const api = createApiV1({ host, registry: createRegistry(host, {}, { meta: {} }), log, extras: () => ({ rng: { cursor: 0 } }) })

  const before = api.state.dump(['save', 'runtime'])
  assert.deepEqual(Object.keys(before), ['save', 'runtime'])
  const rt = before.runtime as Record<string, any>
  assert.deepEqual(rt.position, { x: 8.5, y: 2.5, elev: 0, facing: 'down' }, 'positions are rounded to 3 decimals')
  assert.equal(rt.map, 'origin-home')
  assert.equal(rt.battle.active, false)
  assert.deepEqual(rt.rng, { cursor: 0 }, 'extras are merged into the runtime section')
  assert.equal(api.state.digest(['save']), api.state.digest(['save']))

  save.money -= 30
  save.bag.potion += 1
  const after = api.state.dump(['save', 'runtime'])
  assert.deepEqual(api.state.diff(before, after).map((o) => o.path), ['/save/bag/potion', '/save/money'], 'only the money and the potion count changed')
  assert.notEqual(api.state.digest(['save']), digest(before.save))

  assert.equal(api.expect.state('/save/money', 70), true)
  assert.equal(api.expect.state('/save/bag/potion', { gte: 2 }), true)
  assert.equal(api.expect.state('/save/flags/x', { exists: false }), true)
  assert.throws(() => api.expect.state('/save/money', 71), /\/save\/money/)
  assert.throws(() => api.expect.state('/save/nope', 1), (e: Error) => e.message === t('dev.expect.missing', { path: '/save/nope' }))

  classes.add('ap-battle-on')
  events.emit('battle:start', { kind: 'boss' } as never)
  assert.deepEqual((api.state.dump(['runtime']).runtime as Record<string, any>).battle, { active: true, kind: 'boss', lastKind: null, lastResult: null })

  assert.equal(api.expect.noErrors(), true)
  ;(g.window as { __AP_LOG: string[] }).__AP_LOG.push('warn: fine', 'error: boom')
  assert.throws(() => api.expect.noErrors(), /boom/)
  assert.deepEqual(api.log(), ['warn: fine', 'error: boom'])

  const pending = api.wait.event('toast', { text: 'hi' }, { timeoutMs: 500 })
  events.emit('toast', { text: 'other' })
  setTimeout(() => events.emit('toast', { text: 'hi' }), 30)
  assert.equal(((await pending).payload as { text: string }).text, 'hi')
  assert.equal(await api.wait.free({ timeoutMs: 50 }), true)
  assert.equal(await api.wait.map('origin-home', { timeoutMs: 50 }), 'origin-home')
  await assert.rejects(api.wait.map('elsewhere', { timeoutMs: 30 }), /map elsewhere/)

  assert.deepEqual(api.events.since(0).events.map((e) => e.type), ['battle:start', 'toast', 'toast'])
  assert.equal(api.info().worldSeed, 1)
  assert.equal(api.info().rngSeed, 7)
  assert.equal(api.info().commit, 'unknown')
  assert.equal(api.info().contentHash.length, 14)
  delete g.document
  delete g.window
})
