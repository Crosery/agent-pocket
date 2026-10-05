// Invoke through ego-browser nodejs with the goal's existing TaskSpace and an isolated development save slot.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export async function runDoorEntryQA({ task, slot }) {
  assert.match(slot ?? '', /^\d{10}$/, 'An isolated development save slot is required')
  const page = task.page('p1')
  const url = new URL(await page.url())
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.searchParams.get('dev'), '1')
  assert.equal(url.searchParams.get('slot'), slot)
  const output = fileURLToPath(new URL('../output/door-qa/', import.meta.url))
  await mkdir(output, { recursive: true })

  const fixtures = await page.evaluate(async () => {
    const { propDoors } = await import('/src/shared/world/collision.ts')
    const { worldBuildInfo } = await import('/src/shared/world/index.ts')
    const ctx = window.__AP
    ctx.save.settings.autoRun = false
    const m = ctx.data.world.maps[ctx.data.world.startMap]
    const fixture = p => ({
      prop: p.prop, rot: p.rot, lanes: propDoors(p),
      warp: m.warps.find(w => w.x === propDoors(p)[0]?.x && w.y === propDoors(p)[0]?.y),
    })
    const core = ['lab', 'center', 'gym', 'datacenter', 'temple', 'shop', 'house_large'].map(key =>
      fixture(m.props.find(p => p.prop === key && p.rot === 0)))
    const frontier = []
    const provider = m.infinite
    for (const gate of worldBuildInfo(ctx.data.world).features.gates) {
      const [sx, sy] = provider.grid.cellOf(gate.x, gate.y)
      const site = provider.grid.siteAt(sx, sy)
      if (site?.type !== 'hamlet') continue
      const layout = provider.decorSite(site).layout
      for (const p of layout.props.filter(p => propDoors(p).length > 1)) {
        const f = fixture(p)
        f.warp = layout.warps.find(w => w.x === f.lanes[0].x && w.y === f.lanes[0].y)
        if (!frontier.some(f => f.rot === p.rot)) frontier.push(f)
      }
    }
    return { map: m.id, core, frontier }
  })
  const reports = []
  const inward = { down: 'ArrowUp', up: 'ArrowDown', left: 'ArrowRight', right: 'ArrowLeft' }
  let sequence = 0

  async function exercise(fixture, lane, running, label) {
    assert.ok(fixture.warp, `${label}: missing warp fixture`)
    await page.evaluate(async ({ map, lane }) => { await window.__ap.tp(lane.front.x, lane.front.y, map) }, { map: fixtures.map, lane })
    await page.waitForFunction(({ map }) => window.__AP.overworld.free && window.__ap.pos().map === map &&
      document.querySelector('#ap-loading')?.hidden, { map: fixtures.map })
    const start = await page.evaluate(() => window.__ap.pos())
    if (running) await page.keyboard.down('Shift')
    await page.keyboard.down(inward[lane.facing])
    try {
      await page.waitForFunction(map => window.__ap.pos().map === map, fixture.warp.toMap, { timeout: 12000 })
    } finally {
      await page.keyboard.up(inward[lane.facing])
      if (running) await page.keyboard.up('Shift')
    }
    await page.waitForFunction(map => window.__AP.overworld.free && window.__ap.pos().map === map &&
      document.querySelector('#ap-loading')?.hidden, fixture.warp.toMap)
    const inside = await page.evaluate(() => window.__ap.pos())
    assert.equal(inside.map, fixture.warp.toMap)
    if (label.startsWith('lab-')) await page.screenshot({ path: `${output}${label}-inside.png` })

    const exit = await page.evaluate(map => window.__AP.world.map.warps.find(w => w.toMap === map), fixtures.map)
    assert.ok(exit, `${label}: missing return warp`)
    const dx = exit.x + 0.5 - inside.x, dy = exit.y + 0.5 - inside.y
    const exitKey = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'ArrowRight' : 'ArrowLeft') : (dy > 0 ? 'ArrowDown' : 'ArrowUp')
    await page.keyboard.down(exitKey)
    try {
      await page.waitForFunction(map => window.__ap.pos().map === map, fixtures.map, { timeout: 12000 })
    } finally {
      await page.keyboard.up(exitKey)
    }
    await page.waitForFunction(map => window.__AP.overworld.free && window.__ap.pos().map === map, fixtures.map)
    const outside = await page.evaluate(() => window.__ap.pos())
    assert.deepEqual([Math.floor(outside.x), Math.floor(outside.y)], [fixture.lanes[0].front.x, fixture.lanes[0].front.y])
    assert.equal(outside.facing, fixture.lanes[0].facing)
    const errors = await page.evaluate(() => (window.__AP_LOG ?? []).filter(s => /uncaught|rejection/.test(s)))
    assert.deepEqual(errors, [])
    reports.push({ label, running, start, inside, outside })
    await writeFile(`${output}after-runtime-report.json`, `${JSON.stringify(reports, null, 2)}\n`)
    console.log(`${++sequence}. ${label}: keyboard entry and return PASS`)
  }

  for (const fixture of fixtures.core) {
    for (const lane of fixture.lanes) {
      const side = lane.x === fixture.lanes[0].x ? 'right' : 'left'
      await exercise(fixture, lane, false, `${fixture.prop}-${side}-walk`)
      if (fixture.prop === 'lab') await exercise(fixture, lane, true, `lab-${side}-run`)
    }
  }
  for (const fixture of fixtures.frontier) {
    for (let i = 0; i < fixture.lanes.length; i++) {
      await exercise(fixture, fixture.lanes[i], false, `frontier-${fixture.rot}-lane${i}`)
    }
  }
  const lab = fixtures.core[0]
  await page.evaluate(async ({ map, lane }) => { await window.__ap.tp(lane.front.x, lane.front.y, map) },
    { map: fixtures.map, lane: lab.lanes[1] })
  await page.reload()
  await page.waitForFunction(() => !!window.__ap && window.__AP?.overworld.free &&
    document.querySelector('#ap-loading')?.hidden, undefined, { timeout: 30000 })
  await exercise(lab, lab.lanes[1], false, 'lab-left-after-reload')

  await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: false })
  await page.waitForFunction(() => innerWidth === 390 && innerHeight === 844)
  await exercise(lab, lab.lanes[1], false, 'lab-left-narrow-viewport')
  await page.cdp('Emulation.clearDeviceMetricsOverride')
  return { checks: reports.length, reports }
}
