// Portable dungeon coordinator runtime: party coordination (when enabled), multi-room progression,
// mechanism activation, authoritative elite battles, shared/solo Boss Raids, and reward/contract settlement.
import gameJson from '../../../content/game.json' with { type: 'json' }
import type { BattleAction, BattleEvent, BattleInit, BattleRequest, Creature, SaveData } from '../types.ts'
import type { CoopClientMsg, CoopServerMsg, InstanceState, PartyState, RaidSummary } from './protocol.ts'
import { addPartyMember, canStartParty, createParty, removePartyMember, setMemberReady } from './party.ts'
import {
  activateMechanism,
  createDungeonInstance,
  getEliteDef,
  getRoomDef,
  getRoomEliteIds,
  markEliteDefeated,
  transitionRoom,
} from './instance.ts'
import {
  applyRaidPlayerAction,
  buildRaidSummary,
  createRaidSession,
  disconnectRaidMember,
  getBossRaidState,
  getRaidMemberStates,
  rejoinRaidMember,
  type RaidSession,
} from './raid.ts'
import { BattleEngine, perspective } from '../battle/engine.ts'
import { CONTENT, t } from '../content/index.ts'
import { createCreature, healFull } from '../creature.ts'
import { GAMEPLAY } from '../gameplay/data.ts'
import { captureSeed, rollBossCard } from '../gameplay/bosscard.ts'
import {
  checkInstanceAchievements,
  contractOdds,
  dailyLockoutStatus,
  instancePeriodKey,
  isOffPeakDouble,
  isTierUnlocked,
  progressOf,
  recordDailyReward,
  recordDailyRoll,
  rollContractOutcome,
} from '../gameplay/instances.ts'
import { hashString, Rng } from '../rng.ts'

export interface DungeonPlayer {
  readonly id: string
  readonly name: string
  readonly avatar: string
  readonly closed?: boolean
  readonly pvpBusy?: boolean
  readonly tradeId?: string | null
  dungeonBusy?: boolean
  readonly state?: {
    readonly map: string
    readonly x: number
    readonly y: number
  } | null
}

export interface DungeonAuthority {
  getSave(playerId: string): SaveData | null
  isUntrustedImport(playerId: string): boolean
  isInBattle(playerId: string): boolean
  mutateSave<T>(playerId: string, ref: string, fn: (save: SaveData) => T): T | null
  grantReward?(playerId: string, reward: { money?: number; items?: Record<string, number>; creatures?: Creature[] }, ref: string): boolean
  audit?(accountId: string | null, kind: string, detail: Record<string, unknown>, severity?: number): void
}

export interface DungeonHost {
  authority: DungeonAuthority
  lookupPlayer(id: string): DungeonPlayer | null
  send(player: DungeonPlayer, msg: CoopServerMsg): void
  inRange?(a: DungeonPlayer, b: DungeonPlayer, range: number): boolean
  onBusyChange?(player: DungeonPlayer, busy: boolean): void
  allowParties?: boolean
  randomSeed?: () => number
  secretKey?: string
  scrubPublicInit?: boolean
  log?: (msg: string) => void
}

export interface DungeonRuntime {
  handle(p: DungeonPlayer, msg: CoopClientMsg): void
  onPlayerLeave(p: DungeonPlayer): void
  close(): void
}

interface ActiveEliteBattle {
  battleId: string
  instanceId: string
  roomId: string
  eliteId: string
  playerId: string
  engine: BattleEngine
  init: BattleInit
}

function scrubCoopBattleInit(init: BattleInit | undefined): BattleInit | undefined {
  if (!init) return undefined
  const clone = structuredClone(init)
  clone.seed = ((init.seed ^ 0x5bd1e995) >>> 0) || 1
  const foeSide = clone.sides[1]
  if (foeSide) {
    delete foeSide.items
    for (const c of foeSide.party) {
      c.ivs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }
      c.moves = []
      c.abilityId = ''
      delete c.heldItem
    }
  }
  return clone
}

export function createDungeonRuntime(host: DungeonHost): DungeonRuntime {
  const { authority } = host
  const partiesAllowed = host.allowParties !== false

  const parties = new Map<string, PartyState>()
  const playerToParty = new Map<string, string>()

  const instances = new Map<string, InstanceState>()
  const playerToInstance = new Map<string, string>()

  const raids = new Map<string, RaidSession>()
  const playerToRaid = new Map<string, string>()

  const eliteBattles = new Map<string, ActiveEliteBattle>()
  let seqCounter = 0

  function sendToPlayer(playerId: string, msg: CoopServerMsg): void {
    const player = host.lookupPlayer(playerId)
    if (player) host.send(player, msg)
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
    for (const [memberId, mSession] of session.members.entries()) {
      if (mSession.disconnected) continue
      sendToPlayer(memberId, msg)
    }
  }

  function isPlayerInActiveDungeonBattle(playerId: string): boolean {
    if (eliteBattles.has(playerId)) return true
    const raidId = playerToRaid.get(playerId)
    if (!raidId) return false
    const session = raids.get(raidId)
    if (!session || session.ended) return false
    const m = session.members.get(playerId)
    return Boolean(m && !m.disconnected)
  }

  function syncPlayerDungeonBusy(playerId: string): void {
    const pl = host.lookupPlayer(playerId)
    if (!pl) return
    const busy = isPlayerInActiveDungeonBattle(playerId)
    if (pl.dungeonBusy !== busy) {
      pl.dungeonBusy = busy
      host.onBusyChange?.(pl, busy)
    }
  }

  function isCharacterBusyWithConflict(pl: DungeonPlayer): boolean {
    return Boolean(
      pl.pvpBusy ||
      (pl.tradeId !== undefined && pl.tradeId !== null) ||
      authority.isInBattle(pl.id) ||
      pl.dungeonBusy ||
      isPlayerInActiveDungeonBattle(pl.id),
    )
  }

  function cleanupFinishedInstanceForPlayer(playerId: string): void {
    const instId = playerToInstance.get(playerId)
    if (!instId) return
    const inst = instances.get(instId)
    const raid = raids.get(instId)
    if (!inst || inst.completed || (raid && raid.ended)) {
      playerToInstance.delete(playerId)
      playerToRaid.delete(playerId)
      if (inst) {
        const idx = inst.members.indexOf(playerId)
        if (idx !== -1) inst.members.splice(idx, 1)
        if (inst.members.length === 0) {
          instances.delete(instId)
        }
      }
      syncPlayerDungeonBusy(playerId)
    }
  }

  function isAtDungeonEntry(pl: DungeonPlayer, instDef: (typeof GAMEPLAY.instances)[string]): boolean {
    const entry = instDef.entry
    if (!entry?.map) return true
    if (!pl.state || pl.state.map !== entry.map) return false
    if (typeof entry.x === 'number' && typeof entry.y === 'number') {
      if (!Number.isFinite(pl.state.x) || !Number.isFinite(pl.state.y)) return false
      if (Math.hypot(pl.state.x - entry.x, pl.state.y - entry.y) > 12) return false
    }
    return true
  }

  function validateMemberForDungeonTier(
    playerId: string,
    instanceId: string,
    instDef: (typeof GAMEPLAY.instances)[string],
    tierDef: (typeof GAMEPLAY.instances)[string]['tiers'][string],
    partySize: number,
  ): { ok: true; save: SaveData; player: DungeonPlayer } | { ok: false; code: string; message: string } {
    const pl = host.lookupPlayer(playerId)
    if (!pl || pl.closed) {
      return { ok: false, code: 'target_offline', message: t('multiplayer.party.targetOffline') }
    }
    if (isCharacterBusyWithConflict(pl)) {
      return { ok: false, code: 'busy', message: t('net.error.self_busy') }
    }
    if (!isAtDungeonEntry(pl, instDef)) {
      return { ok: false, code: 'not_at_entry', message: t('net.error.invalid_encounter') }
    }
    const save = authority.getSave(playerId)
    if (!save) {
      return { ok: false, code: 'no_save', message: t('multiplayer.party.noSave') }
    }
    if (!save.party || !save.party.some((c) => c && c.hp > 0)) {
      return { ok: false, code: 'empty_party', message: t('multiplayer.party.emptyParty') }
    }
    const boolFlags = Object.fromEntries(Object.entries(save.flags ?? {}).map(([k, v]) => [k, Boolean(v)]))
    const check = isTierUnlocked(tierDef, save.badges ?? [], boolFlags, partySize)
    const unlockTier = (tierDef.unlock as { tier?: string } | undefined)?.tier
    const prog = progressOf(save, instanceId)
    const minCoop = tierDef.coop?.minPlayers ?? 1
    const maxCoop = tierDef.coop?.maxPlayers ?? 4
    if (!check.unlocked || (unlockTier && (prog.clears[unlockTier] ?? 0) <= 0) || partySize < minCoop || partySize > maxCoop) {
      return { ok: false, code: 'locked', message: check.reason ?? t('multiplayer.dungeon.errLocked') }
    }
    return { ok: true, save, player: pl }
  }

  function drainEliteEngine(engine: BattleEngine, initialEvents: BattleEvent[]): { events: BattleEvent[]; request: BattleRequest } {
    const raw = [...initialEvents]
    for (let i = 0; i < 16 && !engine.finished && engine.request(0).kind === 'wait' && engine.ready(); i++) {
      raw.push(...engine.step())
    }
    return {
      events: perspective(raw, 0),
      request: engine.finished ? { kind: 'wait' } : engine.request(0),
    }
  }

  // -------------------------------------------------------------
  // Party handlers
  // -------------------------------------------------------------

  function rejectPartyOffline(p: DungeonPlayer): void {
    host.send(p, { t: 'party.error', code: 'offline', message: t('multiplayer.status.notOnline') })
  }

  function handlePartyCreate(p: DungeonPlayer): void {
    if (!partiesAllowed) {
      rejectPartyOffline(p)
      return
    }
    if (playerToParty.has(p.id)) {
      host.send(p, { t: 'party.error', code: 'already_in_party', message: t('multiplayer.party.alreadyInParty') })
      return
    }
    const save = authority.getSave(p.id)
    if (!save) {
      host.send(p, { t: 'party.error', code: 'no_save', message: t('multiplayer.party.noSave') })
      return
    }
    if (authority.isUntrustedImport(p.id)) {
      authority.audit?.(p.id, 'coop.untrusted_rejected', { op: 'party.create' }, 1)
      host.send(p, { t: 'party.error', code: 'untrusted_save', message: t('multiplayer.dungeon.untrustedCoop') })
      return
    }
    if (!save.party || save.party.length === 0) {
      host.send(p, { t: 'party.error', code: 'empty_party', message: t('multiplayer.party.emptyParty') })
      return
    }
    const partyId = `party-${p.id}-${(++seqCounter).toString(36)}`
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

  function handlePartyInvite(p: DungeonPlayer, targetId: string): void {
    if (!partiesAllowed) {
      rejectPartyOffline(p)
      return
    }
    const partyId = playerToParty.get(p.id)
    if (!partyId) {
      host.send(p, { t: 'party.error', code: 'no_party', message: t('multiplayer.party.noParty') })
      return
    }
    const party = parties.get(partyId)
    if (!party || party.leaderId !== p.id) {
      host.send(p, { t: 'party.error', code: 'not_leader', message: t('multiplayer.party.notLeader') })
      return
    }
    if (authority.isUntrustedImport(p.id) || authority.isUntrustedImport(targetId)) {
      host.send(p, { t: 'party.error', code: 'untrusted_save', message: t('multiplayer.dungeon.untrustedCoop') })
      return
    }
    const target = host.lookupPlayer(targetId)
    if (!target) {
      host.send(p, { t: 'party.error', code: 'target_offline', message: t('multiplayer.party.targetOffline') })
      return
    }
    if (playerToParty.has(targetId)) {
      host.send(p, { t: 'party.error', code: 'target_busy', message: t('multiplayer.party.targetBusy') })
      return
    }
    host.send(target, { t: 'party.invited', from: p.id, name: p.name })
  }

  function handlePartyRespond(p: DungeonPlayer, fromLeaderId: string, accept: boolean): void {
    if (!partiesAllowed) {
      rejectPartyOffline(p)
      return
    }
    if (playerToParty.has(p.id)) return
    const leaderPlayer = host.lookupPlayer(fromLeaderId)
    if (!leaderPlayer) return
    const partyId = playerToParty.get(fromLeaderId)
    if (!partyId) return
    const party = parties.get(partyId)
    if (!party) return

    if (!accept) {
      host.send(leaderPlayer, {
        t: 'party.error',
        code: 'invite_declined',
        message: t('multiplayer.party.declined', { name: p.name }),
      })
      return
    }

    if (authority.isUntrustedImport(p.id) || authority.isUntrustedImport(fromLeaderId)) {
      authority.audit?.(p.id, 'coop.untrusted_rejected', { op: 'party.respond', fromLeaderId }, 1)
      host.send(p, { t: 'party.error', code: 'untrusted_save', message: t('multiplayer.dungeon.untrustedCoop') })
      return
    }

    const save = authority.getSave(p.id)
    if (!save || !save.party || save.party.length === 0) {
      host.send(p, { t: 'party.error', code: 'invalid_party', message: t('multiplayer.party.emptyParty') })
      return
    }

    const res = addPartyMember(party, { id: p.id, name: p.name, avatar: p.avatar })
    if (!res.ok) {
      host.send(p, { t: 'party.error', code: res.code, message: res.message })
      return
    }

    playerToParty.set(p.id, partyId)
    broadcastParty(party)
  }

  function handlePartyLeave(p: DungeonPlayer): void {
    if (!partiesAllowed) {
      host.send(p, { t: 'party.update', party: null })
      return
    }
    const partyId = playerToParty.get(p.id)
    if (!partyId) return
    const party = parties.get(partyId)
    if (!party) return

    playerToParty.delete(p.id)
    host.send(p, { t: 'party.update', party: null })

    const { party: remaining } = removePartyMember(party, p.id)
    if (!remaining) {
      parties.delete(partyId)
    } else {
      broadcastParty(remaining)
    }
  }

  function handlePartyKick(p: DungeonPlayer, targetId: string): void {
    if (!partiesAllowed) {
      rejectPartyOffline(p)
      return
    }
    const partyId = playerToParty.get(p.id)
    if (!partyId) return
    const party = parties.get(partyId)
    if (!party || party.leaderId !== p.id) {
      host.send(p, { t: 'party.error', code: 'not_leader', message: t('multiplayer.party.notLeader') })
      return
    }

    playerToParty.delete(targetId)
    const kickedPlayer = host.lookupPlayer(targetId)
    if (kickedPlayer) host.send(kickedPlayer, { t: 'party.update', party: null })

    const { party: remaining } = removePartyMember(party, targetId)
    if (remaining) broadcastParty(remaining)
  }

  function handlePartyReady(p: DungeonPlayer, ready: boolean): void {
    if (!partiesAllowed) {
      rejectPartyOffline(p)
      return
    }
    const partyId = playerToParty.get(p.id)
    if (!partyId) return
    const party = parties.get(partyId)
    if (!party) return

    setMemberReady(party, p.id, ready)
    broadcastParty(party)
  }

  function handlePartyStart(p: DungeonPlayer, instanceId: string, tierId: string): void {
    if (!partiesAllowed) {
      rejectPartyOffline(p)
      return
    }
    const partyId = playerToParty.get(p.id)
    if (!partyId) return
    const party = parties.get(partyId)
    if (!party || party.leaderId !== p.id) {
      host.send(p, { t: 'party.error', code: 'not_leader', message: t('multiplayer.party.notLeader') })
      return
    }

    if (party.members.some((m) => authority.isUntrustedImport(m.id))) {
      authority.audit?.(p.id, 'coop.untrusted_rejected', { op: 'party.start', instanceId, tierId }, 1)
      host.send(p, { t: 'party.error', code: 'untrusted_save', message: t('multiplayer.dungeon.untrustedCoop') })
      return
    }

    const instDef = GAMEPLAY.instances[instanceId]
    const tierDef = instDef?.tiers[tierId]
    if (!instDef || !tierDef || !instDef.rooms) {
      host.send(p, { t: 'party.error', code: 'invalid_instance', message: t('multiplayer.dungeon.errInvalidInstance') })
      return
    }

    if (!canStartParty(party, tierDef.coop?.minPlayers ?? 1)) {
      host.send(p, { t: 'party.error', code: 'not_all_ready', message: t('multiplayer.party.notAllReady') })
      return
    }

    for (const m of party.members) {
      cleanupFinishedInstanceForPlayer(m.id)
      if (playerToInstance.has(m.id)) {
        host.send(p, { t: 'party.error', code: 'already_in_dungeon', message: t('multiplayer.party.targetBusy') })
        return
      }
      const check = validateMemberForDungeonTier(m.id, instanceId, instDef, tierDef, party.members.length)
      if (!check.ok) {
        host.send(p, { t: 'party.error', code: check.code, message: check.message })
        return
      }
      if (m.id !== p.id && host.inRange && !host.inRange(p, check.player, 12)) {
        host.send(p, { t: 'party.error', code: 'too_far', message: t('net.error.too_far') })
        return
      }
    }
    party.dungeon = { instanceId, tierId }

    const instStateId = `inst-${party.id}-${(++seqCounter).toString(36)}`
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

  function handlePartyDisband(p: DungeonPlayer): void {
    if (!partiesAllowed) {
      rejectPartyOffline(p)
      return
    }
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

  function handleDungeonEnter(p: DungeonPlayer, instanceId: string, tierId: string): void {
    cleanupFinishedInstanceForPlayer(p.id)
    if (playerToInstance.has(p.id)) {
      host.send(p, { t: 'dungeon.error', code: 'already_in_dungeon', message: t('net.error.self_busy') })
      return
    }
    const instDef = GAMEPLAY.instances[instanceId]
    const tierDef = instDef?.tiers[tierId]
    if (!instDef || !tierDef || !instDef.rooms) {
      host.send(p, { t: 'dungeon.error', code: 'invalid_instance', message: t('multiplayer.dungeon.errInvalidInstance') })
      return
    }

    if (((tierDef.coop?.minPlayers ?? 1) > 1 || tierId === 'cluster') && authority.isUntrustedImport(p.id)) {
      host.send(p, { t: 'dungeon.error', code: 'untrusted_save', message: t('multiplayer.dungeon.untrustedCoop') })
      return
    }

    const check = validateMemberForDungeonTier(p.id, instanceId, instDef, tierDef, 1)
    if (!check.ok) {
      host.send(p, { t: 'dungeon.error', code: check.code, message: check.message })
      return
    }
    const instStateId = `inst-solo-${p.id}-${(++seqCounter).toString(36)}`
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

  function handleDungeonRoomMove(p: DungeonPlayer, roomId: string): void {
    const instId = playerToInstance.get(p.id)
    if (!instId) return
    const inst = instances.get(instId)
    if (!inst || inst.completed) return
    const instDef = GAMEPLAY.instances[inst.instanceId] ?? null

    const existingRaid = raids.get(inst.id)
    if (existingRaid && !existingRaid.ended) {
      host.send(p, { t: 'dungeon.error', code: 'battle_active', message: t('net.error.self_busy') })
      return
    }
    for (const b of eliteBattles.values()) {
      if (b.instanceId === inst.id) {
        host.send(p, { t: 'dungeon.error', code: 'battle_active', message: t('net.error.self_busy') })
        return
      }
    }

    const roomDef = getRoomDef(instDef, roomId)
    const isBossRoom = Boolean(instDef && (roomId === 'boss' || roomDef?.kind === 'boss'))
    if (isBossRoom && instDef) {
      const tierDef = instDef.tiers[inst.tierId]
      const minPlayers = Math.max(tierDef?.coop?.minPlayers ?? 1, tierDef?.unlock?.minPlayers ?? 1)
      if (inst.members.length < minPlayers) {
        host.send(p, { t: 'dungeon.error', code: 'locked', message: t('multiplayer.dungeon.coopRequired') })
        return
      }
      for (const mId of inst.members) {
        if (inst.members.length > 1 && authority.isUntrustedImport(mId)) {
          host.send(p, { t: 'dungeon.error', code: 'untrusted_save', message: t('multiplayer.dungeon.untrustedCoop') })
          return
        }
        const mPl = host.lookupPlayer(mId)
        if (mPl && isCharacterBusyWithConflict(mPl)) {
          host.send(p, { t: 'dungeon.error', code: 'battle_active', message: t('net.error.self_busy') })
          return
        }
        const sv = authority.getSave(mId)
        if (!sv || !sv.party?.some((c) => c && c.hp > 0)) {
          host.send(p, { t: 'dungeon.error', code: 'empty_party', message: t('multiplayer.party.emptyParty') })
          return
        }
      }
    }

    const res = transitionRoom(inst, roomId, instDef)
    if (!res.ok) {
      host.send(p, { t: 'dungeon.error', code: res.code, message: res.message })
      return
    }

    for (const memberId of inst.members) {
      sendToPlayer(memberId, { t: 'dungeon.roomChanged', roomId })
    }
    broadcastInstance(inst)

    // Entering boss room initiates Boss Raid
    if (isBossRoom && instDef && !raids.has(inst.id)) {
      startRaidForInstance(inst, instDef)
    }
  }

  function handleDungeonMechanism(p: DungeonPlayer, mechanismId: string): void {
    const instId = playerToInstance.get(p.id)
    if (!instId) return
    const inst = instances.get(instId)
    if (!inst) return
    const instDef = GAMEPLAY.instances[inst.instanceId] ?? null

    const res = activateMechanism(inst, inst.currentRoom, mechanismId, instDef)
    if (!res.ok) {
      host.send(p, { t: 'dungeon.error', code: res.code, message: res.message })
      return
    }

    for (const memberId of inst.members) {
      sendToPlayer(memberId, { t: 'dungeon.mechanismActivated', mechanismId, by: p.name })
    }
    broadcastInstance(inst)
  }

  function handleDungeonEliteFight(p: DungeonPlayer, eliteId: string): void {
    const instId = playerToInstance.get(p.id)
    if (!instId) return
    const inst = instances.get(instId)
    if (!inst || inst.completed) return
    const instDef = GAMEPLAY.instances[inst.instanceId]
    if (!instDef) return

    if (isCharacterBusyWithConflict(p)) {
      host.send(p, { t: 'dungeon.error', code: 'busy', message: t('net.error.self_busy') })
      return
    }
    const activeRaid = raids.get(inst.id)
    if (activeRaid && !activeRaid.ended) {
      host.send(p, { t: 'dungeon.error', code: 'battle_active', message: t('net.error.self_busy') })
      return
    }
    for (const b of eliteBattles.values()) {
      if (b.instanceId === inst.id && b.eliteId === eliteId) {
        host.send(p, { t: 'dungeon.error', code: 'elite_busy', message: t('net.error.busy') })
        return
      }
    }

    const roomElites = getRoomEliteIds(instDef, inst.currentRoom)
    const eliteDef = getEliteDef(instDef, eliteId)
    if (!roomElites.includes(eliteId) || !eliteDef) {
      host.send(p, { t: 'dungeon.error', code: 'invalid_elite', message: t('multiplayer.dungeon.errInvalidElite') })
      return
    }

    const roomState = inst.rooms[inst.currentRoom]
    if (roomState?.defeatedElites.includes(eliteId)) {
      host.send(p, { t: 'dungeon.error', code: 'already_defeated', message: t('multiplayer.dungeon.errEliteDefeated') })
      return
    }

    const save = authority.getSave(p.id)
    if (!save || !save.party?.some((c) => c && c.hp > 0)) {
      host.send(p, { t: 'dungeon.error', code: 'empty_party', message: t('multiplayer.party.emptyParty') })
      return
    }

    const bossDef = CONTENT.bosses[instDef.boss]
    const baseBossLevel = bossDef?.tiers?.[inst.tierId]?.level ?? bossDef?.level ?? 20
    const eliteLevel = Math.max(
      1,
      Math.min(
        CONTENT.config.party.maxLevel,
        (eliteDef.level ?? baseBossLevel) + (eliteDef.levelOffset ?? 0),
      ),
    )

    const battleId = `elite-${inst.id}-${p.id}-${++seqCounter}`
    const seed = (host.randomSeed?.() ?? (hashString(`${battleId}:${eliteId}`) >>> 0)) || 1
    const foe = createCreature(
      eliteDef.species,
      eliteLevel,
      { rng: new Rng(seed ^ 0x5bd1e995), nature: CONTENT.quality.npcNature },
      CONTENT,
    )
    const foeName = CONTENT.species[eliteDef.species]?.nameZh ?? eliteDef.name
    const init: BattleInit = {
      seed,
      sides: [
        {
          kind: 'player',
          name: p.name || save.name,
          party: structuredClone(save.party),
          sprite: p.avatar || save.avatar,
          items: { ...(save.bag ?? {}) },
        },
        {
          kind: 'wild',
          name: foeName,
          party: [foe],
          aiLevel: 3,
        },
      ],
      isWild: true,
      canRun: false,
      canCatch: false,
      expGain: true,
      biome: CONTENT.biomes[0]?.id ?? 'circuit',
      timeOfDay: 'day',
    }

    const engine = new BattleEngine(init, CONTENT)
    const { events, request } = drainEliteEngine(engine, engine.start())

    eliteBattles.set(p.id, {
      battleId,
      instanceId: inst.id,
      roomId: inst.currentRoom,
      eliteId,
      playerId: p.id,
      engine,
      init,
    })
    syncPlayerDungeonBusy(p.id)

    host.send(p, {
      t: 'dungeon.eliteStarted',
      battleId,
      eliteId,
      init: host.scrubPublicInit ? scrubCoopBattleInit(init)! : init,
      events,
      request,
    })
  }

  function handleDungeonEliteAction(p: DungeonPlayer, battleId: string, action: BattleAction): void {
    const active = eliteBattles.get(p.id)
    if (!active || active.battleId !== battleId) {
      host.send(p, { t: 'dungeon.error', code: 'battle_not_found', message: t('multiplayer.dungeon.errBattleNotFound') })
      return
    }

    if (action.kind === 'item') {
      const liveSave = authority.getSave(p.id)
      if (!liveSave || (liveSave.bag?.[action.itemId] ?? 0) <= 0) {
        host.send(p, { t: 'dungeon.error', code: 'item_not_owned', message: t('net.error.item_not_owned') })
        return
      }
    }

    const err = active.engine.choose(0, action)
    if (err) {
      host.send(p, { t: 'dungeon.error', code: 'invalid_action', message: err })
      return
    }

    const { events, request } = drainEliteEngine(active.engine, active.engine.step())
    if (!active.engine.finished) {
      host.send(p, {
        t: 'dungeon.eliteEvents',
        battleId: active.battleId,
        eliteId: active.eliteId,
        events,
        request,
      })
      return
    }

    eliteBattles.delete(p.id)
    syncPlayerDungeonBusy(p.id)
    const result = active.engine.result ?? 'lose'
    const inst = instances.get(active.instanceId)
    const instDef = inst ? GAMEPLAY.instances[inst.instanceId] : null
    const eliteDef = getEliteDef(instDef, active.eliteId)

    authority.mutateSave(p.id, `dungeon-elite:${inst?.instanceId ?? 'unknown'}:${active.eliteId}`, (save) => {
      const updatedParty = structuredClone(active.engine.party(0))
      if (result !== 'win' && updatedParty.every((c) => c.hp <= 0)) {
        for (const c of updatedParty) healFull(c, CONTENT)
      }
      const updatedByUid = new Map(updatedParty.map((c) => [c.uid, c]))
      const boxedUids = new Set<string>()
      for (const box of save.boxes ?? []) {
        for (const c of box) {
          if (c?.uid) boxedUids.add(c.uid)
        }
      }
      save.party = (save.party ?? [])
        .filter((c) => !boxedUids.has(c.uid))
        .map((c) => {
          const next = updatedByUid.get(c.uid)
          return next ? structuredClone(next) : c
        })
      if (result !== 'win' && save.party.length > 0 && save.party.every((c) => c.hp <= 0)) {
        for (const c of save.party) healFull(c, CONTENT)
      }

      save.bag ??= {}
      const initItems = active.init.sides[0].items ?? {}
      const leftItems = active.engine.itemsLeft(0)
      for (const [itemId, startQty] of Object.entries(initItems)) {
        const consumed = Math.max(0, (startQty ?? 0) - (leftItems[itemId] ?? 0))
        if (consumed > 0) {
          const nextQty = (save.bag[itemId] ?? 0) - consumed
          if (nextQty > 0) save.bag[itemId] = nextQty
          else delete save.bag[itemId]
        }
      }

      if (eliteDef && !save.dexSeen.includes(eliteDef.species)) {
        save.dexSeen.push(eliteDef.species)
      }
      if (result === 'win') {
        save.stats.battlesWon = (save.stats.battlesWon ?? 0) + 1
      }
      return true
    })

    host.send(p, {
      t: 'dungeon.eliteEvents',
      battleId: active.battleId,
      eliteId: active.eliteId,
      events,
      request: { kind: 'wait' },
    })
    host.send(p, {
      t: 'dungeon.eliteEnd',
      battleId: active.battleId,
      eliteId: active.eliteId,
      result,
    })

    if (result === 'win' && inst) {
      const markRes = markEliteDefeated(inst, active.roomId, active.eliteId, instDef)
      if (markRes.ok) {
        for (const memberId of inst.members) {
          sendToPlayer(memberId, { t: 'dungeon.eliteDefeated', eliteId: active.eliteId, by: p.name })
        }
        broadcastInstance(inst)
      }
    }
  }

  function handleDungeonLeave(p: DungeonPlayer): void {
    eliteBattles.delete(p.id)
    const instId = playerToInstance.get(p.id)
    if (!instId) {
      syncPlayerDungeonBusy(p.id)
      return
    }
    const inst = instances.get(instId)
    playerToInstance.delete(p.id)
    playerToRaid.delete(p.id)
    syncPlayerDungeonBusy(p.id)
    if (!inst) return

    const idx = inst.members.indexOf(p.id)
    if (idx !== -1) inst.members.splice(idx, 1)

    const raidSession = raids.get(instId)
    if (raidSession && !raidSession.ended) {
      const { ended, victory } = disconnectRaidMember(raidSession, p.id)
      if (ended) {
        inst.completed = true
        for (const mId of raidSession.members.keys()) {
          playerToRaid.delete(mId)
          syncPlayerDungeonBusy(mId)
        }
        const summary = buildRaidSummary(raidSession)
        broadcastRaid(raidSession, {
          t: 'raid.end',
          raidId: raidSession.raidId,
          victory,
          summary,
        })
      }
    }

    host.send(p, { t: 'dungeon.update', instance: null })
    if (inst.members.length === 0 && (!raidSession || raidSession.ended)) {
      instances.delete(instId)
      if (!raidSession || !raidSession.victory) {
        raids.delete(instId)
      }
    } else if (inst.members.length > 0) {
      broadcastInstance(inst)
    }
  }

  // -------------------------------------------------------------
  // Boss Raid handlers
  // -------------------------------------------------------------

  function startRaidForInstance(inst: InstanceState, def: typeof GAMEPLAY.instances[string]): void {
    const tierDef = def.tiers[inst.tierId]
    const minPlayers = Math.max(tierDef?.coop?.minPlayers ?? 1, tierDef?.unlock?.minPlayers ?? 1)
    if (inst.members.length < minPlayers) return

    const candidateMembers: Array<{ id: string; name: string; avatar: string; save: SaveData }> = []
    for (const id of inst.members) {
      if ((inst.members.length > 1 || inst.tierId === 'cluster') && authority.isUntrustedImport(id)) return
      const pl = host.lookupPlayer(id)
      const sv = authority.getSave(id)
      if (!sv || !sv.party || !sv.party.some((c) => c && c.hp > 0)) return
      candidateMembers.push({
        id,
        name: pl?.name ?? sv.name ?? id,
        avatar: pl?.avatar ?? sv.avatar ?? '',
        save: sv,
      })
    }

    if (candidateMembers.length !== inst.members.length || candidateMembers.length < minPlayers) return

    const raidMembers: Array<{ id: string; name: string; avatar: string; party: Creature[]; runSeq: number }> = []
    for (const cand of candidateMembers) {
      const runSeq = authority.mutateSave(cand.id, `dungeon-run:${inst.instanceId}`, (save) => {
        const prog = progressOf(save, inst.instanceId)
        prog.runSeq = (prog.runSeq ?? 0) + 1
        return prog.runSeq
      })
      if (runSeq === null) return

      const freshSave = authority.getSave(cand.id) ?? cand.save
      raidMembers.push({
        id: cand.id,
        name: cand.name,
        avatar: cand.avatar,
        party: freshSave.party,
        runSeq,
      })
    }

    const defaultCoop = GAMEPLAY.instanceDefaults.coop
    const activeMechanisms = Object.values(inst.rooms).flatMap((r) => r.activeMechanisms)
    const session = createRaidSession({
      raidId: inst.id,
      instanceId: inst.instanceId,
      tierId: inst.tierId,
      bossId: def.boss,
      hpScaleExp: tierDef?.coop?.hpScaleExp ?? defaultCoop?.hpScaleExp,
      minContribution: tierDef?.coop?.minContribution ?? defaultCoop?.minContribution,
      activeMechanisms,
      seed: (host.randomSeed?.() ?? (hashString(inst.id) >>> 0)) || 1,
      members: raidMembers,
    })
    for (const m of raidMembers) {
      session.runSeqByMember.set(m.id, m.runSeq)
    }

    if (raids.size > 256) {
      for (const [k, old] of raids) {
        if (old.ended) {
          raids.delete(k)
          if (raids.size <= 192) break
        }
      }
    }
    raids.set(inst.id, session)
    for (const m of raidMembers) {
      playerToRaid.set(m.id, inst.id)
      syncPlayerDungeonBusy(m.id)
    }

    const memberStates = getRaidMemberStates(session)
    const bossState = getBossRaidState(session)
    let sideIdx = 0
    for (const m of raidMembers) {
      const mSession = session.members.get(m.id)
      sendToPlayer(m.id, {
        t: 'raid.start',
        raidId: session.raidId,
        boss: bossState,
        members: memberStates,
        yourSide: sideIdx++,
        init: host.scrubPublicInit ? scrubCoopBattleInit(mSession?.init) : mSession?.init,
        events: mSession?.intro,
        request: mSession?.engine.request(0),
      })
    }
  }

  function handleRaidJoin(p: DungeonPlayer, raidId: string): void {
    const session = raids.get(raidId)
    const inst = instances.get(raidId)
    if (!session || session.ended || !inst) return
    if (p.pvpBusy || (p.tradeId !== undefined && p.tradeId !== null) || authority.isInBattle(p.id) || eliteBattles.has(p.id)) {
      host.send(p, { t: 'raid.error', code: 'busy', message: t('net.error.self_busy') })
      return
    }
    const liveSave = authority.getSave(p.id)
    const existingMember = session.members.get(p.id)
    if (!liveSave || !existingMember) return
    const liveUids = new Set((liveSave.party ?? []).map((c) => c.uid))
    for (const cr of existingMember.engine.party(0)) {
      if (!liveUids.has(cr.uid)) {
        cr.hp = 0
      }
    }
    if (!existingMember.engine.party(0).some((c) => c.hp > 0)) {
      return
    }
    if (!rejoinRaidMember(session, { id: p.id, name: p.name, avatar: p.avatar })) return

    if (!inst.members.includes(p.id)) inst.members.push(p.id)
    playerToInstance.set(p.id, raidId)
    playerToRaid.set(p.id, raidId)
    syncPlayerDungeonBusy(p.id)

    broadcastInstance(inst)
    const memberStates = getRaidMemberStates(session)
    const bossState = getBossRaidState(session)
    const memberKeys = [...session.members.keys()]
    const yourSide = Math.max(0, memberKeys.indexOf(p.id))
    const mSession = session.members.get(p.id)
    host.send(p, {
      t: 'raid.start',
      raidId: session.raidId,
      boss: bossState,
      members: memberStates,
      yourSide,
      init: host.scrubPublicInit ? scrubCoopBattleInit(mSession?.init) : mSession?.init,
      events: mSession?.intro,
      request: mSession?.engine.request(0),
    })
  }

  function handleRaidAction(p: DungeonPlayer, raidId: string, action: BattleAction): void {
    const session = raids.get(raidId)
    if (!session || session.ended) return

    if (action.kind === 'item') {
      const liveSave = authority.getSave(p.id)
      if (!liveSave || (liveSave.bag?.[action.itemId] ?? 0) <= 0) {
        host.send(p, { t: 'raid.error', code: 'item_not_owned', message: t('net.error.item_not_owned') })
        return
      }
    }

    const { events, ended, victory } = applyRaidPlayerAction(session, p.id, action)
    if (action.kind === 'item' && events.some((e) => e.t === 'item' && e.side === 0 && e.itemId === action.itemId)) {
      authority.mutateSave(p.id, `dungeon-raid-item:${session.instanceId}:${action.itemId}`, (save) => {
        save.bag ??= {}
        const nextQty = (save.bag[action.itemId] ?? 0) - 1
        if (nextQty > 0) save.bag[action.itemId] = nextQty
        else delete save.bag[action.itemId]
        return true
      })
    }

    const tickEvents = ended ? events : events.filter((e) => e.t !== 'end')
    const memberStates = getRaidMemberStates(session)
    const bossState = getBossRaidState(session)

    for (const [memberId, mSession] of session.members.entries()) {
      if (mSession.disconnected) continue
      sendToPlayer(memberId, {
        t: 'raid.tick',
        raidId: session.raidId,
        boss: bossState,
        members: memberStates,
        events: tickEvents,
        actorId: p.id,
        request: mSession.engine.request(0),
      })
    }

    if (ended) {
      const inst = instances.get(session.raidId)
      if (inst) {
        inst.completed = true
        if (victory && inst.rooms.boss) inst.rooms.boss.cleared = true
      }
      for (const memberId of session.members.keys()) {
        playerToRaid.delete(memberId)
        syncPlayerDungeonBusy(memberId)
      }
      const summary = buildRaidSummary(session)
      if (victory) {
        settleRaidVictory(session, summary)
      }
      broadcastRaid(session, {
        t: 'raid.end',
        raidId: session.raidId,
        victory,
        summary,
      })
    }
  }

  function settleRaidVictory(session: RaidSession, summary: RaidSummary): void {
    if (session.settled) return
    session.settled = true
    const instDef = GAMEPLAY.instances[session.instanceId]
    const tierDef = instDef?.tiers[session.tierId]
    if (!instDef || !tierDef) return

    const offPeak = isOffPeakDouble()
    const periodKey = instancePeriodKey(instDef.refresh ?? 'daily', GAMEPLAY.instancePeriod)
    const shardItem = GAMEPLAY.instanceDefaults.shardItem
    const bossSpecies = CONTENT.bosses[instDef.boss]?.species
    const isSharedCoop = session.members.size > 1 || session.tierId === 'cluster'

    for (const mem of summary.members) {
      if (!mem.qualified) continue
      if (session.settledMembers.has(mem.id)) continue
      if (isSharedCoop && authority.isUntrustedImport(mem.id)) {
        authority.audit?.(mem.id, 'coop.untrusted_reward_blocked', { instanceId: session.instanceId, tierId: session.tierId }, 1)
        continue
      }
      session.settledMembers.add(mem.id)

      authority.mutateSave(mem.id, `dungeon:${session.instanceId}`, (save) => {
        const prog = progressOf(save, session.instanceId)
        if ((prog.runSeq ?? 0) === 0) prog.runSeq = 1
        const boundRunSeq = session.runSeqByMember.get(mem.id) ?? prog.runSeq
        const first = (prog.clears[session.tierId] ?? 0) === 0
        const lockout = dailyLockoutStatus(prog, periodKey)

        prog.clears[session.tierId] = (prog.clears[session.tierId] ?? 0) + 1
        prog.losses[session.tierId] = 0
        save.flags ??= {}
        save.flags[`${gameJson.flags.bossWonPrefix}${instDef.boss}`] = true
        if (GAMEPLAY.instanceDefaults.assistOfferFlag) {
          save.flags[GAMEPLAY.instanceDefaults.assistOfferFlag] = false
        }

        checkInstanceAchievements(prog, instDef, {
          tierId: session.tierId,
          win: true,
          turns: session.turn,
          partySize: session.members.size,
        })

        if (bossSpecies && !save.dexSeen.includes(bossSpecies)) {
          save.dexSeen.push(bossSpecies)
        }
        save.stats.battlesWon = (save.stats.battlesWon ?? 0) + 1
        save.bag ??= {}

        if (!lockout.canReward) {
          if (shardItem) {
            save.bag[shardItem] = (save.bag[shardItem] ?? 0) + (GAMEPLAY.instanceDefaults.failShardQty ?? 0)
          }
          return true
        }

        recordDailyReward(prog, periodKey)

        let shards = (first ? tierDef.reward.shards : tierDef.repeat.shards) ?? 0
        const jackpot = tierDef.reward.jackpot ?? GAMEPLAY.instanceDefaults.jackpot
        if (jackpot && shards > 0) {
          const jackpotKey = host.secretKey ? `${host.secretKey}:${save.playerId}` : save.playerId
          const rng = new Rng(hashString(`${jackpotKey}:${session.instanceId}:${boundRunSeq}:jackpot`) >>> 0)
          if (rng.next() < jackpot.chance) {
            shards *= jackpot.mul
          }
        }
        if (offPeak) {
          shards *= GAMEPLAY.instanceDefaults.offPeakDouble?.shardMul ?? 2
        }

        if (shards > 0 && shardItem) {
          save.bag[shardItem] = (save.bag[shardItem] ?? 0) + shards
        }

        const baseMoney = first ? (tierDef.reward.money ?? 0) : (tierDef.repeat.money ?? 0)
        const moneyGain = offPeak ? baseMoney * (GAMEPLAY.instanceDefaults.offPeakDouble?.shardMul ?? 2) : baseMoney
        save.money = (save.money ?? 0) + moneyGain

        if (first && tierDef.firstReward.items) {
          for (const [it, qty] of Object.entries(tierDef.firstReward.items)) {
            save.bag[it] = (save.bag[it] ?? 0) + (qty ?? 1)
          }
        }
        return true
      })
    }
  }

  function handleRaidRollContract(p: DungeonPlayer, raidId: string, ballId: string): void {
    const session = raids.get(raidId)
    if (!session || !session.ended || !session.victory) return

    const isSharedCoop = session.members.size > 1 || session.tierId === 'cluster'
    if (isSharedCoop && authority.isUntrustedImport(p.id)) {
      authority.audit?.(p.id, 'coop.untrusted_contract_blocked', { instanceId: session.instanceId, tierId: session.tierId }, 1)
      host.send(p, { t: 'raid.error', code: 'untrusted_save', message: t('multiplayer.dungeon.untrustedCoop') })
      return
    }

    const summary = buildRaidSummary(session)
    const mem = summary.members.find((m) => m.id === p.id)
    const boundRunSeq = session.runSeqByMember.get(p.id)
    if (!mem || !mem.qualified || boundRunSeq === undefined || boundRunSeq <= 0) {
      host.send(p, {
        t: 'raid.error',
        code: 'not_qualified',
        message: t('multiplayer.dungeon.errNotQualified'),
      })
      return
    }

    if (session.rolledMembers.has(p.id)) {
      host.send(p, {
        t: 'raid.error',
        code: 'already_rolled',
        message: t('multiplayer.dungeon.errAlreadyRolled'),
      })
      return
    }

    const instDef = GAMEPLAY.instances[session.instanceId]
    const tierDef = instDef?.tiers[session.tierId]
    if (!instDef || !tierDef) return

    const ballItem = CONTENT.items[ballId]
    if (!ballItem || ballItem.effect.kind !== 'ball') {
      host.send(p, { t: 'raid.error', code: 'invalid_ball', message: t('multiplayer.dungeon.errInvalidBall') })
      return
    }

    const save = authority.getSave(p.id)
    if (!save) {
      host.send(p, { t: 'raid.error', code: 'no_save', message: t('multiplayer.party.noSave') })
      return
    }

    if ((save.bag?.[ballId] ?? 0) <= 0) {
      host.send(p, { t: 'raid.error', code: 'no_ball', message: t('multiplayer.dungeon.errNoBall') })
      return
    }

    const prog = progressOf(save, session.instanceId)
    const first = (prog.captures[session.tierId] ?? 0) === 0

    if (!first && !tierDef.repeat.capture) {
      host.send(p, {
        t: 'raid.error',
        code: 'no_repeat_capture',
        message: t('multiplayer.dungeon.errNoRepeatCapture'),
      })
      return
    }

    if (prog.lastRollRun?.[session.tierId] !== undefined && prog.lastRollRun[session.tierId] >= boundRunSeq) {
      host.send(p, {
        t: 'raid.error',
        code: 'already_rolled',
        message: t('multiplayer.dungeon.errAlreadyRolled'),
      })
      return
    }

    const periodKey = instancePeriodKey(instDef.refresh ?? 'daily', GAMEPLAY.instancePeriod)
    const lockout = dailyLockoutStatus(prog, periodKey)
    if (!lockout.canRoll) {
      host.send(p, {
        t: 'raid.error',
        code: 'daily_limit',
        message: t('multiplayer.dungeon.errDailyLimit'),
      })
      return
    }

    const rollResult = authority.mutateSave(p.id, `dungeon-contract:${session.instanceId}`, (s) => {
      if (session.rolledMembers.has(p.id)) return null
      s.bag ??= {}
      if ((s.bag[ballId] ?? 0) <= 0) return null
      s.bag[ballId] -= 1
      if (s.bag[ballId] <= 0) delete s.bag[ballId]
      session.rolledMembers.add(p.id)

      const pProg = progressOf(s, session.instanceId)
      if ((pProg.runSeq ?? 0) === 0) pProg.runSeq = 1
      const isFirstCapture = (pProg.captures[session.tierId] ?? 0) === 0
      pProg.lastRollRun ??= {}
      pProg.lastRollRun[session.tierId] = Math.max(pProg.runSeq, boundRunSeq)
      recordDailyRoll(pProg, periodKey)

      const ballBonus = CONTENT.quality.capture.ballBonus[ballId] ?? 0
      const isMaster = ballId === CONTENT.quality.capture.masterBall
      const curPity = pProg.pity?.[session.tierId] ?? 0
      const odds = contractOdds(tierDef, ballBonus, !isFirstCapture, curPity)

      s.rollSeed ??= hashString(s.playerId) >>> 0
      const baseRollSeed = host.secretKey
        ? hashString(`${host.secretKey}:raid-contract:${s.playerId}:${s.rollSeed >>> 0}`) >>> 0
        : s.rollSeed
      const seed = captureSeed(baseRollSeed, session.instanceId, session.tierId, isFirstCapture ? 0 : boundRunSeq)
      const rng = new Rng(seed)
      const success = isMaster || odds.guaranteed || rollContractOutcome(rng, odds.chance)

      if (success) {
        pProg.pity ??= {}
        pProg.pity[session.tierId] = 0
        pProg.captures[session.tierId] = (pProg.captures[session.tierId] ?? 0) + 1

        const cardRng = new Rng((seed ^ 0x5bd1e995) >>> 0)
        const card = rollBossCard(cardRng, instDef.boss, session.tierId, tierDef, {
          first: isFirstCapture,
          run: String(boundRunSeq),
          at: Date.now(),
          otName: s.name,
          otId: s.playerId,
          ballId,
        }, CONTENT)

        if (!s.dexSeen.includes(card.speciesId)) s.dexSeen.push(card.speciesId)
        if (!s.dexCaught.includes(card.speciesId)) s.dexCaught.push(card.speciesId)
        s.stats.caught = (s.stats.caught ?? 0) + 1

        if (s.party.length < CONTENT.config.party.maxParty) {
          s.party.push(card)
        } else {
          s.boxes ??= [[]]
          if (!s.boxes.length) s.boxes.push([])
          s.boxes[s.boxes.length - 1].push(card)
        }
        return { success: true, card, pity: 0 }
      }

      pProg.pity ??= {}
      pProg.pity[session.tierId] = curPity + 1
      const failShard = tierDef.repeat.shards ?? GAMEPLAY.instanceDefaults.failShardQty ?? 0
      const shardItem = GAMEPLAY.instanceDefaults.shardItem
      if (shardItem && failShard > 0) {
        s.bag[shardItem] = (s.bag[shardItem] ?? 0) + failShard
      }
      return { success: false, shardsAwarded: failShard, pity: pProg.pity[session.tierId] }
    })

    if (rollResult) {
      host.send(p, {
        t: 'raid.contractResult',
        raidId: session.raidId,
        memberId: p.id,
        success: rollResult.success,
        card: rollResult.card,
        shardsAwarded: rollResult.shardsAwarded,
        pity: rollResult.pity,
      })
    }
  }

  // -------------------------------------------------------------
  // Message dispatcher
  // -------------------------------------------------------------

  function handle(p: DungeonPlayer, msg: CoopClientMsg): void {
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
      case 'dungeon.eliteAction': handleDungeonEliteAction(p, msg.battleId, msg.action); return
      case 'dungeon.leave': handleDungeonLeave(p); return
      case 'raid.join': handleRaidJoin(p, msg.raidId); return
      case 'raid.action': handleRaidAction(p, msg.raidId, msg.action); return
      case 'raid.rollContract': handleRaidRollContract(p, msg.raidId, msg.ballId); return
    }
  }

  function onPlayerLeave(p: DungeonPlayer): void {
    if (partiesAllowed) handlePartyLeave(p)
    handleDungeonLeave(p)
  }

  function close(): void {
    const busyIds = new Set<string>([...eliteBattles.keys(), ...playerToRaid.keys()])
    parties.clear()
    playerToParty.clear()
    instances.clear()
    playerToInstance.clear()
    raids.clear()
    playerToRaid.clear()
    eliteBattles.clear()
    for (const id of busyIds) {
      syncPlayerDungeonBusy(id)
    }
  }

  return {
    handle,
    onPlayerLeave,
    close,
  }
}
