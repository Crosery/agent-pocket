// Typed view of content/ui.json "attention" (what the red dots and the first-time prompt are about) and its validator.
import uiJson from '../../../content/ui.json' with { type: 'json' }
import { CONTENT } from '../../shared/content/index.ts'

export interface AttentionSource {
  id: string
  /** Name of the function (logic.ts PROVIDERS) that counts what is waiting for the player. */
  provider: string
  /** Pause-menu action (content/screens.json pause.entries) the dot and the first-time guidance point at. */
  entry: string
  /** Save flag set once the player opened that entry; until then the menu cursor starts on it and the row pulses. */
  guideFlag: string
  /** Text key of the line shown in the pause menu's detail pane while the source has something. */
  detail: string
}

export interface AttentionConfig {
  /** Seconds between two looks at the save. */
  pollSec: number
  sources: AttentionSource[]
}

export const ATTENTION: AttentionConfig = (uiJson as unknown as { attention: AttentionConfig }).attention

/** Problems in an attention config (empty = OK): providers and pause entries must exist, texts must be there. */
export function validateAttention(cfg: AttentionConfig, providers: readonly string[], pauseActions: readonly string[], text: Record<string, string> = CONTENT.text): string[] {
  const errs: string[] = []
  if (!(cfg.pollSec > 0)) errs.push('attention.pollSec must be > 0')
  const ids = new Set<string>()
  const flags = new Set<string>()
  for (const s of cfg.sources) {
    const where = `attention source ${s.id}`
    if (ids.has(s.id)) errs.push(`${where}: duplicate id`)
    ids.add(s.id)
    if (!providers.includes(s.provider)) errs.push(`${where}: unknown provider "${s.provider}"`)
    if (!pauseActions.includes(s.entry)) errs.push(`${where}: "${s.entry}" is not a pause-menu entry`)
    if (!s.guideFlag || flags.has(s.guideFlag)) errs.push(`${where}: needs its own guideFlag`)
    flags.add(s.guideFlag)
    if (!(s.detail in text)) errs.push(`${where}: missing text "${s.detail}"`)
  }
  for (const key of ['hud.attention.menu', 'hud.attention.dot']) if (!(key in text)) errs.push(`attention: missing text "${key}"`)
  return errs
}
