// Contract between the hub and the PvP module (src/server/pvp.ts, implemented separately).
// The hub owns sockets, presence and persistence; the PvP module owns battle sessions.
import type { ClientMsg, ServerMsg } from '../shared/protocol.ts'

export interface PvpHost {
  send(playerId: string, msg: ServerMsg): void
  getPlayer(id: string): { id: string; name: string; avatar: string; busy: boolean } | null
  setBusy(id: string, busy: boolean): void
  recordPvp(winnerId: string | null, loserId: string | null): void
  /** Optional proximity rule (same map, within pvp range); absent = no range limit. */
  inRange?(a: string, b: string): boolean
}

export interface PvpInstance {
  handle(fromId: string, msg: ClientMsg): void
  onDisconnect(id: string): void
  /** Optional: release timers when the server shuts down. */
  dispose?(): void
}

export type PvpModule = { createPvp(host: PvpHost): PvpInstance }

/** Loads ./pvp.ts if present. Returns null (PvP disabled → 'pvp_unavailable') when missing or malformed. */
export async function loadPvpModule(log: (msg: string) => void = () => {}): Promise<PvpModule | null> {
  try {
    const mod = (await import(new URL('./pvp.ts', import.meta.url).href)) as Partial<PvpModule>
    if (typeof mod.createPvp !== 'function') { log('pvp.ts has no createPvp(), PvP disabled'); return null }
    return mod as PvpModule
  } catch (err) {
    log(`pvp module unavailable, PvP disabled (${(err as Error).message})`)
    return null
  }
}
