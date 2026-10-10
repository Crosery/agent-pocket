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
import { createDungeonServer, type DungeonAuthority } from '../src/server/dungeon.ts'
import type { HubCore, Player } from '../src/server/core.ts'
import type { ServerMsg } from '../src/shared/protocol.ts'
import { signContract } from '../src/client/battle/contract.ts'
import { getActualDungeons } from '../src/client/net/coop-channel.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { storyProblems } from '../src/shared/world/story.ts'

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
  // Cannot jump directly to boss before clearing corridor elite
  assert.equal(transitionRoom(state, 'boss').ok, false)
  // Invalid mechanism or elite for wrong room is rejected
  assert.equal(activateMechanism(state, 'lobby', 'load-breaker').ok, false)
  assert.equal(markEliteDefeated(state, 'lobby', 'queue-guard').ok, false)

  assert.deepEqual(transitionRoom(state, 'corridor'), { ok: true })
  assert.equal(state.currentRoom, 'corridor')
  assert.deepEqual(activateMechanism(state, 'corridor', 'load-breaker'), { ok: true })
  assert.ok(state.rooms.corridor.activeMechanisms.includes('load-breaker'))

  // Still cannot enter boss room before defeating corridor elite
  assert.equal(transitionRoom(state, 'boss').ok, false)

  assert.deepEqual(markEliteDefeated(state, 'corridor', 'queue-guard'), { ok: true })
  assert.ok(state.rooms.corridor.defeatedElites.includes('queue-guard'))
  assert.equal(state.rooms.corridor.cleared, true)

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
    activeMechanisms: ['load-breaker'],
  })

  // Active mechanism load-breaker sets tide=1 and takenMulBonus=0.2
  assert.equal(session.bossState.meters.tide, 1)
  assert.equal(session.bossState.takenMulBonus, 0.2)

  // Scaled maxHp is preserved in BossDirector across turns without phantom damage
  const soloSession = createRaidSession({
    raidId: 'raid-solo',
    instanceId: 'deepseek-tide',
    tierId: 'cluster',
    bossId: 'deepseek',
    hpScaleExp: 0.8,
    members: [{ id: 'u1', name: 'Alice', avatar: 'hero', party: [createCreature('o1', 25, { rng: new Rng(10) })] }],
  })
  const expectedScaledMaxHp = scaleBossHp(soloSession.bossState.maxHp, 2, 0.8)
  assert.equal(session.bossState.maxHp, expectedScaledMaxHp)
  assert.equal(session.boss.hp, expectedScaledMaxHp)
  const initialBossHp = session.boss.hp

  // Alice attacks: maxHp stays scaled and damageDealt equals exact HP drop (no phantom clamping)
  const act1: BattleAction = { kind: 'move', moveIndex: 0 }
  const res1 = applyRaidPlayerAction(session, 'u1', act1)
  assert.equal(session.bossState.maxHp, expectedScaledMaxHp)
  assert.ok(session.boss.hp < initialBossHp)
  assert.equal(session.members.get('u1')!.damageDealt, initialBossHp - session.boss.hp)
  assert.ok(res1.events.some((e) => e.t === 'damage'))

  // Force boss HP to low to test victory
  session.bossState.hp = 10
  const resVictory = applyRaidPlayerAction(session, 'u2', act1)
  assert.equal(resVictory.victory, true)
  assert.equal(session.ended, true)
  const summary = buildRaidSummary(session)
  assert.equal(summary.victory, true)
  assert.ok(summary.members.length === 2)
  for (const m of summary.members) {
    assert.ok(m.damage > 0)
    assert.equal(m.qualified, true)
  }
})

test('world entries: all 8 dungeons have valid world NPCs with instance ops and deepseek-drill is excluded from picker', () => {
  const actual = getActualDungeons()
  assert.equal(actual.length, 8)
  assert.equal(actual.some(([id]) => id === 'deepseek-drill'), false)

  const world = buildWorld()
  const problems = storyProblems(world)
  assert.deepEqual(problems, [])

  for (const [id, inst] of actual) {
    assert.ok(inst.entry, `dungeon "${id}" missing entry`)
    const map = world.maps[inst.entry.map]
    assert.ok(map, `dungeon "${id}" entry map "${inst.entry.map}" not found`)
    const npc = map.npcs.find((n) => n.x === inst.entry!.x && n.y === inst.entry!.y)
    assert.ok(npc, `dungeon "${id}" has no entry NPC at ${inst.entry.map} (${inst.entry.x},${inst.entry.y})`)
  }
})

test('multiplayer server simulation: authoritative elite battle, mechanism effects, raid settlement, repeat runSeq rolls, untrusted isolation, and disconnect defeat', () => {
  const sentMessages: Array<{ targetId: string; msg: ServerMsg }> = []

  const makePlayer = (id: string, name: string): Player =>
    ({
      id,
      name,
      avatar: 'sprite-hero',
      ws: {} as never,
      ip: '127.0.0.1',
      version: 1,
      limits: {} as never,
      closed: false,
      state: { map: 'origin', x: 10, y: 10 } as never,
    }) as unknown as Player

  const p1 = makePlayer('c1', '玩家一')
  const p2 = makePlayer('c2', '玩家二')
  const pUntrusted = makePlayer('c3', '导入玩家')

  const p1Save = newTestSave(p1.id, p1.name)
  p1Save.badges = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']
  p1Save.party = [createCreature('o1', 80, { rng: new Rng(1) })]
  p1Save.bag = { 'prompt-ball': 3, 'few-shot-ball': 2, 'data-shard': 0 }

  const p2Save = newTestSave(p2.id, p2.name)
  p2Save.badges = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']
  p2Save.party = [createCreature('o1', 80, { rng: new Rng(2) })]
  p2Save.bag = { 'prompt-ball': 3, 'few-shot-ball': 2, 'data-shard': 0 }

  const p3Save = newTestSave(pUntrusted.id, pUntrusted.name)
  p3Save.flags['auth:untrustedImport'] = true

  const playerSaves = new Map<string, SaveData>([
    [p1.id, p1Save],
    [p2.id, p2Save],
    [pUntrusted.id, p3Save],
  ])
  const untrustedIds = new Set<string>([pUntrusted.id])

  const playerMap = new Map<string, Player>([
    [p1.id, p1],
    [p2.id, p2],
    [pUntrusted.id, pUntrusted],
  ])

  const mockCore: HubCore = {
    send: (c, msg) => {
      const pl = c as Player
      sentMessages.push({ targetId: pl.id, msg: msg as ServerMsg })
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

  let revCounter = 0
  const mockAuthority: DungeonAuthority = {
    getSave: (id) => playerSaves.get(id) ?? null,
    isUntrustedImport: (id) => untrustedIds.has(id),
    mutateSave: (id, ref, fn) => {
      const s = playerSaves.get(id)
      if (!s) return null
      const out = fn(s)
      const pl = playerMap.get(id)
      if (pl) {
        mockCore.send(pl, { t: 'state.sync', save: s, rev: ++revCounter, reason: ref })
      }
      return out
    },
    audit: () => {},
  }

  const server = createDungeonServer({
    core: mockCore,
    authority: mockAuthority,
    lookupPlayer: (id) => playerMap.get(id) ?? null,
  })

  // 0. Untrusted imported account cannot create or join a co-op party
  server.handle(pUntrusted, { t: 'party.create' })
  assert.ok(sentMessages.some((m) => m.targetId === 'c3' && m.msg.t === 'party.error' && m.msg.code === 'untrusted_save'))
  sentMessages.length = 0

  // 1. P1 creates party and invites P2 (inviting untrusted P3 is rejected)
  server.handle(p1, { t: 'party.create' })
  assert.ok(sentMessages.some((m) => m.targetId === 'c1' && m.msg.t === 'party.update'))

  server.handle(p1, { t: 'party.invite', to: 'c3' })
  assert.ok(sentMessages.some((m) => m.targetId === 'c1' && m.msg.t === 'party.error' && m.msg.code === 'untrusted_save'))
  sentMessages.length = 0

  server.handle(p1, { t: 'party.invite', to: 'c2' })
  assert.ok(sentMessages.some((m) => m.targetId === 'c2' && m.msg.t === 'party.invited'))

  // 2. P2 accepts and readies up
  server.handle(p2, { t: 'party.respond', from: 'c1', accept: true })
  server.handle(p2, { t: 'party.ready', ready: true })
  sentMessages.length = 0

  // 3. P1 starts cluster dungeon
  server.handle(p1, { t: 'party.start', instanceId: 'deepseek-tide', tierId: 'cluster' })
  assert.equal(sentMessages.filter((m) => m.msg.t === 'dungeon.update').length, 2)
  sentMessages.length = 0

  // 4. Cannot activate corridor mechanism from lobby or skip corridor elite to boss
  server.handle(p1, { t: 'dungeon.mechanism', mechanismId: 'load-breaker' })
  assert.ok(sentMessages.some((m) => m.msg.t === 'dungeon.error' && m.msg.code === 'invalid_mechanism'))
  sentMessages.length = 0

  server.handle(p1, { t: 'dungeon.roomMove', roomId: 'boss' })
  assert.ok(sentMessages.some((m) => m.msg.t === 'dungeon.error' && m.msg.code === 'room_not_cleared'))
  sentMessages.length = 0

  // 5. Move to corridor, activate load-breaker, and fight queue-guard authoritatively on server
  server.handle(p1, { t: 'dungeon.roomMove', roomId: 'corridor' })
  assert.ok(sentMessages.some((m) => m.msg.t === 'dungeon.roomChanged' && m.msg.roomId === 'corridor'))
  sentMessages.length = 0

  server.handle(p1, { t: 'dungeon.mechanism', mechanismId: 'load-breaker' })
  assert.ok(sentMessages.some((m) => m.msg.t === 'dungeon.mechanismActivated' && m.msg.mechanismId === 'load-breaker'))
  sentMessages.length = 0

  server.handle(p1, { t: 'dungeon.eliteFight', eliteId: 'queue-guard' })
  const eliteStart = sentMessages.find(
    (m): m is { targetId: string; msg: Extract<ServerMsg, { t: 'dungeon.eliteStarted' }> } =>
      m.targetId === 'c1' && m.msg.t === 'dungeon.eliteStarted',
  )
  assert.ok(eliteStart, 'dungeon.eliteFight starts authoritative server battle without immediately claiming victory')
  assert.equal(sentMessages.some((m) => m.msg.t === 'dungeon.eliteDefeated'), false)

  const eliteBattleId = eliteStart.msg.battleId
  for (let step = 0; step < 20; step++) {
    if (sentMessages.some((m) => m.msg.t === 'dungeon.eliteEnd')) break
    server.handle(p1, { t: 'dungeon.eliteAction', battleId: eliteBattleId, action: { kind: 'move', moveIndex: 0 } })
  }
  assert.ok(sentMessages.some((m) => m.msg.t === 'dungeon.eliteDefeated' && m.msg.eliteId === 'queue-guard'))
  sentMessages.length = 0

  // 6. Move to boss room initiates raid and increments runSeq to 1 via authority.mutateSave (emitting state.sync)
  server.handle(p1, { t: 'dungeon.roomMove', roomId: 'boss' })
  const raidStarts = sentMessages.filter(
    (m): m is { targetId: string; msg: Extract<ServerMsg, { t: 'raid.start' }> } => m.msg.t === 'raid.start',
  )
  assert.equal(raidStarts.length, 2)
  assert.equal(progressOf(p1Save, 'deepseek-tide').runSeq, 1)
  assert.equal(progressOf(p2Save, 'deepseek-tide').runSeq, 1)
  const raidId = raidStarts[0].msg.raidId
  assert.equal(raidStarts[0].msg.boss.meters.tide, 1, 'load-breaker mechanism applied to boss raid')

  // 7. Both players deal damage to defeat Boss and qualify (>=10% contribution)
  sentMessages.length = 0
  const act: BattleAction = { kind: 'move', moveIndex: 0 }
  for (let turn = 0; turn < 30; turn++) {
    if (sentMessages.some((m) => m.msg.t === 'raid.end')) break
    server.handle(p1, { t: 'raid.action', raidId, action: act })
    if (sentMessages.some((m) => m.msg.t === 'raid.end')) break
    server.handle(p2, { t: 'raid.action', raidId, action: act })
  }
  const raidEnd = sentMessages.find(
    (m): m is { targetId: string; msg: Extract<ServerMsg, { t: 'raid.end' }> } => m.msg.t === 'raid.end',
  )
  assert.ok(raidEnd && raidEnd.msg.victory)
  assert.ok(sentMessages.some((m) => m.msg.t === 'state.sync'), 'reward settlement emits state.sync')
  assert.ok(progressOf(p1Save, 'deepseek-tide').achievements?.includes('clear-cluster'))

  // 8. Unowned master ball is rejected; owned ball is consumed and only 1 roll per runSeq is allowed
  sentMessages.length = 0
  server.handle(p1, { t: 'raid.rollContract', raidId, ballId: CONTENT.quality.capture.masterBall })
  assert.ok(sentMessages.some((m) => m.msg.t === 'raid.error' && m.msg.code === 'no_ball'))

  sentMessages.length = 0
  const ballsBefore = p1Save.bag['prompt-ball']
  server.handle(p1, { t: 'raid.rollContract', raidId, ballId: 'prompt-ball' })
  assert.ok(sentMessages.some((m) => m.msg.t === 'raid.contractResult'))
  assert.equal(p1Save.bag['prompt-ball'], ballsBefore - 1, 'owned ball consumed on contract roll')

  // Duplicate roll in same runSeq is rejected
  sentMessages.length = 0
  server.handle(p1, { t: 'raid.rollContract', raidId, ballId: 'prompt-ball' })
  assert.ok(sentMessages.some((m) => m.msg.t === 'raid.error' && m.msg.code === 'already_rolled'))

  // 9. Starting a new run increments runSeq to 2 and allows a repeat contract roll
  server.handle(p1, { t: 'dungeon.leave' })
  server.handle(p2, { t: 'dungeon.leave' })
  sentMessages.length = 0

  server.handle(p1, { t: 'dungeon.enter', instanceId: 'deepseek-tide', tierId: 'hard' })
  server.handle(p1, { t: 'dungeon.roomMove', roomId: 'corridor' })
  server.handle(p1, { t: 'dungeon.eliteFight', eliteId: 'queue-guard' })
  const eliteStart2 = sentMessages.find(
    (m): m is { targetId: string; msg: Extract<ServerMsg, { t: 'dungeon.eliteStarted' }> } => m.msg.t === 'dungeon.eliteStarted',
  )!
  for (let step = 0; step < 20; step++) {
    if (sentMessages.some((m) => m.msg.t === 'dungeon.eliteEnd')) break
    server.handle(p1, { t: 'dungeon.eliteAction', battleId: eliteStart2.msg.battleId, action: act })
  }
  sentMessages.length = 0
  server.handle(p1, { t: 'dungeon.roomMove', roomId: 'boss' })
  assert.equal(progressOf(p1Save, 'deepseek-tide').runSeq, 2)
  const raid2Start = sentMessages.find(
    (m): m is { targetId: string; msg: Extract<ServerMsg, { t: 'raid.start' }> } => m.msg.t === 'raid.start',
  )!
  for (let turn = 0; turn < 30; turn++) {
    if (sentMessages.some((m) => m.msg.t === 'raid.end')) break
    server.handle(p1, { t: 'raid.action', raidId: raid2Start.msg.raidId, action: act })
  }
  sentMessages.length = 0
  server.handle(p1, { t: 'raid.rollContract', raidId: raid2Start.msg.raidId, ballId: 'prompt-ball' })
  assert.ok(sentMessages.some((m) => m.msg.t === 'raid.contractResult'), 'new runSeq allows contract roll')

  // 10. Disconnect during active raid does not hang defeat when remaining member faints
  server.handle(p1, { t: 'dungeon.leave' })
  p1Save.party = [createCreature('phi-3', 1, { rng: new Rng(3) })]
  p1Save.party[0].hp = 1
  p2Save.party = [createCreature('o1', 80, { rng: new Rng(4) })]

  server.handle(p1, { t: 'party.start', instanceId: 'deepseek-tide', tierId: 'cluster' })
  server.handle(p2, { t: 'dungeon.roomMove', roomId: 'corridor' })
  server.handle(p2, { t: 'dungeon.eliteFight', eliteId: 'queue-guard' })
  const eliteStart3 = sentMessages.findLast(
    (m): m is { targetId: string; msg: Extract<ServerMsg, { t: 'dungeon.eliteStarted' }> } => m.msg.t === 'dungeon.eliteStarted',
  )!
  for (let step = 0; step < 20; step++) {
    if (sentMessages.some((m) => m.msg.t === 'dungeon.eliteEnd' && m.msg.battleId === eliteStart3.msg.battleId)) break
    server.handle(p2, { t: 'dungeon.eliteAction', battleId: eliteStart3.msg.battleId, action: act })
  }
  sentMessages.length = 0
  server.handle(p2, { t: 'dungeon.roomMove', roomId: 'boss' })
  const raid3Start = sentMessages.find(
    (m): m is { targetId: string; msg: Extract<ServerMsg, { t: 'raid.start' }> } => m.msg.t === 'raid.start',
  )!
  // P2 disconnects (leaving only Lv1 1HP P1 in raid)
  server.onPlayerLeave(p2)
  sentMessages.length = 0
  // P1 acts and faints -> raid immediately terminates in defeat without hanging on disconnected P2
  for (let turn = 0; turn < 10; turn++) {
    if (sentMessages.some((m) => m.msg.t === 'raid.end')) break
    server.handle(p1, { t: 'raid.action', raidId: raid3Start.msg.raidId, action: act })
  }
  const defeatEnd = sentMessages.find(
    (m): m is { targetId: string; msg: Extract<ServerMsg, { t: 'raid.end' }> } => m.msg.t === 'raid.end',
  )
  assert.ok(defeatEnd && defeatEnd.msg.victory === false, 'raid terminates in defeat when remaining connected player faints')

  server.close()
})
