// Run in one ego-browser TaskSpace with an isolated development save.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { measureHUD, setHUDViewport } from './qa-hud-layout.mjs'

const output = fileURLToPath(new URL('../output/hud-events-design/', import.meta.url))

async function eventPage(task, slot) {
  const page = task.page('p1')
  const url = new URL(await page.url())
  assert.equal(url.origin, 'http://127.0.0.1:5175')
  assert.equal(url.searchParams.get('dev'), '1')
  assert.match(slot ?? '', /^\d{10}$/)
  assert.equal(url.searchParams.get('slot'), slot, 'Refusing to change a different save slot')
  await page.evaluate(() => window.__AP.net.disconnect())
  await mkdir(output, { recursive: true })
  return page
}

export async function runEventDensityQA({ task, slot, phase = 'after' }) {
  assert.match(phase, /^[a-z0-9-]+$/)
  const page = await eventPage(task, slot)
  await page.waitForSelector('.ap-banner', { state: 'hidden' })
  await page.waitForSelector('.ap-tip', { state: 'hidden' })
  const layout = await measureHUD(page)
  const unit = await page.evaluate(() => Number(document.documentElement.style.getPropertyValue('--ap-ui-scale')))
  const events = layout.peers.find(peer => peer.selector === '.ap-evchips')
  assert.ok(events, 'The multi-event fixture must have an event HUD')
  const report = { ...layout, unit, events }
  await writeFile(`${output}${phase}-density.json`, `${JSON.stringify(report, null, 2)}\n`)
  await page.screenshot({ path: `${output}${phase}-desktop.png` })
  assert.deepEqual(layout.violations, [])
  assert.ok(events.height <= Math.max(30, 24 * unit) + 1,
    'Multiple active events must occupy one collapsed row, not a stack of event cards')
  assert.ok(events.width <= 128 * unit + 1, 'The collapsed event entry must not span the playfield')
  assert.ok(layout.stack.height <= 100 * unit + 1, 'Persistent field information must stay compact with multiple events')
  console.log(`multi-event density: PASS (${events.width / unit} x ${events.height / unit} UI units)`)
  return report
}

async function measureFieldHits(page) {
  return page.evaluate(() => {
    const hits = []
    const selectors = ['.ap-quest-toggle', '.ap-objective-toggle', '.ap-evtoggle', '.ap-evdetails', '.ap-chat-open',
      ...[...document.querySelectorAll('.ap-touch__btn')].map(n => `.ap-touch__btn[data-action="${n.dataset.action}"]`)]
    for (const selector of selectors) {
      const node = document.querySelector(selector)
      if (!node?.checkVisibility()) continue
      const r = node.getBoundingClientRect()
      for (const x of [r.left + Math.min(12, r.width / 2), r.left + r.width / 2, r.right - Math.min(12, r.width / 2)]) {
        const y = r.top + r.height / 2
        const top = document.elementFromPoint(x, y)
        hits.push({ selector, x, y, hit: top?.className ?? null, reachable: !!top && node.contains(top) })
      }
    }
    return hits
  })
}

export async function runEventHitQA({ task, slot, phase = 'after' }) {
  assert.match(phase, /^[a-z0-9-]+$/)
  const page = await eventPage(task, slot)
  const hits = await measureFieldHits(page)
  await writeFile(`${output}${phase}-hit-report.json`, `${JSON.stringify(hits, null, 2)}\n`)
  assert.deepEqual(hits.filter(h => !h.reachable), [],
    'Transparent HUD containers must not intercept the visible field controls')
  console.log('field control hit testing: PASS')
}

export async function runEventInteractionQA({ task, slot }) {
  const page = await eventPage(task, slot)
  const backup = await page.evaluate(() => ({ clock: window.__AP.clock.minutes, player: window.__AP.overworld.player }))
  await page.focus('.ap-evtoggle')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.ap-evtoggle').getAttribute('aria-expanded') === 'true')
  assert.ok(await page.evaluate(() => document.querySelector('.ap-evdetails').checkVisibility()))
  const titles = await page.evaluate(() => [...document.querySelectorAll('.ap-evchip-title')].map(node => node.textContent))
  assert.deepEqual(titles, ['国庆·黄金周大迁徙', 'GPU 短缺', 'Token 雨'])
  assert.ok(await page.evaluate(() => {
    const details = document.querySelector('.ap-evdetails')
    return details.scrollHeight <= details.clientHeight + 1
  }), 'Three ordinary events must be readable without an unnecessary scrollbar')
  await page.focus('.ap-evdetails')
  const beforeTimes = await page.evaluate(() => [...document.querySelectorAll('.ap-evchip-sub')].map(node => node.textContent))
  try {
    await page.evaluate(() => { window.__AP.clock.minutes += 1 })
    await page.waitForFunction(before => [...document.querySelectorAll('.ap-evchip-sub')].some((node, i) => node.textContent !== before[i]), beforeTimes)
    assert.ok(await page.evaluate(() => document.activeElement === document.querySelector('.ap-evdetails') &&
      document.querySelector('.ap-evtoggle').getAttribute('aria-expanded') === 'true'),
    'A minute refresh must preserve reading focus and the open list')
    await page.keyboard.press('ArrowDown')
    await page.screenshot({ path: `${output}keyboard-reading.png` })
    assert.deepEqual(await page.evaluate(() => window.__AP.overworld.player), backup.player,
      'Reading activity information must not move or turn the player')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('.ap-evtoggle').getAttribute('aria-expanded') === 'false')
    assert.ok(await page.evaluate(() => document.activeElement === document.querySelector('.ap-evtoggle')))
    assert.equal(await page.evaluate(() => window.__AP.ui.isBlocking()), false,
      'Closing activity details must not also open the game menu')
    await page.keyboard.press('Space')
    await page.click('.ap-quest-toggle')
    assert.equal(await page.evaluate(() => document.querySelector('.ap-evtoggle').getAttribute('aria-expanded')), 'false')
    await page.click('.ap-evtoggle')
    assert.equal(await page.evaluate(() => document.querySelector('.ap-quest-toggle').getAttribute('aria-expanded')), 'false')
    await page.click('.ap-objective-toggle')
    assert.equal(await page.evaluate(() => document.querySelector('.ap-evtoggle').getAttribute('aria-expanded')), 'false')
    await page.click('.ap-evtoggle')
    assert.equal(await page.evaluate(() => document.querySelector('.ap-objective-toggle').getAttribute('aria-expanded')), 'false')
    await page.mouse.click(900, 700, { label: 'return to game view' })
    assert.equal(await page.evaluate(() => document.querySelector('.ap-evtoggle').getAttribute('aria-expanded')), 'false')
    await page.focus('.ap-evtoggle')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    assert.ok(await page.evaluate(() => document.activeElement === document.querySelector('.ap-evdetails')))
    await page.keyboard.press('Escape')
    await page.keyboard.press('Tab')
    assert.ok(await page.evaluate(() => document.activeElement?.matches('.ap-chat-bar button')))
    console.log('live event keyboard, timer refresh, mutual disclosure and outside dismissal: PASS')
  } finally {
    await page.evaluate(backup => { window.__AP.clock.minutes = backup.clock }, backup)
  }
  const more = await page.evaluate(() => {
    const ids = ['launch-livestream', 'api-rate-limit']
    for (const id of ids) window.__ap.gameplay.start(id)
    return ids
  })
  try {
    await page.waitForFunction(() => document.querySelector('.ap-evcount').textContent === '5')
    await page.click('.ap-evtoggle')
    assert.equal(await page.evaluate(() => document.querySelectorAll('.ap-evchip').length), 5,
      'The runtime must not discard applicable events after the third entry')
    assert.equal(await page.evaluate(() => document.querySelectorAll('.ap-evpips .ap-evpip').length), 3)
    await page.screenshot({ path: `${output}live-five-events.png` })
    console.log('live runtime: all 5 applicable events retained, preview limited to 3 pips: PASS')
  } finally {
    await page.evaluate(ids => { for (const id of ids) window.__ap.gameplay.end(id) }, more)
    await page.waitForFunction(() => document.querySelector('.ap-evcount').textContent === '3')
    await page.keyboard.press('Escape')
  }
}

export async function runEventResponsiveQA({ task, slot }) {
  const page = await eventPage(task, slot)
  const viewports = [
    { name: 'desktop-1280', width: 1280, height: 900, dpr: 1 },
    { name: 'desktop-retina', width: 1280, height: 900, dpr: 2 },
    { name: 'desktop-1024', width: 1024, height: 768, dpr: 1 },
    { name: 'desktop-1920', width: 1920, height: 1080, dpr: 1 },
    { name: 'mobile-390', width: 390, height: 844, dpr: 3 },
    { name: 'mobile-320', width: 320, height: 740, dpr: 2 },
    { name: 'touch-390', width: 390, height: 844, dpr: 3, touch: true },
    { name: 'touch-320', width: 320, height: 568, dpr: 2, touch: true },
    { name: 'landscape-844', width: 844, height: 390, dpr: 3, touch: true },
    { name: 'landscape-568', width: 568, height: 320, dpr: 2, touch: true },
  ]
  const reports = []
  for (const vp of viewports) {
    await setHUDViewport(page, vp)
    await page.waitForSelector('.ap-banner', { state: 'hidden' })
    await page.waitForSelector('.ap-tip', { state: 'hidden' })
    const collapsed = await measureHUD(page)
    collapsed.violations.push(...(await measureFieldHits(page)).filter(h => !h.reachable).map(h => `${h.selector} is intercepted by ${h.hit}`))
    reports.push({ name: `${vp.name}-collapsed`, ...collapsed })
    await page.screenshot({ path: `${output}${vp.name}-collapsed.png` })
    if (vp.touch) {
      const point = await page.evaluate(() => {
        const r = document.querySelector('.ap-evtoggle').getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })
      await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
      await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else {
      await page.focus('.ap-evtoggle')
      await page.keyboard.press('Enter')
    }
    await page.waitForFunction(() => document.querySelector('.ap-evtoggle').getAttribute('aria-expanded') === 'true')
    const expanded = await measureHUD(page)
    expanded.violations.push(...(await measureFieldHits(page)).filter(h => !h.reachable).map(h => `${h.selector} is intercepted by ${h.hit}`))
    reports.push({ name: `${vp.name}-expanded`, ...expanded })
    await page.screenshot({ path: `${output}${vp.name}-expanded.png` })
    assert.ok(await page.evaluate(() => {
      const details = document.querySelector('.ap-evdetails')
      return details.scrollWidth <= details.clientWidth + 1
    }))
    if (vp.touch && await page.evaluate(() => {
      const details = document.querySelector('.ap-evdetails')
      return details.scrollHeight > details.clientHeight + 1
    })) {
      const gesture = await page.evaluate(() => {
        const details = document.querySelector('.ap-evdetails')
        details.scrollTop = 0
        const r = details.getBoundingClientRect()
        return { x: r.left + r.width / 2, start: r.bottom - 8, end: r.top + 8, player: window.__AP.overworld.player }
      })
      await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gesture.x, y: gesture.start }] })
      for (let i = 1; i <= 5; i++) {
        await page.cdp('Input.dispatchTouchEvent', { type: 'touchMove',
          touchPoints: [{ x: gesture.x, y: gesture.start + (gesture.end - gesture.start) * i / 5 }] })
      }
      await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.screenshot({ path: `${output}${vp.name}-touch-scroll.png` })
      await page.waitForFunction(() => document.querySelector('.ap-evdetails').scrollTop > 0)
      assert.deepEqual(await page.evaluate(() => window.__AP.overworld.player), gesture.player,
        'Touch-scrolling activity details must not steer the player through the joystick capture zone')
    }
    await page.focus('.ap-evdetails')
    await page.keyboard.press('End')
    await page.screenshot({ path: `${output}${vp.name}-scroll-end.png` })
    assert.ok(await page.evaluate(() => {
      const details = document.querySelector('.ap-evdetails').getBoundingClientRect()
      const last = document.querySelector('.ap-evchip:last-child').getBoundingClientRect()
      return last.bottom <= details.bottom + 1
    }), 'The last activity must be reachable inside the constrained reading panel')
    await page.keyboard.press('Escape')
    console.log(`${vp.name}: closed/open/keyboard scroll ${collapsed.violations.length + expanded.violations.length ? 'FAIL' : 'PASS'}`)
  }
  await writeFile(`${output}responsive-report.json`, `${JSON.stringify(reports, null, 2)}\n`)
  assert.deepEqual(reports.flatMap(r => r.violations.map(v => `${r.name}: ${v}`)), [])
  return reports
}

export async function runEventFixtureQA({ task }) {
  await mkdir(output, { recursive: true })
  const page = await task.newPage()
  await page.goto('http://127.0.0.1:5175/scripts/qa-event-hud.html')
  await page.waitForFunction(() => !!window.__eventQA)
  const checks = []
  for (const vp of [
    { name: 'desktop', width: 1280, height: 900, dpr: 2 },
    { name: 'narrow', width: 320, height: 568, dpr: 2 },
    { name: 'small-desktop', width: 640, height: 450, dpr: 2 },
  ]) {
    await page.cdp('Emulation.setDeviceMetricsOverride', {
      width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: false,
    })
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    for (const n of [0, 1, 3, 12]) {
      await page.evaluate(n => {
        const { events, chips } = window.__eventQA
        events.setChips(Array.from({ length: n }, (_, i) => ({
          ...chips[i % chips.length], id: `qa-${i}`,
        })))
      }, n)
      const state = await page.evaluate(() => {
        const node = document.querySelector('.ap-evchips')
        const r = node.getBoundingClientRect()
        return { visible: node.checkVisibility(), height: r.height, width: r.width,
          count: document.querySelector('.ap-evcount').textContent,
          unit: Number(document.documentElement.style.getPropertyValue('--ap-ui-scale')) }
      })
      assert.equal(state.visible, n > 0)
      if (!n) { assert.equal(state.height, 0); continue }
      assert.equal(state.count, String(n))
      assert.ok(state.height <= Math.max(30, 24 * state.unit) + 1)
      await page.click('.ap-evtoggle')
      assert.equal(await page.evaluate(() => document.querySelectorAll('.ap-evchip').length), n)
      await page.focus('.ap-evdetails')
      await page.keyboard.press('End')
      await page.screenshot({ path: `${output}fixture-${vp.name}-${n}-scroll.png` })
      assert.ok(await page.evaluate(() => {
        const s = getComputedStyle(document.querySelector('.ap-evdetails'))
        return s.borderImageSource.includes('hud-frame.png') && s.backgroundColor === 'rgba(23, 29, 20, 0.94)'
      }), 'Scrolled activity text must retain its opaque backdrop and fixed nine-slice border')
      const before = await page.evaluate(() => {
        window.__eventQA.readingRow = document.querySelector('.ap-evchip')
        return document.querySelector('.ap-evdetails').scrollTop
      })
      await page.evaluate(n => {
        const { events, chips } = window.__eventQA
        events.setChips(Array.from({ length: n }, (_, i) => ({
          ...chips[i % chips.length], id: `qa-${i}`, sub: `剩余 ${111 - i} 分钟`,
        })))
      }, n)
      assert.ok(await page.evaluate(before =>
        document.activeElement === document.querySelector('.ap-evdetails') &&
        document.querySelector('.ap-evtoggle').getAttribute('aria-expanded') === 'true' &&
        document.querySelector('.ap-evdetails').scrollTop === before &&
        document.querySelector('.ap-evchip') === window.__eventQA.readingRow, before),
      'A content refresh must retain open state, focus, scroll and row identity')
      await page.keyboard.press('Escape')
      checks.push(`${vp.name}: ${n} events, bounded density and stable refresh`)
    }
    await page.evaluate(() => {
      const { events, chips } = window.__eventQA
      events.setChips(chips.map(c => ({ ...c, title: `${c.title} · 超长活动名称用于检查完整文字换行与不遮挡时间`.repeat(3) })))
    })
    await page.click('.ap-evtoggle')
    const long = await measureHUD(page)
    assert.deepEqual(long.violations, [])
    assert.ok(await page.evaluate(() => {
      const details = document.querySelector('.ap-evdetails')
      return details.scrollWidth <= details.clientWidth + 1
    }))
    await page.focus('.ap-evdetails')
    await page.keyboard.press('End')
    await page.screenshot({ path: `${output}fixture-${vp.name}-long-names.png` })
    await page.keyboard.press('Escape')
    checks.push(`${vp.name}: long names wrap without truncation or horizontal overflow`)
  }
  await page.evaluate(() => {
    window.__eventQA.events.setAmbience(['tokenRain'])
    window.__eventQA.events.setVisible(false)
  })
  assert.ok(await page.evaluate(() => document.querySelector('.ap-l-evfx').classList.contains('is-hidden') &&
    document.querySelector('.ap-evchips').classList.contains('is-hidden')))
  await page.evaluate(() => window.__eventQA.events.setVisible(true))
  assert.ok(await page.evaluate(() => document.querySelector('.ap-evfx[data-cue="tokenRain"]') &&
    document.querySelector('.ap-evtoggle').getAttribute('aria-expanded') === 'false'))
  await page.click('.ap-evtoggle')
  await page.focus('.ap-evdetails')
  await page.evaluate(() => window.__eventQA.events.setChips([]))
  assert.ok(await page.evaluate(() => !document.querySelector('.ap-evchips').checkVisibility() &&
    !document.querySelector('.ap-evchips').contains(document.activeElement)))
  await page.evaluate(() => window.__eventQA.events.dispose())
  assert.equal(await page.evaluate(() => document.querySelectorAll('.ap-evchips, .ap-l-evfx, .ap-l-evhud').length), 0)
  checks.push('visibility, empty-list focus, ambience preservation and disposal')
  await writeFile(`${output}fixture-report.json`, `${JSON.stringify({ checks }, null, 2)}\n`)
  console.log(checks.join('\n'))
  await page.close()
  return checks
}
