// Procedural names and sign texts from the word pools in pois.json (lore.words, lore.biomeWords): every
// `{word}` placeholder is replaced by a seeded pick from its pool, `{biome}` by a biome adjective.
import type { Rng } from './random.ts'
import type { PoisFile } from './schema.ts'

export function fillWords(template: string, lore: PoisFile['lore'], biome: string, rng: Rng, params: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    if (k in params) return params[k]
    if (k === 'biome') {
      const pool = lore.biomeWords[biome]
      return pool?.length ? rng.pick(pool) : ''
    }
    const pool = lore.words[k]
    return pool?.length ? rng.pick(pool) : m
  })
}

/** A unique name: tries the patterns a few times, then appends a counter. */
export function uniqueName(patterns: string[], lore: PoisFile['lore'], biome: string, rng: Rng, used: Set<string>): string {
  let name = ''
  for (let t = 0; t < 12; t++) {
    name = fillWords(rng.pick(patterns), lore, biome, rng)
    if (!used.has(name)) { used.add(name); return name }
  }
  for (let n = 2; ; n++) {
    const v = `${name}${n}`
    if (!used.has(v)) { used.add(v); return v }
  }
}

/** Sign text for a lore key (`lore.templates[key]`), or null when the key has no templates. */
export function loreText(key: string, lore: PoisFile['lore'], biome: string, rng: Rng, params: Record<string, string>): string | null {
  const list = lore.templates[key]
  if (!list?.length) return null
  return fillWords(rng.pick(list), lore, biome, rng, params)
}
