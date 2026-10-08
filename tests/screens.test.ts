import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Creature, ItemDef, SaveData } from '../src/shared/types.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { createCreature, maxHp } from '../src/shared/creature.ts'
import { Rng } from '../src/shared/rng.ts'
import { UI_CONFIG, INPUT_BINDINGS } from '../src/client/ui/config.ts'
import { SCREENS, validateScreensConfig, type SettingsField } from '../src/client/ui/screens/config.ts'
import {
  addItem, applyMedicine, canSell, dexCounts, evolutionChain, expProgress, extraEnglishName, filterDex, ivStars, maxAffordable,
  medicineBlocker, moveCreature, pickInDirection, playTimeParts, releaseCreature, sellPrice, stepSetting, teachState,
} from '../src/client/ui/screens/logic.ts'

const here = dirname(fileURLToPath(import.meta.url))
const screensDir = join(here, '..', 'src', 'client', 'ui', 'screens')
// online.ts belongs to the multiplayer module and is checked by its own tests.
const sources = readdirSync(screensDir).filter((f) => f.endsWith('.ts') && f !== 'online.ts')
  .map((f) => ({ file: f, code: readFileSync(join(screensDir, f), 'utf8') }))

// ---------------------------------------------------------------------------
// Fixtures built only from CONTENT (no ids hardcoded)
// ---------------------------------------------------------------------------

function emptySave(): SaveData {
  return {
    version: 1, playerId: 'p', name: 'n', avatar: CONTENT.characters[0]?.id ?? '', createdAt: 0, playTimeSec: 0,
    money: 0, position: { map: '', x: 0, y: 0, facing: 'down' }, party: [], boxes: Array.from({ length: CONTENT.config.party.boxCount }, () => []),
    bag: {}, dexSeen: [], dexCaught: [], flags: {}, badges: [], defeatedTrainers: [], quests: {}, visitedTowns: [],
    settings: { ...CONTENT.config.defaultSettings }, explored: {},
  } as unknown as SaveData
}

const rng = new Rng(11)
const mk = (i = 0, level = 10): Creature => createCreature(CONTENT.speciesList[i % CONTENT.speciesList.length].id, level, { rng })
const itemOf = (pred: (it: ItemDef) => boolean): ItemDef | undefined => CONTENT.itemList.find(pred)

// ---------------------------------------------------------------------------
// Content wiring
// ---------------------------------------------------------------------------

test('content/screens.json validates against CONTENT and the ui-kit glyphs', () => {
  const errs = validateScreensConfig(SCREENS, CONTENT, UI_CONFIG)
  assert.deepEqual(errs, [], errs.join('\n'))
})

test('every literal screens.* text key used by the screens exists', () => {
  const missing: string[] = []
  for (const { file, code } of sources) {
    for (const m of code.matchAll(/'(screens\.[A-Za-z0-9_.]+)'/g)) {
      if (!(m[1] in CONTENT.text)) missing.push(`${file}: ${m[1]}`)
    }
  }
  assert.deepEqual(missing, [])
})

test('every templated screens.* text key resolves for all values it can take', () => {
  const keys: string[] = []
  for (const e of SCREENS.pause.entries) keys.push(`screens.pause.description.${e.action}`)
  for (const dir of ['left', 'up', 'down', 'right']) keys.push(`screens.newGame.direction.${dir}`, `screens.newGame.directionLabel.${dir}`)
  for (const mode of ['view', 'select', 'battleSwitch']) keys.push(`screens.party.title.${mode}`)
  for (const mode of ['field', 'battle']) keys.push(`screens.bag.title.${mode}`, `screens.bag.hint.${mode}`)
  for (const st of ['caught', 'seen', 'unseen']) keys.push(`screens.dex.caught.${st}`, `screens.dex.state.${st}`)
  for (const f of SCREENS.dex.filters) keys.push(`screens.dex.filterTitle.${f}`)
  for (const a of SCREENS.settings.keyHelp) keys.push(`screens.keys.${a}`)
  for (const cat of ['physical', 'special', 'status']) keys.push(`screens.move.category.${cat}`)
  for (const kind of new Set(SCREENS.quests.tabs.flatMap((tb) => tb.kinds))) keys.push(`screens.quests.kind.${kind}`)
  for (const st of ['offline', 'connecting', 'online', 'error']) keys.push(`screens.title.net.${st}`)
  for (const st of ['ok', 'known', 'unable']) keys.push(`screens.use.teach.${st}`)
  for (const f of SCREENS.settings.fields) {
    keys.push(`screens.settings.field.${f.key}`, `screens.settings.section.${f.section}`)
    if (f.kind === 'choice' && !f.format) for (const o of f.options ?? []) keys.push(`screens.settings.opt.${f.key}.${String(o)}`)
  }
  // Blockers returned by medicineBlocker are shown in full and as a short party-card note.
  const logic = sources.find((s) => s.file === 'logic.ts')!.code
  for (const m of logic.matchAll(/'(screens\.use\.[A-Za-z]+)'/g)) keys.push(m[1], `${m[1]}Short`)
  const missing = [...new Set(keys)].filter((k) => !(k in CONTENT.text))
  assert.deepEqual(missing, [])
})

test('key help covers only bound actions', () => {
  for (const a of SCREENS.settings.keyHelp) assert.ok(INPUT_BINDINGS.keyboard[a]?.length, `no keyboard binding for ${a}`)
})

test('species country / category labels (soft: unknown codes fall back to the raw value)', (t) => {
  const missing = new Set<string>()
  for (const sp of CONTENT.speciesList) {
    if (!(`screens.country.${sp.country}` in CONTENT.text)) missing.add(`screens.country.${sp.country}`)
    if (!(`screens.category.${sp.category}` in CONTENT.text)) missing.add(`screens.category.${sp.category}`)
  }
  if (missing.size) t.diagnostic(`labels missing (raw code shown): ${[...missing].join(', ')}`)
})

test('screens code carries no player-facing text, colours or entity ids', () => {
  const problems: string[] = []
  // Effect / key kinds are schema enums shared with item ids of the same name (e.g. an item whose effect kind is its id).
  const kinds = new Set<string>(CONTENT.itemList.flatMap((i) => [i.effect.kind, ...(i.effect.kind === 'key' ? [i.effect.key] : [])]))
  const ids = new Set([...CONTENT.speciesList.map((s) => s.id), ...CONTENT.itemList.map((i) => i.id), ...CONTENT.moveList.map((m) => m.id)].filter((id) => !kinds.has(id)))
  for (const { file, code } of sources) {
    const noComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    if (/[㐀-鿿＀-￯]/.test(noComments)) problems.push(`${file}: CJK text in code`)
    for (const m of noComments.matchAll(/['"`](#[0-9a-fA-F]{3,8})\b/g)) problems.push(`${file}: colour literal ${m[1]}`)
    for (const m of noComments.matchAll(/'([a-z0-9][a-z0-9_-]*)'/g)) if (ids.has(m[1]) && m[1].length > 3) problems.push(`${file}: entity id '${m[1]}'`)
  }
  assert.deepEqual(problems, [])
})

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

test('shop prices and affordability', () => {
  const it = itemOf((x) => x.price > 0 && x.category !== 'key')!
  assert.equal(sellPrice(it), Math.floor(it.price * CONTENT.config.economy.sellRatio))
  assert.ok(canSell(it))
  const key = itemOf((x) => x.category === 'key')
  if (key) assert.equal(canSell(key), false)
  assert.equal(maxAffordable(100, 350, 99), 3)
  assert.equal(maxAffordable(100, 50, 99), 0)
  assert.equal(maxAffordable(1, 10_000, SCREENS.shop.qtyMax), SCREENS.shop.qtyMax)
  const s = emptySave()
  addItem(s, it.id, 3)
  addItem(s, it.id, -2)
  assert.equal(s.bag[it.id], 1)
  addItem(s, it.id, -5)
  assert.equal(it.id in s.bag, false)
})

test('box moves keep a conscious party member and respect capacities', () => {
  const s = emptySave()
  s.party = [mk(0), mk(1)]
  s.boxes[0] = [mk(2)]
  // Swap party <-> box.
  const a = s.party[0]
  const b = s.boxes[0][0]
  assert.equal(moveCreature(s, { area: 'party', box: 0, index: 0 }, { area: 'box', box: 0, index: 0 }), null)
  assert.equal(s.party[0], b)
  assert.equal(s.boxes[0][0], a)
  // Deposit into an empty slot appends.
  assert.equal(moveCreature(s, { area: 'party', box: 0, index: 1 }, { area: 'box', box: 1, index: 0 }), null)
  assert.equal(s.party.length, 1)
  assert.equal(s.boxes[1].length, 1)
  // Last member cannot leave or be released.
  assert.equal(moveCreature(s, { area: 'party', box: 0, index: 0 }, { area: 'box', box: 2, index: 0 }), 'screens.box.err.lastMember')
  assert.equal(releaseCreature(s, { area: 'party', box: 0, index: 0 }), 'screens.box.err.lastMember')
  // Only-fainted party is refused.
  s.boxes[3] = [mk(3)]
  s.boxes[3][0].hp = 0
  assert.equal(moveCreature(s, { area: 'party', box: 0, index: 0 }, { area: 'box', box: 3, index: 0 }), 'screens.box.err.needConscious')
  assert.equal(s.party.length, 1, 'refused moves leave state unchanged')
  // Full party.
  s.party = Array.from({ length: CONTENT.config.party.maxParty }, (_, i) => mk(i))
  assert.equal(moveCreature(s, { area: 'box', box: 0, index: 0 }, { area: 'party', box: 0, index: s.party.length }), 'screens.box.err.partyFull')
  assert.equal(releaseCreature(s, { area: 'box', box: 0, index: 0 }), null)
  assert.equal(releaseCreature(s, { area: 'box', box: 9, index: 0 }), 'screens.box.err.empty')
})

test('dex filters never reveal unseen species', () => {
  const s = emptySave()
  const list = CONTENT.speciesList
  s.dexSeen = list.slice(0, 2).map((x) => x.id)
  s.dexCaught = [list[0].id]
  assert.equal(filterDex(list, {}, s, SCREENS.dex.countries).length, list.length)
  const type = list[0].types[0]
  const byType = filterDex(list, { type }, s, SCREENS.dex.countries)
  assert.ok(byType.every((sp) => s.dexSeen.includes(sp.id) && sp.types.includes(type)))
  assert.deepEqual(filterDex(list, { caught: 'caught' }, s, SCREENS.dex.countries).map((x) => x.id), [list[0].id])
  assert.deepEqual(filterDex(list, { query: list[1].nameZh }, s, SCREENS.dex.countries).map((x) => x.id), [list[1].id])
  const counts = dexCounts(s)
  assert.deepEqual(counts, { seen: 2, caught: 1, total: list.length })
  for (const g of SCREENS.dex.countries) {
    const r = filterDex(list, { country: g.id }, { ...s, dexSeen: list.map((x) => x.id) }, SCREENS.dex.countries)
    assert.ok(r.every((sp) => (!g.codes || g.codes.includes(sp.country)) && !(g.exclude ?? []).includes(sp.country)))
  }
})

test('medicine blockers and effects', () => {
  const heal = itemOf((x) => x.effect.kind === 'heal')
  const revive = itemOf((x) => x.effect.kind === 'revive')
  const c = mk(0, 20)
  const max = maxHp(c)
  if (heal) {
    assert.equal(medicineBlocker(c, heal), 'screens.use.hpFull')
    c.hp = 1
    assert.equal(medicineBlocker(c, heal), null)
    const r = applyMedicine(c, heal)
    assert.ok(r.hp > 0 && c.hp <= max)
    c.hp = 0
    assert.equal(medicineBlocker(c, heal), 'screens.use.fainted')
  }
  if (revive) {
    c.hp = max
    assert.equal(medicineBlocker(c, revive), 'screens.use.notFainted')
    c.hp = 0
    assert.equal(medicineBlocker(c, revive), null)
    const r = applyMedicine(c, revive)
    assert.ok(r.revived && c.hp >= 1)
  }
  const chip = itemOf((x) => x.effect.kind === 'chip')
  if (chip && chip.effect.kind === 'chip') {
    const st = teachState(c, chip.effect.move)
    assert.equal(medicineBlocker(c, chip), st === 'ok' ? null : st === 'known' ? 'screens.use.known' : 'screens.use.cannotLearn')
  }
})

test('settings stepping wraps choices and clamps sliders', () => {
  for (const f of SCREENS.settings.fields as SettingsField[]) {
    const d = (CONTENT.config.defaultSettings as unknown as Record<string, unknown>)[f.key]
    if (f.kind === 'toggle') assert.equal(stepSetting(f, d, 1), !d)
    if (f.kind === 'choice') {
      const opts = f.options!
      let v: unknown = d
      for (let i = 0; i < opts.length; i++) v = stepSetting(f, v, 1)
      assert.equal(v, d, `${f.key} wraps`)
    }
    if (f.kind === 'slider') {
      assert.equal(stepSetting(f, f.max, 1), f.max)
      assert.equal(stepSetting(f, f.min, -1), f.min)
    }
  }
})

test('map direction picking, IV stars, play time, exp, evolution chains', () => {
  const pts = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 1 }, { id: 'c', x: -8, y: 0 }, { id: 'd', x: 0, y: -9 }]
  assert.equal(pickInDirection(pts, pts[0], 'right')?.id, 'b')
  assert.equal(pickInDirection(pts, pts[0], 'left')?.id, 'c')
  assert.equal(pickInDirection(pts, pts[0], 'up')?.id, 'd')
  assert.equal(pickInDirection(pts, pts[0], 'down'), null)
  assert.equal(ivStars(0, 31, 5), 0)
  assert.equal(ivStars(31, 31, 5), 5)
  assert.deepEqual(playTimeParts(3 * 3600 + 5 * 60 + 59), { h: 3, m: '05' })
  const c = mk(0, 10)
  const xp = expProgress(c)
  assert.ok(xp.need > 0 && xp.into >= 0 && xp.into <= xp.need && xp.ratio >= 0 && xp.ratio <= 1)
  for (const sp of CONTENT.speciesList) {
    const chain = evolutionChain(sp.id)
    assert.ok(chain.some((x) => x.id === sp.id), `${sp.id} in its own chain`)
    assert.equal(new Set(chain.map((x) => x.id)).size, chain.length)
  }
})

test('model names: the English line only appears when it differs, and no name outgrows the layouts audited at 1280x720 / 390x844', () => {
  let same = 0
  for (const sp of CONTENT.speciesList) {
    if (sp.nameEn === sp.nameZh) { same++; assert.equal(extraEnglishName(sp), null, sp.id) }
    else assert.equal(extraEnglishName(sp), sp.nameEn, sp.id)
    // The box party column, starter cards and battle HUD were checked with names up to this many characters (output/20/names).
    assert.ok(sp.nameZh.length <= 26, `${sp.id}: "${sp.nameZh}" is longer than the audited layouts allow`)
    assert.ok(sp.nameEn.length <= 64, `${sp.id}: "${sp.nameEn}"`)
  }
  assert.ok(same > 0)
})
