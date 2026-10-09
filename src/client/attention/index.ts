// Watches the save for things the player can act on (see logic.ts) and shows them: the menu chip on desktop, the red
// dot on the pad's menu key on phones, and an `attention:raised` event the tutorial turns into a one-time prompt.
// The menu rows and the claimable entries read the same logic themselves when they paint.
import type { GameContext } from '../contracts.ts'
import { ATTENTION } from './config.ts'
import { attentionCounts, attentionTotal, raisedSources, type AttentionCounts } from './logic.ts'

export const ATTENTION_MENU_CLASS = 'ap-attn-menu'

export interface Attention {
  readonly counts: AttentionCounts
  update(dt: number): void
  /** Look at the save now (after a claim) instead of waiting for the next poll. */
  refresh(): void
  dispose(): void
}

export function createAttention(ctx: GameContext): Attention {
  const html = document.documentElement
  let counts: AttentionCounts = {}
  let seen: AttentionCounts | null = null
  let wait = 0

  const refresh = () => {
    counts = attentionCounts(ctx.save)
    const total = attentionTotal(counts)
    html.classList.toggle(ATTENTION_MENU_CLASS, total > 0)
    ctx.hud.setMenuAlert(total > 0, ctx.input.lastDevice)
    for (const id of raisedSources(seen, counts)) ctx.events.emit('attention:raised', { id })
    seen = counts
  }
  const off = ctx.events.on('save:changed', refresh)
  refresh()

  return {
    get counts() { return counts },
    update(dt) {
      wait -= dt
      if (wait > 0) return
      wait = ATTENTION.pollSec
      refresh()
    },
    refresh,
    dispose() { off(); html.classList.remove(ATTENTION_MENU_CLASS); ctx.hud.setMenuAlert(false, ctx.input.lastDevice) },
  }
}
