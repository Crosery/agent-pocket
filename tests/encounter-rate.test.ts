import assert from 'node:assert/strict'
import test from 'node:test'
import { GAME, grassEncounterRate } from '../src/client/world/config.ts'
import { Rng } from '../src/shared/rng.ts'
import { buildWorld } from '../src/shared/world/index.ts'

test('grass encounters use the reduced comfort rate while preserving event modifiers', () => {
  assert.equal(GAME.encounters.grassRateMultiplier, 0.45)
  assert.ok(Math.abs(grassEncounterRate(0.1) - 0.045) < 1e-12)
  assert.ok(Math.abs(grassEncounterRate(0.1, 2) - 0.09) < 1e-12)
  assert.ok(Math.abs(grassEncounterRate(2) - 0.9) < 1e-12)
})

// ---- before / after, per tall-grass step ---------------------------------------------------------------------
// Before the comfort multiplier a step rolled `region.encounterRate x event modifier`; the owner found grass
// "almost every time" (10 % per step = a battle every ~10 steps, 65 % of crossing a 10-tile patch).

const before = (rate: number, mod = 1) => Math.min(1, rate * mod)
const after = (rate: number, mod = 1) => grassEncounterRate(rate, mod)
const crossing = (p: number, steps: number) => 1 - (1 - p) ** steps

test('per-step grass encounter probability: clearly lower than before, never zero, in every region', () => {
  const world = buildWorld()
  const regions = world.maps[world.startMap].regions.filter((r) => r.encounters.length > 0 && r.encounterRate > 0)
  assert.ok(regions.length >= 10)
  const rows: string[] = []
  for (const r of regions) {
    const b = before(r.encounterRate), a = after(r.encounterRate)
    assert.ok(a > 0, `${r.id} still encounters`)
    assert.ok(a <= b * 0.5, `${r.id}: ${a} vs ${b} is not clearly lower`)
    assert.ok(a >= b * 0.3, `${r.id}: ${a} vs ${b} is too suppressed`)
    if (r.id === 'meadow') rows.push(`meadow: ${(b * 100).toFixed(1)}% -> ${(a * 100).toFixed(1)}% per step; ~${(1 / b).toFixed(0)} -> ~${(1 / a).toFixed(0)} steps per battle; crossing 10 tiles ${(crossing(b, 10) * 100).toFixed(0)}% -> ${(crossing(a, 10) * 100).toFixed(0)}%, 25 tiles ${(crossing(b, 25) * 100).toFixed(0)}% -> ${(crossing(a, 25) * 100).toFixed(0)}%`)
  }
  console.log(rows.join('\n'))
})

test('simulated grass walking: encounter frequency matches the reduced rate, events still scale it', () => {
  const rate = 0.1
  for (const mod of [1, 2, 0.5]) {
    const rng = new Rng(2026)
    const N = 200_000
    let hits = 0
    for (let i = 0; i < N; i++) if (rng.chance(after(rate, mod))) hits++
    const p = hits / N, want = after(rate, mod)
    assert.ok(Math.abs(p - want) < 0.004, `mod ${mod}: simulated ${p.toFixed(4)} vs ${want.toFixed(4)}`)
  }
  const base = after(rate), boosted = after(rate, 2)
  assert.ok(boosted > base * 1.9 && boosted < base * 2.1, 'an encounter event still doubles the reduced rate')
  assert.ok(after(rate, 2) < before(rate), 'even a doubled event rate stays at the old baseline at most')
})
