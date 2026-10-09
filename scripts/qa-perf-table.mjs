// Summarises scripts/qa-perf.mjs output: node scripts/qa-perf-table.mjs <file.json> [<other.json> ...]
import { readFileSync } from 'node:fs'

const f = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '-')
for (const file of process.argv.slice(2)) {
  const rows = JSON.parse(readFileSync(file, 'utf8'))
  console.log(`## ${file}`)
  console.log('viewport | scene | run | mode | tick avg | p95 | p99 | max | render cpu | gpu wait | update | main ms/f | heap KB/f | calls | tris(k) | tex | geo | heapMB | tier | internal')
  for (const r of rows) {
    for (const mode of ['stand', 'walk']) {
      const m = r[mode]
      if (!m) continue
      console.log([r.viewport, r.sceneId, r.run, mode, f(m.tick.avg), f(m.tick.p95), f(m.tick.p99), f(m.tick.max), f(m.render.avg, 2), f(m.gpu.avg, 2), f(m.update.avg, 2), f(m.mainThreadMsPerFrame, 2),
        f(m.heapDeltaKB / 300, 1), m.calls, f(m.triangles / 1000, 0), m.textures, m.geometries, f(r.heapMB, 0), m.quality + (m.governor ? '+g' + m.governor : ''), `${m.internal.w}x${m.internal.h}`].join(' | '))
    }
    if (r.raf) {
      const m = r.raf
      console.log([r.viewport, r.sceneId, r.run, 'raf', f(m.frame.avg), f(m.frame.p95), f(m.frame.p99), f(m.frame.max), f(m.render.avg, 2), '-', f(m.update.avg, 2), '-', '-', m.calls, f(m.triangles / 1000, 0), m.textures, m.geometries, f(r.heapMB, 0),
        m.quality + (m.governor ? '+g' + m.governor : ''), `${m.internal.w}x${m.internal.h}`, `stalls=${m.stalls} >33ms=${f(m.over33 * 100, 0)}% ${m.states.join('/')}`].join(' | '))
    }
  }
}
