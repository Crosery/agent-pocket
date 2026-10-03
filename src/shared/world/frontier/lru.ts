// Bounded least-recently-used cache (Map insertion order). Every frontier cache uses one, so memory never grows
// without bound however far the player travels.
export class Lru<K, V> {
  private readonly map = new Map<K, V>()
  readonly capacity: number

  constructor(capacity: number) { this.capacity = Math.max(1, Math.floor(capacity)) }

  get size(): number { return this.map.size }

  get(key: K): V | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  /** Lookup without touching the recency order. */
  peek(key: K): V | undefined { return this.map.get(key) }

  has(key: K): boolean { return this.map.has(key) }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K
      this.map.delete(oldest)
    }
  }

  delete(key: K): boolean { return this.map.delete(key) }

  clear(): void { this.map.clear() }

  keys(): IterableIterator<K> { return this.map.keys() }

  entries(): IterableIterator<[K, V]> { return this.map.entries() }
}
