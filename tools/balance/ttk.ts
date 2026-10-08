// Time-to-KO bands: how many hits of the attacker's best STAB move a level-matched same-rarity defender survives.
// Deterministic (expected damage from the shared formulas); bands live in tools/balance/rules.json (ttk).
import type { Creature, SpeciesDef } from '../../src/shared/types.ts'
import { typeEffectiveness } from '../../src/shared/content/index.ts'
import { calcStats, createCreature } from '../../src/shared/creature.ts'
import { Rng } from '../../src/shared/rng.ts'
import { emptyStages, estimateDamage, type Fighter } from '../../src/shared/battle/formulas.ts'
import { C, RULES, STATS, mean, quantile, r1, table } from './lib.ts'

export type TtkClass = 'neutral' | 'superEffective' | 'resisted'

function fighterOf(sp: SpeciesDef, level: number, iv: number): Fighter {
  const cr: Creature = createCreature(sp.id, level, { rng: new Rng(1), shiny: false }, C)
  for (const k of STATS) cr.ivs[k] = iv
  cr.abilityId = ''
  return { creature: cr, level, stats: calcStats(cr, C), stages: emptyStages(), critStageAdd: 0 }
}

/** The attacker's strongest STAB damaging move inside [lo, hi] power (accuracy-weighted), or null. */
function mainMove(sp: SpeciesDef, lo: number, hi: number): { id: string; power: number } | null {
  let best: { id: string; power: number } | null = null
  for (const e of sp.learnset) {
    const m = C.moves[e.move]
    if (!m || m.category === 'status' || !sp.types.includes(m.type) || m.power < lo || m.power > hi) continue
    if (m.effects.some((x) => x.kind === 'recharge' || x.kind === 'selfFaint' || x.kind === 'multiHit' || x.kind === 'fixedDamage')) continue
    if (!best || m.power * (m.accuracy || 100) > best.power * (C.moves[best.id].accuracy || 100)) best = { id: m.id, power: m.power }
  }
  return best
}

export interface TtkRow { level: number; cls: TtkClass; n: number; p10: number; median: number; p90: number }

/** Hits-to-KO samples at one level for every effectiveness class. */
export function ttkRows(level: number, rarities = ['R', 'SR', 'SSR'], pairs = 1200, seed = 1): TtkRow[] {
  const pool = C.speciesList.filter((s) => rarities.includes(s.rarity))
  const rng = new Rng(seed)
  const by: Record<TtkClass, number[]> = { neutral: [], superEffective: [], resisted: [] }
  const iv = Math.round(C.config.creature.ivMax / 2)
  const [lo, hi] = RULES.ttk.movePower
  for (let i = 0; i < pairs; i++) {
    const a = pool[rng.int(0, pool.length - 1)]
    const d = pool[rng.int(0, pool.length - 1)]
    if (a.id === d.id) continue
    const mv = mainMove(a, lo, hi)
    if (!mv) continue
    const att = fighterOf(a, level, iv)
    const def = fighterOf(d, level, iv)
    const eff = typeEffectiveness(C.moves[mv.id].type, d.types, C)
    if (eff === 0) continue
    const avg = estimateDamage(att, def, C.moves[mv.id], 'none', C).avg
    const cls: TtkClass = eff > 1 ? 'superEffective' : eff < 1 ? 'resisted' : 'neutral'
    by[cls].push(def.stats.hp / Math.max(1, avg))
  }
  return (Object.keys(by) as TtkClass[]).map((cls) => ({
    level, cls, n: by[cls].length, p10: r1(quantile(by[cls], 0.1)), median: r1(quantile(by[cls], 0.5)), p90: r1(quantile(by[cls], 0.9)),
  }))
}

export function ttkViolations(): string[] {
  const out: string[] = []
  for (const level of RULES.ttk.levels) {
    for (const r of ttkRows(level)) {
      const [lo, hi] = RULES.ttk.band[r.cls]
      if (r.median < lo || r.median > hi) out.push(`level ${level} ${r.cls}: median hits-to-KO ${r.median} outside [${lo}, ${hi}]`)
    }
  }
  return out
}

export function report(): string {
  const lines: string[] = [`== hits to KO with the attacker's best STAB move (power ${RULES.ttk.movePower.join('-')}), level-matched R/SR/SSR pairs ==`]
  const rows: (string | number)[][] = []
  for (const level of RULES.ttk.levels) for (const r of ttkRows(level)) rows.push([level, r.cls, r.n, r.p10, r.median, r.p90, `${RULES.ttk.band[r.cls][0]}-${RULES.ttk.band[r.cls][1]}`])
  lines.push(table(['level', 'matchup', 'n', 'p10', 'median', 'p90', 'band'], rows))
  const v = ttkViolations()
  lines.push('', `== violations: ${v.length} ==`, ...v)
  void mean
  return lines.join('\n')
}
