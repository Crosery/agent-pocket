// Boot-time benchmark (issue #36): navigation start -> loading overlay -> User Timing marks (ap:*) -> title interactive,
// and (with --scenario) -> in the world. Run it against a production build (`vite preview`), not the dev server.
//   node scripts/qa-perf-boot.mjs [--base http://127.0.0.1:5236] [--space ap-36] [--runs 3] [--viewports phone,desktop]
//        [--scenario fresh-start]   (needs a devtools build) [--label before] [--out output/36/raw]
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []))
const VIEWPORTS = {
  phone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true, throttle: 4 },
  desktop: { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false, touch: false, throttle: 1 },
}
const config = {
  base: args.base ?? 'http://127.0.0.1:5236',
  space: args.space ?? 'ap-36',
  runs: Number(args.runs ?? 3),
  scenario: args.scenario ?? '',
  label: args.label ?? 'boot',
  viewports: (args.viewports ?? 'phone,desktop').split(',').map((v) => ({ name: v, ...VIEWPORTS[v] })),
}

const browser = `
const task = await taskSpace(CONFIG.space)
const page = task.page('p1')
const emulate = async (vp) => {
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.deviceScaleFactor, mobile: vp.mobile })
  await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: vp.touch, maxTouchPoints: vp.touch ? 5 : 1 })
  await page.cdp('Emulation.setCPUThrottlingRate', { rate: vp.throttle })
}
for (const vp of CONFIG.viewports) {
  for (let run = 1; run <= CONFIG.runs; run++) {
    try {
      await emulate(vp)
      await page.goto('about:blank')
      await emulate(vp)
      await page.goto(CONFIG.base + '/' + (CONFIG.scenario ? '?dev=1&scenario=' + CONFIG.scenario : ''))
      await emulate(vp)
      if (CONFIG.scenario) await page.waitForFunction(() => performance.getEntriesByName('ap:world-entered').length > 0, undefined, { timeout: 180000 })
      else await page.waitForFunction(() => performance.getEntriesByName('ap:title').length > 0 && !!document.querySelector('.aps-titlescreen'), undefined, { timeout: 180000 })
      await page.waitForTimeout(300)
      const r = await page.evaluate(() => {
        const marks = Object.fromEntries(performance.getEntriesByType('mark').filter((m) => m.name.startsWith('ap:')).map((m) => [m.name.slice(3), Math.round(m.startTime)]))
        const paint = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]))
        const nav = performance.getEntriesByType('navigation')[0]
        const res = performance.getEntriesByType('resource')
        const js = res.filter((e) => /\\.js(\\?|$)/.test(e.name))
        const titleEl = document.querySelector('.aps-titlescreen')
        return { marks, paint, domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), jsFiles: js.length, jsTransferKB: Math.round(js.reduce((a, e) => a + e.transferSize, 0) / 1024), jsDecodedKB: Math.round(js.reduce((a, e) => a + e.decodedBodySize, 0) / 1024), title: !!titleEl }
      })
      console.log('BOOT ' + JSON.stringify({ viewport: vp.name, run, ...r }))
    } catch (err) {
      console.log('ERR ' + vp.name + ' ' + (err && err.message ? err.message : err))
    }
  }
}
await page.cdp('Emulation.setCPUThrottlingRate', { rate: 1 })
`
const res = spawnSync('ego-browser', ['nodejs'], { input: `const CONFIG = ${JSON.stringify(config)}\n${browser}`, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 1_800_000 })
const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
const rows = text.split('\n').filter((l) => l.startsWith('BOOT ')).map((l) => JSON.parse(l.slice(5)))
for (const l of text.split('\n')) if (l.startsWith('ERR ')) console.error(l)
const out = args.out ?? 'output/36/raw'
mkdirSync(out, { recursive: true })
writeFileSync(`${out}/${config.label}.json`, JSON.stringify(rows, null, 1))
const order = ['boot', 'assets', 'world', 'modules', 'title', 'world-entered']
console.log('viewport | run | FCP | ' + order.join(' | ') + ' | js files | js transfer KB | js decoded KB')
for (const r of rows) console.log([r.viewport, r.run, r.paint['first-contentful-paint'] ?? '-', ...order.map((k) => r.marks[k] ?? '-'), r.jsFiles, r.jsTransferKB, r.jsDecodedKB].join(' | '))
