import type { EventBus } from '../contracts.ts'

/**
 * Typed synchronous pub/sub. Handlers added or removed during an emit do not affect that emit,
 * and a throwing handler is reported without preventing the remaining handlers from running.
 */
export function createEventBus<E>(): EventBus<E> {
  const handlers = new Map<keyof E, Set<(payload: never) => void>>()

  const on = <K extends keyof E>(type: K, fn: (payload: E[K]) => void): (() => void) => {
    let set = handlers.get(type)
    if (!set) { set = new Set(); handlers.set(type, set) }
    set.add(fn as (payload: never) => void)
    return () => { handlers.get(type)?.delete(fn as (payload: never) => void) }
  }

  return {
    on,
    once<K extends keyof E>(type: K, fn: (payload: E[K]) => void): () => void {
      const off = on(type, (payload) => { off(); fn(payload) })
      return off
    },
    emit<K extends keyof E>(type: K, payload: E[K]): void {
      const set = handlers.get(type)
      if (!set || set.size === 0) return
      for (const fn of [...set]) {
        try { (fn as (p: E[K]) => void)(payload) } catch (err) { reportError(err) }
      }
    },
  }
}

function reportError(err: unknown): void {
  const g = globalThis as { reportError?: (e: unknown) => void }
  if (typeof g.reportError === 'function') g.reportError(err)
  else console.error(err)
}
