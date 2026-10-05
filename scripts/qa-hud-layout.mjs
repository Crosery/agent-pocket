// Run through ego-browser with the current TaskSpace and an isolated development save.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const output = fileURLToPath(new URL('../output/hud-layout-qa/', import.meta.url))

export async function runHUDLayoutQA({ task, slot, phase = 'after' }) {
  const page = task.page('p1')
  const url = new URL(await page.url())
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.searchParams.get('dev'), '1')
  assert.match(slot ?? '', /^\d{10}$/)
  assert.equal(url.searchParams.get('slot'), slot, 'Refusing to change a different save slot')
  assert.match(phase, /^[a-z0-9-]+$/)
  await mkdir(output, { recursive: true })

  await page.cdp('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 2, mobile: false,
  })
  const target = await page.evaluate(async () => {
    const ctx = window.__AP
    ctx.net.disconnect()
    ctx.save.money = 3390
    ctx.save.badges = []
    ctx.save.quests.main = { stage: 1, done: false }
    ctx.save.trackedQuest = 'main'
    ctx.save.flags['rival:lab'] = true
    ctx.save.settings.touchControls = 'off'
    const { applyDocumentSettings } = await import('/src/client/core/settings.ts')
    applyDocumentSettings(ctx.save.settings)
    const { worldAnchors } = await import('/src/shared/world/index.ts')
    const lab = worldAnchors(ctx.data.world)['town:origin:lab']
    const target = { map: lab.map, x: lab.x + 0.5, y: lab.y + 2.5 }
    const p = ctx.overworld.player
    if (p.map !== target.map || Math.hypot(p.x - target.x, p.y - target.y) > 0.1) {
      void window.__ap.tp(lab.x, lab.y + 2, lab.map)
    }
    return target
  })
  await page.waitForFunction(target => {
    const p = window.__AP.overworld.player
    return window.__AP.overworld.free && p.map === target.map &&
      Math.hypot(p.x - target.x, p.y - target.y) <= 0.1 &&
      document.querySelector('.ap-region')?.textContent === '原点镇' &&
      document.querySelector('.ap-money-val')?.textContent === '3,390' &&
      document.querySelector('.ap-quest-text')?.textContent.includes('1 号道路')
  }, target)
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(async () => {
    const ctx = window.__AP
    const { regionSubtitle } = await import('/src/client/world/explore.ts')
    ctx.hud.showBanner(ctx.overworld.region.nameZh, regionSubtitle(ctx.data.world, ctx.overworld.region))
    window.__apOnboarding.debugShow('menuHint')
  })
  await page.waitForSelector('.ap-banner.is-on', { state: 'visible' })

  const report = await measureHUD(page)
  await page.screenshot({ path: `${output}${phase}-desktop-banner.png` })
  await writeFile(`${output}${phase}-layout-report.json`, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`desktop banner: ${report.violations.length ? 'FAIL' : 'PASS'}`)
  if (report.violations.length) console.log(report.violations.join('\n'))
  assert.deepEqual(report.violations, [], 'Field information must not paint over other HUD text')
  return report
}

export async function measureHUD(page) {
  return page.evaluate(() => {
    const violations = []
    const eps = 1
    const rect = (node) => {
      const r = node.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
    }
    const visible = (node) => node && node.checkVisibility() && getComputedStyle(node).visibility !== 'hidden'
    const overlaps = (a, b) => Math.min(a.right, b.right) > Math.max(a.left, b.left) + eps &&
      Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + eps
    const selectors = ['.ap-plate', '.ap-quest', '.ap-objective', '.ap-evchips', '.ap-evdetails', '.ap-minimap', '.ap-net', '.ap-evsense', '.ap-tip']
    const peers = selectors.flatMap(selector => {
      const node = document.querySelector(selector)
      return visible(node) ? [{ selector, text: node.textContent, ...rect(node) }] : []
    })
    for (const [index, peer] of peers.entries()) {
      if (peer.left < -eps || peer.right > innerWidth + eps || peer.top < -eps || peer.bottom > innerHeight + eps) {
        violations.push(`${peer.selector} exceeds viewport`)
      }
      for (const other of peers.slice(index + 1)) {
        const node = document.querySelector(peer.selector)
        const otherNode = document.querySelector(other.selector)
        if (node.contains(otherNode) || otherNode.contains(node)) continue
        if (overlaps(peer, other)) violations.push(`${peer.selector} overlaps ${other.selector}`)
      }
    }
    const banner = document.querySelector('.ap-banner')
    const box = rect(banner)
    if (visible(banner)) {
      if (box.left < -eps || box.right > innerWidth + eps || box.top < -eps || box.bottom > innerHeight + eps) {
        violations.push('map banner exceeds viewport')
      }
      for (const peer of peers) {
        if (overlaps(box, peer)) violations.push(`map banner overlaps ${peer.selector}`)
      }
    }
    const textSelectors = ['.ap-banner-title', '.ap-banner-sub', '.ap-quest-text', '.ap-objective-text',
      '.ap-evchip-title', '.ap-evchip-sub', '.ap-evsense-text', '.ap-tip-body', '.ap-tip-foot']
    for (const selector of textSelectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (!visible(node)) continue
        const bounds = rect(node)
        const range = document.createRange()
        range.selectNodeContents(node)
        if ([...range.getClientRects()].some(r => r.left < bounds.left - eps || r.right > bounds.right + eps)) {
          violations.push(`${selector} has horizontally clipped text`)
        }
      }
    }
    const tip = peers.find(peer => peer.selector === '.ap-tip')
    if (tip) {
      for (const button of document.querySelectorAll('.ap-touch__btn, .ap-touch__stick')) {
        if (visible(button) && overlaps(tip, rect(button))) violations.push('guide overlaps touch controls')
      }
    }
    const errors = (window.__AP_LOG ?? []).filter(s => /uncaught|rejection|frame error/.test(s))
    violations.push(...errors)
    const stack = rect(document.querySelector('.ap-hud-tl'))
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      stack, banner: { text: banner.textContent, ...box }, peers, violations,
    }
  })
}

export async function runHUDQuestQA({ task, slot, phase = 'after' }) {
  const page = task.page('p1')
  const url = new URL(await page.url())
  assert.equal(url.searchParams.get('dev'), '1')
  assert.match(slot ?? '', /^\d{10}$/)
  assert.equal(url.searchParams.get('slot'), slot)
  await mkdir(output, { recursive: true })
  await page.waitForSelector('.ap-quest', { state: 'visible' })
  const collapsed = await page.evaluate(() => {
    const quest = document.querySelector('.ap-quest')
    return {
      height: quest.getBoundingClientRect().height,
      unit: Number(document.documentElement.style.getPropertyValue('--ap-ui-scale')),
    }
  })
  await writeFile(`${output}${phase}-quest-report.json`, `${JSON.stringify(collapsed, null, 2)}\n`)
  assert.ok(collapsed.height <= 32 * collapsed.unit, 'A tracked quest must not keep its full paragraph open')
  await page.focus('.ap-quest-toggle')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.ap-quest-toggle')?.getAttribute('aria-expanded') === 'true')
  const expanded = await page.evaluate(() => {
    const details = document.querySelector('.ap-quest-details')
    const text = document.querySelector('.ap-quest-text')
    return { text: text.textContent, visible: details.checkVisibility(),
      contained: details.scrollWidth <= details.clientWidth + 1 }
  })
  assert.ok(expanded.visible && expanded.contained)
  assert.match(expanded.text, /沿镇子西边的 1 号道路前往开源林镇/)
  await page.keyboard.press('Space')
  await page.waitForFunction(() => document.querySelector('.ap-quest-toggle')?.getAttribute('aria-expanded') === 'false')
  assert.ok(await page.evaluate(() => !document.querySelector('.ap-quest-details').checkVisibility()))
  console.log('quest density and keyboard disclosure: PASS')
}

export async function runHUDObjectiveQA({ task, slot }) {
  const page = task.page('p1')
  const url = new URL(await page.url())
  assert.equal(url.searchParams.get('dev'), '1')
  assert.match(slot ?? '', /^\d{10}$/)
  assert.equal(url.searchParams.get('slot'), slot)
  await page.evaluate(() => { delete window.__AP.save.flags['rival:lab'] })
  await page.waitForFunction(() => window.__apOnboarding.objectiveId === 'rival')
  assert.deepEqual((await measureHUD(page)).violations, [],
    'A newly appearing objective must not animate over the adjacent event text')
  assert.equal(await page.evaluate(() =>
    document.querySelector('.ap-objective-toggle').getAttribute('aria-expanded')), 'false',
  'Changing the objective must not automatically open another paragraph over the game')

  await page.focus('.ap-objective-toggle')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.ap-objective-toggle').getAttribute('aria-expanded') === 'true')
  await page.click('.ap-quest-toggle')
  await page.waitForFunction(() => document.querySelector('.ap-quest-toggle').getAttribute('aria-expanded') === 'true')
  assert.equal(await page.evaluate(() =>
    document.querySelector('.ap-objective-toggle').getAttribute('aria-expanded')), 'false',
  'Opening the tracked quest must close objective details')
  await page.click('.ap-objective-toggle')
  await page.waitForFunction(() => document.querySelector('.ap-objective-toggle').getAttribute('aria-expanded') === 'true')
  assert.equal(await page.evaluate(() =>
    document.querySelector('.ap-quest-toggle').getAttribute('aria-expanded')), 'false',
  'Opening objective details must close the tracked quest')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelector('.ap-objective-toggle').getAttribute('aria-expanded') === 'false')
  await page.evaluate(() => { window.__AP.save.flags['rival:lab'] = true })
  await page.waitForFunction(() => window.__apOnboarding.objectiveId === 'route')
  console.log('objective default density, mutual disclosure and Escape: PASS')
}

export async function runHUDDensityQA({ task, slot, phase = 'after' }) {
  const page = task.page('p1')
  const url = new URL(await page.url())
  assert.equal(url.searchParams.get('dev'), '1')
  assert.match(slot ?? '', /^\d{10}$/)
  assert.equal(url.searchParams.get('slot'), slot)
  await page.waitForSelector('.ap-banner', { state: 'hidden' })
  const report = await measureHUD(page)
  const unit = await page.evaluate(() => Number(document.documentElement.style.getPropertyValue('--ap-ui-scale')))
  await writeFile(`${output}${phase}-density-report.json`, `${JSON.stringify({ ...report, unit }, null, 2)}\n`)
  assert.ok(report.stack.width <= 176 * unit + 1, 'The field information stack must remain a compact sidebar')
  assert.ok(report.stack.height <= 100 * unit + 1, 'Persistent field information must not occupy a large part of the game')
  console.log(`persistent HUD density: PASS (${(report.stack.height / unit).toFixed(1)} UI units high)`)
}

export async function setHUDViewport(page, vp) {
  await page.cdp('Emulation.setDeviceMetricsOverride', {
    width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: false,
  })
  await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: !!vp.touch, maxTouchPoints: vp.touch ? 5 : 1 })
  await page.waitForFunction(({ width, height, dpr }) =>
    innerWidth === width && innerHeight === height && devicePixelRatio === dpr, vp)
  const expected = await page.evaluate(async (vp) => {
    const { computeUIScale } = await import('/src/client/ui/scale.ts')
    const { applyDocumentSettings } = await import('/src/client/core/settings.ts')
    window.__AP.save.settings.touchControls = vp.touch ? 'on' : 'off'
    applyDocumentSettings(window.__AP.save.settings)
    window.__AP.input.setTouchControlsVisible(!!vp.touch)
    window.dispatchEvent(new Event('resize'))
    return computeUIScale(vp.width, vp.height, vp.dpr)
  }, vp)
  await page.waitForFunction(({ cssPerUnit, compact }) =>
    Number(document.documentElement.style.getPropertyValue('--ap-ui-scale')) === cssPerUnit &&
    document.documentElement.classList.contains('ap-compact') === compact, expected)
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  if (vp.touch) {
    const point = await page.evaluate(() => {
      const r = document.querySelector('.ap-touch__btn[data-action="run"]').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    for (let i = 0; i < 2; i++) {
      await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
      await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    }
    await page.waitForFunction(() => window.__AP.input.lastDevice === 'touch')
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('.ap-touch__btn')].every(b => b.checkVisibility())))
  } else {
    await page.keyboard.press('Shift')
    await page.waitForFunction(() => window.__AP.input.lastDevice === 'keyboard')
  }
}

export async function runHUDResponsiveQA({ task, slot, phase = 'after' }) {
  const page = task.page('p1')
  const url = new URL(await page.url())
  assert.equal(url.searchParams.get('dev'), '1')
  assert.match(slot ?? '', /^\d{10}$/)
  assert.equal(url.searchParams.get('slot'), slot)
  await mkdir(output, { recursive: true })
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
    const compact = await measureHUD(page)
    await page.screenshot({ path: `${output}${phase}-${vp.name}-compact.png` })
    reports.push({ name: `${vp.name}-compact`, ...compact })
    await page.evaluate(async () => {
      const ctx = window.__AP
      const { regionSubtitle } = await import('/src/client/world/explore.ts')
      ctx.hud.showBanner(ctx.overworld.region.nameZh, regionSubtitle(ctx.data.world, ctx.overworld.region))
      window.__apOnboarding.debugShow('menuHint')
    })
    await page.waitForFunction(() => {
      const banner = document.querySelector('.ap-banner')
      const tip = document.querySelector('.ap-tip')
      return Number(getComputedStyle(banner).opacity) > 0.99 &&
        !tip.getAnimations().some(a => a.playState === 'running' && a.effect?.target !== document.querySelector('.ap-tip-progress'))
    })
    const notices = await measureHUD(page)
    await page.screenshot({ path: `${output}${phase}-${vp.name}-notices.png` })
    reports.push({ name: `${vp.name}-notices`, ...notices })
    console.log(`${vp.name}: ${compact.violations.length + notices.violations.length ? 'FAIL' : 'PASS'}`)
  }
  await writeFile(`${output}${phase}-responsive-report.json`, `${JSON.stringify(reports, null, 2)}\n`)
  const violations = reports.flatMap(r => r.violations.map(v => `${r.name}: ${v}`))
  if (violations.length) console.log(violations.join('\n'))
  assert.deepEqual(violations, [], 'Field HUD, map notices and guide text must stay readable at every viewport')
  return reports
}

export async function runHUDEdgeQA({ task, slot }) {
  const page = task.page('p1')
  const url = new URL(await page.url())
  assert.equal(url.searchParams.get('dev'), '1')
  assert.match(slot ?? '', /^\d{10}$/)
  assert.equal(url.searchParams.get('slot'), slot)
  await setHUDViewport(page, { width: 320, height: 740, dpr: 2 })
  await page.waitForSelector('.ap-banner', { state: 'hidden' })
  await page.waitForSelector('.ap-tip', { state: 'hidden' })
  const backup = await page.evaluate(() => {
    const s = window.__AP.save
    return { trackedQuest: s.trackedQuest, quests: structuredClone(s.quests), badges: [...s.badges] }
  })
  const checks = []
  try {
    const stage = await page.evaluate(() => {
      const ctx = window.__AP
      ctx.save.badges = [ctx.data.world.badges[0].id]
      ctx.save.quests.main = { stage: 4, done: false }
      ctx.save.quests['sq-floppy'] = { stage: 0, done: false }
      ctx.save.trackedQuest = 'sq-floppy'
      return ctx.data.world.quests.find(q => q.id === 'main').stages[4].text
    })
    await page.waitForFunction(() => window.__apOnboarding.objectiveId === 'next' &&
      document.querySelector('.ap-quest-summary')?.textContent === '古董软盘')
    assert.equal(await page.evaluate(() =>
      document.querySelector('.ap-objective-toggle').getAttribute('aria-expanded')), 'false')
    await page.click('.ap-objective-toggle')
    await page.waitForFunction(stage => document.querySelector('.ap-objective-text')?.textContent === stage, stage)
    const next = await measureHUD(page)
    assert.deepEqual(next.violations, [])
    await page.screenshot({ path: `${output}after-mobile-320-long-objective.png` })
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 7400)))
    assert.equal(await page.evaluate(() =>
      document.querySelector('.ap-objective-toggle').getAttribute('aria-expanded')), 'true',
    'User-opened details must not disappear while the player is reading')
    checks.push('side quest remains tracked while the main story objective is shown; manual details stay open')

    await page.evaluate(() => {
      const ctx = window.__AP
      const longest = ctx.data.world.quests.flatMap(q => q.stages.map(s => s.text)).sort((a, b) => b.length - a.length)[0]
      ctx.hud.setQuest(Array.from({ length: 8 }, () => longest).join('\n'), '古董软盘')
    })
    await page.click('.ap-quest-toggle')
    await page.waitForFunction(() => document.querySelector('.ap-quest-toggle').getAttribute('aria-expanded') === 'true')
    await page.focus('.ap-quest-details')
    const start = await page.evaluate(() => window.__AP.overworld.player)
    await page.keyboard.press('PageDown')
    await page.screenshot({ path: `${output}after-mobile-320-quest-scroll-start.png` })
    await page.screenshot({ path: `${output}after-mobile-320-scrollable-quest.png` })
    await page.waitForFunction(() => document.querySelector('.ap-quest-details').scrollTop > 0)
    assert.deepEqual(await page.evaluate(() => window.__AP.overworld.player), start,
      'Reading the scrollable quest must not move the character')
    const long = await measureHUD(page)
    assert.deepEqual(long.violations, [])
    await page.keyboard.press('Escape')
    assert.ok(await page.evaluate(() => document.activeElement === document.querySelector('.ap-quest-toggle')))
    assert.equal(await page.evaluate(() =>
      document.querySelector('.ap-quest-toggle').getAttribute('aria-expanded')), 'false')
    await page.keyboard.press('Tab')
    assert.ok(await page.evaluate(() => document.activeElement === document.querySelector('.ap-objective-toggle')))
    assert.equal(await page.evaluate(() => window.__AP.ui.isBlocking()), false,
      'Tabbing through field controls must not accidentally open the game menu')
    checks.push('long quest wraps, scrolls by keyboard, restores focus and does not trigger gameplay')

    await page.evaluate(() => { window.__AP.save.trackedQuest = undefined })
    await page.waitForSelector('.ap-quest', { state: 'hidden' })
    checks.push('no tracked quest leaves no empty card')

    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    const shownAt = Date.now()
    await page.evaluate(() => window.__apOnboarding.debugShow('menuHint'))
    await page.waitForSelector('.ap-tip', { state: 'visible' })
    await page.waitForSelector('.ap-tip', { state: 'hidden', timeout: 10000 })
    const ttlMs = Date.now() - shownAt
    assert.ok(ttlMs >= 6800 && ttlMs < 9500, `Guide lifetime was ${ttlMs}ms`)
    checks.push(`guide expires automatically (${ttlMs}ms including fade)`)

    await page.evaluate(() => {
      const ctx = window.__AP
      ctx.hud.showBanner(ctx.overworld.region.nameZh)
    })
    await page.waitForSelector('.ap-banner.is-on', { state: 'visible' })
    await page.waitForFunction(() => !document.querySelector('.ap-banner').classList.contains('is-on'))
    await page.evaluate(() => window.__AP.hud.showBanner(window.__AP.overworld.region.nameZh))
    await page.waitForFunction(() => new Promise(resolve => setTimeout(() => resolve(
      !document.querySelector('.ap-banner').hidden && document.querySelector('.ap-banner').classList.contains('is-on')), 700)))
    await page.waitForSelector('.ap-banner', { state: 'hidden' })
    assert.equal(await page.evaluate(() => document.querySelector('.ap-banner').getBoundingClientRect().height), 0)
    checks.push('a new map notice cancels the old fade timer; expired notice reserves no space')

    await page.evaluate((backup) => {
      const ctx = window.__AP
      Object.assign(ctx.save, backup)
    }, backup)
    await page.waitForFunction(() => document.querySelector('.ap-quest-summary')?.textContent === '智灵之路')
    await writeFile(`${output}edge-report.json`, `${JSON.stringify({ checks, next, long, ttlMs }, null, 2)}\n`)
    console.log(checks.join('\n'))
  } finally {
    await page.evaluate((backup) => Object.assign(window.__AP.save, backup), backup)
  }
}

export async function runHUDMenuQA({ task, slot, phase = 'menu', touch = false }) {
  const page = task.page('p1')
  const url = new URL(await page.url())
  assert.equal(url.searchParams.get('dev'), '1')
  assert.match(slot ?? '', /^\d{10}$/)
  assert.equal(url.searchParams.get('slot'), slot)
  assert.match(phase, /^[a-z0-9-]+$/)
  await page.waitForFunction(() => window.__AP.overworld.free && !window.__AP.ui.isBlocking())
  if (touch) {
    const point = await page.evaluate(() => {
      const button = document.querySelector('.ap-touch__btn[data-action="menu"]')
      if (!button?.checkVisibility()) throw new Error('Touch menu button must be visible')
      const r = button.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    await page.screenshot({ path: `${output}${phase}-held.png` })
    assert.ok(await page.evaluate(() => !window.__AP.ui.isBlocking()),
      'A touch menu gesture must finish before the menu replaces its hit targets')
    await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await page.focus('.ap-quest-toggle')
    await page.keyboard.press('Escape')
  }
  await page.screenshot({ path: `${output}${phase}-opening.png` })
  try {
    await page.waitForSelector('.aps-pause', { state: 'visible', timeout: 5000 })
  } catch {
    assert.fail(touch ? 'The touch menu button must still open the game menu' :
      'Escape from a collapsed HUD control must still open the game menu')
  }
  if (touch) {
    assert.ok(await page.evaluate(() =>
      [...document.querySelectorAll('.ap-touch__btn')].every(button =>
        !button.checkVisibility() || getComputedStyle(button).visibility === 'hidden')),
    'The pause menu must not waste space on gameplay touch controls')
  }
  try {
    await page.evaluate(() => window.__apOnboarding.debugShow('menu'))
    assert.ok(await page.evaluate(() => document.querySelector('.ap-tip')?.checkVisibility()),
      'A menu guide must not be hidden by the compact menu layout')
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.aps-pause-cardslot, .aps-pause-menu, .ap-tip')]
        .every(node => !node.getAnimations().some(a => a.playState === 'running')))
    await page.focus('.ap-tip-close')
    if (await page.evaluate(() => {
      const tip = document.querySelector('.ap-tip').getBoundingClientRect()
      const body = document.querySelector('.aps-pause .aps-body').getBoundingClientRect()
      return tip.top < body.top || tip.bottom > body.bottom
    })) {
      await page.keyboard.press('PageDown')
      await page.screenshot({ path: `${output}${phase}-scroll-probe.png` })
      await page.waitForFunction(() => {
        const tip = document.querySelector('.ap-tip').getBoundingClientRect()
        const body = document.querySelector('.aps-pause .aps-body').getBoundingClientRect()
        return tip.top >= body.top - 1 && tip.bottom <= body.bottom + 1
      })
    }
    await page.screenshot({ path: `${output}${phase}-tip-probe.png` })
    const report = await page.evaluate(() => {
      const card = document.querySelector('.ap-tip')
      const tip = card.getBoundingClientRect()
      const overlaps = []
      const clipped = []
      for (const node of document.querySelectorAll('.aps-pause-row, .aps-pc-top, .aps-pc-rows, .aps-pause-detail-title, .aps-pause-detail-text, .aps-pause-detail-hint, .aps-foot')) {
        if (!node.checkVisibility()) continue
        const r = node.getBoundingClientRect()
        if (Math.min(tip.right, r.right) > Math.max(tip.left, r.left) + 1 &&
          Math.min(tip.bottom, r.bottom) > Math.max(tip.top, r.top) + 1) {
          overlaps.push({ class: node.className, text: node.textContent })
        }
      }
      for (const node of card.querySelectorAll('.ap-tip-body, .ap-tip-foot')) {
        const range = document.createRange()
        range.selectNodeContents(node)
        const r = node.getBoundingClientRect()
        if ([...range.getClientRects()].some(text => text.left < r.left - 1 || text.right > r.right + 1)) {
          clipped.push(node.className)
        }
      }
      return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        inline: card.classList.contains('is-inline'), visible: card.checkVisibility(),
        scrollTop: document.querySelector('.aps-pause .aps-body').scrollTop, overlaps, clipped }
    })
    await writeFile(`${output}${phase}-report.json`, `${JSON.stringify(report, null, 2)}\n`)
    assert.ok(report.visible && report.inline)
    assert.deepEqual(report.overlaps, [], 'A menu guide must not paint over menu actions or their descriptions')
    assert.deepEqual(report.clipped, [], 'A menu guide must keep its complete text readable')
    if (touch) {
      const point = await page.evaluate(() => {
        const r = document.querySelector('.ap-tip-close').getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })
      await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
      await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else {
      await page.keyboard.press('Enter')
    }
    await page.waitForSelector('.ap-tip', { state: 'hidden' })
    assert.equal(await page.evaluate(() =>
      document.querySelectorAll('.ap-kit-stack > .aps-screen:not(.ap-pushed-out)').length), 1,
    'Dismissing the guide must not activate a menu action beneath it')
    if (touch) {
      assert.ok(await page.evaluate(() => window.__AP.ui.isBlocking() &&
        document.querySelector('.aps-pause')?.contains(document.activeElement) &&
        !document.querySelector('.ap-tip')?.contains(document.activeElement)),
      'Touch dismissal must keep focus inside the menu, not on the hidden guide')
    } else {
      assert.ok(await page.evaluate(() => document.activeElement?.matches('.aps-pause-row.is-active')),
        'Dismissing the inline guide must return focus to the selected menu action')
    }
    console.log(`${phase}: menu opening, guide placement and keyboard/touch focus: PASS`)
    return report
  } finally {
    await page.click('.aps-pause .aps-close')
    await page.waitForSelector('.aps-pause', { state: 'detached' })
    await page.waitForSelector('.ap-tip', { state: 'hidden' })
    if (touch) {
      assert.ok(await page.evaluate(() =>
        [...document.querySelectorAll('.ap-touch__btn')].every(button =>
          button.checkVisibility() && getComputedStyle(button).visibility !== 'hidden')),
      'Gameplay touch controls must return after closing the pause menu')
    }
  }
}
