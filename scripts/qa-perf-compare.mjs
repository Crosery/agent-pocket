// Markdown comparison of qa-perf.mjs / qa-perf-ab.mjs results (issue #36): the first file is the baseline.
//   node scripts/qa-perf-compare.mjs <viewport> <mode> label=file.json [label=file.json ...]
// One row per scene; every cell is the median over the runs (the shared machine makes single runs noisy): tick avg / p95 ms (CPU+GPU per frame, stepped), main-thread CPU ms, draw calls, kilo-triangles.
import { readFileSync } from 'node:fs'

const [viewport, mode, ...specs] = process.argv.slice(2)
const sets = specs.map((s) => {
  const i = s.indexOf('=')
  return { label: s.slice(0, i), rows: JSON.parse(readFileSync(s.slice(i + 1), 'utf8')).filter((r) => r.viewport === viewport && r[mode]) }
})
const mean = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2 }
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-')
const scenes = [...new Set(sets.flatMap((s) => s.rows.map((r) => r.sceneId)))]
const cell = (set, scene) => {
  const rs = set.rows.filter((r) => r.sceneId === scene).map((r) => r[mode])
  if (!rs.length) return null
  return { n: rs.length, avg: mean(rs.map((m) => m.tick.avg)), p95: mean(rs.map((m) => m.tick.p95)), p99: Math.max(...rs.map((m) => m.tick.p99)), cpu: mean(rs.map((m) => m.cpuMsPerFrame ?? NaN)),
    calls: mean(rs.map((m) => m.callsAvg ?? m.calls)), tris: mean(rs.map((m) => (m.trisAvg ?? m.triangles) / 1000)), tier: rs[0].quality, internal: `${rs[0].internal.w}x${rs[0].internal.h}` }
}
console.log(`| scene | ${sets.map((s) => `${s.label}: avg / p95 ms | cpu ms | calls | ktris`).join(' | ')} |`)
console.log(`|---|${sets.map(() => '---|').join('')}`)
for (const scene of scenes) {
  const cells = sets.map((s) => cell(s, scene))
  console.log(`| ${scene} | ${cells.map((c, i) => (c ? `${f(c.avg)} / ${f(c.p95)}${i ? ` (${f(((c.avg / cells[0].avg) - 1) * 100, 0)}%)` : ''} | ${f(c.cpu)} | ${f(c.calls, 0)} | ${f(c.tris, 0)}` : '- | - | - | -')).join(' | ')} |`)
}
const t = sets.map((s) => { const c = s.rows[0]; return c ? `${s.label}: ${c[mode].quality} ${c[mode].internal.w}x${c[mode].internal.h}` : '' }).join('; ')
console.log(`\nTier / internal grid: ${t}`)
