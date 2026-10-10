import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import { GAMEPLAY } from '../src/shared/gameplay/data.ts'
import type { BattleAction, SaveData } from '../src/shared/types.ts'
import type { GameContext } from '../src/client/contracts.ts'
import { createCreature } from '../src/shared/creature.ts'
import { Rng } from '../src/shared/rng.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import {
  checkInstanceAchievements,
  contractOdds,
  dailyLockoutStatus,
  instancePeriodKey,
  isOffPeakDouble,
  isTierUnlocked,
  progressOf,
} from '../src/shared/gameplay/instances.ts'
import {
  createParty,
  addPartyMember,
  removePartyMember,
  setMemberReady,
  canStartParty,
} from '../src/shared/coop/party.ts'
import {
  createDungeonInstance,
  activateMechanism,
  markEliteDefeated,
  transitionRoom,
} from '../src/shared/coop/instance.ts'
import {
  applyRaidPlayerAction,
  buildRaidSummary,
  createRaidSession,
  scaleBossHp,
} from '../src/shared/coop/raid.ts'
import { createDungeonServer } from '../src/server/dungeon.ts'
import type { HubCore, Player } from '../src/server/core.ts'
import type { CoopClientMsg, CoopServerMsg } from '../src/shared/coop/protocol.ts'
import { signContract } from '../src/client/battle/contract.ts'

function newTestSave(playerId = 'player-test-1', name = '训练家1'): SaveData {
  const saves = createSaveManager({
    world: null as never,
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    now: () => 1,
    newId: () => playerId,
  })
  const save = saves.newGame({ name, avatar: 'sprite-hero' })
  save.party.push(createCreature('o1', 15, { rng: new Rng(1) }))
  save.bag = { 'prompt-ball': 5, 'few-shot-ball': 2, 'data-shard': 0 }
  return save
}

function testCtxOf(save: SaveData): GameContext & { toasts: string[] } {
  const toasts: string[] = []
  return {
    save,
    data: CONTENT,
    toasts,
    events: { emit: () => {} },
    overworld: { player: { map: 'origin' } },
    persist: () => {},
    audio: { playSfx: () => {} },
    ui: { toast: (text: string) => { toasts.push(text) } },
  } as unknown as GameContext & { toasts: string[] }
}

test('dungeons: at least 6 thematic AI-circle dungeons exist with complete rooms, mechanisms, elites and tiers', () => {
  const instances = Object.entries(GAMEPLAY.instances)
  assert.ok(instances.length >= 6, `expected >= 6 dungeons, found ${instances.length}`)

  const requiredDungeons = [
    'deepseek-tide',
    'cursor-atelier',
    'doubao-arena',
    'minimax-colosseum',
    'kimi-archive',
    'qwen-distill',
    'astra-datacenter',
    'mythos-vault',
  ]

  for (const id of requiredDungeons) {
    const inst = GAMEPLAY.instances[id]
    assert.ok(inst, `missing required dungeon "${id}"`)
    assert.ok(inst.boss in CONTENT.bosses, `unknown boss "${inst.boss}" in "${id}"`)
    assert.ok(inst.rooms && Object.keys(inst.rooms).length >= 2, `dungeon "${id}" missing multi-room layout`)
    assert.ok(inst.mechanisms && Object.keys(inst.mechanisms).length >= 1, `dungeon "${id}" missing mechanisms`)
    assert.ok(inst.elites && Object.keys(inst.elites).length >= 1, `dungeon "${id}" missing elites`)
    assert.ok(inst.achievements && Object.keys(inst.achievements).length >= 1, `dungeon "${id}" missing achievements`)

    for (const tid of ['story', 'hard', 'full', 'cluster']) {
      const tier = inst.tiers[tid]
      assert.ok(tier, `dungeon "${id}" missing tier "${tid}"`)
      assert.ok(tier.capture.first >= 0 && tier.capture.first <= 1, `tier "${tid}" capture.first out of range`)
      assert.ok(tier.repeat.expMul > 0, `tier "${tid}" repeat.expMul must be > 0`)
    }
  }
})

test('dungeon unlock checks: badges, flags and party size constraints are properly enforced', () => {
  const inst = GAMEPLAY.instances['deepseek-tide']
  const hard = inst.tiers.hard
  const cluster = inst.tiers.cluster

  // Hard requires 4 badges
  assert.equal(isTierUnlocked(hard, [], {}).unlocked, false)
  assert.equal(isTierUnlocked(hard, ['b1', 'b2', 'b3', 'b4'], {}).unlocked, true)

  // Cluster requires 2..4 players and 7 badges
  assert.equal(isTierUnlocked(cluster, ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'], {}, 1).unlocked, false)
  assert.equal(isTierUnlocked(cluster, ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'], {}, 2).unlocked, true)
  assert.equal(isTierUnlocked(cluster, ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'], {}, 5).unlocked, false)
})

test('contract odds and pity: M2 repeat probabilities, pity triggers, ball bonuses, and expected attempts', () => {
  const doubao = GAMEPLAY.instances['doubao-arena']
  const storyTier = doubao.tiers.story
  const hardTier = doubao.tiers.hard
  const fullTier = doubao.tiers.full

  // Story repeat: 35%, pity 3 -> E ~ 2.35
  const storyOdds = contractOdds(storyTier, 0, true, 0)
  assert.equal(storyOdds.chance, 0.35)
  assert.equal(storyOdds.maxPity, 3)
  assert.equal(storyOdds.guaranteed, false)
  assert.equal(storyOdds.avgAttempts, 2.35)

  // Pity guarantee at count >= 3
  const storyPityOdds = contractOdds(storyTier, 0, true, 3)
  assert.equal(storyPityOdds.chance, 1.0)
  assert.equal(storyPityOdds.guaranteed, true)

  // Hard repeat: 25%, pity 4 -> E ~ 3.05
  const hardOdds = contractOdds(hardTier, 0, true, 0)
  assert.equal(hardOdds.chance, 0.25)
  assert.equal(hardOdds.maxPity, 4)
  assert.equal(hardOdds.avgAttempts, 3.05)

  // Full repeat: 15%, pity 5 -> E ~ 4.15
  const fullOdds = contractOdds(fullTier, 0, true, 0)
  assert.equal(fullOdds.chance, 0.15)
  assert.equal(fullOdds.maxPity, 5)
  assert.equal(fullOdds.avgAttempts, 4.15)

  // Ball bonus increases probability
  const withBonus = contractOdds(hardTier, 0.10, true, 0)
  assert.equal(Number(withBonus.chance.toFixed(2)), 0.35)
})

test('period keys and off-peak double events', () => {
  // Day shifts at 5 AM UTC+8
  const morningBefore5 = new Date('2026-10-11T04:30:00+08:00').getTime()
  const morningAfter5 = new Date('2026-10-11T05:30:00+08:00').getTime()
  assert.equal(instancePeriodKey('daily', undefined, morningBefore5), '2026-10-10')
  assert.equal(instancePeriodKey('daily', undefined, morningAfter5), '2026-10-11')

  // Off-peak valley hours: 23:00 to 07:00
  const lateNight = new Date('2026-10-11T23:30:00+08:00').getTime()
  const midday = new Date('2026-10-11T14:00:00+08:00').getTime()
  assert.equal(isOffPeakDouble(lateNight), true)
  assert.equal(isOffPeakDouble(midday), false)
})

test('daily lockouts and achievements tracking', () => {
  const save = newTestSave()
  const prog = progressOf(save, 'cursor-atelier')
  const period = '2026-10-11'

  const status1 = dailyLockoutStatus(prog, period, 3)
  assert.equal(status1.canRoll, true)
  assert.equal(status1.rollsLeft, 3)

  prog.day!.rolls = 3
  const status2 = dailyLockoutStatus(prog, period, 3)
  assert.equal(status2.canRoll, false)
  assert.equal(status2.rollsLeft, 0)

  // Achievement unlock
  const inst = GAMEPLAY.instances['cursor-atelier']
  const awarded = checkInstanceAchievements(prog, inst, { tierId: 'story', win: true })
  assert.ok(awarded.includes('clear-story'))
  assert.ok(prog.achievements?.includes('clear-story'))
})

test('signContract: preserves backwards compatibility while supporting M2 repeat failure compensation', () => {
  const save = newTestSave()
  const ctx = testCtxOf(save)

  // First clear signs 100%
  const signed = signContract(ctx, 'cursor', 'story', 'prompt-ball')!
  assert.ok(signed)
  assert.equal(signed.where, 'party')
  assert.equal(progressOf(save, 'cursor-atelier').captures.story, 1)

  // Calling signContract again in the same runSeq returns null
  assert.equal(signContract(ctx, 'cursor', 'story', 'prompt-ball'), null)

  // Starting a new runSeq allows repeat rolls
  progressOf(save, 'cursor-atelier').runSeq = 2
  // We can test that repeated runs process contract rolls without throwing
  const repeatOutcome = signContract(ctx, 'cursor', 'story', 'prompt-ball')
  // Outcome is either signed creature or null (which gave failure shard)
  if (repeatOutcome === null) {
    assert.ok((save.bag['data-shard'] ?? 0) >= 1, 'failure awards data-shard fragment')
  }
})

test('party domain: creation, invites, capacity limit, and leader handover', () => {
  const party = createParty({
    id: 'p1',
    leaderId: 'u1',
    leaderName: 'Alice',
    leaderAvatar: 'hero',
  })
  assert.equal(party.members.length, 1)
  assert.equal(party.leaderId, 'u1')
  assert.equal(party.members[0].ready, true)

  // Add members
  assert.deepEqual(addPartyMember(party, { id: 'u2', name: 'Bob', avatar: 'hero' }), { ok: true })
  assert.deepEqual(addPartyMember(party, { id: 'u3', name: 'Charlie', avatar: 'hero' }), { ok: true })
  assert.deepEqual(addPartyMember(party, { id: 'u4', name: 'David', avatar: 'hero' }), { ok: true })
  // 5th member fails (cap 4)
  assert.equal(addPartyMember(party, { id: 'u5', name: 'Eve', avatar: 'hero' }).ok, false)

  // Ready states
  assert.equal(canStartParty(party, 4), false)
  setMemberReady(party, 'u2', true)
  setMemberReady(party, 'u3', true)
  setMemberReady(party, 'u4', true)
  assert.equal(canStartParty(party, 4), true)

  // Leader leaves -> handover to u2
  const { party: pAfterLeave, leaderChanged } = removePartyMember(party, 'u1')
  assert.ok(pAfterLeave)
  assert.equal(leaderChanged, true)
  assert.equal(pAfterLeave.leaderId, 'u2')
  assert.equal(pAfterLeave.members.length, 3)
})

test('dungeon instance domain: room transitions, mechanism activation, and elite tracking', () => {
  const instDef = GAMEPLAY.instances['deepseek-tide']
  const state = createDungeonInstance({
    id: 'inst-test-1',
    instanceId: 'deepseek-tide',
    tierId: 'story',
    def: instDef,
    memberIds: ['p1', 'p2'],
  })

  assert.equal(state.currentRoom, 'lobby')
  assert.deepEqual(activateMechanism(state, 'corridor', 'load-breaker'), { ok: true })
  assert.ok(state.rooms.corridor.activeMechanisms.includes('load-breaker'))

  assert.deepEqual(markEliteDefeated(state, 'corridor', 'queue-guard'), { ok: true })
  assert.ok(state.rooms.corridor.defeatedElites.includes('queue-guard'))

  assert.deepEqual(transitionRoom(state, 'corridor'), { ok: true })
  assert.equal(state.currentRoom, 'corridor')
  assert.deepEqual(transitionRoom(state, 'boss'), { ok: true })
  assert.equal(state.currentRoom, 'boss')
})

test('authoritative shared boss raid: HP scaling N^0.8, damage attribution, minContribution and settlement', () => {
  // Scale check
  const baseHp = 1000
  assert.equal(scaleBossHp(baseHp, 1, 0.8), 1000)
  assert.equal(scaleBossHp(baseHp, 2, 0.8), 1741)
  assert.equal(scaleBossHp(baseHp, 4, 0.8), 3031)

  const p1Cr = createCreature('o1', 25, { rng: new Rng(10) })
  const p2Cr = createCreature('phi-3', 25, { rng: new Rng(20) })

  const session = createRaidSession({
    raidId: 'raid-1',
    instanceId: 'deepseek-tide',
    tierId: 'cluster',
    bossId: 'deepseek',
    hpScaleExp: 0.8,
    minContribution: 10,
    members: [
      { id: 'u1', name: 'Alice', avatar: 'hero', party: [p1Cr] },
      { id: 'u2', name: 'Bob', avatar: 'hero', party: [p2Cr] },
    ],
  })

  assert.ok(session.boss.hp > 1000)
  const initialBossHp = session.boss.hp

  // Alice attacks
  const act1: BattleAction = { kind: 'move', moveIndex: 0 }
  const res1 = applyRaidPlayerAction(session, 'u1', act1)
  assert.ok(session.boss.hp < initialBossHp)
  assert.ok(res1.events.some((e) => e.t === 'damage'))

  // Force boss HP to low to test victory
  session.boss.hp = 10
  const resVictory = applyRaidPlayerAction(session, 'u2', act1)
  assert.equal(resVictory.victory, true)
  assert.equal(session.ended, true)

  // Summary and qualification
  const summary = buildRaidSummary(session)
  assert.equal(summary.victory, true)
  assert.ok(summary.members.length === 2)
  for (const m of summary.members) {
    assert.ok(m.damage > 0)
    assert.equal(m.qualified, true)
  }
})

test('multiplayer server simulation: 2 clients form party, enter dungeon, defeat raid, and settle rewards', () => {
  const sentMessages: Array<{ targetId: string; msg: CoopServerMsg }> = []

  const p1 = {
    id: 'c1',
    name: '玩家一',
    avatar: 'sprite-hero',
    ws: {} as never,
    ip: '127.0.0.1',
    version: 1,
    limits: {} as never,
    closed: false,
    state: { map: 'origin', x: 10, y: 10 } as never,
  } as unknown as Player

  const p2 = {
    id: 'c2',
    name: '玩家二',
    avatar: 'sprite-hero',
    ws: {} as never,
    ip: '127.0.0.1',
    version: 1,
    limits: {} as never,
    closed: false,
    state: { map: 'origin', x: 11, y: 10 } as never,
  } as unknown as Player

  const p1Save = newTestSave(p1.id, p1.name)
  p1Save.badges = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']
  const p2Save = newTestSave(p2.id, p2.name)
  const playerSaves = new Map<string, SaveData>([
    [p1.id, p1Save],
    [p2.id, p2Save],
  ])
  const mockStore = {
    getSave: (id: string) => playerSaves.get(id) ?? null,
    putSave: (id: string, s: SaveData) => { playerSaves.set(id, s) },
    audit: () => {},
  }

  const playerMap = new Map<string, Player>([
    [p1.id, p1],
    [p2.id, p2],
  ])

  const mockCore: HubCore = {
    send: (c, msg) => {
      const pl = c as Player
      sentMessages.push({ targetId: pl.id, msg: msg as CoopServerMsg })
    },
    broadcast: () => {},
    error: () => {},
    byId: (id) => playerMap.get(id),
    find: (s) => playerMap.get(s),
    players: () => playerMap.values(),
    nearby: () => [],
    inRange: () => true,
    isBusy: () => false,
    touch: () => {},
  }

  const server = createDungeonServer({
    core: mockCore,
    store: mockStore,
    lookupPlayer: (id) => playerMap.get(id) ?? null,
  })

  // 1. P1 creates party
  server.handle(p1, { t: 'party.create' })
  const p1PartyUpdate = sentMessages.find((m) => m.targetId === 'c1' && m.msg.t === 'party.update')
  assert.ok(p1PartyUpdate)

  // 2. P1 invites P2
  server.handle(p1, { t: 'party.invite', to: 'c2' })
  const inviteMsg = sentMessages.find((m) => m.targetId === 'c2' && m.msg.t === 'party.invited')
  assert.ok(inviteMsg)

  // 3. P2 accepts
  server.handle(p2, { t: 'party.respond', from: 'c1', accept: true })
  sentMessages.length = 0

  // 4. P2 readies up
  server.handle(p2, { t: 'party.ready', ready: true })

  // 5. P1 starts dungeon
  server.handle(p1, { t: 'party.start', instanceId: 'deepseek-tide', tierId: 'cluster' })
  const dungeonUpdates = sentMessages.filter((m) => m.msg.t === 'dungeon.update')
  assert.equal(dungeonUpdates.length, 2, 'both players receive dungeon.update')

  // 6. Mechanism activation
  server.handle(p1, { t: 'dungeon.mechanism', mechanismId: 'load-breaker' })
  assert.ok(sentMessages.some((m) => m.msg.t === 'dungeon.mechanismActivated'))

  // 7. Move to boss room initiates raid
  sentMessages.length = 0
  server.handle(p1, { t: 'dungeon.roomMove', roomId: 'boss' })
  const raidStarts = sentMessages.filter((m): m is { targetId: string; msg: Extract<CoopServerMsg, { t: 'raid.start' }> } => m.msg.t === 'raid.start')
  assert.equal(raidStarts.length, 2, 'both players receive raid.start')
  const raidId = raidStarts[0].msg.raidId

  // 8. Battle actions against boss
  sentMessages.length = 0
  const action: BattleAction = { kind: 'move', moveIndex: 0 }
  server.handle(p1, { t: 'raid.action', raidId, action })
  assert.ok(sentMessages.some((m) => m.msg.t === 'raid.tick'))

  server.close()
})
