// Move value model: effective power (power x accuracy x hits, adjusted for drawbacks and secondary effects) against PP.
// All coefficients are in tools/balance/rules.json (moves.*).
import type { MoveDef, MoveEffect } from '../../src/shared/types.ts'
import { C, RULES, isDamagingMove, mean, r1, table } from './lib.ts'

const EV = () => RULES.moves.effectValue

/** Power-equivalent value of one secondary effect. */
export function effectValue(e: MoveEffect, power: number): number {
  const ev = EV()
  const chance = 'chance' in e ? e.chance / 100 : 1
  switch (e.kind) {
    case 'status': {
      const v = ev[`status:${e.status}`] ?? ev['status:default'] ?? 0
      return e.target === 'enemy' ? v * chance : -v * chance
    }
    case 'volatile': {
      const v = ev[`volatile:${e.volatile}`] ?? ev['volatile:default'] ?? 0
      return e.target === 'enemy' ? v * chance : v * chance
    }
    case 'stat': {
      let v = 0
      for (const [k, d] of Object.entries(e.stats)) {
        if (!d) continue
        const w = ev[`stat:${k}`] ?? ev['stat:default'] ?? 0
        // Boosts to self and drops on the enemy are good; the opposite signs are costs.
        const good = (e.target === 'self' && d > 0) || (e.target === 'enemy' && d < 0)
        v += (good ? 1 : -1) * w * Math.abs(d)
      }
      return v * chance
    }
    case 'heal': return (ev['heal'] ?? 0) * e.fraction * 2
    case 'drain': return (ev['drain'] ?? 0) * e.fraction * power * 2
    case 'weather': return ev['weather'] ?? 0
    case 'cureStatus': return ev['cureStatus'] ?? 0
    case 'highCrit': return ev['highCrit'] ?? 0
    default: return 0
  }
}

export interface MoveRow {
  id: string
  type: string
  category: string
  /** Raw power x accuracy x hits, drawback multipliers applied. */
  damageValue: number
  /** Secondary effect value in power points. */
  effectValue: number
  /** damageValue + effectValue: the number compared against PP. */
  value: number
  pp: number
  priority: number
  /** PP window expected for this value, from the tier table. */
  ppWindow: [number, number]
  /** Value points over (+) or under (-) what the PP would buy at the tier midpoint. */
  slack: number
}

export function movePowerPoints(m: MoveDef): number {
  const fixed = m.effects.find((e) => e.kind === 'fixedDamage')
  if (fixed) return fixed.amount === 'level' ? RULES.sim.level * 1.2 : fixed.amount * 1.5
  return m.power
}

export function damageValue(m: MoveDef): number {
  if (!isDamagingMove(m)) return 0
  const R = RULES.moves
  const multi = m.effects.find((e) => e.kind === 'multiHit')
  const hits = multi ? (multi.min + multi.max) / 2 : 1
  const sure = m.accuracy === 0 || m.effects.some((e) => e.kind === 'alwaysHit')
  let v = movePowerPoints(m) * hits * (sure ? 1 : m.accuracy / 100)
  const recoil = m.effects.find((e) => e.kind === 'recoil')
  if (recoil) v *= 1 - recoil.fraction * (1 - R.recoilMul) * 3
  if (m.effects.some((e) => e.kind === 'recharge')) v *= R.rechargeMul
  if (m.effects.some((e) => e.kind === 'selfFaint')) v *= R.selfFaintMul
  if (m.priority !== 0) v *= R.priorityMul ** m.priority
  return v
}

export function ppWindowFor(value: number): [number, number] {
  for (const t of RULES.moves.ppTiers) if (value <= t.upTo) return t.pp
  const last = RULES.moves.ppTiers[RULES.moves.ppTiers.length - 1]
  return last ? last.pp : [1, 99]
}

export function moveRows(): MoveRow[] {
  return C.moveList.map((m) => {
    const dv = damageValue(m)
    const ev = m.effects.reduce((a, e) => a + effectValue(e, movePowerPoints(m)), 0)
    const value = dv + ev
    const win = ppWindowFor(value)
    const mid = (win[0] + win[1]) / 2
    return { id: m.id, type: m.type, category: m.category, damageValue: r1(dv), effectValue: r1(ev), value: r1(value), pp: m.pp, priority: m.priority, ppWindow: win, slack: r1(mid - m.pp) }
  })
}

export interface MoveViolation { id: string; why: string }

export function moveViolations(): MoveViolation[] {
  const R = RULES.moves
  const out: MoveViolation[] = []
  for (const m of C.moveList) {
    const row = moveRows().find((r) => r.id === m.id)!
    if (isDamagingMove(m) && movePowerPoints(m) > R.maxPower) out.push({ id: m.id, why: `power ${movePowerPoints(m)} above ceiling ${R.maxPower}` })
    if (m.pp < row.ppWindow[0] || m.pp > row.ppWindow[1]) out.push({ id: m.id, why: `PP ${m.pp} outside window [${row.ppWindow}] for value ${row.value}` })
    if (!isDamagingMove(m) && m.power !== 0) out.push({ id: m.id, why: 'status move with non-zero power' })
    if (isDamagingMove(m) && m.category !== 'status' && m.power <= 0) out.push({ id: m.id, why: 'damaging move without power' })
  }
  return out
}

/** Moves whose value is far above their same-PP peers (cost-efficiency outliers), by tolerance. */
export function valueOutliers(): { id: string; value: number; peerMean: number; delta: number }[] {
  const rows = moveRows()
  const tol = RULES.moves.valueTolerance
  const out: { id: string; value: number; peerMean: number; delta: number }[] = []
  for (const r of rows) {
    if (r.damageValue <= 0) continue
    const peers = rows.filter((p) => p.damageValue > 0 && p.id !== r.id && Math.abs(p.pp - r.pp) <= 2)
    if (peers.length < 4) continue
    const pm = mean(peers.map((p) => p.value))
    if (Math.abs(r.value - pm) > tol) out.push({ id: r.id, value: r.value, peerMean: r1(pm), delta: r1(r.value - pm) })
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
}

export function report(): string {
  const rows = moveRows().filter((r) => r.damageValue > 0).sort((a, b) => b.value - a.value)
  const lines: string[] = ['== damaging moves by value (power x acc x hits, drawbacks, secondary effects) vs PP ==']
  lines.push(table(['move', 'type', 'cat', 'dmg', 'eff', 'value', 'pp', 'win', 'slack'], rows.map((r) => [r.id, r.type, r.category.slice(0, 4), r.damageValue, r.effectValue, r.value, r.pp, `${r.ppWindow[0]}-${r.ppWindow[1]}`, r.slack])))
  const st = moveRows().filter((r) => r.damageValue <= 0).sort((a, b) => b.value - a.value)
  lines.push('', '== status moves by value ==', table(['move', 'type', 'value', 'pp', 'win'], st.map((r) => [r.id, r.type, r.value, r.pp, `${r.ppWindow[0]}-${r.ppWindow[1]}`])))
  const v = moveViolations()
  lines.push('', `== violations: ${v.length} ==`, ...v.map((x) => `${x.id}: ${x.why}`))
  const o = valueOutliers()
  lines.push('', `== peer outliers (|value - same-PP peers| > ${RULES.moves.valueTolerance}): ${o.length} ==`, ...o.map((x) => `${x.id}: value ${x.value} vs peers ${x.peerMean} (${x.delta > 0 ? '+' : ''}${x.delta})`))
  return lines.join('\n')
}
