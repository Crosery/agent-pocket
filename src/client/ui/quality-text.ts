// Player-facing text for natures and grades (no DOM): names, quips, stat-arrow summaries and the one-line appraisal.
import type { Creature, StatKey } from '../../shared/types.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { gradeOf } from '../../shared/gameplay/quality.ts'

const statName = (k: StatKey): string => CONTENT.statByKey[k]?.nameZh ?? k

export const natureName = (id: string | undefined): string => (id && CONTENT.natureById[id] ? t(`screens.quality.nature.${id}.name`) : t('screens.common.dash'))
export const natureQuip = (id: string | undefined): string => (id && CONTENT.natureById[id] ? t(`screens.quality.nature.${id}.quip`) : '')
export const gradeNick = (gradeId: string): string => t(`screens.quality.grade.${gradeId}`)

/** Names of the boosted / lowered stats; null for the neutral natures. */
export function natureStats(id: string | undefined): { up: string; down: string } | null {
  const n = id ? CONTENT.natureById[id] : undefined
  return n?.up && n.down ? { up: statName(n.up), down: statName(n.down) } : null
}

/** "推理↑ 稳健↓" for a biased nature, '' for a neutral one. */
export function natureArrowsText(id: string | undefined): string {
  const s = natureStats(id)
  return s ? `${s.up}↑ ${s.down}↓` : ''
}

/** One-line appraisal: "B · 激进 推理↑ 稳健↓" (neutral natures drop the arrows). */
export function appraisalText(cr: Pick<Creature, 'ivs' | 'nature'>): string {
  const grade = gradeOf(cr.ivs).id
  const s = natureStats(cr.nature)
  return s
    ? t('screens.quality.chip', { grade, nature: natureName(cr.nature), up: s.up, down: s.down })
    : t('screens.quality.chipNeutral', { grade, nature: natureName(cr.nature) })
}
