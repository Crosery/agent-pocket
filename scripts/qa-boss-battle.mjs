// Boss battle presentation audit (issue #32): every boss at 1280x720, 1920x1080 and 390x844.
//   ego-browser nodejs <<'JS'
//   const { runBossAudit } = await import('file:///<repo>/scripts/qa-boss-battle.mjs')
//   await runBossAudit({ task: await taskSpace(<id>), base: 'http://127.0.0.1:<port>', phase: 'boss' })
//   JS
// Per boss and viewport: the layout auditor over the whole battle UI with the foe window showing the boss strip,
// plus geometry: the boss sprite (opaque pixels, projected from the live stage) must not touch the foe or own status
// window, the message bar or the command menu, and the status windows must be opaque enough to read. A mid-intro
// screenshot of the cut-in is saved too. Output: output/32/<phase>/<viewport>/<boss>.png, intro-<boss>.png, report.json.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { VIEWPORTS, measureScreen } from './qa-layout-audit.mjs'
import { setHUDViewport } from './qa-hud-layout.mjs'

/** Runs in the page: boss sprite rectangle (opaque pixels) vs every window of the battle UI, plus window contrast. */
export async function bossGeometry(bossId) {
  const stage = window.__apStage
  const ctx = window.__AP
  const vw = innerWidth, vh = innerHeight
  const card = stage?.creatureRect(1)
  if (!card) return { error: 'no boss sprite rect' }
  const cw = (card.right - card.left) * vw, ch = (card.bottom - card.top) * vh
  // opaque bounding box of the boss art inside its card
  const { CONTENT } = await import('/src/shared/content/index.ts')
  const speciesId = CONTENT.bosses[bossId]?.species
  let box = { x0: 0, y0: 0, x1: 1, y1: 1 }
  const tex = speciesId ? ctx.assets.creatureTexture(speciesId) : null
  const img = tex?.image
  if (img?.width) {
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const { data } = g.getImageData(0, 0, c.width, c.height)
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (data[(y * c.width + x) * 4 + 3] > 40) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    if (x1 >= 0) box = { x0: x0 / c.width, y0: y0 / c.height, x1: (x1 + 1) / c.width, y1: (y1 + 1) / c.height }
  }
  const boss = {
    left: card.left * vw + box.x0 * cw, right: card.left * vw + box.x1 * cw,
    top: card.top * vh + box.y0 * ch, bottom: card.top * vh + box.y1 * ch,
  }
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }
  const windows = [
    ['foe-status', '.apb-status.is-foe'], ['own-status', '.apb-status.is-own'], ['message', '.apb-msg'], ['menu', '.apb-cmd, .apb-moves'],
  ].flatMap(([name, sel]) => [...document.querySelectorAll(sel)].filter((e) => e.checkVisibility() && e.getBoundingClientRect().width > 1).map((e) => [name, rectOf(e)]))
  const overlaps = []
  for (const [name, r] of windows) {
    const w = Math.min(boss.right, r.right) - Math.max(boss.left, r.left)
    const h = Math.min(boss.bottom, r.bottom) - Math.max(boss.top, r.top)
    if (w > 0 && h > 0) overlaps.push({ name, px: Math.round(w * h), frac: +(w * h / ((boss.right - boss.left) * (boss.bottom - boss.top))).toFixed(3) })
  }
  // contrast of the status windows: the panel gradient's lightest stop against the name colour, and how opaque the panel is
  const parse = (c) => { const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1]; return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 } }
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const probe = document.createElement('i')
  document.body.append(probe)
  const color = (w, name) => { probe.style.color = ''; probe.style.color = `var(${name})`; w.append(probe); const c = parse(getComputedStyle(probe).color); probe.remove(); return c }
  const contrast = []
  for (const sel of ['.apb-status.is-foe', '.apb-status.is-own']) {
    const w = document.querySelector(sel)
    if (!w || !w.checkVisibility()) continue
    const stops = ['--ap-panel-top', '--ap-panel-mid', '--ap-panel-bot'].map((n) => color(w, n))
    const bg = stops.reduce((a, b) => (lum(b) > lum(a) ? b : a))
    const fg = parse(getComputedStyle(w.querySelector('.apb-st-name')).color)
    const ratio = (lum(fg) + 0.05) / (lum(bg) + 0.05)
    contrast.push({ window: sel, bgAlpha: Math.min(...stops.map((c) => c.a)), opacity: +getComputedStyle(w).opacity, ratio: +Math.max(ratio, 1 / ratio).toFixed(1) })
  }
  return { boss: Object.fromEntries(Object.entries(boss).map(([k, v]) => [k, Math.round(v)])), overlaps, contrast }
}

export const BOSS_IDS = ['astra', 'deepseek', 'kimi', 'minimax', 'qwen', 'cursor', 'claude-code', 'mythos', 'alpha', 'opus', 'chatgpt', 'unitree', 'grok', 'openclaw', 'gemini', 'doubao', 'seedance', 'glm']

export async function runBossAudit({ task, base, phase = 'boss', viewports = VIEWPORTS, bosses = BOSS_IDS, slot = '2032100001', repoRoot = null }) {
  assert.match(phase, /^[a-z0-9-]+$/)
  const root = repoRoot ?? fileURLToPath(new URL('..', import.meta.url))
  const outDir = `${root}output/32/${phase}/`
  const page = task.page('p1')
  const report = []
  for (const vp of viewports) {
    await mkdir(`${outDir}${vp.name}`, { recursive: true })
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: false })
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: !!vp.touch, maxTouchPoints: vp.touch ? 5 : 1 })
    for (const boss of bosses) {
      const violations = [], warnings = []
      const record = (extra = {}) => { report.push({ boss, viewport: vp.name, violations, warnings, ...extra }); console.log(`${vp.name} ${boss.padEnd(12)} violations=${violations.length} warnings=${warnings.length}`) }
      try {
        await page.goto(`${base}/?dev=1&skipTitle=1&reset=1&slot=${slot}&battle=boss&boss=${boss}&t=720`)
        await page.waitForFunction(() => window.__AP, undefined, { timeout: 30000 })
        await setHUDViewport(page, vp)
        await page.evaluate(() => { window.__AP.save.settings.showTips = false })
        // the cut-in, mid-way
        const intro = await page.waitForFunction(() => document.querySelector('.apb-bi.is-playing, .apb-bi.is-static'), undefined, { timeout: 12000 }).then(() => true).catch(() => false)
        if (intro) {
          await page.waitForTimeout(1600)
          await page.screenshot({ path: `${outDir}${vp.name}/intro-${boss}.png` })
          const introResult = await measureScreen(page, { scope: '.apb-bi', ignore: '' }, `${outDir}${vp.name}/intro-${boss}-ui.png`)
          for (const v of introResult.violations) violations.push({ ...v, where: 'intro' })
          await page.keyboard.press('KeyZ')
        } else warnings.push({ type: 'no-intro', detail: 'the cut-in overlay never appeared' })
        await page.waitForFunction(() => !document.querySelector('.apb-bi'), undefined, { timeout: 8000 }).catch(() => {})
        await page.evaluate(() => document.querySelectorAll('.ap-tip').forEach((n) => n.remove()))
        await page.waitForFunction(() => document.querySelector('.apb-status.is-foe:not(.is-away)') && document.querySelector('.apb-status.is-own:not(.is-away)'), undefined, { timeout: 25000 })
        await page.waitForTimeout(3500)
        const shot = `${outDir}${vp.name}/${boss}.png`
        const ui = await measureScreen(page, { scope: '.apb-root', ignore: '' }, shot)
        for (const v of ui.violations) violations.push({ ...v, where: 'battle' })
        for (const w of ui.warnings) warnings.push(w)
        const geo = await page.evaluate(bossGeometry, boss)
        if (geo.error) violations.push({ type: 'harness', sel: 'boss', text: '', detail: geo.error })
        else {
          for (const o of geo.overlaps) violations.push({ type: 'boss-over-window', sel: o.name, text: '', detail: `boss sprite covers ${(o.frac * 100).toFixed(1)}% of itself over the ${o.name} window (${o.px}px²)` })
          for (const c of geo.contrast) {
            if (c.bgAlpha < 0.85 && c.opacity >= 0.99) warnings.push({ type: 'translucent-window', sel: c.window, text: '', detail: `background alpha ${c.bgAlpha}` })
            if (c.ratio < 4.5) violations.push({ type: 'low-contrast', sel: c.window, text: '', detail: `name contrast ${c.ratio}:1` })
          }
        }
        record({ geometry: geo, shot })
      } catch (err) {
        violations.push({ type: 'harness', sel: boss, text: '', detail: String(err.message).slice(0, 200) })
        record()
      }
    }
  }
  await page.cdp('Emulation.clearDeviceMetricsOverride').catch(() => {})
  await writeFile(`${outDir}report.json`, `${JSON.stringify(report, null, 2)}\n`)
  const total = report.reduce((n, r) => n + r.violations.length, 0)
  console.log(`boss audit (${phase}): ${total} violations across ${report.length} boss/viewport checks`)
  return report
}
