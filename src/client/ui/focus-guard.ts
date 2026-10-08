// Pure rules that keep the chat, the game's Input and DOM focus in agreement about who owns the keyboard.
// No DOM access: the glue lives in focus.ts and chat.ts. Tunables come from content/ui.json (ui.focus).

/** Chat is open exactly while focus sits in its own input or controls; focus anywhere else belongs to the game. */
export function chatFocusVerdict(open: boolean, focusInside: boolean): 'keep' | 'close' {
  return open && !focusInside ? 'close' : 'keep'
}

/** An overlay that can hold input hostage, so Esc must always be able to dismiss it. */
export interface EscapeLayer {
  id: string
  isOpen(): boolean
  dismiss(): void
}

export interface EscapeStack {
  register(layer: EscapeLayer): () => void
  /** Dismisses the topmost open layer and returns its id; null when nothing was open (Esc then falls through to the game). */
  dismissTop(): string | null
}

/** `order` lists layer ids topmost first; unlisted ids rank below every listed one, in registration order. */
export function createEscapeStack(order: readonly string[]): EscapeStack {
  const layers: EscapeLayer[] = []
  const rank = (id: string) => {
    const i = order.indexOf(id)
    return i < 0 ? order.length : i
  }
  return {
    register(layer) {
      layers.push(layer)
      return () => {
        const i = layers.indexOf(layer)
        if (i >= 0) layers.splice(i, 1)
      }
    },
    dismissTop() {
      const top = [...layers].sort((a, b) => rank(a.id) - rank(b.id)).find((l) => l.isOpen())
      if (!top) return null
      top.dismiss()
      return top.id
    },
  }
}

export interface StallWatch {
  /**
   * Feed once per frame. `blocked`: input is being refused; `trying`: the player is asking to move anyway.
   * Returns true exactly when blocked attempts have added up to the limit (the caller then releases the block).
   */
  step(dtSec: number, blocked: boolean, trying: boolean): boolean
  reset(): void
}

/** Accumulates time spent trying to move while blocked; any frame that is not blocked starts over. */
export function createStallWatch(limitSec: number): StallWatch {
  let stalled = 0
  return {
    step(dtSec, blocked, trying) {
      if (!blocked) { stalled = 0; return false }
      if (!trying) return false
      stalled += dtSec
      if (stalled < limitSec) return false
      stalled = 0
      return true
    },
    reset() { stalled = 0 },
  }
}
