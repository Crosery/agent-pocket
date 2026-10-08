// Monte Carlo of boss fights: win rate with the plain shared AI vs with the boss's counter strategy.
// Usage: node scripts/boss-sim.ts [bossId ...] [--n=200] [--turns]
import { CONTENT } from '../src/shared/content/index.ts'
import { COUNTERS } from '../tests/boss-counters.ts'
import { simulate, winRate } from '../tests/boss-sim.ts'

const args = process.argv.slice(2)
const n = Number(args.find((a) => a.startsWith('--n='))?.slice(4) ?? 100)
const ids = args.filter((a) => !a.startsWith('--'))
for (const id of ids.length ? ids : CONTENT.bossList.map((b) => b.id)) {
  const plain = winRate({ bossId: id }, n)
  const counter = COUNTERS[id] ? winRate({ bossId: id, ...COUNTERS[id] }, n) : plain
  const sample = simulate({ bossId: id, seed: 1, ...(COUNTERS[id] ?? {}) })
  console.log(`${id.padEnd(12)} plain ${(plain.rate * 100).toFixed(0).padStart(3)}% (${plain.turns.toFixed(1)}t)  counter ${(counter.rate * 100).toFixed(0).padStart(3)}% (${counter.turns.toFixed(1)}t, ${counter.baits.toFixed(1)} baits)  forms ${sample.bossForms.join('>')}`)
}
