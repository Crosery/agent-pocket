// Ring buffer of every GameEvents emission (the bus is wrapped, not subscribed per type), for window.__ap.v1.events.
import type { EventBus, GameEvents } from '../contracts.ts'

export interface LoggedEvent { seq: number; at: number; type: string; payload: unknown }

export interface EventLog {
  /** Sequence number of the newest event (0 before any). */
  cursor(): number
  /** Events after `cursor`; `dropped` counts those already pushed out of the buffer. */
  since(cursor: number): { cursor: number; dropped: number; events: LoggedEvent[] }
  dispose(): void
}

const jsonSafe = (v: unknown): unknown => {
  try { return v === undefined ? null : JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

export function createEventLog(bus: EventBus<GameEvents>, limit: number, now: () => number = Date.now): EventLog {
  const buf: LoggedEvent[] = []
  let seq = 0
  const original = bus.emit
  bus.emit = ((type: keyof GameEvents, payload: GameEvents[keyof GameEvents]) => {
    buf.push({ seq: ++seq, at: now(), type: String(type), payload: jsonSafe(payload) })
    if (buf.length > limit) buf.splice(0, buf.length - limit)
    return (original as (t: keyof GameEvents, p: unknown) => void).call(bus, type, payload)
  }) as typeof bus.emit
  return {
    cursor: () => seq,
    since(cursor) {
      const oldest = buf.length ? buf[0].seq : seq + 1
      return { cursor: seq, dropped: Math.max(0, oldest - 1 - cursor), events: buf.filter((e) => e.seq > cursor) }
    },
    dispose() { bus.emit = original },
  }
}
