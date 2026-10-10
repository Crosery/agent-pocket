// Multiplayer dungeon server adapter: party coordination, dungeon room/mechanism sync, and authoritative shared Boss Raids.
import type { BattleAction, Creature, SaveData } from '../shared/types.ts'
import type { CoopClientMsg, CoopServerMsg, PartyState, InstanceState, RaidSummary } from '../shared/coop/protocol.ts'
import { createParty, addPartyMember, removePartyMember, setMemberReady, canStartParty } from '../shared/coop/party.ts'
import { createDungeonInstance, activateMechanism, markEliteDefeated, transitionRoom } from '../shared/coop/instance.ts'
import {
  applyRaidPlayerAction,
  buildRaidSummary,
  createRaidSession,
  getRaidMemberStates,
  type RaidSession,
} from '../shared/coop/raid.ts'
import { CONTENT } from '../shared/content/index.ts'
import { GAMEPLAY } from '../shared/gameplay/data.ts'
import { rollBossCard } from '../shared/gameplay/bosscard.ts'
import {
  contractOdds,
  isOffPeakDouble,
  isTierUnlocked,
  progressOf,
  rollContractOutcome,
} from '../shared/gameplay/instances.ts'
import { Rng } from '../shared/rng.ts'
import type { HubCore, Player } from './core.ts'
import type { ProfileStore } from './store.ts'

export interface DungeonAccountStore {
  getSave?(id: string): SaveData | null
  putSave?(id: string, s: SaveData): unknown
}

export interface DungeonServerOptions {
  core: HubCore
  store?: ProfileStore | DungeonAccountStore | null
  lookupPlayer: (id: string) => Player | null
  log?: (msg: string) => void
}

export interface DungeonServer {
  handle(p: Player, msg: CoopClientMsg): void
  onPlayerLeave(p: Player): void
  close(): void
}

export function createDungeonServer(opts: DungeonServerOptions): DungeonServer {
  const { core } = opts

  const parties = new Map<string, PartyState>()
  const playerToParty = new Map<string, string>()

  const instances = new Map<string, InstanceState>()
  const playerToInstance = new Map<string, string>()

  const raids = new Map<string, RaidSession>()
  const playerToRaid = new Map<string, string>()

  // Fallback in-memory save storage when standalone without account store
  const inMemorySaves = new Map<string, SaveData>()

  function sendToPlayer(playerId: string, msg: CoopServerMsg): void {
    const player = opts.lookupPlayer(playerId)
    if (player) core.send(player, msg)
  }

  function broadcastParty(party: PartyState): void {
    for (const m of party.members) {
      sendToPlayer(m.id, { t: 'party.update', party })
    }
  }

  function broadcastInstance(inst: InstanceState): void {
    for (const memberId of inst.members) {
      sendToPlayer(memberId, { t: 'dungeon.update', instance: inst })
    }
  }

  function broadcastRaid(session: RaidSession, msg: CoopServerMsg): void {
    for (const memberId of session.members.keys()) {
      sendToPlayer(memberId, msg)
    }
  }

  function getSaveForPlayer(playerId: string): SaveData {
    const st = opts.store as DungeonAccountStore | undefined
    const external = st?.getSave?.(playerId)
    if (external) return external
    let local = inMemorySaves.get(playerId)
    if (!local) {
      local = {
        playerId,
        name: opts.lookupPlayer(playerId)?.name ?? playerId,
        money: 1000,
        bag: { 'prompt-ball': 5, 'data-shard': 0 },
        party: [],
        boxes: [[]],
        badges: [],
        dexSeen: [],
        dexCaught: [],
        flags: {},
        stats: { battlesWon: 0, caught: 0, steps: 0, pvpWins: 0, pvpLosses: 0, trades: 0, shiniesFound: 0 },
        instances: {},
      }
      inMemorySaves.set(playerId, local)
    }
    return local
  }

  function savePlayer(playerId: string, save: SaveData): void {
    const st = opts.store as DungeonAccountStore | undefined
    if (st?.putSave) {
      st.putSave(playerId, save)
    } else {
      inMemorySaves.set(playerId, save)
    }
  }

  // -------------------------------------------------------------
  // Party handlers
  // -------------------------------------------------------------

  function handlePartyCreate(p: Player): void {
    if (playerToParty.has(p.id)) {
      core.send(p, { t: 'party.error', code: 'already_in_party', message: '已在队伍中' })
      return
    }
    const partyId = `party-${p.id}-${Date.now().toString(36)}`
    const party = createParty({
      id: partyId,
      leaderId: p.id,
      leaderName: p.name,
      leaderAvatar: p.avatar,
    })
    parties.set(partyId, party)
    playerToParty.set(p.id, partyId)
    broadcastParty(party)
  }

  function handlePartyInvite(p: Player, targetId: string): void {
    const partyId = playerToParty.get(p.id)
    if (!partyId) {
      core.send(p, { t: 'party.error', code: 'no_party', message: '未加入任何队伍' })
      return
    }
    const party = parties.get(partyId)
    if (!party || party.leaderId !== p.id) {
      core.send(p, { t: 'party.error', code: 'not_leader', message: '只有队长可以邀请队员' })
      return
    }
    const target = opts.lookupPlayer(targetId)
    if (!target) {
      core.send(p, { t: 'party.error', code: 'target_offline', message: '目标玩家不在线' })
      return
    }
    if (playerToParty.has(targetId)) {
      core.send(p, { t: 'party.error', code: 'target_busy', message: '目标玩家已在其他队伍中' })
      return
    }
    core.send(target, { t: 'party.invited', from: p.id, name: p.name })
  }

  function handlePartyRespond(p: Player, fromLeaderId: string, accept: boolean): void {
    if (playerToParty.has(p.id)) return
    const leaderPlayer = opts.lookupPlayer(fromLeaderId)
    if (!leaderPlayer) return
    const partyId = playerToParty.get(fromLeaderId)
    if (!partyId) return
    const party = parties.get(partyId)
    if (!party) return

    if (!accept) {
      core.send(leaderPlayer, {
        t: 'party.error',
        code: 'invite_declined',
        message: `${p.name} 拒绝了组队邀请`,
      })
      return
    }

    const res = addPartyMember(party, { id: p.id, name: p.name, avatar: p.avatar })
    if (!res.ok) {
      core.send(p, { t: 'party.error', code: res.code, message: res.message })
      return
    }

    playerToParty.set(p.id, partyId)
    broadcastParty(party)
  }

  function handlePartyLeave(p: Player): void {
    const partyId = playerToParty.get(p.id)
    if (!partyId) return
    const party = parties.get(partyId)
    if (!party) return

    playerToParty.delete(p.id)
    core.send(p, { t: 'party.update', party: null })

    const { party: remaining } = removePartyMember(party, p.id)
    if (!remaining) {
      parties.delete(partyId)
    } else {
      broadcastParty(remaining)
    }
  }

  function handlePartyKick(p: Player, targetId: string): void {
    const partyId = playerToParty.get(p.id)
    if (!partyId) return
    const party = parties.get(partyId)
    if (!party || party.leaderId !== p.id) {
      core.send(p, { t: 'party.error', code: 'not_leader', message: '只有队长可以移出队员' })
      return
    }

    playerToParty.delete(targetId)
    const kickedPlayer = opts.lookupPlayer(targetId)
    if (kickedPlayer) core.send(kickedPlayer, { t: 'party.update', party: null })

    const { party: remaining } = removePartyMember(party, targetId)
    if (remaining) broadcastParty(remaining)
  }

  function handlePartyReady(p: Player, ready: boolean): void {
    const partyId = playerToParty.get(p.id)
    if (!partyId) return
    const party = parties.get(partyId)
    if (!party) return

    setMemberReady(party, p.id, ready)
    broadcastParty(party)
  }

  function handlePartyStart(p: Player, instanceId: string, tierId: string): void {
    const partyId = playerToParty.get(p.id)
    if (!partyId) return
    const party = parties.get(partyId)
    if (!party || party.leaderId !== p.id) {
      core.send(p, { t: 'party.error', code: 'not_leader', message: '只有队长可以开启副本' })
      return
    }

    const instDef = GAMEPLAY.instances[instanceId]
    const tierDef = instDef?.tiers[tierId]
    if (!instDef || !tierDef) {
      core.send(p, { t: 'party.error', code: 'invalid_instance', message: '未知副本或难度' })
      return
    }

    // Check unlocks and ready state
    const leaderSave = getSaveForPlayer(p.id)
    const boolFlags = Object.fromEntries(Object.entries(leaderSave.flags).map(([k, v]) => [k, Boolean(v)]))
    const check = isTierUnlocked(tierDef, leaderSave.badges, boolFlags, party.members.length)
    if (!check.unlocked) {
      core.send(p, { t: 'party.error', code: 'locked', message: check.reason ?? '难度未解锁' })
      return
    }

    if (!canStartParty(party, tierDef.coop?.minPlayers ?? 1)) {
      core.send(p, { t: 'party.error', code: 'not_all_ready', message: '还有队员尚未准备就绪' })
      return
    }

    party.dungeon = { instanceId, tierId }

    const instStateId = `inst-${party.id}-${Date.now().toString(36)}`
    const instState = createDungeonInstance({
      id: instStateId,
      instanceId,
      tierId,
      def: instDef,
      memberIds: party.members.map((m) => m.id),
    })

    instances.set(instStateId, instState)
    for (const m of party.members) {
      playerToInstance.set(m.id, instStateId)
    }

    broadcastInstance(instState)
  }

  function handlePartyDisband(p: Player): void {
    const partyId = playerToParty.get(p.id)
    if (!partyId) return
    const party = parties.get(partyId)
    if (!party || party.leaderId !== p.id) return

    for (const m of party.members) {
      playerToParty.delete(m.id)
      sendToPlayer(m.id, { t: 'party.update', party: null })
    }
    parties.delete(partyId)
  }

  // -------------------------------------------------------------
  // Dungeon Instance handlers
  // -------------------------------------------------------------

  function handleDungeonEnter(p: Player, instanceId: string, tierId: string): void {
    // Solo dungeon entry (N=1)
    if (playerToInstance.has(p.id)) return
    const instDef = GAMEPLAY.instances[instanceId]
    const tierDef = instDef?.tiers[tierId]
    if (!instDef || !tierDef) {
      core.send(p, { t: 'dungeon.error', code: 'invalid_instance', message: '未知副本或难度' })
      return
    }

    const save = getSaveForPlayer(p.id)
    const boolFlags = Object.fromEntries(Object.entries(save.flags).map(([k, v]) => [k, Boolean(v)]))
    const check = isTierUnlocked(tierDef, save.badges, boolFlags, 1)
    if (!check.unlocked) {
      core.send(p, { t: 'dungeon.error', code: 'locked', message: check.reason ?? '难度未解锁' })
      return
    }

    const instStateId = `inst-solo-${p.id}-${Date.now().toString(36)}`
    const instState = createDungeonInstance({
      id: instStateId,
      instanceId,
      tierId,
      def: instDef,
      memberIds: [p.id],
    })

    instances.set(instStateId, instState)
    playerToInstance.set(p.id, instStateId)
    broadcastInstance(instState)
  }

  function handleDungeonRoomMove(p: Player, roomId: string): void {
    const instId = playerToInstance.get(p.id)
    if (!instId) return
    const inst = instances.get(instId)
    if (!inst) return

    const res = transitionRoom(inst, roomId)
    if (!res.ok) {
      core.send(p, { t: 'dungeon.error', code: res.code, message: res.message })
      return
    }

    for (const memberId of inst.members) {
      sendToPlayer(memberId, { t: 'dungeon.roomChanged', roomId })
    }
    broadcastInstance(inst)

    // Entering boss room initiates Boss Raid
    const instDef = GAMEPLAY.instances[inst.instanceId]
    if (instDef && roomId === 'boss' && !raids.has(inst.id)) {
      startRaidForInstance(inst, instDef)
    }
  }

  function handleDungeonMechanism(p: Player, mechanismId: string): void {
    const instId = playerToInstance.get(p.id)
    if (!instId) return
    const inst = instances.get(instId)
    if (!inst) return

    const res = activateMechanism(inst, inst.currentRoom, mechanismId)
    if (!res.ok) {
      core.send(p, { t: 'dungeon.error', code: res.code, message: res.message })
      return
    }

    for (const memberId of inst.members) {
      sendToPlayer(memberId, { t: 'dungeon.mechanismActivated', mechanismId, by: p.name })
    }
    broadcastInstance(inst)
  }

  function handleDungeonEliteFight(p: Player, eliteId: string): void {
    const instId = playerToInstance.get(p.id)
    if (!instId) return
    const inst = instances.get(instId)
    if (!inst) return

    const res = markEliteDefeated(inst, inst.currentRoom, eliteId)
    if (!res.ok) {
      core.send(p, { t: 'dungeon.error', code: res.code, message: res.message })
      return
    }

    for (const memberId of inst.members) {
      sendToPlayer(memberId, { t: 'dungeon.eliteDefeated', eliteId, by: p.name })
    }
    broadcastInstance(inst)
  }

  function handleDungeonLeave(p: Player): void {
    const instId = playerToInstance.get(p.id)
    if (!instId) return
    const inst = instances.get(instId)
    if (!inst) return

    playerToInstance.delete(p.id)
    playerToRaid.delete(p.id)

    const idx = inst.members.indexOf(p.id)
    if (idx !== -1) inst.members.splice(idx, 1)

    core.send(p, { t: 'dungeon.update', instance: null })
    if (inst.members.length === 0) {
      instances.delete(instId)
      raids.delete(instId)
    } else {
      broadcastInstance(inst)
    }
  }

  // -------------------------------------------------------------
  // Boss Raid handlers
  // -------------------------------------------------------------

  function startRaidForInstance(inst: InstanceState, def: typeof GAMEPLAY.instances[string]): void {
    const raidMembers = inst.members.map((id) => {
      const pl = opts.lookupPlayer(id)
      const sv = getSaveForPlayer(id)
      return {
        id,
        name: pl?.name ?? sv.name ?? id,
        avatar: pl?.avatar ?? 'sprite-hero',
        party: sv.party.length > 0 ? sv.party : [createPlaceholderCreature(id)],
      }
    })

    const tierDef = def.tiers[inst.tierId]
    const session = createRaidSession({
      raidId: inst.id,
      instanceId: inst.instanceId,
      tierId: inst.tierId,
      bossId: def.boss,
      hpScaleExp: tierDef?.coop?.hpScaleExp ?? 0.8,
      minContribution: tierDef?.coop?.minContribution ?? 10,
      members: raidMembers,
    })

    raids.set(inst.id, session)
    for (const m of raidMembers) {
      playerToRaid.set(m.id, inst.id)
    }

    const memberStates = getRaidMemberStates(session)
    let sideIdx = 0
    for (const m of raidMembers) {
      sendToPlayer(m.id, {
        t: 'raid.start',
        raidId: session.raidId,
        boss: session.boss,
        members: memberStates,
        yourSide: sideIdx++,
      })
    }
  }

  function createPlaceholderCreature(otId: string): Creature {
    return {
      uid: `raid-starter-${otId}`,
      speciesId: 'deepseek-v4',
      level: 15,
      exp: 0,
      hp: 80,
      maxHp: 80,
      ivs: { hp: 15, atk: 15, def: 15, spa: 15, spd: 15, spe: 15 },
      nature: 'balanced',
      abilityId: 'peak-valley',
      moves: [{ id: 'tensor-tackle', pp: 20, ppMax: 20 }],
      shiny: false,
      otId,
      otName: 'Trainer',
    }
  }

  function handleRaidAction(p: Player, action: BattleAction): void {
    const raidId = playerToRaid.get(p.id)
    if (!raidId) return
    const session = raids.get(raidId)
    if (!session || session.ended) return

    const { events, ended, victory } = applyRaidPlayerAction(session, p.id, action)
    const memberStates = getRaidMemberStates(session)

    broadcastRaid(session, {
      t: 'raid.tick',
      raidId: session.raidId,
      boss: session.boss,
      members: memberStates,
      events,
    })

    if (ended) {
      const summary = buildRaidSummary(session)
      broadcastRaid(session, {
        t: 'raid.end',
        raidId: session.raidId,
        victory,
        summary,
      })

      if (victory) {
        settleRaidVictory(session, summary)
      }
    }
  }

  function settleRaidVictory(session: RaidSession, summary: RaidSummary): void {
    const instDef = GAMEPLAY.instances[session.instanceId]
    const tierDef = instDef?.tiers[session.tierId]
    if (!instDef || !tierDef) return

    const offPeak = isOffPeakDouble()

    for (const mem of summary.members) {
      if (!mem.qualified) continue
      const save = getSaveForPlayer(mem.id)
      const prog = progressOf(save, session.instanceId)
      const first = (prog.clears[session.tierId] ?? 0) === 0

      prog.clears[session.tierId] = (prog.clears[session.tierId] ?? 0) + 1
      prog.losses[session.tierId] = 0

      let shards = (first ? tierDef.reward.shards : tierDef.repeat.shards) ?? 0
      if (tierDef.reward.jackpot && Math.random() < tierDef.reward.jackpot.chance) {
        shards *= tierDef.reward.jackpot.mul
      }
      if (offPeak) shards *= 2

      save.bag ??= {}
      if (shards > 0) {
        save.bag['data-shard'] = (save.bag['data-shard'] ?? 0) + shards
      }

      const moneyGain = offPeak
        ? (first ? (tierDef.reward.money ?? 0) * 2 : (tierDef.repeat.money ?? 0) * 2)
        : (first ? (tierDef.reward.money ?? 0) : (tierDef.repeat.money ?? 0))
      save.money = (save.money ?? 0) + (moneyGain ?? 0)

      if (first && tierDef.firstReward.items) {
        for (const [it, qty] of Object.entries(tierDef.firstReward.items)) {
          save.bag[it] = (save.bag[it] ?? 0) + (qty ?? 1)
        }
      }

      savePlayer(mem.id, save)
    }
  }

  function handleRaidRollContract(p: Player, ballId: string): void {
    const raidId = playerToRaid.get(p.id)
    if (!raidId) return
    const session = raids.get(raidId)
    if (!session || !session.ended || !session.victory) return

    const summary = buildRaidSummary(session)
    const mem = summary.members.find((m) => m.id === p.id)
    if (!mem || !mem.qualified) {
      core.send(p, {
        t: 'raid.error',
        code: 'not_qualified',
        message: '贡献度不足，无法参与本次签约',
      })
      return
    }

    const instDef = GAMEPLAY.instances[session.instanceId]
    const tierDef = instDef?.tiers[session.tierId]
    if (!instDef || !tierDef) return

    const save = getSaveForPlayer(p.id)
    const prog = progressOf(save, session.instanceId)
    const first = (prog.captures[session.tierId] ?? 0) === 0

    if (!first && !tierDef.repeat.capture) {
      core.send(p, {
        t: 'raid.error',
        code: 'no_repeat_capture',
        message: '该难度不支持重复签约',
      })
      return
    }

    if (prog.lastRollRun?.[session.tierId] !== undefined && prog.lastRollRun[session.tierId] === prog.runSeq) {
      core.send(p, {
        t: 'raid.error',
        code: 'already_rolled',
        message: '本轮已经完成签约掷骰',
      })
      return
    }

    prog.lastRollRun ??= {}
    prog.lastRollRun[session.tierId] = prog.runSeq

    const ballBonus = CONTENT.quality.capture.ballBonus[ballId] ?? 0
    const isMaster = ballId === CONTENT.quality.capture.masterBall
    const curPity = prog.pity?.[session.tierId] ?? 0
    const odds = contractOdds(tierDef, ballBonus, !first, curPity)

    const rng = new Rng((Date.now() ^ 0x5bd1e995) >>> 0)
    const success = first || isMaster || odds.guaranteed || rollContractOutcome(rng, odds.chance)

    if (success) {
      prog.pity ??= {}
      prog.pity[session.tierId] = 0
      prog.captures[session.tierId] = (prog.captures[session.tierId] ?? 0) + 1

      const card = rollBossCard(rng, instDef.boss, session.tierId, tierDef, {
        first,
        run: String(prog.runSeq),
        at: Date.now(),
        otName: save.name,
        otId: save.playerId,
        ballId,
      }, CONTENT)

      if (save.party.length < CONTENT.config.party.maxParty) {
        save.party.push(card)
      } else {
        save.boxes ??= [[]]
        if (!save.boxes.length) save.boxes.push([])
        save.boxes[save.boxes.length - 1].push(card)
      }
      savePlayer(p.id, save)

      core.send(p, {
        t: 'raid.contractResult',
        raidId: session.raidId,
        memberId: p.id,
        success: true,
        card,
        pity: 0,
      })
    } else {
      prog.pity ??= {}
      prog.pity[session.tierId] = curPity + 1
      const failShard = tierDef.repeat.shards ?? GAMEPLAY.instanceDefaults.failShardQty ?? 1
      save.bag ??= {}
      save.bag['data-shard'] = (save.bag['data-shard'] ?? 0) + failShard
      savePlayer(p.id, save)

      core.send(p, {
        t: 'raid.contractResult',
        raidId: session.raidId,
        memberId: p.id,
        success: false,
        shardsAwarded: failShard,
        pity: prog.pity[session.tierId],
      })
    }
  }

  // -------------------------------------------------------------
  // Message dispatcher
  // -------------------------------------------------------------

  function handle(p: Player, msg: CoopClientMsg): void {
    switch (msg.t) {
      case 'party.create': handlePartyCreate(p); return
      case 'party.invite': handlePartyInvite(p, msg.to); return
      case 'party.respond': handlePartyRespond(p, msg.from, msg.accept); return
      case 'party.leave': handlePartyLeave(p); return
      case 'party.kick': handlePartyKick(p, msg.targetId); return
      case 'party.ready': handlePartyReady(p, msg.ready); return
      case 'party.start': handlePartyStart(p, msg.instanceId, msg.tierId); return
      case 'party.disband': handlePartyDisband(p); return
      case 'dungeon.enter': handleDungeonEnter(p, msg.instanceId, msg.tierId); return
      case 'dungeon.roomMove': handleDungeonRoomMove(p, msg.roomId); return
      case 'dungeon.mechanism': handleDungeonMechanism(p, msg.mechanismId); return
      case 'dungeon.eliteFight': handleDungeonEliteFight(p, msg.eliteId); return
      case 'dungeon.leave': handleDungeonLeave(p); return
      case 'raid.action': handleRaidAction(p, msg.action); return
      case 'raid.rollContract': handleRaidRollContract(p, msg.ballId); return
    }
  }

  function onPlayerLeave(p: Player): void {
    handlePartyLeave(p)
    handleDungeonLeave(p)
  }

  function close(): void {
    parties.clear()
    playerToParty.clear()
    instances.clear()
    playerToInstance.clear()
    raids.clear()
    playerToRaid.clear()
  }

  return {
    handle,
    onPlayerLeave,
    close,
  }
}
