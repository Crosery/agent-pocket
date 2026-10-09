// Pure helpers of the type chart screen (no DOM): matchup rows of a type, the verdict of a pair, the worked example,
// and the geometry of the loop rings. Every fact comes from content/types.json (CONTENT.typeChart); only the way it is
// grouped (which multipliers get a row, in what order) comes from content/screens.json typeChart.matchups.
import { CONTENT, typeEffectiveness } from '../../../shared/content/index.ts'
import type { LoopDef } from '../../onboarding/config.ts'
import { SCREENS, type MatchupRow, type TypeChartConfig } from './config.ts'

export interface MatchupGroup { row: MatchupRow; types: string[] }

/** Damage multiplier of `atk` moves against a single-type defender. */
export const mulOf = (atk: string, def: string): number => typeEffectiveness(atk, [def])

const typeIds = (): string[] => CONTENT.types.map((x) => x.id)

/** Attack side of `typeId`: the defenders its moves hit at each listed multiplier (empty groups are kept so the row can say "none"). */
export function attackGroups(typeId: string, cfg: TypeChartConfig = SCREENS.typeChart): MatchupGroup[] {
  return cfg.matchups.attack.map((row) => ({ row, types: typeIds().filter((d) => mulOf(typeId, d) === row.mul) }))
}

/** Defence side of `typeId`: the attackers whose moves hit it at each listed multiplier. */
export function defendGroups(typeId: string, cfg: TypeChartConfig = SCREENS.typeChart): MatchupGroup[] {
  return cfg.matchups.defend.map((row) => ({ row, types: typeIds().filter((a) => mulOf(a, typeId) === row.mul) }))
}

/** The attack-side row of a multiplier (x2 / x0.5 / x0), or null for a neutral x1 pair. */
export function rowOfMul(mul: number, cfg: TypeChartConfig = SCREENS.typeChart): MatchupRow | null {
  return cfg.matchups.attack.find((r) => r.mul === mul) ?? null
}

/** A worked example for the per-type view: the first type this one is strong against (else the first it is resisted by). */
export function exampleOf(typeId: string, cfg: TypeChartConfig = SCREENS.typeChart): { def: string; mul: number } | null {
  for (const g of attackGroups(typeId, cfg)) if (g.types[0]) return { def: g.types[0], mul: g.row.mul }
  return null
}

/** Number as shown in text ("2", "0.5", "0"). */
export const formatMul = (mul: number): string => String(mul)

/** The arrows of a loop: each type's moves are super effective against the next, the last against the first. */
export function loopEdges(loop: LoopDef): [string, string][] {
  return loop.types.map((from, i) => [from, loop.types[(i + 1) % loop.types.length]])
}

export interface RingNode { id: string; x: number; y: number; labelAbove: boolean }
export interface RingArrow { from: string; to: string; x1: number; y1: number; x2: number; y2: number; head: [number, number][] }
export interface RingLayout { nodes: RingNode[]; arrows: RingArrow[] }
export interface RingSize { w: number; h: number; radius: number; node: number; gap: number; head: number }

/**
 * Nodes on a circle, the first at the top and the rest clockwise, vertically centred in a w x h box once the labels
 * (`label` units above the top nodes, below the others) are counted; arrows run along the chords with the head's
 * tip touching the next node's rim (+gap).
 */
export function ringLayout(types: string[], ring: RingSize, label: number): RingLayout {
  const n = types.length
  const raw = types.map((id, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
    const x = ring.radius * Math.cos(a), y = ring.radius * Math.sin(a)
    return { id, x, y, labelAbove: y < -ring.radius * 0.5 }
  })
  const top = Math.min(...raw.map((p) => p.y - ring.node / 2 - (p.labelAbove ? label : 0)))
  const bottom = Math.max(...raw.map((p) => p.y + ring.node / 2 + (p.labelAbove ? 0 : label)))
  const cx = ring.w / 2
  const cy = (ring.h - (bottom - top)) / 2 - top
  const nodes = raw.map((p) => ({ id: p.id, x: Math.round(cx + p.x), y: Math.round(cy + p.y), labelAbove: p.labelAbove }))
  const arrows = nodes.map((a, i) => {
    const b = nodes[(i + 1) % n]
    const dx = b.x - a.x, dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len, uy = dy / len
    const reach = ring.node / 2 + ring.gap
    const tip = { x: b.x - ux * reach, y: b.y - uy * reach }
    const base = { x: tip.x - ux * ring.head, y: tip.y - uy * ring.head }
    const half = ring.head * 0.6
    const head: [number, number][] = [[tip.x, tip.y], [base.x - uy * half, base.y + ux * half], [base.x + uy * half, base.y - ux * half]]
    return { from: a.id, to: b.id, x1: a.x + ux * reach, y1: a.y + uy * reach, x2: base.x, y2: base.y, head }
  })
  return { nodes, arrows }
}
