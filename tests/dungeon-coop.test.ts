import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import { GAMEPLAY } from '../src/shared/gameplay/data.ts'
import type { BattleAction, BattleEvent, BattleInit, SaveData } from '../src/shared/types.ts'
import type { GameContext } from '../src/client/contracts.ts'
import { createCreature, legalMoves } from '../src/shared/creature.ts'
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
  getActualDungeons,
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
  canMemberRollContract,
  createRaidSession,
  disconnectRaidMember,
  isMemberSettled,
  recordMemberContractRoll,
  recordMemberSettled,
  rejoinRaidMember,
  scaleBossHp,
} from '../src/shared/coop/raid.ts'
import { createDungeonRuntime, type DungeonAuthority, type DungeonPlayer } from '../src/shared/coop/runtime.ts'
import type { CoopClientMsg, CoopServerMsg } from '../src/shared/coop/protocol.ts'
import { createDungeonServer } from '../src/server/dungeon.ts'
import type { HubCore, Player } from '../src/server/core.ts'
import type { ServerMsg } from '../src/shared/protocol.ts'
import { signContract } from '../src/client/battle/contract.ts'
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

  // Story repeat: 35%, pity 3
  const storyOdds = contractOdds(storyTier, 0, true, 0)
  assert.equal(storyOdds.chance, 0.35)
  assert.equal(storyOdds.maxPity, 3)
  assert.equal(storyOdds.guaranteed, false)
  assert.ok(storyOdds.avgAttempts > 1 && storyOdds.avgAttempts < storyOdds.maxPity)

  // Pity guarantee at count >= 3
  const storyPityOdds = contractOdds(storyTier, 0, true, 3)
  assert.equal(storyPityOdds.chance, 1.0)
  assert.equal(storyPityOdds.guaranteed, true)

  // Hard repeat: 25%, pity 4
  const hardOdds = contractOdds(hardTier, 0, true, 0)
  assert.equal(hardOdds.chance, 0.25)
  assert.equal(hardOdds.maxPity, 4)
  assert.ok(hardOdds.avgAttempts > storyOdds.avgAttempts && hardOdds.avgAttempts < hardOdds.maxPity)

  // Full repeat: 15%, pity 5
  const fullOdds = contractOdds(fullTier, 0, true, 0)
  assert.equal(fullOdds.chance, 0.15)
  assert.equal(fullOdds.maxPity, 5)
  assert.ok(fullOdds.avgAttempts > hardOdds.avgAttempts && fullOdds.avgAttempts < fullOdds.maxPity)
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

  const p1Cr = createCreature('agi', 95, { rng: new Rng(10) })
  const p2Cr = createCreature('claude-fable', 95, { rng: new Rng(20) })

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
    members: [{ id: 'u1', name: 'Alice', avatar: 'hero', party: [createCreature('agi', 95, { rng: new Rng(10) })] }],
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

  // Force boss HP to 150 in valley state to test victory and >=10% contribution qualification
  session.bossState.meters.tide = 1
  session.bossState.hp = 150
  session.boss.hp = 150
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
      clientBusy: false,
      pvpBusy: false,
      dungeonBusy: false,
      tradeId: null,
      closed: false,
      state: { map: 'origin-lab-b1', x: 13, y: 3 } as never,
    }) as unknown as Player

  const p1 = makePlayer('c1', '玩家一')
  const p2 = makePlayer('c2', '玩家二')
  const pUntrusted = makePlayer('c3', '导入玩家')

  const p1Save = newTestSave(p1.id, p1.name)
  p1Save.badges = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']
  p1Save.party = [
    createCreature('agi', 100, { rng: new Rng(1) }),
    createCreature('claude-fable', 100, { rng: new Rng(11) }),
  ]
  p1Save.bag = { 'prompt-ball': 3, 'few-shot-ball': 2, 'data-shard': 0 }

  const p2Save = newTestSave(p2.id, p2.name)
  p2Save.badges = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']
  p2Save.party = [
    createCreature('agi', 100, { rng: new Rng(2) }),
    createCreature('claude-fable', 100, { rng: new Rng(12) }),
  ]

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
    isInBattle: () => false,
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
  p2Save.party = [createCreature('agi', 100, { rng: new Rng(4) })]

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

test('raid engine regression: individual wipeout with surviving teammate preserves scaled maxHp and form without corrupting shared state', () => {
  // P1 has a fragile Lv1 creature that will faint; P2 has a high-level creature with plenty of HP
  const p1Cr = createCreature('phi-3', 1, { rng: new Rng(1) })
  p1Cr.hp = 1
  const p2Cr = createCreature('agi', 95, { rng: new Rng(2) })

  const session = createRaidSession({
    raidId: 'raid-wipeout-test',
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

  const initialMaxHp = session.bossState.maxHp
  const initialForm = session.bossState.form
  const initialSpecies = session.bossState.speciesId

  assert.ok(initialMaxHp > 1000, `expected scaled max HP > 1000, got ${initialMaxHp}`)

  // P1 takes action and faints from Boss counter-attack
  const p1Session = session.members.get('u1')!
  const p2Session = session.members.get('u2')!

  applyRaidPlayerAction(session, 'u1', { kind: 'move', moveIndex: 0 })

  // P1 engine finished (wiped out)
  assert.equal(p1Session.engine.finished, true, 'P1 engine must be finished after wipeout')
  assert.equal(p1Session.engine.result, 'lose', 'P1 engine result must be lose')

  // Surviving teammate keeps the raid active
  assert.equal(session.ended, false, 'session must NOT end while P2 is still alive')
  assert.equal(session.victory, false)

  // Shared bossState must preserve scaled maxHp and authoritative form/species
  assert.equal(session.bossState.maxHp, initialMaxHp, 'bossState.maxHp must NOT collapse to unscaled creature plainMaxHp')
  assert.equal(session.bossState.form, initialForm, 'boss form must be preserved')
  assert.equal(session.bossState.speciesId, initialSpecies, 'boss speciesId must be preserved')
  assert.ok(session.bossState.hp > 0, 'boss must still have HP')

  // P2 engine must retain scaled maxHp and live boss HP
  const p2BossView = p2Session.engine.activeView(1)
  assert.equal(p2BossView.maxHp, initialMaxHp, 'P2 engine boss view maxHp must match scaled maxHp')
  assert.equal(p2BossView.hp, session.bossState.hp, 'P2 engine boss view hp must match shared bossState.hp')
  assert.equal(p2Session.engine.finished, false, 'P2 engine must still be active')

  // P2 acts and deals damage without phantom damage or corrupt state
  const prevHp = session.bossState.hp
  applyRaidPlayerAction(session, 'u2', { kind: 'move', moveIndex: 0 })
  assert.equal(session.bossState.maxHp, initialMaxHp, 'maxHp must remain scaled after P2 action')
  assert.ok(session.bossState.hp < prevHp, 'boss HP must decrease after P2 attack')
  assert.equal(p2Session.damageDealt, prevHp - session.bossState.hp, 'P2 damageDealt must equal exact HP delta')
})

test('raid engine regression: killing blow contribution is exact and does not suffer phantom damage loss', () => {
  const p1Cr = createCreature('agi', 95, { rng: new Rng(11) })
  const p2Cr = createCreature('agi', 95, { rng: new Rng(22) })

  const session = createRaidSession({
    raidId: 'raid-kill-test',
    instanceId: 'deepseek-tide',
    tierId: 'cluster',
    bossId: 'deepseek',
    hpScaleExp: 0.8,
    minContribution: 10,
    activeMechanisms: ['load-breaker'],
    members: [
      { id: 'u1', name: 'Alice', avatar: 'hero', party: [p1Cr] },
      { id: 'u2', name: 'Bob', avatar: 'hero', party: [p2Cr] },
    ],
  })

  const scaledMaxHp = session.bossState.maxHp
  const p2Session = session.members.get('u2')!

  // Force remaining Boss HP to exactly 150
  session.bossState.hp = 150
  session.boss.hp = 150
  p2Session.engine.applyBossState(session.bossState)

  const dmgBefore = p2Session.damageDealt
  const res = applyRaidPlayerAction(session, 'u2', { kind: 'move', moveIndex: 0 })

  assert.equal(res.ended, true, 'raid must end on killing blow')
  assert.equal(res.victory, true, 'raid must be victory on killing blow')
  assert.equal(session.ended, true)
  assert.equal(session.victory, true)
  assert.equal(session.bossState.hp, 0, 'boss HP must be 0')
  assert.equal(session.bossState.maxHp, scaledMaxHp, 'boss maxHp must NOT collapse across restore() on killing blow')

  // Killer must receive the exact 150 damage, not shrunken by plainMaxHp / scaledMaxHp (~15)
  const dmgDelta = p2Session.damageDealt - dmgBefore
  assert.equal(dmgDelta, 150, `killing blow contribution must be exact 150, got ${dmgDelta}`)

  const summary = buildRaidSummary(session)
  assert.equal(summary.victory, true)
  const p2Summary = summary.members.find((m) => m.id === 'u2')
  assert.ok(p2Summary && p2Summary.qualified, 'killer must qualify for rewards')
})

test('raid engine regression: scaled startup and rejoin visible events reflect scaled HP and mechanism meters', () => {
  const p1Cr = createCreature('o1', 25, { rng: new Rng(31) })
  const p2Cr = createCreature('phi-3', 25, { rng: new Rng(32) })

  const session = createRaidSession({
    raidId: 'raid-events-test',
    instanceId: 'deepseek-tide',
    tierId: 'cluster',
    bossId: 'deepseek',
    hpScaleExp: 0.8,
    members: [
      { id: 'u1', name: 'Alice', avatar: 'hero', party: [p1Cr] },
      { id: 'u2', name: 'Bob', avatar: 'hero', party: [p2Cr] },
    ],
    activeMechanisms: ['load-breaker'],
  })

  const p1Session = session.members.get('u1')!
  const p2Session = session.members.get('u2')!
  const scaledMaxHp = session.bossState.maxHp

  // 1. Initial intro events must show scaled maxHp in switch event and active mechanism meters in boss event
  const p1BossSwitch = p1Session.intro.find(
    (e): e is Extract<typeof e, { t: 'switch' }> => e.t === 'switch' && e.side === 1,
  )
  assert.ok(p1BossSwitch, 'intro must have side 1 switch event')
  assert.equal(p1BossSwitch.creature.hp, scaledMaxHp, 'intro boss switch event hp must be scaled')
  assert.equal(p1BossSwitch.creature.maxHp, scaledMaxHp, 'intro boss switch event maxHp must be scaled')

  const p1BossHud = p1Session.intro.find(
    (e): e is Extract<typeof e, { t: 'boss' }> => e.t === 'boss' && e.side === 1,
  )
  assert.ok(p1BossHud, 'intro must have side 1 boss hud event')
  assert.equal(p1BossHud.hud.meters.tide, 1, 'intro boss hud must include load-breaker mechanism meter')
  assert.equal(p1Session.engine.flush().length, 0, 'engine output queue must be cleanly flushed')

  // 2. Mid-battle rejoin must update intro and init to current scaled HP and meters
  const damagedHp = Math.round(scaledMaxHp * 0.6)
  session.bossState.hp = damagedHp
  session.boss.hp = damagedHp
  session.bossState.meters.tide = 3

  assert.equal(disconnectRaidMember(session, 'u2').ended, false)
  assert.equal(rejoinRaidMember(session, { id: 'u2', name: 'Bob', avatar: 'hero' }), true)

  // Rejoin must update side-1 party in init
  assert.equal(p2Session.init.sides[1].party[0].hp, damagedHp, 'rejoin init must show current boss HP')

  // Rejoin must update intro switch and boss hud events
  const p2BossSwitch = p2Session.intro.find(
    (e): e is Extract<typeof e, { t: 'switch' }> => e.t === 'switch' && e.side === 1,
  )
  assert.ok(p2BossSwitch)
  assert.equal(p2BossSwitch.creature.hp, damagedHp, 'rejoin intro switch event must reflect current boss HP')
  assert.equal(p2BossSwitch.creature.maxHp, scaledMaxHp, 'rejoin intro switch event must retain scaled maxHp')

  const p2BossHud = p2Session.intro.find(
    (e): e is Extract<typeof e, { t: 'boss' }> => e.t === 'boss' && e.side === 1,
  )
  assert.ok(p2BossHud)
  assert.equal(p2BossHud.hud.meters.tide, 3, 'rejoin intro boss hud must reflect updated mechanism meter')
})

test('raid engine regression: recharge moves auto-drain so player request is actionable or terminal, preventing UI forfeit', () => {
  // perplexity-computer legitimately learns the recharge move long-horizon (Lv64) and owns the retrieval ability
  const p1Cr = createCreature('perplexity-computer', 100, { rng: new Rng(41), moves: ['long-horizon'] })
  p1Cr.abilityId = 'retrieval'
  assert.ok(CONTENT.species[p1Cr.speciesId].abilities.includes(p1Cr.abilityId))
  assert.ok(legalMoves(p1Cr.speciesId, p1Cr.level).has('long-horizon'))
  const session = createRaidSession({
    raidId: 'raid-recharge-test',
    instanceId: 'deepseek-tide',
    tierId: 'cluster',
    bossId: 'deepseek',
    hpScaleExp: 0.8,
    members: [{ id: 'u1', name: 'Alice', avatar: 'hero', party: [p1Cr] }],
  })

  const p1Session = session.members.get('u1')!
  assert.equal(p1Session.engine.request(0).kind, 'action')

  // Use recharge move
  const res = applyRaidPlayerAction(session, 'u1', { kind: 'move', moveIndex: 0 })

  // Auto-drain must advance through the recharge wait turn
  assert.ok(res.events.length > 0)
  assert.ok(
    res.events.some((e) => (e.t === 'msg' && String(e.text).includes('recharge')) || e.t === 'msg' || e.t === 'damage'),
    'events must include actions from attack and recharge turn',
  )

  // Engine request must NOT be stuck in 'wait'
  const postReq = p1Session.engine.request(0)
  assert.notEqual(postReq.kind, 'wait', 'engine request must NOT be "wait" after recharge auto-drain')
  assert.ok(postReq.kind === 'action' || postReq.kind === 'switch' || p1Session.engine.finished, 'must progress to actionable or terminal state')
})

test('raid engine regression: session identity, runSeq binding, contract rolls and settlement are isolated per member', () => {
  const p1Cr = createCreature('o1', 25, { rng: new Rng(51) })
  const p2Cr = createCreature('phi-3', 25, { rng: new Rng(52) })

  const session = createRaidSession({
    raidId: 'raid-identity-test',
    instanceId: 'deepseek-tide',
    tierId: 'cluster',
    bossId: 'deepseek',
    hpScaleExp: 0.8,
    members: [
      { id: 'u1', name: 'Alice', avatar: 'hero', party: [p1Cr] },
      { id: 'u2', name: 'Bob', avatar: 'hero', party: [p2Cr] },
    ],
  })

  // 1. Initial collection identity fields
  assert.ok(session.runSeqByMember instanceof Map)
  assert.ok(session.rolledMembers instanceof Set)
  assert.ok(session.settledMembers instanceof Set)
  assert.equal(session.rolledMembers.size, 0)
  assert.equal(session.settledMembers.size, 0)

  // 2. Bound runSeq per member
  session.runSeqByMember.set('u1', 1)
  session.runSeqByMember.set('u2', 4)
  assert.equal(session.runSeqByMember.get('u1'), 1)
  assert.equal(session.runSeqByMember.get('u2'), 4)
  assert.equal(session.runSeqByMember.get('u3'), undefined)

  // 3. Contract roll deduplication per member
  session.victory = true
  assert.equal(canMemberRollContract(session, 'u1'), true)
  assert.equal(canMemberRollContract(session, 'u2'), true)

  recordMemberContractRoll(session, 'u1')
  assert.equal(canMemberRollContract(session, 'u1'), false, 'u1 cannot re-roll contract')
  assert.equal(canMemberRollContract(session, 'u2'), true, 'u2 roll eligibility is isolated from u1')

  recordMemberContractRoll(session, 'u2')
  assert.equal(canMemberRollContract(session, 'u2'), false, 'u2 cannot re-roll contract after rolling')

  // 4. Victory settlement per member
  assert.equal(isMemberSettled(session, 'u1'), false)
  recordMemberSettled(session, 'u1')
  assert.equal(isMemberSettled(session, 'u1'), true)
  assert.equal(isMemberSettled(session, 'u2'), false, 'u2 settlement is isolated from u1')
})

test('offline dungeon runtime: real battles, room gates, mechanism, one-shot contracts, repeat rewards and daily counters', () => {
  const save = newTestSave('offline-hero-1', '离线训练家')
  save.position = { map: 'origin-lab-b1', x: 13, y: 4, facing: 'up' }
  save.party = [
    createCreature('agi', 95, { rng: new Rng(77) }),
    createCreature('claude-fable', 95, { rng: new Rng(88) }),
  ]
  save.bag = { 'prompt-ball': 5, 'data-shard': 0 }
  save.money = 1000
  const player: DungeonPlayer = {
    id: save.playerId, name: save.name, avatar: save.avatar,
    closed: false, pvpBusy: false, tradeId: null, dungeonBusy: false,
    state: { map: save.position.map, x: 13, y: 4 },
  }
  const messages: CoopServerMsg[] = []
  const persisted: string[] = []
  const runtime = createDungeonRuntime({
    allowParties: false,
    lookupPlayer: (id) => id === player.id ? player : null,
    send: (_player, msg) => { messages.push(structuredClone(msg)) },
    authority: {
      getSave: (id) => id === player.id ? save : null,
      isUntrustedImport: () => false,
      isInBattle: () => false,
      mutateSave(id, ref, fn) {
        assert.equal(id, player.id)
        const result = fn(save)
        persisted.push(ref)
        return result
      },
    },
  })
  const send = (msg: CoopClientMsg) => runtime.handle(player, msg)
  function message<T extends CoopServerMsg['t']>(type: T, from = 0): Extract<CoopServerMsg, { t: T }> {
    const found = messages.slice(from).find((m) => m.t === type)
    assert.ok(found, `expected ${type}; received ${messages.slice(from).map((m) => m.t).join(', ')}`)
    return found as Extract<CoopServerMsg, { t: T }>
  }
  function completeRun(tierId: string, mechanism: boolean): string {
    const start = messages.length
    send({ t: 'dungeon.enter', instanceId: 'deepseek-tide', tierId })
    const instance = message('dungeon.update', start).instance
    assert.ok(instance)
    assert.equal(instance.currentRoom, 'lobby')
    send({ t: 'dungeon.roomMove', roomId: 'boss' })
    assert.equal(message('dungeon.error', start).code, 'room_not_cleared')
    send({ t: 'dungeon.roomMove', roomId: 'corridor' })
    assert.equal(message('dungeon.roomChanged', start).roomId, 'corridor')
    if (mechanism) {
      send({ t: 'dungeon.mechanism', mechanismId: 'load-breaker' })
      assert.equal(message('dungeon.mechanismActivated', start).mechanismId, 'load-breaker')
    }
    send({ t: 'dungeon.eliteFight', eliteId: 'queue-guard' })
    const elite = message('dungeon.eliteStarted', start)
    assert.equal(player.dungeonBusy, true)
    for (let turn = 0; turn < 30 && !messages.slice(start).some((m) => m.t === 'dungeon.eliteEnd'); turn++) {
      send({ t: 'dungeon.eliteAction', battleId: elite.battleId, action: { kind: 'move', moveIndex: 0 } })
    }
    assert.equal(message('dungeon.eliteEnd', start).result, 'win')
    assert.ok(message('dungeon.eliteEvents', start).events.some((e) => e.t === 'damage'))
    assert.equal(player.dungeonBusy, false)
    const bossFrom = messages.length
    send({ t: 'dungeon.roomMove', roomId: 'boss' })
    const raid = message('raid.start', bossFrom)
    assert.ok(raid.events)
    assert.equal(raid.raidId, instance.id)
    if (mechanism) {
      const hud = raid.events.find((e) => e.t === 'boss' && e.side === 1)
      assert.ok(hud?.t === 'boss')
      assert.equal(hud.hud.meters.tide, 1)
    }
    for (let turn = 0; turn < 30 && !messages.slice(bossFrom).some((m) => m.t === 'raid.end'); turn++) {
      send({ t: 'raid.action', raidId: raid.raidId, action: { kind: 'move', moveIndex: 0 } })
    }
    const end = message('raid.end', bossFrom)
    assert.equal(end.victory, true)
    assert.equal(end.summary.members[0].qualified, true)
    assert.equal(player.dungeonBusy, false)
    return raid.raidId
  }
  try {
    send({ t: 'party.create' })
    assert.equal(message('party.error').code, 'offline')
    const lockedFrom = messages.length
    send({ t: 'dungeon.enter', instanceId: 'deepseek-tide', tierId: 'cluster' })
    assert.ok(message('dungeon.error', lockedFrom))
    const firstId = completeRun('story', true)
    const progress = progressOf(save, 'deepseek-tide')
    assert.equal(progress.runSeq, 1)
    assert.equal(progress.clears.story, 1)
    assert.equal(save.flags['bossWon:deepseek'], true)
    assert.ok(progress.achievements?.includes('clear-story'))
    assert.ok(save.money > 1000)
    assert.ok(save.bag['data-shard'] >= 2)
    assert.equal(save.bag['off-peak-coupon'], 2)
    assert.equal(progress.day?.rewards, 1)
    assert.ok(persisted.includes('dungeon:deepseek-tide'))
    const partySize = save.party.length
    send({ t: 'raid.rollContract', raidId: firstId, ballId: 'prompt-ball' })
    assert.equal(message('raid.contractResult').success, true)
    assert.equal(save.bag['prompt-ball'], 4)
    assert.equal(save.party.length, partySize + 1)
    assert.equal(progress.captures.story, 1)
    assert.equal(progress.lastRollRun?.story, 1)
    assert.equal(progress.day?.rolls, 1)
    const replayFrom = messages.length
    send({ t: 'raid.rollContract', raidId: firstId, ballId: 'prompt-ball' })
    assert.equal(message('raid.error', replayFrom).code, 'already_rolled')
    assert.equal(save.bag['prompt-ball'], 4)
    send({ t: 'dungeon.leave' })
    const moneyBeforeRepeat = save.money
    const secondId = completeRun('story', false)
    assert.equal(progress.runSeq, 2)
    assert.equal(progress.clears.story, 2)
    assert.equal(progress.day?.rewards, 2)
    assert.ok(save.money > moneyBeforeRepeat)
    assert.equal(save.bag['off-peak-coupon'], 2, 'first-clear gift must not repeat')
    const noRepeatFrom = messages.length
    send({ t: 'raid.rollContract', raidId: secondId, ballId: 'prompt-ball' })
    assert.equal(message('raid.error', noRepeatFrom).code, 'no_repeat_capture')
    assert.equal(save.bag['prompt-ball'], 4)
    send({ t: 'dungeon.leave' })
    save.badges = ['badge-code', 'badge-vision', 'badge-sound', 'badge-search']
    const hardId = completeRun('hard', true)
    assert.equal(progress.runSeq, 3)
    assert.equal(progress.clears.hard, 1)
    send({ t: 'raid.rollContract', raidId: hardId, ballId: 'prompt-ball' })
    assert.equal(save.bag['prompt-ball'], 3)
    assert.equal(progress.day?.rolls, 2)
  } finally {
    runtime.close()
  }
})
