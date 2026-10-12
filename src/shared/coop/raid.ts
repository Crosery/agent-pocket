// Authoritative multiplayer Boss Raid synchronization and settlement via BattleEngine.
import type { BattleAction, BattleEvent, BattleInit, BossState, Creature } from '../types.ts'
import { maxHp } from '../creature.ts'
import { CONTENT } from '../content/index.ts'
import { GAMEPLAY } from '../gameplay/data.ts'
import { startBossBattle } from '../battle/boss-battle.ts'
import type { BattleEngine } from '../battle/engine.ts'
import { getMechanismDef } from './instance.ts'
import type { BossRaidState, RaidMemberState, RaidSummary } from './protocol.ts'

export interface CreateRaidOpts {
  raidId: string
  instanceId: string
  tierId: string
  bossId: string
  hpScaleExp?: number
  minContribution?: number
  activeMechanisms?: string[]
  seed?: number
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
  init: BattleInit
  intro: BattleEvent[]
  damageDealt: number
  disconnected?: boolean
}

export interface RaidSession {
  raidId: string
  instanceId: string
  tierId: string
  bossId: string
  minContribution: number
  bossState: BossState
  boss: BossState
  activeMechanisms: string[]
  members: Map<string, RaidMemberSession>
  events: BattleEvent[]
  ended: boolean
  victory: boolean
  turn: number
  settled?: boolean
  runSeqByMember: Map<string, number>
  rolledMembers: Set<string>
  settledMembers: Set<string>
}

/**
 * Calculates Boss Max HP scaled by N^exp where N is number of players.
 */
export function scaleBossHp(
  baseHp: number,
  playerCount: number,
  exp = GAMEPLAY.instanceDefaults.coop?.hpScaleExp ?? 0.8,
): number {
  const n = Math.max(1, playerCount)
  const mul = Math.pow(n, exp)
  return Math.round(baseHp * mul)
}

export function applyActiveMechanismsToBossState(
  bossState: BossState,
  instanceId: string,
  activeMechanisms: readonly string[] = [],
): void {
  if (!activeMechanisms.length) return
  const instDef = GAMEPLAY.instances[instanceId]
  const bossDef = CONTENT.bosses[bossState.bossId]
  if (!instDef) return

  let bonus = bossState.takenMulBonus ?? 0
  for (const mechId of activeMechanisms) {
    const mech = getMechanismDef(instDef, mechId)
    const eff = mech?.bossEffect
    if (!eff) continue
    if (eff.meterId) {
      const meterDef = bossDef?.meters.find((m) => m.id === eff.meterId)
      const max = meterDef?.max ?? Number.MAX_SAFE_INTEGER
      const cur = bossState.meters[eff.meterId] ?? 0
      bossState.meters[eff.meterId] = Math.min(max, Math.max(0, cur + (eff.meterAdd ?? 0)))
    }
    if (eff.takenMulBonus && eff.takenMulBonus > 0) {
      bonus += eff.takenMulBonus
    }
  }
  if (bonus > 0) {
    bossState.takenMulBonus = Number(bonus.toFixed(4))
  }
}
export function syncMemberBattleIntroAndInit(
  member: RaidMemberSession,
  bossState: BossState,
): void {
  const bossCr = member.init.sides[1]?.party?.[0]
  if (bossCr) {
    bossCr.hp = Math.max(0, Math.min(bossState.hp, bossState.maxHp))
    bossCr.speciesId = bossState.speciesId
  }
  const playerParty = member.engine.party(0)
  if (member.init.sides[0]?.party && playerParty) {
    member.init.sides[0].party = structuredClone(playerParty)
  }

  const bossView = member.engine.activeView(1)
  const playerView = member.engine.activeView(0)
  const hud = member.engine.bossHud()

  let hasBossHud = false
  for (const ev of member.intro) {
    if (ev.t === 'switch') {
      if (ev.side === 1) {
        ev.creature = { ...bossView }
      } else if (ev.side === 0) {
        ev.creature = { ...playerView }
      }
    } else if (ev.t === 'boss' && ev.side === 1) {
      if (hud) {
        ev.hud = { ...hud }
        hasBossHud = true
      }
    }
  }
  if (!hasBossHud && hud) {
    member.intro.push({ t: 'boss', side: 1, hud: { ...hud } })
  }
  member.engine.flush()
}


export function createRaidSession(opts: CreateRaidOpts): RaidSession {
  const memberMap = new Map<string, RaidMemberSession>()
  let baseBossState: BossState | null = null
  const baseSeed = opts.seed ?? 1

  let idx = 0
  for (const m of opts.members) {
    const { engine, init, intro } = startBossBattle(opts.bossId, structuredClone(m.party), {
      seed: baseSeed + idx++,
      tier: opts.tierId,
      playerName: m.name,
      playerSprite: m.avatar,
      expGain: false,
    })
    baseBossState ??= engine.extractBossState()
    memberMap.set(m.id, {
      info: { id: m.id, name: m.name, avatar: m.avatar },
      engine,
      init,
      intro,
      damageDealt: 0,
      disconnected: false,
    })
  }

  if (!baseBossState) {
    throw new Error(`cannot initialize raid boss "${opts.bossId}"`)
  }

  const defaultCoop = GAMEPLAY.instanceDefaults.coop
  const scaledHp = scaleBossHp(
    baseBossState.maxHp,
    opts.members.length,
    opts.hpScaleExp ?? defaultCoop?.hpScaleExp ?? 0.8,
  )
  baseBossState.maxHp = scaledHp
  baseBossState.hp = scaledHp
  applyActiveMechanismsToBossState(baseBossState, opts.instanceId, opts.activeMechanisms ?? [])

  for (const m of memberMap.values()) {
    m.engine.applyBossState(baseBossState)
    syncMemberBattleIntroAndInit(m, baseBossState)
  }

  const session: RaidSession = {
    raidId: opts.raidId,
    instanceId: opts.instanceId,
    tierId: opts.tierId,
    bossId: opts.bossId,
    minContribution: opts.minContribution ?? defaultCoop?.minContribution ?? 10,
    bossState: baseBossState,
    boss: baseBossState,
    activeMechanisms: [...(opts.activeMechanisms ?? [])],
    members: memberMap,
    events: [],
    ended: false,
    victory: false,
    turn: 1,
    runSeqByMember: new Map<string, number>(),
    rolledMembers: new Set<string>(),
    settledMembers: new Set<string>(),
  }
  return session
}

export function getBossRaidState(session: RaidSession): BossRaidState {
  const def = CONTENT.bosses[session.bossId]
  const tierDef = def?.tiers?.[session.tierId]
  return {
    speciesId: session.bossState.speciesId,
    level: tierDef?.level ?? def?.level ?? 1,
    hp: session.bossState.hp,
    maxHp: session.bossState.maxHp,
    form: session.bossState.form,
    meters: { ...session.bossState.meters },
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
    const fainted = Boolean(m.disconnected) || party.every((c) => c.hp <= 0)
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

export function checkAllRaidMembersFainted(session: RaidSession): boolean {
  let hasActive = false
  for (const m of session.members.values()) {
    if (m.disconnected) continue
    if (m.engine.party(0).some((c) => c.hp > 0)) {
      hasActive = true
      break
    }
  }
  return !hasActive
}

export function disconnectRaidMember(
  session: RaidSession,
  playerId: string,
): { ended: boolean; victory: boolean } {
  const member = session.members.get(playerId)
  if (!member) return { ended: session.ended, victory: session.victory }
  member.disconnected = true
  if (!session.ended && checkAllRaidMembersFainted(session)) {
    session.ended = true
    session.victory = false
  }
  return { ended: session.ended, victory: session.victory }
}

export function rejoinRaidMember(
  session: RaidSession,
  player: { id: string; name: string; avatar: string },
): boolean {
  if (session.ended) return false
  const member = session.members.get(player.id)
  if (!member) return false
  member.disconnected = false
  member.info.name = player.name || member.info.name
  member.info.avatar = player.avatar || member.info.avatar
  member.engine.applyBossState(session.bossState)
  syncMemberBattleIntroAndInit(member, session.bossState)
  return true
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
  if (!member || member.disconnected) return { events: [], ended: false, victory: false }

  // Sync latest shared boss state before taking action
  member.engine.applyBossState(session.bossState)

  const prevHp = session.bossState.hp
  const prevMaxHp = session.bossState.maxHp

  // If the member's active creature fainted on a prior turn and they send a move instead of switching,
  // auto-switch to their next alive party member first.
  const preEvents: BattleEvent[] = []
  if (member.engine.request(0).kind === 'switch' && action.kind !== 'switch') {
    const nextIdx = member.engine.party(0).findIndex((c) => c.hp > 0)
    if (nextIdx >= 0 && member.engine.choose(0, { kind: 'switch', partyIndex: nextIdx }) === null) {
      preEvents.push(...member.engine.step())
    }
  }

  const err = member.engine.choose(0, action)
  if (err) return { events: preEvents, ended: false, victory: false }

  const stepEvents = member.engine.step()
  const events = [...preEvents, ...stepEvents]

  // If the active creature fainted at the end of this turn and another party member is alive,
  // automatically send out the next alive creature so the member is ready for the next raid turn.
  if (!member.engine.finished && member.engine.request(0).kind === 'switch') {
    const nextIdx = member.engine.party(0).findIndex((c) => c.hp > 0)
    if (nextIdx >= 0 && member.engine.choose(0, { kind: 'switch', partyIndex: nextIdx }) === null) {
      events.push(...member.engine.step())
    }
  }

  // Drain legitimate automatic recharge/wait turns so player does not receive un-actionable wait request
  let autoSteps = 0
  while (!member.engine.finished && member.engine.request(0).kind === 'wait' && member.engine.ready() && autoSteps < 10) {
    autoSteps++
    events.push(...member.engine.step())
    if (!member.engine.finished && member.engine.request(0).kind === 'switch') {
      const nextIdx = member.engine.party(0).findIndex((c) => c.hp > 0)
      if (nextIdx >= 0 && member.engine.choose(0, { kind: 'switch', partyIndex: nextIdx }) === null) {
        events.push(...member.engine.step())
      }
    }
  }

  const updatedBoss = member.engine.extractBossState()
  if (updatedBoss) {
    const expectedPrevHp =
      updatedBoss.maxHp === prevMaxHp
        ? prevHp
        : Math.round((prevHp / Math.max(1, prevMaxHp)) * updatedBoss.maxHp)
    const dmg = Math.max(0, expectedPrevHp - updatedBoss.hp)
    member.damageDealt += dmg
    if (session.bossState.takenMulBonus && !updatedBoss.takenMulBonus) {
      updatedBoss.takenMulBonus = session.bossState.takenMulBonus
    }
    session.bossState = updatedBoss
    session.boss = updatedBoss
    session.turn = Math.max(session.turn, updatedBoss.turn)

    // Sync updated boss state to other members
    for (const [otherId, other] of session.members.entries()) {
      if (otherId !== playerId && !other.engine.finished) {
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

  // Check defeat: all connected members' parties fainted
  if (checkAllRaidMembersFainted(session)) {
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

export function canMemberRollContract(session: RaidSession, playerId: string): boolean {
  return session.victory && !session.rolledMembers.has(playerId)
}

export function recordMemberContractRoll(session: RaidSession, playerId: string): void {
  session.rolledMembers.add(playerId)
}

export function isMemberSettled(session: RaidSession, playerId: string): boolean {
  return session.settledMembers.has(playerId)
}

export function recordMemberSettled(session: RaidSession, playerId: string): void {
  session.settledMembers.add(playerId)
}
