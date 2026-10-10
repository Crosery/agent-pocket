// Shared coop protocol types for party management, dungeon progression, and multiplayer Boss Raids.
import type { BattleAction, BattleEvent, Creature, CreatureView } from '../types.ts'

export interface PartyMember {
  id: string
  name: string
  avatar: string
  ready: boolean
  leader: boolean
}

export interface PartyState {
  id: string
  leaderId: string
  members: PartyMember[]
  dungeon?: {
    instanceId: string
    tierId: string
  }
}

export interface InstanceRoomState {
  id: string
  cleared: boolean
  activeMechanisms: string[]
  defeatedElites: string[]
}

export interface InstanceState {
  id: string
  instanceId: string
  tierId: string
  currentRoom: string
  rooms: Record<string, InstanceRoomState>
  members: string[]
  completed: boolean
}

export interface RaidMemberState {
  id: string
  name: string
  avatar: string
  lead: CreatureView
  hp: number
  maxHp: number
  fainted: boolean
  contribution: number
  eligible: boolean
}

export interface BossRaidState {
  speciesId: string
  level: number
  hp: number
  maxHp: number
  form: string
  meters: Record<string, number>
  status?: string
}

export interface RaidSummary {
  raidId: string
  instanceId: string
  tierId: string
  victory: boolean
  totalDamage: number
  members: Array<{
    id: string
    name: string
    damage: number
    contributionPct: number
    qualified: boolean
  }>
}

// ----------------------------- Coop Client -> Server Messages -----------------------------

export type CoopClientMsg =
  | { t: 'party.create' }
  | { t: 'party.invite'; to: string }
  | { t: 'party.respond'; from: string; accept: boolean }
  | { t: 'party.leave' }
  | { t: 'party.kick'; targetId: string }
  | { t: 'party.ready'; ready: boolean }
  | { t: 'party.start'; instanceId: string; tierId: string }
  | { t: 'party.disband' }
  | { t: 'dungeon.enter'; instanceId: string; tierId: string }
  | { t: 'dungeon.roomMove'; roomId: string }
  | { t: 'dungeon.mechanism'; mechanismId: string }
  | { t: 'dungeon.eliteFight'; eliteId: string }
  | { t: 'dungeon.leave' }
  | { t: 'raid.join'; raidId: string; party: Creature[] }
  | { t: 'raid.action'; raidId: string; action: BattleAction }
  | { t: 'raid.rollContract'; raidId: string; ballId: string }

// ----------------------------- Coop Server -> Client Messages -----------------------------

export type CoopServerMsg =
  | { t: 'party.update'; party: PartyState | null }
  | { t: 'party.invited'; from: string; name: string }
  | { t: 'party.error'; code: string; message: string }
  | { t: 'dungeon.update'; instance: InstanceState | null }
  | { t: 'dungeon.roomChanged'; roomId: string }
  | { t: 'dungeon.mechanismActivated'; mechanismId: string; by: string }
  | { t: 'dungeon.eliteDefeated'; eliteId: string; by: string }
  | { t: 'dungeon.error'; code: string; message: string }
  | { t: 'raid.start'; raidId: string; boss: BossRaidState; members: RaidMemberState[]; yourSide: number }
  | { t: 'raid.tick'; raidId: string; boss: BossRaidState; members: RaidMemberState[]; events: BattleEvent[] }
  | { t: 'raid.end'; raidId: string; victory: boolean; summary: RaidSummary }
  | { t: 'raid.contractResult'; raidId: string; memberId: string; success: boolean; card?: Creature; shardsAwarded?: number; pity?: number }
  | { t: 'raid.error'; code: string; message: string }
