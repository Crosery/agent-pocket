// Save v1 -> v2 (natures and origins): three real v1 saves lose nothing, the one-time gift is handed out once,
// migration is idempotent and a current save passes through untouched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CONTENT, t } from '../src/shared/content/index.ts'
import type { Creature, SaveData, ScriptStep, World } from '../src/shared/types.ts'
import type { GameContext, GameEvents } from '../src/client/contracts.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { MIGRATIONS, STORY_CONTENT, applyStory, storyProblems, validateStoryMigrations, type MigrationsFile, type StoryContent } from '../src/shared/world/story.ts'
import { createEventBus } from '../src/client/core/events.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { inferContentRev, migrateSave } from '../src/client/core/save-migrate.ts'
import {
  acknowledgeContentUpdate,
  contentUpdateSummaryText,
  emitSaveLoaded,
  hasPendingContentUpdate,
  pendingContentRevisions,
  reconcileSave,
} from '../src/client/core/save-reconcile.ts'
import { encodeSaveCode } from '../src/client/core/save-codec.ts'
import { attentionCounts } from '../src/client/attention/logic.ts'
import { applyQuest } from '../src/client/world/save-ops.ts'
import { createTriggers } from '../src/client/world/triggers.ts'

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
    assert.equal(migrated.version, 3, n)
    const out = saves.sanitize(migrated)!
    assert.equal(out.version, 3)
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
  assert.equal(v2.version, 3)
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
  assert.equal(loaded.version, 3)
  assert.ok(loaded.party.every((c) => c.nature === Q.legacyNature && c.origin?.kind === 'legacy'))
  assert.equal(loaded.bag['persona-card'], 2)
  const imported = mgr.importCode(encodeSaveCode(raw as unknown as SaveData, 1))!
  assert.equal(imported.bag['persona-card'], 2)
  assert.ok(imported.party.every((c) => c.nature === Q.legacyNature))
})

// Save v2 -> v3 (the new prologue): main stages from 1 shift by 7; a save that already has a starter keeps every gate
// open and gets the DeepSeek terminal as an optional quest; a save still in the prologue keeps its stage and its gates.
const v2fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/save-v2-${name}.json`, import.meta.url), 'utf8'))
const shiftedStage = (raw: unknown) => ((migrateSave(raw) as SaveData).quests.main as { stage: number } | undefined)?.stage

test('v2 -> v3: a save with a starter opens the gates and gets the optional DeepSeek quest', () => {
  for (const n of NAMES) {
    const raw = v2fixture(n)
    assert.equal(raw.version, 2, n)
    const out = migrateSave(raw) as SaveData
    assert.equal(out.version, 3, n)
    assert.equal(out.flags['ds:gateOpen'], true, n)
    assert.equal(out.flags['ds:legacy'], true, n)
    assert.deepEqual(out.position, (raw as unknown as SaveData).position, `${n}: the player stays where they stood`)
  }
})

test('v2 -> v3: main quest stages from 1 shift by 7, stage 0 and the done flag stay', () => {
  const at = (stage: number, done = false) => ({ ...v2fixture('starter'), quests: { main: { stage, done } } })
  assert.equal(shiftedStage(at(0)), 0)
  assert.equal(shiftedStage(at(1)), 8)
  assert.equal(shiftedStage(at(4)), 11)
  const end = migrateSave(at(12, true)) as SaveData
  assert.deepEqual(end.quests.main, { stage: 19, done: true })
  assert.equal(world.quests.find((q) => q.id === 'main')!.stages.length, 20, 'the shifted chain still has 20 stages (0-19)')
})

test('v2 -> v3: a save still in the prologue (no starter) keeps its gates shut', () => {
  const raw = { ...v2fixture('starter'), flags: {} }
  const out = migrateSave(raw) as SaveData
  assert.equal(out.flags['ds:gateOpen'], undefined)
  assert.equal(out.flags['ds:legacy'], undefined)
})

test('v2 -> v3 is idempotent', () => {
  const once = migrateSave(v2fixture('3badges'))
  assert.equal(migrateSave(once), once)
  assert.deepEqual(saves.sanitize(migrateSave(saves.sanitize(once))), saves.sanitize(once))
})

// ---------------------------------------------------------------------------
// Content revisions, load-time reconciliation, quest stage guard & triggers (#87)
// Note: save-0.1.x-3badges, save-rc5-midgame, save-rc12-champion, save-rc16-prologue-done
// are synthetic fixtures constructed to match the exact schema and content state of tags
// v0.1.1-rc.3, v0.2.0-rc.5, v0.2.0-rc.12, and v0.2.0-rc.16.
// ---------------------------------------------------------------------------
const rawFixture = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${file}.json`, import.meta.url), 'utf8'))

function loadThroughManager(raw: unknown): SaveData {
  const store = memory()
  const mgr = createSaveManager({ world, storage: store, now: () => 1_700_000_000_000, newId: () => '00000000-0000-4000-8000-000000000099' })
  store.setItem(`${CONTENT.config.save.storagePrefix}0`, JSON.stringify(raw))
  const loaded = mgr.load(0)
  assert.ok(loaded, 'save loaded cleanly')
  return loaded
}

test('historical synthetic fixtures (0.1.x, rc.5, rc.12, rc.16) infer their starting contentRev and migrate sequentially', () => {
  const targetVer = CONTENT.config.save.version
  const targetRev = MIGRATIONS.contentRev
  const f01x = rawFixture('save-0.1.x-3badges')
  const frc5 = rawFixture('save-rc5-midgame')
  const frc12 = rawFixture('save-rc12-champion')
  const frc16 = rawFixture('save-rc16-prologue-done')

  assert.equal(inferContentRev(f01x, targetVer, targetRev), 0, '0.1.x (v1, no anchors) starts at rev 0')
  assert.equal(inferContentRev(frc5, targetVer, targetRev), 1, '0.2.0-rc.5 (v1, with anchors/events) starts at rev 1')
  assert.equal(inferContentRev(frc12, targetVer, targetRev), 2, '0.2.0-rc.12 (v2, natures) starts at rev 2')
  assert.equal(inferContentRev(frc16, targetVer, targetRev), 3, '0.2.0-rc.16 (v3, no contentRev) starts at rev 3')

  // 0.1.x -> current: nature/origin added, persona-card x2 granted once, main stage 5 -> 12, sq-dex reconciled 0 -> 1, badge flags synced
  const s01x = loadThroughManager(f01x)
  assert.equal(s01x.version, targetVer)
  assert.equal(s01x.contentRev, targetRev)
  assert.equal(s01x.bag['persona-card'], 2)
  assert.equal(s01x.flags['ds:gateOpen'], true)
  assert.equal(s01x.flags['ds:legacy'], true)
  assert.deepEqual(s01x.quests.main, { stage: 12, done: false })
  assert.deepEqual(s01x.quests['ds-legacy'], { stage: 0, done: false })
  assert.deepEqual(s01x.quests['sq-dex'], { stage: 1, done: false }, 'sq-dex reconciled from sq-dex:stage1 flag')
  assert.equal(s01x.flags['reward:quest:sq-floppy'], true, 'completed sq-floppy reward marked paid')
  for (const b of ['code', 'vision', 'sound']) assert.equal(s01x.flags[`badge:${b}`], true)
  for (const l of ['leader_code', 'leader_vision', 'leader_sound']) assert.equal(s01x.flags[`trainer:${l}`], true)
  assert.equal(s01x.flags['update:fromRev'], 0)
  assert.equal(s01x.flags['update:pendingRev'], targetRev)
  assert.equal(pendingContentRevisions(s01x).length, targetRev)

  // 0.2.0-rc.5 -> current: hq-zero started and reconciled to stage 1 from zero:t1/zero:t2, expired/retired events & flags cleaned
  const src5 = loadThroughManager(frc5)
  assert.equal(src5.contentRev, targetRev)
  assert.equal(src5.bag['persona-card'], 2)
  assert.deepEqual(src5.quests.main, { stage: 13, done: false })
  assert.deepEqual(src5.quests['hq-zero'], { stage: 1, done: false }, 'hq-zero reconciled from zero:t1 & zero:t2')
  assert.deepEqual(src5.quests['ds-legacy'], { stage: 0, done: false })
  assert.equal(src5.events?.['token-rain']?.activeUntil, undefined, 'expired activeUntil cleaned on load')
  assert.equal(src5.events?.['token-rain']?.count, 1, 'historical event run count preserved')
  assert.equal(src5.events?.['retired-beta-event'], undefined, 'unknown retired event dropped')
  assert.equal(src5.flags['evspawn:ev:token-rain:0.0'], undefined, 'orphaned spawn flag cleaned')
  assert.equal(src5.flags['evitem:ev:token-rain:item-1'], undefined, 'orphaned item flag cleaned')
  assert.equal(src5.flags['trainer:ev:benchmark-tournament:tr-grinder'], undefined, 'orphaned event trainer flag cleaned')
  assert.equal(src5.flags['news:retired-beta-event'], undefined, 'retired event news flag cleaned')
  assert.equal(src5.flags['rumor:retired-beta-event'], undefined, 'retired event rumor flag cleaned')
  assert.equal(src5.flags['update:fromRev'], 1)

  // 0.2.0-rc.12 -> current: persona-card NOT granted a second time, main 12 (done) -> 19 (done), ds-legacy opened and tracked
  const src12 = loadThroughManager(frc12)
  assert.equal(src12.contentRev, targetRev)
  assert.equal(src12.bag['persona-card'], 2, 'persona-card not granted twice')
  assert.equal(src12.party.find((c) => c.speciesId === 'o1')?.finetuned, 1, 'finetuned count preserved')
  assert.deepEqual(src12.quests.main, { stage: 19, done: true })
  assert.deepEqual(src12.quests['ds-legacy'], { stage: 0, done: false })
  assert.equal(src12.trackedQuest, 'ds-legacy', 'completed main switches tracker to open ds-legacy quest')
  assert.equal(src12.flags['boss:won:deepseek'], true)
  assert.equal(src12.flags['gate:ruins'], true)
  assert.equal(src12.flags['villain:boss'], true)
  assert.equal(src12.flags['update:fromRev'], 2)

  // 0.2.0-rc.16 -> current: contracted Boss card & instances preserved, main stage 8 reconciled to 10 for 2 badges, ds-legacy not reopened since ds:done
  const src16 = loadThroughManager(frc16)
  assert.equal(src16.contentRev, targetRev)
  assert.deepEqual(src16.quests.main, { stage: 10, done: false }, '2 badges reconcile main stage from 8 to 10')
  assert.equal(src16.quests['ds-legacy'], undefined, 'ds:done is already true so ds-legacy is not added')
  assert.equal(src16.instances?.['deepseek-tide']?.clears.story, 1)
  assert.equal(src16.instances?.['deepseek-tide']?.captures.story, 1)
  assert.equal(src16.flags['boss:won:deepseek'], true)
  assert.equal(src16.flags['update:fromRev'], 3)
})

test('legacy champion fixtures with empty quests (save-v1-champion, save-v2-champion) reconcile main quest and badge flags on load', () => {
  for (const file of ['save-v1-champion', 'save-v2-champion']) {
    const loaded = loadThroughManager(rawFixture(file))
    assert.deepEqual(loaded.quests.main, { stage: 19, done: false }, `${file}: champion without legend stands at stage 19`)
    assert.deepEqual(loaded.quests['ds-legacy'], { stage: 0, done: false }, `${file}: ds-legacy quest started`)
    assert.equal(loaded.trackedQuest, 'main', `${file}: main quest tracked`)
    assert.equal(loaded.flags['boss:won:deepseek'], true, `${file}: deepseek boss flag set`)
    assert.equal(loaded.flags['boss:won:kimi'], true, `${file}: boxed kimi boss flag set`)
    assert.equal(loaded.flags['badge:compute'], true, `${file}: snowpass gate badge flag set`)
    assert.equal(loaded.flags['gate:ruins'], true, `${file}: ruins gate flag set`)
  }
})

test('idempotent reload and importCode: reloading any migrated save never changes state or re-grants rewards', () => {
  const files = [
    'save-v1-starter', 'save-v1-3badges', 'save-v1-champion',
    'save-v2-starter', 'save-v2-3badges', 'save-v2-champion',
    'save-0.1.x-3badges', 'save-rc5-midgame', 'save-rc12-champion', 'save-rc16-prologue-done',
  ]
  for (const file of files) {
    const store = memory()
    const mgr = createSaveManager({ world, storage: store, now: () => 1_700_000_000_000, newId: () => '00000000-0000-4000-8000-000000000099' })
    store.setItem(`${CONTENT.config.save.storagePrefix}0`, JSON.stringify(rawFixture(file)))
    const first = mgr.load(0)!
    assert.ok(mgr.write(first, 0))
    const second = mgr.load(0)!
    assert.deepEqual(second, first, `${file}: second load is identical`)
    const viaCode = mgr.importCode(mgr.exportCode(first))!
    assert.deepEqual(viaCode, first, `${file}: exportCode -> importCode round-trip is identical`)
  }
})

test('appending a new chapter reopens a completed quest without losing old facts or double-paying rewards', () => {
  const base = loadThroughManager(rawFixture('save-rc12-champion'))
  assert.deepEqual(base.quests.main, { stage: 19, done: true })

  // Extending main with a new chapter (stage 20) in a rev 5 migration reopens main at stage 20 while archiving ch1 completion
  const nextMig: MigrationsFile = {
    ...MIGRATIONS,
    contentRev: MIGRATIONS.contentRev + 1,
    revisions: [
      ...MIGRATIONS.revisions,
      {
        rev: MIGRATIONS.contentRev + 1,
        id: 'm2-chapter-append',
        release: '0.3.0-rc.1',
        titleKey: 'screens.update.rev.rc17ContentReconcile.title',
        summaryKey: 'screens.update.rev.rc17ContentReconcile.summary',
        questChanges: [
          { op: 'appendStages', quest: 'main', stages: [{ text: '前往新大陆的深层机房。', target: 'town:origin:lab' }] },
        ],
        steps: [
          { op: 'reopenQuest', quest: 'main', fromStage: 19, newStage: 20, archiveFlag: 'main:ch1:done' },
        ],
      },
    ],
  }
  const customContent = { ...CONTENT, config: { ...CONTENT.config, save: { ...CONTENT.config.save, contentRev: MIGRATIONS.contentRev + 1 } } }
  const migrated = migrateSave(base, customContent, nextMig) as SaveData
  assert.equal(migrated.contentRev, MIGRATIONS.contentRev + 1)
  assert.deepEqual(migrated.quests.main, { stage: 20, done: false }, 'completed main reopened at the new chapter stage')
  assert.equal(migrated.flags['main:ch1:done'], true, 'previous chapter completion archived')
  assert.equal(migrated.flags.champion, true, 'champion flag preserved')
  assert.equal(migrated.flags.legend, true, 'legend flag preserved')
  assert.equal(migrated.badges.length, 8, 'all 8 badges preserved')

  // Runtime applyQuest on a side quest with a reward: reopening to a newly appended stage never pays the completion reward twice
  const events = createEventBus<GameEvents>()
  const sqDef = world.quests.find((q) => q.id === 'sq-dex')!
  const extendedWorld: World = {
    ...world,
    quests: world.quests.map((q) => (q.id === 'sq-dex' ? { ...q, stages: [...q.stages, { text: '收服 50 种智灵。' }] } : q)),
  }
  const save = saves.newGame({ name: '测试', avatar: '' })
  const ctx = { data: { ...CONTENT, world: extendedWorld }, save, events } as unknown as GameContext
  applyQuest(ctx, 'sq-dex', 1, true)
  const moneyAfterFirstFinish = save.money
  const rareDatasetAfterFirst = save.bag['rare-dataset'] ?? 0
  assert.equal(moneyAfterFirstFinish, CONTENT.config.economy.startMoney + (sqDef.reward?.money ?? 0))
  assert.equal(rareDatasetAfterFirst, sqDef.reward?.items?.['rare-dataset'] ?? 0)

  // Reopen sq-dex at stage 2 (done: false), then finish stage 2 (done: true) -> reward is NOT paid a second time
  const reopened = applyQuest(ctx, 'sq-dex', 2, false)
  assert.equal(reopened?.advanced, true)
  assert.deepEqual(save.quests['sq-dex'], { stage: 2, done: false })
  applyQuest(ctx, 'sq-dex', 2, true)
  assert.deepEqual(save.quests['sq-dex'], { stage: 2, done: true })
  assert.equal(save.money, moneyAfterFirstFinish, 'quest money reward paid once only')
  assert.equal(save.bag['rare-dataset'], rareDatasetAfterFirst, 'quest item reward paid once only')
})

test('quest stage guard: editing quest stages without a declared migration fails validation and storyProblems()', () => {
  assert.deepEqual(validateStoryMigrations(), [], 'shipped quests.json and migrations.json are in sync')

  // 1. Appending a stage to main in quests.json without declaring it in migrations.json
  const extraStageQuests = STORY_CONTENT.quests.map((q) =>
    q.id === 'main' ? { ...q, stages: [...q.stages, { text: '未声明的新阶段', target: 'town:origin:lab' }] } : q)
  const errsCount = validateStoryMigrations(extraStageQuests, MIGRATIONS)
  assert.ok(errsCount.some((e) => e.includes('quest main: stage count changed')), errsCount.join('\n'))

  // 2. Modifying an existing stage target without a migration
  const changedTargetQuests = STORY_CONTENT.quests.map((q) =>
    q.id === 'sq-floppy' ? { ...q, stages: [{ ...q.stages[0], target: 'town:origin:lab' }] } : q)
  const errsTarget = validateStoryMigrations(changedTargetQuests, MIGRATIONS)
  assert.ok(errsTarget.some((e) => e.includes('quest sq-floppy stage 0: changed without a declared migration')), errsTarget.join('\n'))

  // 3. Adding a new quest without an addQuest migration
  const addedQuestList = [...STORY_CONTENT.quests, { id: 'sq-untracked', nameZh: '未登记任务', kind: 'side' as const, stages: [{ text: '去研究所', target: 'town:origin:lab' }] }]
  const errsAdded = validateStoryMigrations(addedQuestList, MIGRATIONS)
  assert.ok(errsAdded.some((e) => e.includes('quest sq-untracked: added to quests.json without a declared addQuest')), errsAdded.join('\n'))

  // 4. Declaring appendStages in migrations.json without a reopenQuest step
  const badAppendMig: MigrationsFile = {
    ...MIGRATIONS,
    contentRev: MIGRATIONS.contentRev + 1,
    revisions: [
      ...MIGRATIONS.revisions,
      {
        rev: MIGRATIONS.contentRev + 1,
        id: 'bad-append',
        release: '0.3.0',
        titleKey: 'screens.update.rev.rc17ContentReconcile.title',
        summaryKey: 'screens.update.rev.rc17ContentReconcile.summary',
        questChanges: [{ op: 'appendStages', quest: 'main', stages: [{ text: '未声明的新阶段', target: 'town:origin:lab' }] }],
        steps: [],
      },
    ],
  }
  const errsBadAppend = validateStoryMigrations(extraStageQuests, badAppendMig, {
    ...CONTENT,
    config: { ...CONTENT.config, save: { ...CONTENT.config.save, contentRev: MIGRATIONS.contentRev + 1 } },
  })
  assert.ok(errsBadAppend.some((e) => e.includes('requires a matching reopenQuest')), errsBadAppend.join('\n'))

  // 5. storyProblems(world) surfaces quest stage migration errors when applying story content
  const freshWorld: World = {
    ...world,
    trainers: {},
    quests: [],
    maps: Object.fromEntries(Object.entries(world.maps).map(([k, m]) => [k, { ...m, npcs: [] }])),
  }
  const badSc: StoryContent = { ...STORY_CONTENT, quests: extraStageQuests }
  applyStory(freshWorld, badSc)
  assert.ok(storyProblems(freshWorld).some((e) => e.includes('quest main: stage count changed')))
})

test('save:loaded and content:updated triggers fire on load, run once, and drive the one-time update summary', async () => {
  const loaded = loadThroughManager(rawFixture('save-0.1.x-3badges'))
  // Simulate a save where ds:legacy is set but trig:ds-legacy-load was not yet fired
  delete loaded.flags['trig:ds-legacy-start']
  delete loaded.flags['trig:ds-legacy-load']
  delete loaded.quests['ds-legacy']

  const events = createEventBus<GameEvents>()
  const ranSteps: ScriptStep[][] = []
  const ctx = { data: { ...CONTENT, world }, save: loaded, events, net: { status: 'offline' } } as unknown as GameContext
  const runner = createTriggers({
    ctx,
    isFree: () => true,
    run: async (steps) => {
      ranSteps.push([...steps])
      for (const s of steps) if (s.op === 'quest') applyQuest(ctx, s.quest, s.stage, s.done ?? false)
    },
  })

  const loadedEvents: GameEvents['save:loaded'][] = []
  const updatedEvents: GameEvents['content:updated'][] = []
  events.on('save:loaded', (p) => loadedEvents.push(p))
  events.on('content:updated', (p) => updatedEvents.push(p))

  assert.equal(hasPendingContentUpdate(loaded), true)
  assert.equal(attentionCounts(loaded).contentUpdate, 1)
  const summary = contentUpdateSummaryText(loaded)
  assert.match(summary, new RegExp(t('screens.update.rev.rc16PrologueDeepseek.summary')))

  const emitted = emitSaveLoaded(ctx)
  assert.equal(emitted.updated, true)
  assert.equal(emitted.fromRev, 0)
  assert.equal(emitted.toRev, MIGRATIONS.contentRev)
  assert.equal(loadedEvents.length, 1)
  assert.equal(updatedEvents.length, 1)

  runner.update()
  await Promise.resolve()
  assert.equal(ranSteps.length, 1, 'ds-legacy-load trigger ran on save:loaded')
  assert.deepEqual(loaded.quests['ds-legacy'], { stage: 0, done: false })
  assert.equal(loaded.flags['trig:ds-legacy-load'], true)

  // Acknowledge the one-time update summary (as opening the intel screen does)
  assert.equal(acknowledgeContentUpdate(loaded), true)
  assert.equal(acknowledgeContentUpdate(loaded), false, 'idempotent acknowledgement')
  assert.equal(hasPendingContentUpdate(loaded), false)
  assert.equal(attentionCounts(loaded).contentUpdate, 0)

  // Subsequent load emits save:loaded with updated=false and does not emit content:updated or re-run once triggers
  const secondEmit = emitSaveLoaded(ctx)
  assert.equal(secondEmit.updated, false)
  assert.equal(updatedEvents.length, 1, 'content:updated not emitted after acknowledgement')
  runner.update()
  assert.equal(ranSteps.length, 1, 'once trigger does not run a second time')
  runner.dispose()
})

test('future and malformed saves: clamped cleanly without regression or rejected safely', () => {
  const base = saves.newGame({ name: '未来训练家', avatar: '' })
  const futureRaw = {
    ...JSON.parse(JSON.stringify(base)),
    version: 99,
    contentRev: 99,
    badges: ['badge-code', 'badge-future-unknown'],
    flags: { starter: 'o1', 'future:flag': 'kept' },
    quests: { main: { stage: 999, done: false }, 'future-quest': { stage: 3, done: false } },
    events: {
      'token-rain': { lastDay: 99999, count: 2, startedAt: 999999 },
      'future-event': { lastDay: 1, count: 1 },
    },
  }
  const futureLoaded = loadThroughManager(futureRaw)
  assert.equal(futureLoaded.version, CONTENT.config.save.version)
  assert.equal(futureLoaded.contentRev, MIGRATIONS.contentRev)
  assert.deepEqual(futureLoaded.badges, ['badge-code'])
  assert.equal(futureLoaded.flags['badge:code'], true)
  assert.equal(futureLoaded.flags['future:flag'], 'kept')
  assert.equal(futureLoaded.quests.main.stage, world.quests.find((q) => q.id === 'main')!.stages.length - 1)
  assert.equal(futureLoaded.quests['future-quest'], undefined)
  assert.equal(futureLoaded.events?.['future-event'], undefined)
  assert.ok((futureLoaded.events?.['token-rain']?.lastDay ?? 0) <= Math.floor(futureLoaded.clockMinutes / 1440))
  assert.equal(hasPendingContentUpdate(futureLoaded), false, 'future save does not trigger backwards update notice')

  // Malformed saves are rejected by sanitizeSaveData
  for (const bad of [
    null,
    undefined,
    42,
    { version: 0, party: [], position: { map: 'overworld', x: 0, y: 0, facing: 'down' } },
    { version: -2, party: [], position: { map: 'overworld', x: 0, y: 0, facing: 'down' } },
    { version: Number.NaN, party: [], position: { map: 'overworld', x: 0, y: 0, facing: 'down' } },
    { version: 3, position: { map: 'overworld', x: 0, y: 0, facing: 'down' } },
  ]) {
    assert.equal(saves.sanitize(migrateSave(bad)), null)
  }
})
