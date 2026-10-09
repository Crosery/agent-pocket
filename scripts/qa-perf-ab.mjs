// A/B driver for scripts/qa-perf.mjs (issue #36): runs the same job on several builds back to back, so a loaded machine
// disturbs every variant alike, and keeps the partial result of each variant on disk after every job.
//   node scripts/qa-perf-ab.mjs --out /tmp/ap-t36/ab --variants "before=http://127.0.0.1:5236;after=http://127.0.0.1:8836,quality=medium,only=phone"
//        [--viewports phone,desktop] [--scenes ...] [--runs 2] [--frames 300] [--space ap-36] [--raf false] [--modes stand] [--raf-max-ms 20000]
// A variant is `name=url[,quality=<tier>][,only=<viewport>]`. Writes <out>/<name>.json (rows in the qa-perf.mjs format).
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { SCENES } from './qa-perf-scenes.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []))
const out = args.out ?? 'output/36/raw'
mkdirSync(out, { recursive: true })
const variants = String(args.variants ?? '').split(';').filter(Boolean).map((spec) => {
  const [head, ...opts] = spec.split(',')
  const eq = head.indexOf('=')
  return { name: head.slice(0, eq), base: head.slice(eq + 1), ...Object.fromEntries(opts.map((o) => o.split('='))) }
})
const runs = Number(args.runs ?? 2)
const rows = Object.fromEntries(variants.map((v) => [v.name, []]))
for (const scene of (args.scenes ?? Object.keys(SCENES).join(',')).split(',')) {
  for (const viewport of (args.viewports ?? 'phone,desktop').split(',')) {
    for (let run = 1; run <= runs; run++) {
      for (const v of variants) {
        if (v.only && v.only !== viewport) continue
        const a = ['scripts/qa-perf.mjs', '--label', `${v.name}-tmp`, '--out', `${out}/tmp`, '--base', v.base, '--scenes', scene, '--viewports', viewport, '--runs', '1', '--first-run', String(run),
          '--frames', String(args.frames ?? 300), '--space', args.space ?? 'ap-36']
        if (v.quality) a.push('--quality', v.quality)
        if (args.raf) a.push('--raf', args.raf)
        if (args.modes) a.push('--modes', args.modes)
        if (args['raf-max-ms']) a.push('--raf-max-ms', args['raf-max-ms'])
        const res = spawnSync('node', a, { encoding: 'utf8', timeout: 900_000 })
        try {
          const got = JSON.parse(readFileSync(`${out}/tmp/${v.name}-tmp.json`, 'utf8'))
          for (const r of got) rows[v.name].push({ ...r, label: v.name })
          if (!got.length) console.error(`no rows: ${v.name} ${viewport} ${scene} run ${run}: ${String(res.stderr ?? '').split('\n').find((l) => l.startsWith('ERR')) ?? ''}`)
        } catch { console.error(`failed: ${v.name} ${viewport} ${scene} run ${run}: ${String(res.stderr ?? '').slice(0, 200)}`) }
        writeFileSync(`${out}/${v.name}.json`, JSON.stringify(rows[v.name], null, 1))
        console.log(`done ${v.name} ${viewport} ${scene} run ${run}`)
      }
    }
  }
}
