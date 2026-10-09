// Battle screen audit across the seven owner viewports (issue #32): per scenario (boss with 6 meters, boss with 3, wild,
// trainer) and state (message, commands, moves, item screen, party screen): the layout auditor over the whole battle UI
// plus the creature checks of qa-battle-layout.mjs (no window or foreign element on a sprite, bottom anchoring, no pad).
//   ego-browser nodejs <<'JS'
//   const { runBattleAudit } = await import('file:///<repo>/scripts/qa-battle-audit.mjs')
//   await runBattleAudit({ task: await taskSpace(<id>), base: 'http://127.0.0.1:<port>', phase: 'audit' })
//   JS
// Output: output/32/<phase>/<viewport>/<scenario>-<state>.png and report.json.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { measureScreen } from './qa-layout-audit.mjs'
import { BATTLE_VIEWPORTS, setBattleViewport } from './qa-battle-layout.mjs'

export const BATTLE_SCENARIOS = [
  { id: 'opus', query: 'battle=boss&boss=opus' },
  { id: 'astra', query: 'battle=boss&boss=astra' },
  { id: 'wild', query: 'battle=wild' },
  { id: 'trainer', query: 'battle=trainer' },
]
export const BATTLE_STATES = ['msg', 'cmd', 'moves', 'bag', 'party']

export async function runBattleAudit({ task, base, phase = 'audit', viewports = BATTLE_VIEWPORTS, scenarios = BATTLE_SCENARIOS, states = BATTLE_STATES, slot = '2032100003', repoRoot = null }) {
  assert.match(phase, /^[a-z0-9-]+$/)
  const root = repoRoot ?? fileURLToPath(new URL('..', import.meta.url))
  const outDir = `${root}output/32/${phase}/`
  const page = task.page('p1')
  const report = []
  const key = async (k, n = 1) => { for (let i = 0; i < n; i++) { await page.keyboard.press(k); await page.waitForTimeout(140) } }
  for (const vp of viewports) {
    await mkdir(`${outDir}${vp.name}`, { recursive: true })
    for (const sc of scenarios) {
      const violations = [], warnings = []
      const record = (state, extra = {}) => { report.push({ viewport: vp.name, scenario: sc.id, state, violations: [...violations], warnings: [...warnings], ...extra }); violations.length = 0; warnings.length = 0 }
      try {
        await page.cdp('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: false })
        await page.goto(`${base}/?dev=1&skipTitle=1&reset=1&slot=${slot}&${sc.query}&t=720`)
        await page.waitForFunction(() => window.__AP && document.querySelector('.apb-root'), undefined, { timeout: 60000 })
        await setBattleViewport(page, vp)
        await page.evaluate(() => { window.__AP.save.settings.showTips = false })
        const intro = await page.waitForFunction(() => document.querySelector('.apb-bi.is-playing, .apb-bi.is-static'), undefined, { timeout: 4000 }).then(() => true).catch(() => false)
        if (intro) {
          await page.waitForTimeout(1500)
          const r = await measureScreen(page, { scope: '.apb-bi', ignore: '' }, `${outDir}${vp.name}/${sc.id}-intro.png`)
          record('intro', { violations: r.violations, warnings: r.warnings })
          await key('KeyZ')
        }
        await page.waitForFunction(() => !document.querySelector('.apb-bi'), undefined, { timeout: 8000 }).catch(() => {})
        await page.waitForFunction(() => document.querySelector('.apb-menu') && document.querySelector('.apb-menu').checkVisibility(), undefined, { timeout: 40000 })
        await page.evaluate(() => document.querySelectorAll('.ap-tip').forEach((n) => n.remove()))
        await page.waitForTimeout(1800)
        const measure = async (state) => {
          const r = await measureScreen(page, { scope: '.apb-root', ignore: '' }, `${outDir}${vp.name}/${sc.id}-${state}.png`)
          record(state, { violations: r.violations, warnings: r.warnings, stats: r.stats?.battle })
        }
        for (const st of states) {
          if (st === 'msg') await measure('msg')
          if (st === 'cmd') await measure('cmd')
          if (st === 'moves') { await key('KeyZ'); await page.waitForTimeout(600); await measure('moves'); await key('KeyX'); await page.waitForTimeout(500) }
          if (st === 'bag' || st === 'party') {
            await key('ArrowRight', st === 'bag' ? 1 : 0)
            if (st === 'party') await key('ArrowDown')
            await key('KeyZ')
            await page.waitForTimeout(1500)
            const opaque = await page.evaluate(() => {
              const top = document.elementFromPoint(innerWidth / 2, innerHeight / 2)
              return !!top && !top.closest('canvas') && top.id !== 'app'
            })
            await page.screenshot({ path: `${outDir}${vp.name}/${sc.id}-${st}.png` })
            if (!opaque) violations.push({ type: 'screen-not-covering', sel: st, text: '', detail: 'the battle stage shows through the screen centre' })
            record(st)
            await key('KeyX')
            await page.waitForTimeout(600)
            await key('ArrowLeft', st === 'bag' ? 1 : 0)
            if (st === 'party') await key('ArrowUp')
          }
        }
      } catch (err) {
        violations.push({ type: 'harness', sel: sc.id, text: '', detail: String(err.message).slice(0, 200) })
        record('error')
      }
      const n = report.filter((r) => r.viewport === vp.name && r.scenario === sc.id)
      console.log(`${vp.name} ${sc.id.padEnd(8)} ${n.map((r) => `${r.state}:${r.violations.length}`).join(' ')}`)
    }
  }
  await page.cdp('Emulation.clearDeviceMetricsOverride').catch(() => {})
  await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {})
  await writeFile(`${outDir}report.json`, `${JSON.stringify(report, null, 2)}\n`)
  const total = report.reduce((n, r) => n + r.violations.length, 0)
  console.log(`battle audit (${phase}): ${total} violations across ${report.length} checks`)
  return report
}
