// Screenshots of the benchmark scenes for before/after comparison (issue #36): same scenario, same fixed frame count, HUD hidden.
//   node scripts/qa-perf-shots.mjs --label before [--base http://127.0.0.1:5236] [--space ap-36] [--viewports phone,desktop]
//        [--scenes town-day,...] [--frames 90] [--quality medium] [--out output/36/shots]
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { SCENES, VIEWPORTS } from './qa-perf-scenes.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []))
const out = args.out ?? 'output/36/shots'
mkdirSync(out, { recursive: true })
const config = {
  base: args.base ?? 'http://127.0.0.1:5236',
  space: args.space ?? 'ap-36',
  label: args.label ?? 'shot',
  frames: Number(args.frames ?? 90),
  out: new URL(`../${out}/`, import.meta.url).pathname,
  quality: args.quality ?? '',
  jobs: [],
}
for (const v of (args.viewports ?? 'phone,desktop').split(',')) {
  for (const s of (args.scenes ?? Object.keys(SCENES).join(',')).split(',')) config.jobs.push({ viewport: v, vp: VIEWPORTS[v], scene: s, def: SCENES[s] })
}
const browser = `
const task = await taskSpace(CONFIG.space)
const page = task.page('p1')
const ev = (fn, a) => (a === undefined ? page.evaluate(fn) : page.evaluate(fn, a))
const emulate = async (vp) => {
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.deviceScaleFactor, mobile: vp.mobile })
  await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: vp.touch, maxTouchPoints: vp.touch ? 5 : 1 })
}
for (const job of CONFIG.jobs) {
  try {
    await emulate(job.vp)
    await page.goto('about:blank')
    await emulate(job.vp)
    await page.goto(CONFIG.base + '/?dev=1&scenario=' + job.def.scenario)
    await emulate(job.vp)
    await page.waitForFunction(() => window.__ap && window.__ap.v1 && window.__ap.v1.info, undefined, { timeout: 120000 })
    await page.waitForFunction((def) => {
      const ow = window.__AP && window.__AP.overworld
      if (!ow || !ow.mapId) return false
      return def.wait === 'battle' ? ow.battleActive || document.documentElement.classList.contains('ap-battle-on') : ow.free
    }, job.def, { timeout: 120000 })
    const setup = (CONFIG.quality ? [['settings.set', { key: 'quality', value: CONFIG.quality }]] : []).concat(job.def.setup)
    await ev(async (setup) => { for (const [id, a] of setup) await window.__ap.v1.cmd(id, a) }, setup)
    await page.waitForTimeout(job.def.wait === 'battle' ? 9000 : 4000)
    if (job.def.wait !== 'battle') {
      await ev((n) => { window.__ap.v1.time.pause(); window.__ap.v1.time.step(n, 1 / 60) }, CONFIG.frames)
    }
    await ev(() => window.__ap.v1.shot.prepare({ hideDev: true, hideHud: true }))
    const path = CONFIG.out + CONFIG.label + '-' + job.viewport + '-' + job.scene + '.png'
    await page.screenshot({ path })
    await ev(() => window.__ap.v1.shot.release())
    console.log('SHOT ' + path)
  } catch (err) {
    console.log('ERR ' + job.viewport + ' ' + job.scene + ' ' + (err && err.message ? err.message : err))
  }
}
`
const res = spawnSync('ego-browser', ['nodejs'], { input: `const CONFIG = ${JSON.stringify(config)}\n${browser}`, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 1_800_000 })
const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
for (const l of text.split('\n')) if (l.startsWith('SHOT ') || l.startsWith('ERR ')) console.log(l)
