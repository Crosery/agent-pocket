// What is waiting for the player (rewards to claim, new entries, ...), as pure functions of the save. A source in
// content/ui.json names a provider from PROVIDERS; adding a new kind of "go look at this" is one provider here plus one
// source in the content, nothing else (dots, menu cursor, first-time prompt all follow).
import type { SaveData } from '../../shared/types.ts'
import { researchSummary } from '../world/research.ts'
import { ATTENTION, type AttentionConfig, type AttentionSource } from './config.ts'

export type AttentionSave = Pick<SaveData, 'research' | 'flags'>

/** How many things of one kind are waiting (0 = nothing). */
export type AttentionProvider = (save: AttentionSave) => number

export const PROVIDERS: Record<string, AttentionProvider> = {
  researchClaim: (save) => (researchSummary(save).canClaim ? 1 : 0),
}

export type AttentionCounts = Record<string, number>

export function attentionCounts(save: AttentionSave, cfg: AttentionConfig = ATTENTION, providers: Record<string, AttentionProvider> = PROVIDERS): AttentionCounts {
  const out: AttentionCounts = {}
  for (const s of cfg.sources) out[s.id] = Math.max(0, Math.floor(providers[s.provider]?.(save) ?? 0))
  return out
}

export const attentionTotal = (counts: AttentionCounts): number => Object.values(counts).reduce((a, n) => a + n, 0)

/** The sources whose menu entry is `action` and that have something waiting. */
export function entrySources(counts: AttentionCounts, action: string, cfg: AttentionConfig = ATTENTION): AttentionSource[] {
  return cfg.sources.filter((s) => s.entry === action && (counts[s.id] ?? 0) > 0)
}

/** First-time guidance: a waiting source whose entry the player has not opened yet. */
export function guidedSource(save: AttentionSave, counts: AttentionCounts, action: string, cfg: AttentionConfig = ATTENTION): AttentionSource | null {
  return entrySources(counts, action, cfg).find((s) => !save.flags[s.guideFlag]) ?? null
}

/** The player opened a menu entry: the sources behind it have done their guiding. Returns whether a flag changed. */
export function markEntryOpened(save: AttentionSave, action: string, cfg: AttentionConfig = ATTENTION): boolean {
  let changed = false
  for (const s of cfg.sources) {
    if (s.entry !== action || save.flags[s.guideFlag]) continue
    save.flags[s.guideFlag] = true
    changed = true
  }
  return changed
}

/** Sources that have something now and had nothing the last time (the first look counts: a save loaded with a reward waiting). */
export function raisedSources(prev: AttentionCounts | null, next: AttentionCounts): string[] {
  return Object.keys(next).filter((id) => next[id] > 0 && !((prev?.[id] ?? 0) > 0))
}
