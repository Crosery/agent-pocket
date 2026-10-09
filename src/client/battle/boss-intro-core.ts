// Pure helpers of the boss intro cut-in (no DOM): the connection gate and the shared skip request.
import { BOSS_PRES } from '../render/battle/boss-config.ts'

export interface Connection { saveData?: boolean; effectiveType?: string }

/** Whether this connection should not even try the clip (Save-Data, 2G). */
export function shouldSkipClip(conn: Connection | undefined, cfg = BOSS_PRES.intro): boolean {
  if (!conn) return false
  if (cfg.skipOnSaveData && conn.saveData) return true
  return !!conn.effectiveType && cfg.slowConnections.includes(conn.effectiveType)
}

/** One skip request shared by every wait of the intro. */
export interface SkipGate {
  readonly skipped: boolean
  fire(): void
  onSkip(cb: () => void): () => void
  /** Resolves after `ms` or at once when skipped. */
  wait(ms: number): Promise<void>
}

export function createSkipGate(): SkipGate {
  const listeners = new Set<() => void>()
  let skipped = false
  const gate: SkipGate = {
    get skipped() { return skipped },
    fire() { skipped = true; for (const cb of [...listeners]) cb() },
    onSkip(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
    wait(ms) {
      return new Promise<void>((resolve) => {
        if (skipped) { resolve(); return }
        const done = () => { clearTimeout(timer); off(); resolve() }
        const timer = setTimeout(done, ms)
        const off = gate.onSkip(done)
      })
    },
  }
  return gate
}

