// Progression curves: exp, wild/trainer level ladder, gym ladder and the economy. Bands: tools/balance/rules.json (curve).
import type { TrainerDef } from '../../src/shared/types.ts'
import { buildWorld } from '../../src/shared/world/index.ts'
import { calcStats, expForLevel, expYield, createCreature } from '../../src/shared/creature.ts'
import { Rng } from '../../src/shared/rng.ts'
import { C, RULES, STATS, mean, r1, r2, table } from './lib.ts'
import servicesJson from '../../content/world/story/services.json' with { type: 'json' }
import regionsJson from '../../content/world/regions.json' with { type: 'json' }

export const bracketOf = <T extends { upTo: number }>(rows: T[], level: number): T => rows.find((r) => level <= r.upTo) ?? rows[rows.length - 1]

/** Average baseExp of species that appear at a level (rarity bands of the wild generator). */
function meanBaseExp(level: number): number {
  const bands = (C.speciesList.length ? [{ maxLevel: 12, rarities: ['N', 'R'] }, { maxLevel: 25, rarities: ['R', 'SR'] }, { maxLevel: 40, rarities: ['SR'] }, { maxLevel: 55, rarities: ['SR', 'SSR'] }, { maxLevel: 100, rarities: ['SSR'] }] : [])
  const band = bands.find((b) => level <= b.maxLevel) ?? bands[bands.length - 1]
  return mean(C.speciesList.filter((s) => band.rarities.includes(s.rarity) && s.stage >= 1).map((s) => s.baseExp))
}

export interface ExpRow { level: number; toNext: number; wildYield: number; battlesPerLevel: number; trainerBattlesPerLevel: number }

export function expRows(growth = 'medium'): ExpRow[] {
  return RULES.curve.expLevels.map((level) => {
    const toNext = expForLevel(growth as never, level + 1, C) - expForLevel(growth as never, level, C)
    const be = meanBaseExp(level)
    const wild = Math.max(1, Math.floor((be * level) / C.config.battle.expDivisor))
    const trainer = Math.max(1, Math.floor((be * level) / C.config.battle.expDivisor * C.config.battle.trainerExpMultiplier))
    return { level, toNext, wildYield: wild, battlesPerLevel: r1(toNext / wild), trainerBattlesPerLevel: r1(toNext / trainer) }
  })
}

let worldCache: ReturnType<typeof buildWorld> | null = null
const world = (): ReturnType<typeof buildWorld> => (worldCache ??= buildWorld())

/** Total base-stat points a party brings at its levels (IV mid): a size- and level-aware power index. */
export function partyPower(t: TrainerDef): number {
  const rng = new Rng(1)
  return t.party.reduce((a, p) => {
    const cr = createCreature(p.species!, p.level, { rng, shiny: false }, C)
    for (const k of STATS) cr.ivs[k] = Math.round(C.config.creature.ivMax / 2)
    const s = calcStats(cr, C)
    return a + STATS.reduce((x, k) => x + s[k], 0)
  }, 0)
}

export interface GymRow { gym: string; leader: string; level: number; size: number; top: number; power: number; ratio: number; reward: number; underlings: number; underlingMax: number }

export function gymRows(): GymRow[] {
  const w = world()
  const leaders = Object.values(w.trainers).filter((t) => t.id.startsWith('leader_')).map((t) => ({ t, top: Math.max(...t.party.map((p) => p.level)) }))
  leaders.sort((a, b) => a.top - b.top)
  const rows: GymRow[] = []
  let prev = 0
  for (const { t, top } of leaders) {
    const key = t.id.replace('leader_', '')
    const under = Object.values(w.trainers).filter((u) => u.id.startsWith('g') && u.id[2] === '-' && u.id !== t.id && w.trainers[u.id] && (u.id.startsWith(`g${gymLetter(key)}-`)))
    const power = partyPower(t)
    rows.push({
      gym: key, leader: t.id, level: top, size: t.party.length, top, power, ratio: prev ? r2(power / prev) : 0, reward: t.reward ?? 0,
      underlings: under.length, underlingMax: under.length ? Math.max(...under.map((u) => Math.max(...u.party.map((p) => p.level)))) : 0,
    })
    prev = power
  }
  return rows
}

const gymLetter = (key: string): string => ({ code: 'c', vision: 'v', sound: 's', search: 'r', compute: 'p', safety: 'f', agent: 'a', logic: 'l' } as Record<string, string>)[key] ?? '?'

export interface EconRow { item: string; price: number; heal: number | 'full'; perHp: number }

export function healLadder(): EconRow[] {
  const rows: EconRow[] = []
  for (const it of C.itemList) {
    if (it.effect.kind !== 'heal' || !it.buyable) continue
    const amount = it.effect.amount
    rows.push({ item: it.id, price: it.price, heal: amount, perHp: amount === 'full' ? 0 : r1(it.price / amount) })
  }
  return rows.sort((a, b) => a.price - b.price)
}

/** Typical max hp of a mid-stat species at a level, to compare healing items against. */
export function typicalMaxHp(level: number): number {
  const base = mean(C.speciesList.filter((s) => s.rarity === 'SR').map((s) => s.baseStats.hp))
  return Math.floor(((2 * base + C.config.creature.ivMax / 2) * level) / 100) + level + 10
}

export function curveViolations(): string[] {
  const R = RULES.curve
  const out: string[] = []
  for (const r of expRows()) {
    const [lo, hi] = bracketOf(R.battlesPerLevel, r.level).range
    if (r.battlesPerLevel < lo || r.battlesPerLevel > hi) out.push(`exp: ${r.battlesPerLevel} same-level wild battles per level at L${r.level} outside [${lo}, ${hi}]`)
  }
  for (const g of ['fast', 'medium', 'slow']) {
    const rows = expRows(g)
    for (let i = 1; i < rows.length; i++) if (rows[i].toNext <= rows[i - 1].toNext) out.push(`exp: ${g} curve not strictly increasing at L${rows[i].level}`)
  }
  const gyms = gymRows()
  if (gyms.length < R.gymCount) out.push(`gyms: found ${gyms.length}, need ${R.gymCount}`)
  gyms.forEach((g, i) => {
    if (i === 0 && (g.level < R.gymFirstLeaderLevel[0] || g.level > R.gymFirstLeaderLevel[1])) out.push(`gyms: first leader at L${g.level} outside [${R.gymFirstLeaderLevel}]`)
    if (i > 0) {
      const step = g.level - gyms[i - 1].level
      if (step < R.gymLevelStep[0] || step > R.gymLevelStep[1]) out.push(`gyms: ${g.gym} leader L${g.level} is ${step} above the previous gym (allowed ${R.gymLevelStep})`)
      const [rlo, rhi] = i === 1 ? R.gymFirstStepPowerRatio : R.gymPowerRatio
      if (g.ratio < rlo || g.ratio > rhi) out.push(`gyms: ${g.gym} leader party power x${g.ratio} the previous (allowed ${rlo},${rhi})`)
    }
    if (g.underlingMax && g.level - g.underlingMax > R.underlingMaxLevelBelow) out.push(`gyms: ${g.gym} underlings top out ${g.level - g.underlingMax} levels under the leader (max ${R.underlingMaxLevelBelow})`)
  })
  const ladder = healLadder().filter((r) => r.heal !== 'full')
  for (let i = 1; i < ladder.length; i++) if (ladder[i].perHp > ladder[i - 1].perHp) out.push(`economy: ${ladder[i].item} costs more per hp (${ladder[i].perHp}) than ${ladder[i - 1].item} (${ladder[i - 1].perHp})`)
  if (C.config.economy.startMoney < R.startMoneyInPotions * (ladder[0]?.price ?? 0)) out.push(`economy: start money buys fewer than ${R.startMoneyInPotions} of the cheapest potion`)
  return out
}

export function report(): string {
  const lines: string[] = []
  lines.push('== exp: medium-growth creature fighting same-level wild / trainer creatures of the level\'s rarity band ==')
  lines.push(table(['level', 'exp to next', 'wild yield', 'wild battles/level', 'trainer battles/level'], expRows().map((r) => [r.level, r.toNext, r.wildYield, r.battlesPerLevel, r.trainerBattlesPerLevel])))
  lines.push('', '== regions: level range vs the species rarities that can appear ==')
  lines.push(table(['region', 'levels'], (regionsJson as { id: string; levelRange: number[] }[]).map((r) => [r.id, r.levelRange.join('-')])))
  lines.push('', '== gym ladder ==')
  lines.push(table(['gym', 'leader lv', 'size', 'power', 'x prev', 'reward', 'underlings', 'underling top'], gymRows().map((g) => [g.gym, g.level, g.size, g.power, g.ratio, g.reward, g.underlings, g.underlingMax])))
  lines.push('', '== economy: healing items (buyable) ==')
  lines.push(table(['item', 'price', 'heals', 'price/hp', 'heals % of typical hp at L30/L60'], healLadder().map((r) => [r.item, r.price, r.heal, r.perHp, r.heal === 'full' ? '100%' : `${Math.round(100 * r.heal / typicalMaxHp(30))}% / ${Math.round(100 * r.heal / typicalMaxHp(60))}%`])))
  lines.push(`start money ${C.config.economy.startMoney}, blackout loss ${C.config.economy.blackoutMoneyLoss}, sell ratio ${C.config.economy.sellRatio}`)
  lines.push(`shop tiers by badges: ${JSON.stringify((servicesJson as { shop: { tiers: { atLeast: number; items: string[] }[] } }).shop.tiers.map((t) => [t.atLeast, t.items.length]))}`)
  const v = curveViolations()
  lines.push('', `== violations: ${v.length} ==`, ...v)
  return lines.join('\n')
}
