// Authoritative multiplayer Boss Raid synchronization and settlement via BattleEngine.
import type { BattleAction, BattleEvent, Creature, BossState } from '../types.ts'
import { maxHp } from '../creature.ts'
import { CONTENT } from '../content/index.ts'
import { startBossBattle } from '../battle/boss-battle.ts'
import type { BattleEngine } from '../battle/engine.ts'
import type { BossRaidState, RaidMemberState, RaidSummary } from './protocol.ts'

export interface CreateRaidOpts {
  raidId: string
  instanceId: string
  tierId: string
  bossId: string
  hpScaleExp?: number
  minContribution?: number
  members: Array<{
    id: string
    name: string
    avatar: string
    party: Creature[]
  }>
}

export interface RaidMemberSession {
  info: { id: string; name: string; avatar: string }
  engine: BattleEngine
  damageDealt: number
}

export interface RaidSession {
  raidId: string
  instanceId: string
  tierId: string
  bossId: string
  minContribution: number
  bossState: BossState
  members: Map<string, RaidMemberSession>
  events: BattleEvent[]
  ended: boolean
  victory: boolean
  turn: number
}

/**
 * Calculates Boss Max HP scaled by N^exp where N is number of players.
 */
export function scaleBossHp(baseHp: number, playerCount: number, exp = 0.8): number {
  const n = Math.max(1, playerCount)
  const mul = Math.pow(n, exp)
  return Math.round(baseHp * mul)
}

export function createRaidSession(opts: CreateRaidOpts): RaidSession {
  const memberMap = new Map<string, RaidMemberSession>()
  let baseBossState: BossState | null = null

  for (const m of opts.members) {
    const { engine } = startBossBattle(opts.bossId, m.party, {
      seed: 1,
      tier: opts.tierId,
      playerName: m.name,
      playerSprite: m.avatar,
      expGain: false,
    })
    baseBossState ??= engine.extractBossState()
    memberMap.set(m.id, {
      info: { id: m.id, name: m.name, avatar: m.avatar },
      engine,
      damageDealt: 0,
    })
  }

  if (!baseBossState) {
    throw new Error(`cannot initialize raid boss "${opts.bossId}"`)
  }

  const scaledHp = scaleBossHp(baseBossState.maxHp, opts.members.length, opts.hpScaleExp ?? 0.8)
  baseBossState.maxHp = scaledHp
  baseBossState.hp = scaledHp

  for (const m of memberMap.values()) {
    m.engine.applyBossState(baseBossState)
  }

  return {
    raidId: opts.raidId,
    instanceId: opts.instanceId,
    tierId: opts.tierId,
    bossId: opts.bossId,
    minContribution: opts.minContribution ?? 10,
    bossState: baseBossState,
    members: memberMap,
    events: [],
    ended: false,
    victory: false,
    turn: 1,
  }
}

export function getBossRaidState(session: RaidSession): BossRaidState {
  const def = CONTENT.bosses[session.bossId]
  const tierDef = def?.tiers?.[session.tierId]
  return {
    speciesId: session.bossState.speciesId,
    level: tierDef?.level ?? def?.level ?? 50,
    hp: session.bossState.hp,
    maxHp: session.bossState.maxHp,
    form: session.bossState.form,
    meters: session.bossState.meters,
    status: session.bossState.status ?? undefined,
  }
}

export function getRaidMemberStates(session: RaidSession): RaidMemberState[] {
  const list: RaidMemberState[] = []
  const totalDmg = Math.max(1, getTotalDamage(session))

  for (const [id, m] of session.members.entries()) {
    const leadView = m.engine.activeView(0)
    const party = m.engine.party(0)
    const activeCr = party[m.engine.activeIndex(0)]
    const hp = activeCr?.hp ?? leadView.hp
    const mHp = activeCr ? maxHp(activeCr, CONTENT) : leadView.maxHp
    const fainted = party.every((c) => c.hp <= 0)
    const pct = (m.damageDealt / totalDmg) * 100
    list.push({
      id,
      name: m.info.name,
      avatar: m.info.avatar,
      lead: leadView,
      hp,
      maxHp: mHp,
      fainted,
      contribution: m.damageDealt,
      eligible: pct >= session.minContribution,
    })
  }
  return list
}

export function getTotalDamage(session: RaidSession): number {
  let sum = 0
  for (const m of session.members.values()) sum += m.damageDealt
  return sum
}

/**
 * Applies an action from a player against the raid Boss using their local engine
 * and synchronizes BossState across all member engines.
 */
export function applyRaidPlayerAction(
  session: RaidSession,
  playerId: string,
  action: BattleAction,
): { events: BattleEvent[]; ended: boolean; victory: boolean } {
  if (session.ended) return { events: [], ended: true, victory: session.victory }
  const member = session.members.get(playerId)
  if (!member) return { events: [], ended: false, victory: false }

  // Sync latest shared boss state before taking action
  member.engine.applyBossState(session.bossState)

  const prevHp = session.bossState.hp
  const err = member.engine.choose(0, action)
  if (err) return { events: [], ended: false, victory: false }

  const events = member.engine.step()

  const updatedBoss = member.engine.extractBossState()
  if (updatedBoss) {
    const dmg = Math.max(0, prevHp - updatedBoss.hp)
    member.damageDealt += dmg
    session.bossState = updatedBoss

    // Sync updated boss state to other members
    for (const [otherId, other] of session.members.entries()) {
      if (otherId !== playerId) {
        other.engine.applyBossState(session.bossState)
      }
    }
  }

  // Check victory: boss HP zero or engine marked win
  if (session.bossState.hp <= 0 || member.engine.result === 'win') {
    session.ended = true
    session.victory = true
    return { events, ended: true, victory: true }
  }

  // Check defeat: all members' parties fainted
  let allFainted = true
  for (const m of session.members.values()) {
    if (m.engine.party(0).some((c) => c.hp > 0)) {
      allFainted = false
      break
    }
  }

  if (allFainted) {
    session.ended = true
    session.victory = false
    return { events, ended: true, victory: false }
  }

  return { events, ended: false, victory: false }
}

export function buildRaidSummary(session: RaidSession): RaidSummary {
  const totalDmg = Math.max(1, getTotalDamage(session))
  const memberList: RaidSummary['members'] = []

  for (const [id, m] of session.members.entries()) {
    const pct = Number(((m.damageDealt / totalDmg) * 100).toFixed(1))
    memberList.push({
      id,
      name: m.info.name,
      damage: m.damageDealt,
      contributionPct: pct,
      qualified: pct >= session.minContribution,
    })
  }

  return {
    raidId: session.raidId,
    instanceId: session.instanceId,
    tierId: session.tierId,
    victory: session.victory,
    totalDamage: totalDmg,
    members: memberList,
  }
}
