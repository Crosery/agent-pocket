// Uniform-grid spatial index per map for interest management (who can see whom).

export interface Positioned { readonly key: string; readonly map: string; readonly x: number; readonly y: number }

export interface SpatialIndex<T extends Positioned> {
  upsert(item: T): void
  remove(item: T): void
  /** Items on `map` within euclidean `radius` of (x, y). */
  query(map: string, x: number, y: number, radius: number): T[]
  /** All items on a map. */
  onMap(map: string): Iterable<T>
}

export function createSpatialIndex<T extends Positioned>(cellSize: number): SpatialIndex<T> {
  const maps = new Map<string, Map<string, Set<T>>>()
  const where = new Map<string, { map: string; cell: string }>()
  const cellOf = (x: number, y: number) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`

  const detach = (key: string, item: T) => {
    const at = where.get(key)
    if (!at) return
    const grid = maps.get(at.map)
    const set = grid?.get(at.cell)
    set?.delete(item)
    if (set && set.size === 0) grid!.delete(at.cell)
    if (grid && grid.size === 0) maps.delete(at.map)
    where.delete(key)
  }

  return {
    upsert(item) {
      const cell = cellOf(item.x, item.y)
      const at = where.get(item.key)
      if (at && at.map === item.map && at.cell === cell) return
      detach(item.key, item)
      let grid = maps.get(item.map)
      if (!grid) { grid = new Map(); maps.set(item.map, grid) }
      let set = grid.get(cell)
      if (!set) { set = new Set(); grid.set(cell, set) }
      set.add(item)
      where.set(item.key, { map: item.map, cell })
    },
    remove(item) { detach(item.key, item) },
    query(map, x, y, radius) {
      const grid = maps.get(map)
      if (!grid) return []
      const out: T[] = []
      const r2 = radius * radius
      const cx0 = Math.floor((x - radius) / cellSize), cx1 = Math.floor((x + radius) / cellSize)
      const cy0 = Math.floor((y - radius) / cellSize), cy1 = Math.floor((y + radius) / cellSize)
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const set = grid.get(`${cx},${cy}`)
          if (!set) continue
          for (const it of set) {
            const dx = it.x - x, dy = it.y - y
            if (dx * dx + dy * dy <= r2) out.push(it)
          }
        }
      }
      return out
    },
    *onMap(map) {
      const grid = maps.get(map)
      if (!grid) return
      for (const set of grid.values()) yield* set
    },
  }
}
