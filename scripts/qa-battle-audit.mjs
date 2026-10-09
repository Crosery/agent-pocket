// Battle screen audit across the seven owner viewports (issue #32): per scenario (boss with 6 meters, boss with 3, wild,
// trainer) and state (message, commands, moves, item screen, party screen, status sheet in its worst case): the layout auditor over the whole battle UI
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
  { id: 'trainer', query: 'battle=trainer&trainer=route-1' },
]
export const BATTLE_STATES = ['msg', 'cmd', 'moves', 'bag', 'party', 'inspect', 'pause']

/** Runs in the page: card and sheet headers keep every part on one line, names clamp instead of wrapping, the command hint fits its window. */
const textFit = () => {
  const out = []
  // glyph runs of one line overlap vertically (mixed fonts shift their tops); a run that starts below the line's bottom opens a new line
  const lines = (n) => {
    const r = document.createRange(); r.selectNodeContents(n)
    const runs = [...r.getClientRects()].filter((q) => q.width > 0 && q.height > 0).sort((a, b) => a.top - b.top)
    let count = 0, bottom = -Infinity
    for (const q of runs) { if (q.top >= bottom - q.height * 0.4) { count++; bottom = q.bottom } else bottom = Math.max(bottom, q.bottom) }
    return count
  }
  for (const head of document.querySelectorAll('.apb-st-head, .apb-fx-head, .apb-fx-side-head')) {
    if (!head.checkVisibility()) continue
    const kids = [...head.children].filter((c) => c.checkVisibility()).map((c) => c.getBoundingClientRect())
    const hMax = Math.max(0, ...kids.map((k) => k.height))
    const mid = kids.map((k) => k.top + k.height / 2)
    if (kids.length > 1 && Math.max(...mid) - Math.min(...mid) > hMax * 0.5) out.push({ type: 'header-wrap', sel: head.className.slice(0, 40), text: head.textContent.trim().slice(0, 40), detail: 'a part of the header sits on a second line' })
  }
  for (const n of document.querySelectorAll('.apb-st-name, .apb-cmd-row .ap-row-label')) {
    if (n.checkVisibility() && lines(n) > 1) out.push({ type: 'label-wrap', sel: n.className.slice(0, 40), text: n.textContent.trim().slice(0, 40), detail: 'the label wraps instead of clamping' })
  }
  for (const h of document.querySelectorAll('.apb-hint-keys, .apb-hint-touch')) {
    if (!h.checkVisibility()) continue
    const box = h.parentElement.getBoundingClientRect()
    const r = document.createRange(); r.selectNodeContents(h)
    const rect = r.getBoundingClientRect()
    if (rect.width > box.width + 1 || lines(h) > 1) out.push({ type: 'hint-clipped', sel: h.className, text: h.textContent.trim(), detail: `hint ${Math.round(rect.width)}px in a ${Math.round(box.width)}px window` })
  }
  return out
}


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
        await page.waitForFunction(() => window.__AP, undefined, { timeout: 60000 })
        // a trainer talks before the battle opens: confirm through the dialogue
        for (let i = 0; i < 40 && !(await page.evaluate(() => !!document.querySelector('.apb-root'))); i++) {
          if (await page.evaluate(() => !!document.querySelector('.ap-dlg'))) await key('KeyZ')
          else await page.waitForTimeout(500)
        }
        await page.waitForFunction(() => document.querySelector('.apb-root'), undefined, { timeout: 30000 })
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
          violations.push(...r.violations, ...(await page.evaluate(textFit)))
          record(state, { warnings: r.warnings, stats: r.stats?.battle })
        }
        for (const st of states) {
          if (st === 'msg') await measure('msg')
          if (st === 'cmd') await measure('cmd')
          if (st === 'moves') { await key('KeyZ'); await page.waitForTimeout(600); await measure('moves'); await key('KeyX'); await page.waitForTimeout(500) }
          if (st === 'inspect') {
            // worst case: both sides with a status, three or four stat stages and two volatiles, plus weather (and the boss meters, if any)
            await page.evaluate(() => {
              const v = window.__apBattleView
              v.status.forEach((p, i) => {
                p.setStatus(i ? 'paralysis' : 'burn')
                p.setVolatiles(i ? ['confusion', 'taunt'] : ['focus', 'leech'])
                p.setStages(i ? { atk: -1, spe: 2, eva: -2 } : { atk: 2, def: -1, spa: 1, spe: -2 })
              })
              v.setWeather('overclock')
            })
            await page.waitForTimeout(500)
            await page.waitForSelector('.apb-status.is-foe', { timeout: 8000 })
            await page.evaluate(() => document.querySelector('.apb-status.is-foe').click())
            await page.waitForTimeout(900)
            const r = await measureScreen(page, { scope: '.apb-effects-dialog', ignore: '' }, `${outDir}${vp.name}/${sc.id}-inspect.png`)
            violations.push(...r.violations, ...(await page.evaluate(textFit)))
            const fit = await page.evaluate(() => {
              const d = document.querySelector('.apb-effects-dialog')
              const b = d?.querySelector('.apb-fx-body')
              if (!d || !b) return { missing: true }
              const box = d.getBoundingClientRect()
              const head = d.querySelector('.apb-fx-head').getBoundingClientRect()
              return { scroll: b.scrollHeight - b.clientHeight, inView: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, headIn: head.top >= box.top && head.bottom <= box.bottom, sides: d.querySelectorAll('.apb-fx-side').length }
            })
            if (fit.missing) violations.push({ type: 'inspector-missing', sel: '.apb-effects-dialog', text: '', detail: 'the status sheet did not open' })
            else {
              if (fit.scroll > 1) violations.push({ type: 'inspector-scrolls', sel: '.apb-fx-body', text: '', detail: `${fit.scroll}px of the worst case do not fit` })
              if (!fit.inView) violations.push({ type: 'inspector-off-screen', sel: '.apb-effects-dialog', text: '', detail: 'the sheet leaves the viewport' })
              if (!fit.headIn || fit.sides !== 2) violations.push({ type: 'inspector-structure', sel: '.apb-fx-head', text: '', detail: `header inside: ${fit.headIn}, sides: ${fit.sides}` })
            }
            record('inspect', { warnings: r.warnings })
            await key('KeyX')
            await page.waitForTimeout(500)
          }
          if (st === 'pause') {
            // a message mid-flight, then the tip card with its button and the chart opened from it: the battle clock must stand still until it closes
            await page.evaluate(() => { window.__AP.save.settings.showTips = true })
            await page.evaluate(() => { window.__pauseProbe = 0; void window.__apBattleView.message.show('probe', 'auto').then(() => { window.__pauseProbe = 1 }) })
            await page.evaluate(() => window.__apOnboarding.debugShow('typeMatchup'))
            await page.waitForFunction(() => { const b = document.querySelector('.ap-tip .ap-tip-open'); return b && !b.hidden && b.checkVisibility() }, undefined, { timeout: 8000 })
            await page.waitForTimeout(1600)
            const tipHeld = await page.evaluate(() => window.__pauseProbe)
            if (vp.touch) await page.evaluate(() => document.querySelector('.ap-tip .ap-tip-open').click())
            else await key('KeyM')
            await page.waitForFunction(() => document.querySelector('.aps-typechart'), undefined, { timeout: 8000 })
            await page.waitForTimeout(2800)
            const chartHeld = await page.evaluate(() => window.__pauseProbe)
            await key('KeyX')
            await page.waitForTimeout(2400)
            const resumed = await page.evaluate(() => window.__pauseProbe)
            await page.evaluate(() => { window.__AP.save.settings.showTips = false })
            if (tipHeld !== 0) violations.push({ type: 'pause-tip', sel: '.ap-tip', text: '', detail: 'the battle kept running behind a tip card with a button' })
            if (chartHeld !== 0) violations.push({ type: 'pause-chart', sel: '.aps-typechart', text: '', detail: 'the battle kept running behind the type chart' })
            if (resumed !== 1) violations.push({ type: 'pause-resume', sel: '.apb-root', text: '', detail: 'the battle did not resume after the chart closed' })
            record('pause')
          }
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
