import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, t, timeOfDayAt } from '../src/shared/content/index.ts'
import type { GameMap, SaveData, World } from '../src/shared/types.ts'
import type { InputAction } from '../src/client/contracts.ts'
import { createCreature } from '../src/shared/creature.ts'
import { Rng } from '../src/shared/rng.ts'
import { createEventBus } from '../src/client/core/events.ts'
import { createClock, formatClock } from '../src/client/core/clock.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import type { StorageLike } from '../src/client/core/save.ts'
import { decodeSaveCode, encodeSaveCode, fromBase64Url, toBase64Url } from '../src/client/core/save-codec.ts'
import { CRIES, MIX, SFX, SONGS } from '../src/client/core/audio-data.ts'
import { compileSong, getSong, midiToFreq, nextBar, noteToMidi, parseChord } from '../src/client/core/audio-sequencer.ts'
import { cryRecipe } from '../src/client/core/audio-cry.ts'
import { INPUT_CONFIG, boundActions } from '../src/client/core/input-config.ts'
import { computeUiScale } from '../src/client/core/settings.ts'

/** config.defaultSettings with the one-time settings migrations applied (what a fresh save holds); touchOnly ones need a phone. */
function expectedDefaults(cfg = CONTENT.config) {
  const ms = (cfg.settingsMigrations ?? []).filter((m) => !m.touchOnly)
  return { ...cfg.defaultSettings, ...Object.assign({}, ...ms.map((m) => m.set)), migrations: ms.map((m) => m.id) }
}
import { PH } from '../src/client/core/placeholders-data.ts'
import { drawPlaceholder, TUFT_SUFFIX } from '../src/client/core/placeholders.ts'
import { alphaAt } from '../src/client/core/pixel.ts'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v) }, removeItem: (k) => { map.delete(k) } }
}

function stubWorld(): World {
  const map = (id: string, w: number, h: number, spawn: { x: number; y: number }): GameMap => ({
    id, nameZh: id, kind: 'overworld', width: w, height: h,
    terrain: new Uint8Array(w * h), elevation: new Uint8Array(w * h), region: new Uint8Array(w * h), regions: [],
    props: [], warps: [], npcs: [], signs: [], items: [], lights: [], spawn: { ...spawn, facing: 'up' }, outdoor: true, music: '',
  })
  return {
    seed: 1,
    maps: { first: map('first', 8, 8, { x: 1, y: 1 }), start: map('start', 20, 20, { x: 5, y: 7 }) },
    trainers: {}, towns: [{ id: 'town-a', nameZh: 'A', map: 'start', x: 1, y: 1, description: '' }],
    quests: [{ id: 'q1', nameZh: 'Q', kind: 'main', stages: [{ text: 'a' }, { text: 'b' }] }],
    badges: [{ id: 'b1', nameZh: 'B', type: CONTENT.types[0].id, leader: 'x', town: 'town-a' }],
    startMap: 'start',
  }
}

function manager(storage = memoryStorage()) {
  let n = 0
  return createSaveManager({ world: stubWorld(), storage, now: () => 1_700_000_000_000, newId: () => `id-${++n}` })
}

const anySpecies = () => CONTENT.speciesList[0].id
const makeCreature = (seed: number, level = 5) => createCreature(anySpecies(), level, { rng: new Rng(seed) })

// ---------------------------------------------------------------------------
// event bus
// ---------------------------------------------------------------------------

test('event bus: on / once / off / isolation', () => {
  const bus = createEventBus<{ a: number; b: string }>()
  const got: number[] = []
  const off = bus.on('a', (v) => got.push(v))
  bus.once('a', (v) => got.push(v * 10))
  bus.emit('a', 1)
  bus.emit('a', 2)
  off()
  bus.emit('a', 3)
  assert.deepEqual(got, [1, 10, 2])

  const order: string[] = []
  const origErr = console.error
  const g = globalThis as { reportError?: unknown }
  const origReport = g.reportError
  g.reportError = () => order.push('reported')
  try {
    bus.on('b', () => { throw new Error('boom') })
    bus.on('b', (s) => { order.push(s); bus.on('b', () => order.push('late')) })
    bus.emit('b', 'x')
  } finally {
    console.error = origErr
    g.reportError = origReport
  }
  assert.deepEqual(order, ['reported', 'x'], 'throwing handler does not stop others; handlers added mid-emit wait')
})

// ---------------------------------------------------------------------------
// clock
// ---------------------------------------------------------------------------

test('clock advances by config.time.dayRealSeconds and mirrors into the save', () => {
  const save = manager().newGame({ name: 'A', avatar: '' })
  const clock = createClock(save)
  assert.equal(clock.minutes, CONTENT.config.time.startMinutes)
  clock.update(CONTENT.config.time.dayRealSeconds / 24) // one in-game hour
  assert.ok(Math.abs(clock.minutes - (CONTENT.config.time.startMinutes + 60)) < 1e-6)
  assert.equal(save.clockMinutes, clock.minutes)
  clock.minutes = 23 * 60 + 59 + 1440 * 3
  assert.equal(clock.label(), '23:59')
  assert.equal(clock.minutesOfDay, 23 * 60 + 59)
  assert.equal(clock.timeOfDay, timeOfDayAt(clock.minutes))
  assert.equal(formatClock(65), '01:05')
  clock.update(-5)
  assert.equal(clock.minutes, 23 * 60 + 59 + 1440 * 3, 'negative dt ignored')
})

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

test('newGame builds a complete save from config', () => {
  const save = manager().newGame({ name: '  小智\u0007  ', avatar: 'not-a-character' })
  const cfg = CONTENT.config
  assert.equal(save.version, cfg.save.version)
  assert.equal(save.name, '小智')
  assert.ok(CONTENT.characterById[save.avatar]?.playable)
  assert.equal(save.money, cfg.economy.startMoney)
  assert.deepEqual(save.settings, expectedDefaults(cfg))
  assert.equal(save.boxes.length, cfg.party.boxCount)
  assert.deepEqual(save.party, [])
  assert.equal(save.clockMinutes, cfg.time.startMinutes)
  assert.deepEqual(save.position, { map: 'start', x: 5, y: 7, facing: 'up' })
  assert.deepEqual(save.respawn, save.position)
  for (const [id, qty] of Object.entries(save.bag)) {
    assert.ok(CONTENT.items[id], `start item ${id} exists`)
    assert.equal(qty, cfg.economy.startItems[id])
  }
})

test('newGame falls back to the first map when the start map is missing', () => {
  const w = stubWorld()
  w.startMap = 'missing'
  const save = createSaveManager({ world: w, storage: memoryStorage() }).newGame({ name: 'x', avatar: '' })
  assert.equal(save.position.map, 'first')
})

test('save write / load round-trip through storage', () => {
  const storage = memoryStorage()
  const saves = manager(storage)
  const save = saves.newGame({ name: '测试', avatar: '' })
  save.party.push(makeCreature(1), makeCreature(2))
  save.dexSeen.push(anySpecies())
  save.dexCaught.push(anySpecies())
  save.flags = { a: true, b: 2, c: 'x' }
  assert.equal(saves.hasSave(), false)
  assert.equal(saves.write(save), true)
  assert.ok(storage.map.has(`${CONTENT.config.save.storagePrefix}0`))
  assert.equal(saves.hasSave(), true)
  assert.deepEqual(saves.load(), save)
  assert.equal(saves.load(3), null)
  storage.map.set(`${CONTENT.config.save.storagePrefix}1`, '{not json')
  assert.equal(saves.load(1), null)
})

test('write reports storage failures', () => {
  const saves = createSaveManager({ world: stubWorld(), storage: { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} } })
  assert.equal(saves.write(saves.newGame({ name: 'a', avatar: '' })), false)
})

test('export / import codes', () => {
  const saves = manager()
  const save = saves.newGame({ name: '训练家🌟', avatar: '' })
  save.party.push(makeCreature(7, 12))
  const code = saves.exportCode(save)
  assert.match(code, /^\d+\.[A-Za-z0-9_-]+\.[0-9a-f]{8}$/)
  assert.deepEqual(saves.importCode(code), save)
  assert.deepEqual(saves.importCode(`  ${code.slice(0, 20)}\n${code.slice(20)} `), save, 'whitespace tolerated')
  const [v, payload, sum] = code.split('.')
  const flipped = payload.slice(0, -2) + (payload.at(-2) === 'A' ? 'B' : 'A') + payload.at(-1)
  assert.equal(saves.importCode(`${v}.${flipped}.${sum}`), null, 'checksum mismatch rejected')
  assert.equal(saves.importCode('garbage'), null)
  assert.equal(saves.importCode(''), null)
  assert.equal(saves.importCode(encodeSaveCode({ hello: 1 }, 1)), null, 'non-save payload rejected')
})

test('base64url codec handles unicode and rejects junk', () => {
  const s = '智灵口袋 · Agent Pocket ✨ \u0000'
  assert.equal(fromBase64Url(toBase64Url(s)), s)
  assert.equal(fromBase64Url('***'), null)
  assert.equal(decodeSaveCode('1.abc'), null)
})

test('sanitize repairs hostile data', () => {
  const saves = manager()
  const good = saves.newGame({ name: 'ok', avatar: '' })
  const species = anySpecies()
  const party = Array.from({ length: CONTENT.config.party.maxParty + 2 }, (_, i) => makeCreature(100 + i))
  const raw: Record<string, unknown> = {
    ...good,
    name: 'x'.repeat(200),
    money: -50,
    playTimeSec: 'lots',
    bag: { 'no-such-item': 3, ...(CONTENT.itemList[0] ? { [CONTENT.itemList[0].id]: 2.7 } : {}) },
    party: [...party, { uid: 'bad', speciesId: 'nope' }, party[0]],
    boxes: 'nope',
    dexSeen: ['nope', species, species],
    dexCaught: [species],
    badges: ['b1', 'b1', 'fake'],
    visitedTowns: ['town-a', 7],
    quests: { q1: { stage: 99, done: 'yes' }, ghost: { stage: 1, done: true } },
    trackedQuest: 'ghost',
    position: { map: 'start', x: 999, y: 3, facing: 'sideways' },
    respawn: { map: 'nowhere', x: 1, y: 1, facing: 'down' },
    flags: { ok: 1, bad: { nested: true }, nan: Number.NaN },
    settings: { bgmVolume: 7, sfxVolume: -1, quality: 'potato', textSpeed: 'fast', touchControls: 'on', pixelScale: 0, migrations: (CONTENT.config.settingsMigrations ?? []).map((m) => m.id) },
    stats: { battlesWon: -3, caught: 2.5 },
    clockMinutes: -1,
    repelSteps: 'x',
  }
  const s = saves.sanitize(raw)!
  assert.ok(s)
  assert.equal([...s.name].length, CONTENT.config.net.nameMaxLen)
  assert.equal(s.money, 0)
  assert.equal(s.playTimeSec, 0)
  assert.equal(s.bag['no-such-item'], undefined)
  if (CONTENT.itemList[0]) assert.equal(s.bag[CONTENT.itemList[0].id], 2)
  assert.equal(s.party.length, CONTENT.config.party.maxParty)
  const boxed = s.boxes.flat()
  assert.equal(boxed.length, 2, 'party overflow moved to boxes')
  assert.equal(new Set([...s.party, ...boxed].map((c) => c.uid)).size, s.party.length + boxed.length, 'duplicate uids dropped')
  assert.equal(s.boxes.length, CONTENT.config.party.boxCount)
  assert.deepEqual(s.dexSeen, [species])
  assert.deepEqual(s.badges, ['b1'])
  assert.deepEqual(s.visitedTowns, ['town-a'])
  assert.deepEqual(s.quests, { q1: { stage: 1, done: false } })
  assert.equal(s.trackedQuest, undefined)
  assert.deepEqual(s.position, { map: 'start', x: 5, y: 7, facing: 'up' }, 'out-of-bounds position reset to spawn')
  assert.deepEqual(s.respawn, s.position, 'unknown respawn map falls back to position')
  assert.deepEqual(s.flags, { ok: 1 })
  assert.equal(s.settings.bgmVolume, 1)
  assert.equal(s.settings.sfxVolume, 0)
  assert.equal(s.settings.quality, CONTENT.config.defaultSettings.quality)
  assert.equal(s.settings.textSpeed, 'fast')
  assert.equal(s.settings.touchControls, 'on')
  assert.equal(s.settings.pixelScale, CONTENT.config.defaultSettings.pixelScale)
  assert.deepEqual(s.stats, { battlesWon: 0, caught: 2, steps: 0, pvpWins: 0, pvpLosses: 0, trades: 0, shiniesFound: 0 })
  assert.equal(s.clockMinutes, CONTENT.config.time.startMinutes)
  assert.equal(s.repelSteps, 0)

  assert.equal(saves.sanitize(null), null)
  assert.equal(saves.sanitize([1, 2]), null)
  assert.equal(saves.sanitize({ hello: 'world' }), null)
  assert.deepEqual(saves.sanitize(JSON.parse(JSON.stringify(good))), good, 'valid saves pass unchanged')
})

test('defaultSettings is a fresh copy of config.defaultSettings', () => {
  const saves = manager()
  const a = saves.defaultSettings()
  assert.deepEqual(a, expectedDefaults())
  a.sfxVolume = -5
  assert.notEqual(saves.defaultSettings().sfxVolume, -5)
})

// ---------------------------------------------------------------------------
// audio data
// ---------------------------------------------------------------------------

test('every BGM id has a compilable, non-empty procedural song', () => {
  assert.ok(SONGS.songs[SONGS.fallback], 'fallback song exists')
  for (const b of CONTENT.audio.bgm) {
    const def = SONGS.songs[b.id]
    assert.ok(def, `songs.json has "${b.id}"`)
    const song = compileSong(b.id, def)
    const notes = song.tracks.reduce((n, tr) => n + tr.bars.reduce((m, bar) => m + bar.notes.length + bar.drums.length, 0), 0)
    assert.ok(notes > 0, `${b.id} has notes`)
    assert.ok(song.tracks.some((tr) => tr.def.kind === 'melody'), `${b.id} has a melody`)
    assert.equal(nextBar(song, song.length - 1), song.loopFrom, `${b.id} loops`)
  }
  assert.equal(getSong('definitely-not-a-song')?.id, SONGS.fallback)
})

test('every SFX id has a synth recipe', () => {
  assert.ok(SFX.sfx[SFX.fallback])
  for (const id of CONTENT.audio.sfx) {
    const def = SFX.sfx[id]
    assert.ok(def && def.layers.length > 0, `sfx.json has "${id}"`)
    for (const l of def.layers) {
      assert.ok(l.dur > 0 && l.gain > 0, `${id}: positive dur/gain`)
      for (const n of l.notes ?? []) if (typeof n === 'string') assert.notEqual(noteToMidi(n), null, `${id}: note ${n}`)
      if (l.note) assert.notEqual(noteToMidi(l.note), null)
    }
  }
})

test('sequencer theory helpers', () => {
  assert.equal(noteToMidi('C4'), 60)
  assert.equal(noteToMidi('F#5'), 78)
  assert.equal(noteToMidi('Bb2'), 46)
  assert.equal(noteToMidi('H2'), null)
  assert.ok(Math.abs(midiToFreq(69) - 440) < 1e-9)
  const major = SONGS.scales.major
  assert.deepEqual(parseChord('1', major, SONGS.chordQualities), [0, 4, 7])
  assert.deepEqual(parseChord('5:d4', major, SONGS.chordQualities), [7, 11, 14, 17])
  assert.deepEqual(parseChord('b7:maj', major, SONGS.chordQualities), [10, 14, 17])
  assert.throws(() => parseChord('1:nope', major, SONGS.chordQualities))
  const bad = { ...SONGS.songs[SONGS.fallback], tracks: [{ inst: Object.keys(SONGS.instruments)[0], kind: 'melody' as const, bars: ['1 2 3'] }] }
  assert.throws(() => compileSong('bad', bad), /do not divide/)
})

test('cries are deterministic per species and differ between species', () => {
  const ids = CONTENT.speciesList.map((s) => s.id)
  const a = cryRecipe(ids[0])
  assert.deepEqual(cryRecipe(ids[0]), a)
  assert.ok(a.layers.length > 0 && a.gain === CRIES.gain)
  if (ids.length > 1) assert.notDeepEqual(cryRecipe(ids[1]), a)
  assert.ok(cryRecipe('unknown-species').layers.length > 0, 'unknown ids still get a cry')
  assert.ok(MIX.crossfadeMs > 0 && MIX.scheduler.lookaheadSec > 0)
})

// ---------------------------------------------------------------------------
// input / settings
// ---------------------------------------------------------------------------

test('input.json binds every action and touch labels resolve', () => {
  const actions: InputAction[] = ['up', 'down', 'left', 'right', 'confirm', 'cancel', 'menu', 'run', 'map', 'chat', 'minimap', 'bike', 'quickSave', 'debug']
  const touchOnly: InputAction[] = ['bag']
  for (const a of actions) assert.ok(INPUT_CONFIG.keyboard[a]?.length, `keyboard binding for ${a}`)
  for (const a of touchOnly) assert.ok(INPUT_CONFIG.touch.buttons.some((b) => b.action === a) && !INPUT_CONFIG.keyboard[a], `${a} is a touch button without a key`)
  assert.deepEqual(new Set(boundActions()), new Set([...actions, ...touchOnly]))
  assert.ok(INPUT_CONFIG.repeat.delayMs > 0 && INPUT_CONFIG.repeat.intervalMs > 0)
  for (const b of INPUT_CONFIG.touch.buttons) assert.notEqual(t(b.label), b.label, `text ${b.label}`)
  assert.notEqual(t('audio.save.defaultName'), 'audio.save.defaultName')
  const d = INPUT_CONFIG.display
  assert.equal(computeUiScale(d.referenceWidth, d.referenceHeight), 1)
  assert.equal(computeUiScale(d.referenceWidth * 2, d.referenceHeight * 2), Math.min(d.maxScale, 2))
  assert.equal(computeUiScale(10, 10), d.minScale)
})

// ---------------------------------------------------------------------------
// placeholders (pure pixel buffers)
// ---------------------------------------------------------------------------

test('creature placeholders are deterministic and sized from config', () => {
  const size = CONTENT.config.sprites.creatureSize
  for (const s of CONTENT.speciesList) {
    const a = drawPlaceholder('creature', s.id)
    assert.equal(a.w, size)
    assert.equal(a.h, size)
    assert.deepEqual(a.data, drawPlaceholder('creature', s.id).data)
    assert.ok(a.data.some((v, i) => i % 4 === 3 && v > 0), `${s.id} not empty`)
  }
})

test('character sheets follow the sprite layout', () => {
  const { sheetCell, sheetFrames, sheetRows } = CONTENT.config.sprites
  const rows = Math.max(...Object.values(sheetRows)) + 1
  for (const ch of CONTENT.characters) {
    const img = drawPlaceholder('character', ch.id)
    assert.equal(img.w, sheetCell * sheetFrames)
    assert.equal(img.h, sheetCell * rows)
    for (let r = 0; r < rows; r++) for (let f = 0; f < sheetFrames; f++) {
      let any = false
      for (let y = 0; y < sheetCell && !any; y++) for (let x = 0; x < sheetCell && !any; x++) any = alphaAt(img, f * sheetCell + x, r * sheetCell + y) > 0
      assert.ok(any, `${ch.id} cell r${r} f${f} drawn`)
    }
  }
})

test('terrain tiles cover every terrain key, cliffs and tufts', () => {
  const n = PH.terrain.size
  const keys = [...CONTENT.terrain.map((x) => x.key), ...CONTENT.biomes.map((b) => b.cliff)]
  for (const key of keys) {
    const img = drawPlaceholder('terrain', key)
    assert.equal(img.w, n)
    for (let i = 3; i < img.data.length; i += 4) assert.equal(img.data[i], 255, `${key} opaque`)
  }
  for (const tg of CONTENT.terrain.filter((x) => x.tallGrass)) {
    const img = drawPlaceholder('terrain', tg.key + TUFT_SUFFIX)
    const alpha = [...img.data].filter((_, i) => i % 4 === 3)
    assert.ok(alpha.some((a) => a === 0) && alpha.some((a) => a > 0), `${tg.key} tuft is a transparent overlay`)
  }
  assert.equal(drawPlaceholder('terrain', 'brand-new-key').w, n, 'unknown keys still render')
})

test('item icons render for every item; stamps use known palette chars', () => {
  for (const it of CONTENT.itemList) {
    const img = drawPlaceholder('item', it.id)
    assert.equal(img.w, PH.items.size)
    assert.ok(img.data.some((v, i) => i % 4 === 3 && v > 0), `${it.id} icon`)
  }
  const known = new Set(['.', ' ', 'X', 'x', 'h', ...Object.keys(PH.stampPalette)])
  for (const [id, st] of Object.entries(PH.stamps)) for (const row of st.rows) for (const ch of row) assert.ok(known.has(ch), `stamp ${id} char "${ch}"`)
  const referenced = [
    ...Object.values(PH.items.categoryIcons), ...Object.values(PH.items.keyIcons), ...Object.values(PH.items.effectIcons),
    ...Object.values(PH.creature.typeMotifs).flat().map((m) => m.stamp), ...PH.creature.stageMotifs.flat().map((m) => m.stamp),
    ...Object.values(PH.creature.rarityMotifs).flat().map((m) => m.stamp), ...PH.creature.defaultMotifs.map((m) => m.stamp),
  ].filter((x): x is string => !!x)
  for (const id of referenced) assert.ok(PH.stamps[id], `stamp "${id}" defined`)
})

test('save data shape stays JSON-safe', () => {
  const save: SaveData = manager().newGame({ name: 'j', avatar: '' })
  assert.deepEqual(JSON.parse(JSON.stringify(save)), save)
})

test('save manager defaults to the generated world spawn', () => {
  const save = createSaveManager({ storage: memoryStorage() }).newGame({ name: 'w', avatar: '' })
  assert.ok(save.position.map, 'spawn map resolved from buildWorld()')
  assert.deepEqual(save.respawn, save.position)
})
