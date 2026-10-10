// The boss contract (M1b, #59) without a screen: which balls can sign, what signing files and counts, that the first
// card never rerolls, and the badge payout of banked exp. The screen itself is capture.ts (needs a DOM).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { Creature, SaveData } from '../src/shared/types.ts'
import type { GameContext } from '../src/client/contracts.ts'
import { createCreature, expForLevel } from '../src/shared/creature.ts'
import { Rng } from '../src/shared/rng.ts'
import { GAMEPLAY } from '../src/shared/gameplay/data.ts'
import { bankLevels, isBossCard, rollBossCard } from '../src/shared/gameplay/bosscard.ts'
import { progressOf } from '../src/shared/gameplay/instances.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { ballChoices, contractSeed, signContract } from '../src/client/battle/contract.ts'
import { settleBossCards } from '../src/client/world/save-ops.ts'
import { canOffer } from '../src/client/net/trade-flow.ts'
import { BATTLE_UI } from '../src/client/battle/config.ts'

const TIER = GAMEPLAY.instances['deepseek-tide'].tiers.story

function newSave(): SaveData {
  const saves = createSaveManager({ world: null as never, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, now: () => 1, newId: () => 'player-1' })
  const save = saves.newGame({ name: '测试', avatar: '' })
  save.party.push(createCreature('o1', 10, { rng: new Rng(1) }))
  return save
}

const events: string[] = []
function ctxOf(save: SaveData): GameContext & { toasts: string[]; persisted: string[] } {
  const toasts: string[] = []
  const persisted: string[] = []
  return {
    save, data: CONTENT, toasts, persisted,
    events: { emit: (name: string) => { events.push(name) } },
    overworld: { player: { map: 'overworld' } },
    persist: (why: string) => { persisted.push(why) },
    audio: { playSfx: () => {} },
    ui: { toast: (text: string) => { toasts.push(text) } },
    screens: { learnMove: async (cr: Creature) => cr.moves.length },
  } as unknown as GameContext & { toasts: string[]; persisted: string[] }
}

test('ballChoices: the held balls cheapest first, the gifted default ball when none is held', () => {
  const save = newSave()
  save.bag = { 'cot-ball': 1, 'prompt-ball': 3, 'cache-potion': 5 }
  assert.deepEqual(ballChoices(ctxOf(save)), [{ id: 'prompt-ball', owned: 3 }, { id: 'cot-ball', owned: 1 }])
  save.bag = { 'cache-potion': 5 }
  assert.deepEqual(ballChoices(ctxOf(save)), [{ id: BATTLE_UI.contract.defaultBall, owned: 0 }])
})

test('signContract: the first clear files a Lv1 boss card in the party, counts it and cannot be signed twice', () => {
  const save = newSave()
  const ctx = ctxOf(save)
  const signed = signContract(ctx, 'deepseek', 'story', 'prompt-ball')!
  assert.equal(signed.where, 'party')
  assert.equal(signed.card.level, CONTENT.quality.bossCard.startLevel)
  assert.ok(isBossCard(signed.card) && save.party.includes(signed.card))
  assert.equal(signed.card.abilityId, 'peak-valley')
  assert.equal(signed.card.otId, save.playerId)
  assert.equal(signed.card.ballId, 'prompt-ball')
  assert.ok(save.dexCaught.includes('deepseek-v4') && signed.newEntry)
  assert.equal(progressOf(save, 'deepseek-tide').captures.story, 1)
  assert.equal(signContract(ctx, 'deepseek', 'story', 'prompt-ball'), null, 'repeat clears do not sign')
  assert.equal(save.party.length, 2)
  assert.equal(signContract(ctx, 'deepseek', 'nope', 'prompt-ball'), null)
})

test('signContract: a full party sends the card to the first box, a full house overflows the last box', () => {
  const save = newSave()
  const P = CONTENT.config.party
  while (save.party.length < P.maxParty) save.party.push(createCreature('o1', 5, { rng: new Rng(save.party.length) }))
  const a = signContract(ctxOf(save), 'deepseek', 'story', 'prompt-ball')!
  assert.equal(a.where, 'box')
  assert.ok(save.boxes[0].includes(a.card))

  const full = newSave()
  while (full.party.length < P.maxParty) full.party.push(createCreature('o1', 5, { rng: new Rng(full.party.length) }))
  full.boxes = full.boxes.map((b) => Array.from({ length: P.boxSize }, (_, i) => createCreature('o1', 5, { rng: new Rng(i) })))
  const b = signContract(ctxOf(full), 'deepseek', 'story', 'prompt-ball')!
  assert.equal(b.where, 'box')
  assert.ok(full.boxes[full.boxes.length - 1].includes(b.card), 'the first card is never lost')
})

test('the first card is fixed by the save: reloading the room (another run counter) signs the same card', () => {
  const a = newSave()
  const b = structuredClone(a)
  progressOf(b, 'deepseek-tide').runSeq = 5
  progressOf(b, 'deepseek-tide').losses.story = 3
  const ca = signContract(ctxOf(a), 'deepseek', 'story', 'prompt-ball')!.card
  const cb = signContract(ctxOf(b), 'deepseek', 'story', 'prompt-ball')!.card
  const strip = (c: Creature) => ({ ivs: c.ivs, nature: c.nature, abilityId: c.abilityId, moves: c.moves.map((m) => m.id), shiny: c.shiny })
  assert.deepEqual(strip(cb), strip(ca))
  assert.equal(cb.uid, ca.uid)

  const other = newSave()
  other.rollSeed = (a.rollSeed! + 1) >>> 0
  const co = signContract(ctxOf(other), 'deepseek', 'story', 'prompt-ball')!.card
  assert.notDeepEqual({ ...strip(co), uid: co.uid }, { ...strip(ca), uid: ca.uid }, 'a different save rolls a different card')
  assert.equal(contractSeed(ctxOf(a), 'deepseek-tide', 'story', true), contractSeed(ctxOf(b), 'deepseek-tide', 'story', true))
  assert.notEqual(contractSeed(ctxOf(b), 'deepseek-tide', 'story', false), contractSeed(ctxOf(b), 'deepseek-tide', 'story', true), 'later signings follow the run counter')
})

test('a signed boss card cannot be offered for a trade; the rest of the party can', () => {
  const save = newSave()
  const card = signContract(ctxOf(save), 'deepseek', 'story', 'prompt-ball')!.card
  assert.equal(canOffer(save.party, card), false)
  assert.equal(canOffer(save.party, save.party[0]), true)
})

test('settleBossCards: a new badge pays the bank (Lv10 -> Lv14), toasts it and saves; capped cards stay put', async () => {
  const save = newSave()
  const ctx = ctxOf(save)
  const card = rollBossCard(new Rng(3), 'deepseek', 'story', TIER, { first: true })
  card.level = 10
  card.exp = expForLevel('slow', 13)
  assert.equal(bankLevels(card), 3)
  save.party.push(card)

  assert.deepEqual(await settleBossCards(ctx), [], 'no badge yet: nothing to pay')
  save.badges.push('badge-code')
  const levelled = await settleBossCards(ctx)
  assert.deepEqual(levelled, [card])
  assert.equal(card.level, 13, 'the bank held 3 levels')
  assert.equal(bankLevels(card), 0)
  assert.ok(ctx.toasts.some((x) => x.includes('Lv10') && x.includes('Lv13')), ctx.toasts.join('|'))
  assert.deepEqual(ctx.persisted, ['license'])
  assert.deepEqual(await settleBossCards(ctx), [], 'nothing banked any more')
})
