// Red dots and the first-time prompt: what counts as "waiting for the player", how it maps to menu entries, when it
// is raised, and that the content behind it (sources, texts, the tutorial tip) is consistent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, t } from '../src/shared/content/index.ts'
import { researchPoints, tasksFor } from '../src/shared/gameplay/research.ts'
import { GAMEPLAY } from '../src/shared/gameplay/data.ts'
import { buildWorld, worldAnchors } from '../src/shared/world/index.ts'
import { ATTENTION, validateAttention, type AttentionConfig } from '../src/client/attention/config.ts'
import { PROVIDERS, attentionCounts, attentionTotal, entrySources, guidedSource, markEntryOpened, raisedSources, type AttentionSave } from '../src/client/attention/logic.ts'
import { claimResearchRewards } from '../src/client/world/research.ts'
import { TUTORIAL, validateTutorial } from '../src/client/onboarding/config.ts'
import { SCREENS } from '../src/client/ui/screens/config.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import type { GameContext } from '../src/client/contracts.ts'
import type { SaveData } from '../src/shared/types.ts'

const pauseActions = SCREENS.pause.entries.map((e) => e.action)

/** A save with enough research points for level 1 (and nothing claimed). */
function saveWithReward(): SaveData {
  const world = buildWorld()
  const save = createSaveManager({ world, storage: null }).newGame({ name: 'p', avatar: (CONTENT.characters.find((c) => c.playable) ?? CONTENT.characters[0]).id })
  const need = GAMEPLAY.research.levels[0].points
  const state: Record<string, Record<string, number>> = {}
  for (const sp of CONTENT.speciesList) {
    if (researchPoints(state) >= need) break
    state[sp.id] = Object.fromEntries(tasksFor(sp.id).map((tk) => [tk.id, Math.max(...tk.thresholds)]))
  }
  save.research = state
  return save
}

test('the attention content is consistent (providers, pause entries, texts)', () => {
  assert.deepEqual(validateAttention(ATTENTION, Object.keys(PROVIDERS), pauseActions), [])
})

test('validateAttention catches an unknown provider, a missing menu entry, a shared flag and a missing text', () => {
  const bad: AttentionConfig = {
    pollSec: 0,
    sources: [
      { id: 'a', provider: 'nope', entry: 'dex', guideFlag: 'f', detail: 'hud.attention.dot' },
      { id: 'b', provider: 'researchClaim', entry: 'nowhere', guideFlag: 'f', detail: 'hud.attention.nothing' },
    ],
  }
  const errs = validateAttention(bad, Object.keys(PROVIDERS), pauseActions).join('\n')
  for (const part of ['pollSec', 'unknown provider "nope"', '"nowhere" is not a pause-menu entry', 'own guideFlag', 'missing text "hud.attention.nothing"']) assert.match(errs, new RegExp(part))
})

test('research: nothing waiting at the start, a dot once the level reward is claimable, gone right after the claim', () => {
  const none: AttentionSave = { research: {}, flags: {} }
  assert.equal(attentionTotal(attentionCounts(none)), 0)
  const save = saveWithReward()
  const counts = attentionCounts(save)
  assert.equal(counts.research, 1)
  assert.equal(attentionTotal(counts), 1)
  assert.deepEqual(entrySources(counts, 'research').map((s) => s.id), ['research'])
  assert.deepEqual(entrySources(counts, 'dex'), [], 'only the research row wears the dot')
  const ctx = { save, ui: { toast() {} }, events: { emit() {} }, data: { ...CONTENT, world: buildWorld() } } as unknown as GameContext
  assert.ok(claimResearchRewards(ctx))
  assert.equal(attentionTotal(attentionCounts(save)), 0, 'the dot goes away as soon as the reward is claimed')
})

test('first-time guidance: the entry is guided until the player opens it, then only the dot stays', () => {
  const save = saveWithReward()
  const counts = attentionCounts(save)
  assert.equal(guidedSource(save, counts, 'research')?.id, 'research')
  assert.equal(guidedSource(save, counts, 'bag'), null)
  assert.equal(markEntryOpened(save, 'bag'), false)
  assert.equal(markEntryOpened(save, 'research'), true)
  assert.equal(guidedSource(save, counts, 'research'), null)
  assert.equal(entrySources(counts, 'research').length, 1, 'the dot stays until the reward is claimed')
  assert.equal(markEntryOpened(save, 'research'), false, 'the flag is set once')
})

test('raisedSources fires on the first look and on every nothing -> something change, not while it keeps waiting', () => {
  assert.deepEqual(raisedSources(null, { research: 1 }), ['research'], 'a save loaded with a reward waiting')
  assert.deepEqual(raisedSources(null, { research: 0 }), [])
  assert.deepEqual(raisedSources({ research: 0 }, { research: 1 }), ['research'])
  assert.deepEqual(raisedSources({ research: 1 }, { research: 1 }), [])
  assert.deepEqual(raisedSources({ research: 1 }, { research: 2 }), [])
  assert.deepEqual(raisedSources({ research: 1 }, { research: 0 }), [])
})

test('the mechanism is generic: a second source is one provider and one config line', () => {
  const cfg: AttentionConfig = {
    pollSec: 1,
    sources: [
      ...ATTENTION.sources,
      { id: 'newItems', provider: 'newItems', entry: 'bag', guideFlag: 'attn:guided:newItems', detail: 'hud.attention.research.detail' },
    ],
  }
  const providers = { ...PROVIDERS, newItems: (save: AttentionSave) => Number(save.flags['fresh:items'] ?? 0) }
  assert.deepEqual(validateAttention(cfg, Object.keys(providers), pauseActions), [])
  const save: AttentionSave = { research: {}, flags: { 'fresh:items': 3 } }
  const counts = attentionCounts(save, cfg, providers)
  assert.deepEqual(counts, { research: 0, newItems: 3 })
  assert.deepEqual(entrySources(counts, 'bag', cfg).map((s) => s.id), ['newItems'])
  assert.equal(guidedSource(save, counts, 'bag', cfg)?.id, 'newItems')
  assert.deepEqual(raisedSources({ research: 0, newItems: 0 }, counts), ['newItems'])
})

test('the first-time prompt is a tutorial tip: once, in the world, only while the reward still waits, device-aware text', () => {
  const world = buildWorld()
  assert.deepEqual(validateTutorial(world, worldAnchors(world)), [])
  const tip = TUTORIAL.tips.list.find((x) => x.id === 'researchReward')
  assert.ok(tip, 'content/tutorial.json has the research reward tip')
  assert.equal(tip.trigger.kind, 'on')
  if (tip.trigger.kind === 'on') {
    assert.equal(tip.trigger.on, 'attention:raised')
    assert.equal(tip.trigger.phase, 'field', 'queued until the player is free in the world: never over a fight or a story scene')
    assert.deepEqual(tip.trigger.match, { id: 'research' })
  }
  assert.equal(tip.whileAttention, 'research')
  assert.ok(TUTORIAL.curriculum.lessons.some((l) => l.tips?.includes('researchReward')), 'the manual teaches it too')
  assert.match(t(`${tip.text}.body`), /\{menu\}/, 'desktop: names the menu key through the placeholder, not a literal key')
  assert.doesNotMatch(t(`${tip.text}.bodyTouch`), /\{|Esc/, 'phones: the on-screen menu key, no keyboard wording')
  assert.match(t(`${tip.text}.bodyTouch`), /菜单/)
  assert.match(t(`${tip.text}.body`), /智灵研究/)
  assert.match(t(`${tip.text}.bodyTouch`), /智灵研究/)
})
