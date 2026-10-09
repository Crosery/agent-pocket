// Frame-time benchmark (issue #36). Drives the page through window.__ap.v1 and prints one `PERF {json}` line per run.
//   node scripts/qa-perf.mjs [--base http://127.0.0.1:5236] [--space ap-36] [--out output/36/raw] [--frames 300]
//        [--runs 2] [--viewports phone,desktop] [--scenes town-day,night-rain-forge,...] [--label before] [--url-extra "&x=1"]
//        [--first-run 1] [--quality low|medium|high|ultra] [--modes stand,walk] [--raf false] [--raf-max-ms 20000] [--profile stand|walk]   (profile: CDP CPU sampling of that mode, top functions per frame)
// The browser half is piped into `ego-browser nodejs` with a CONFIG object in front, like scripts/qa/run.mjs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SCENES, VIEWPORTS } from './qa-perf-scenes.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []))

const config = {
  base: args.base ?? 'http://127.0.0.1:5236',
  space: args.space ?? 'ap-36',
  frames: Number(args.frames ?? 300),
  runs: Number(args.runs ?? 2),
  firstRun: Number(args['first-run'] ?? 1),
  settleMs: Number(args.settle ?? 4000),
  label: args.label ?? 'run',
  urlExtra: args['url-extra'] ?? '',
  profile: args.profile ?? '',
  modes: (args.modes ?? 'stand,walk').split(','),
  raf: args.raf !== 'false',
  stallMs: Number(args.stall ?? 400),
  rafMaxMs: Number(args['raf-max-ms'] ?? 20000),
  jobs: [],
}
const extraSetup = args.quality ? [['settings.set', { key: 'quality', value: args.quality }]] : []
for (const v of (args.viewports ?? 'phone,desktop').split(',')) {
  for (const s of (args.scenes ?? Object.keys(SCENES).join(',')).split(',')) {
    for (let r = config.firstRun; r < config.firstRun + config.runs; r++) config.jobs.push({ viewport: v, vp: VIEWPORTS[v], scene: s, def: { ...SCENES[s], setup: [...extraSetup, ...SCENES[s].setup] }, run: r })
  }
}

const browserSrc = readFileSync(fileURLToPath(new URL('./qa-perf.browser.mjs', import.meta.url)), 'utf8')
const out = args.out ?? 'output/36/raw'
mkdirSync(out, { recursive: true })
const res = spawnSync('ego-browser', ['nodejs'], { input: `const CONFIG = ${JSON.stringify(config)}\n${browserSrc}`, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 3_000_000 })
const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
const rows = text.split('\n').filter((l) => l.startsWith('PERF ')).map((l) => JSON.parse(l.slice(5)))
for (const l of text.split('\n')) if (l.startsWith('ERR ')) console.error(l)
const profs = text.split('\n').filter((l) => l.startsWith('PROF ')).map((l) => JSON.parse(l.slice(5)))
if (profs.length) writeFileSync(`${out}/${config.label}-profile.json`, JSON.stringify(profs, null, 1))
writeFileSync(`${out}/${config.label}.json`, JSON.stringify(rows, null, 1))
console.log(`${rows.length}/${config.jobs.length} runs -> ${out}/${config.label}.json`)
