// Ground items ('gi-<n>'): item ids chosen from CONTENT.itemList by category weights and price caps per level
// band (content/world/items.json); key items are never placed.
import type { ItemDef } from '../types.ts'
import { CONTENT, type Content } from '../content/index.ts'
import { F_RESERVED, addFlag, type MapDraft } from './grid.ts'
import { Rng } from './random.ts'
import type { GroundItemRules, ItemBand } from './schema.ts'

export interface ItemArea {
  draft: MapDraft
  /** Candidate tile indices (already filtered for walkable, reachable, free). */
  tiles: number[]
  levelMid: number
  visible: number
  hidden: number
}

export function bandFor(rules: GroundItemRules, level: number): ItemBand {
  return rules.bands.find((b) => level <= b.maxLevel) ?? rules.bands[rules.bands.length - 1]
}

export function pickItem(rules: GroundItemRules, level: number, hidden: boolean, rng: Rng, c: Content = CONTENT): ItemDef | null {
  const band = bandFor(rules, level)
  const maxPrice = band.maxPrice * (hidden ? rules.hiddenPriceMul : 1)
  const pool = c.itemList.filter((it) => !rules.excludeCategories.includes(it.category) && it.effect.kind !== 'key')
  const cats = Object.entries(band.weights).filter(([cat, w]) => w > 0 && pool.some((it) => it.category === cat && it.price <= maxPrice))
  if (cats.length) {
    const [cat] = rng.weighted(cats, ([, w]) => w)
    return rng.pick(pool.filter((it) => it.category === cat && it.price <= maxPrice))
  }
  const cheap = pool.filter((it) => it.price <= maxPrice)
  if (cheap.length) return rng.pick(cheap)
  return pool.length ? rng.pick(pool) : null
}

/** Places items into areas in order; ids continue from `counter.next`. */
export function placeGroundItems(areas: ItemArea[], rules: GroundItemRules, rng: Rng, counter: { next: number }, c: Content = CONTENT): void {
  for (const area of areas) {
    const d = area.draft
    const tiles = rng.shuffle(area.tiles.slice())
    const placed: { x: number; y: number }[] = d.items.map((it) => ({ x: it.x, y: it.y }))
    let cursor = 0
    const take = (): { x: number; y: number } | null => {
      while (cursor < tiles.length) {
        const i = tiles[cursor++]
        const x = i % d.w, y = (i - x) / d.w
        if (placed.some((p) => Math.abs(p.x - x) + Math.abs(p.y - y) < rules.minSpacing)) continue
        return { x, y }
      }
      return null
    }
    const kinds = [...Array(area.visible).fill(false), ...Array(area.hidden).fill(true)] as boolean[]
    for (const hidden of kinds) {
      const item = pickItem(rules, area.levelMid, hidden, rng, c)
      if (!item) return
      const at = take()
      if (!at) break
      const band = bandFor(rules, area.levelMid)
      d.items.push({ id: `gi-${counter.next++}`, x: at.x, y: at.y, item: item.id, qty: rng.int(band.qty[0], band.qty[1]), hidden })
      placed.push(at)
      addFlag(d, at.y * d.w + at.x, F_RESERVED)
    }
  }
}

/** Splits `total` over weights with largest-remainder rounding. */
export function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0 || total <= 0) return weights.map(() => 0)
  const raw = weights.map((w) => (w / sum) * total)
  const out = raw.map(Math.floor)
  let left = total - out.reduce((a, b) => a + b, 0)
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (const [, i] of order) { if (left <= 0) break; out[i]++; left-- }
  return out
}
