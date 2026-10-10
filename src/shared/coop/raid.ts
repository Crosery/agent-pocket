// Authoritative multiplayer Boss Raid synchronization and settlement.
import type { BattleAction, BattleEvent, Creature, MoveAnim, TypeId } from '../types.ts'
import { maxHp, toView } from '../creature.ts'
import { CONTENT } from '../content/index.ts'
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
  party: Creature[]
  activeIdx: number
  damageDealt: number
  pendingAction?: BattleAction
}

export interface RaidSession {
  raidId: string
  instanceId: string
  tierId: string
  bossId: string
  minContribution: number
  boss: BossRaidState
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
  const bossDef = CONTENT.bosses[opts.bossId]
  const tierDef = bossDef?.tiers?.[opts.tierId]
  const baseLevel = tierDef?.level ?? bossDef?.level ?? 50
  const species = CONTENT.species[bossDef?.species ?? opts.bossId]
  const rawBaseHp = species ? Math.round(((2 * species.baseStats.hp + 31) * baseLevel) / 100 + baseLevel + 10) : 500
  const statMulHp = bossDef?.forms[bossDef.initialForm]?.statMul?.hp ?? 8
  const baseBossHp = Math.round(rawBaseHp * statMulHp)
  const scaledHp = scaleBossHp(baseBossHp, opts.members.length, opts.hpScaleExp ?? 0.8)

  const bossState: BossRaidState = {
    speciesId: bossDef?.species ?? opts.bossId,
    level: baseLevel,
    hp: scaledHp,
    maxHp: scaledHp,
    form: bossDef?.initialForm ?? 'base',
    meters: {},
  }

  const memberMap = new Map<string, RaidMemberSession>()

  for (const m of opts.members) {
    memberMap.set(m.id, {
      info: { id: m.id, name: m.name, avatar: m.avatar },
      party: m.party,
      activeIdx: 0,
      damageDealt: 0,
    })
  }

  return {
    raidId: opts.raidId,
    instanceId: opts.instanceId,
    tierId: opts.tierId,
    bossId: opts.bossId,
    minContribution: opts.minContribution ?? 10,
    boss: bossState,
    members: memberMap,
    events: [],
    ended: false,
    victory: false,
    turn: 1,
  }
}

export function getRaidMemberStates(session: RaidSession): RaidMemberState[] {
  const list: RaidMemberState[] = []
  const totalDmg = Math.max(1, getTotalDamage(session))

  for (const [id, m] of session.members.entries()) {
    const active = m.party[m.activeIdx] ?? m.party[0]
    const hp = active?.hp ?? 0
    const mHp = active ? maxHp(active, CONTENT) : 100
    const fainted = m.party.every((c) => c.hp <= 0)
    const pct = (m.damageDealt / totalDmg) * 100
    list.push({
      id,
      name: m.info.name,
      avatar: m.info.avatar,
      lead: active ? toView(active, CONTENT) : {
        uid: id,
        speciesId: 'deepseek-v4',
        level: 1,
        hp: 0,
        maxHp: 100,
        status: null,
        shiny: false,
      },
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
 * Applies an action from a player against the raid Boss.
 */
export function applyRaidPlayerAction(
  session: RaidSession,
  playerId: string,
  action: BattleAction,
): { events: BattleEvent[]; ended: boolean; victory: boolean } {
  if (session.ended) return { events: [], ended: true, victory: session.victory }
  const member = session.members.get(playerId)
  if (!member) return { events: [], ended: false, victory: false }

  const events: BattleEvent[] = []

  if (action.kind === 'move') {
    const active = member.party[member.activeIdx]
    if (active && active.hp > 0) {
      const moveId = active.moves[action.moveIndex]?.id ?? 'tensor-tackle'
      const move = CONTENT.moves[moveId]
      const power = move?.power ?? 60
      const atk = active.level * 4
      // Estimated damage formula for shared boss raid tick
      const rawDmg = Math.max(10, Math.round(((atk * power) / 50) + 10))
      const dmg = Math.min(session.boss.hp, rawDmg)

      session.boss.hp = Math.max(0, session.boss.hp - dmg)
      member.damageDealt += dmg

      events.push({
        t: 'move',
        side: 0,
        moveId,
        anim: (move?.anim ?? 'physical') as MoveAnim,
        type: (move?.type ?? 'normal') as TypeId,
      })
      events.push({
        t: 'damage',
        side: 1,
        amount: dmg,
        hp: session.boss.hp,
        maxHp: session.boss.maxHp,
        effectiveness: 1,
        crit: false,
      })
    }
  } else if (action.kind === 'switch') {
    if (action.partyIndex >= 0 && action.partyIndex < member.party.length && member.party[action.partyIndex].hp > 0) {
      member.activeIdx = action.partyIndex
      const switched = member.party[action.partyIndex]
      events.push({
        t: 'switch',
        side: 0,
        partyIndex: action.partyIndex,
        creature: toView(switched, CONTENT),
      })
    }
  }

  // Check victory
  if (session.boss.hp <= 0) {
    session.ended = true
    session.victory = true
    events.push({ t: 'end', result: 'win', winner: 0 })
    return { events, ended: true, victory: true }
  }

  // Boss retaliates against the acting player
  const activeCreature = member.party[member.activeIdx]
  if (activeCreature && activeCreature.hp > 0) {
    const bossAtk = session.boss.level * 3
    const bossDmg = Math.max(5, Math.round(bossAtk * 0.8))
    activeCreature.hp = Math.max(0, activeCreature.hp - bossDmg)

    events.push({
      t: 'damage',
      side: 0,
      amount: bossDmg,
      hp: activeCreature.hp,
      maxHp: maxHp(activeCreature, CONTENT),
      effectiveness: 1,
      crit: false,
    })

    if (activeCreature.hp <= 0) {
      events.push({ t: 'faint', side: 0 })
      // Auto-switch to next alive creature if any
      const nextAlive = member.party.findIndex((c) => c.hp > 0)
      if (nextAlive !== -1) {
        member.activeIdx = nextAlive
        const nextCr = member.party[nextAlive]
        events.push({
          t: 'switch',
          side: 0,
          partyIndex: nextAlive,
          creature: toView(nextCr, CONTENT),
        })
      }
    }
  }

  // Check if all players fainted
  let anyAlive = false
  for (const m of session.members.values()) {
    if (m.party.some((c) => c.hp > 0)) {
      anyAlive = true
      break
    }
  }

  if (!anyAlive) {
    session.ended = true
    session.victory = false
    events.push({ t: 'end', result: 'lose', winner: 1 })
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
