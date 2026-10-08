// Invoke runPartyLayoutQA({ task, slot, phase }) through ego-browser nodejs.
// The caller supplies an existing agent-owned TaskSpace and an isolated development save slot.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function runPartyLayoutQA({ task, slot, phase = 'after' }) {
  assert.match(slot ?? '', /^\d{10}$/, 'slot must identify an isolated development save')
  const output = fileURLToPath(new URL('../output/party-layout-qa/', import.meta.url))
  await mkdir(output, { recursive: true })

  const page = task.page('p1')
  const url = new URL(await page.url())
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.searchParams.get('dev'), '1')
  assert.equal(url.searchParams.get('slot'), slot, 'Refusing to change a different save slot')

  if (await page.evaluate(() => !!document.querySelector('.aps-party'))) {
    await page.click('.aps-party .aps-close')
    await page.waitForSelector('.aps-party', { state: 'detached' })
  }

  await page.evaluate(async () => {
    const { createCreature, maxHp } = await import('/src/shared/creature.ts')
    const { Rng } = await import('/src/shared/rng.ts')
    const ctx = window.__AP
    const rng = new Rng(7)
    const ids = ['gemini-2-5-pro', 'deepseek-v3', 'kimi-k2', 'langchain', 'eleven-v4', 'sensenova']
    ctx.save.party = ids.map((id) => {
      if (!ctx.data.species[id]) throw new Error(`Missing layout fixture species: ${id}`)
      const c = createCreature(id, 30, { rng, otName: ctx.save.name, otId: ctx.save.playerId })
      c.hp = maxHp(c)
      return c
    })
  })

  async function openParty(mode = 'view') {
    await page.evaluate((mode) => { void window.__AP.screens.party(mode) }, mode)
    await page.waitForSelector('.aps-party-grid', { state: 'visible' })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForFunction(() => !document.querySelector('.aps-party')?.getAnimations().some(a => a.playState === 'running'))
  }

  async function closeParty() {
    await page.click('.aps-party .aps-close')
    await page.waitForSelector('.aps-party', { state: 'detached' })
  }

  async function measureParty() {
    return page.evaluate(() => {
      const violations = []
      const eps = 1
      const rect = (node) => {
        const r = node.getBoundingClientRect()
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
      }
      const contains = (outer, inner) => inner.left >= outer.left - eps && inner.right <= outer.right + eps &&
        inner.top >= outer.top - eps && inner.bottom <= outer.bottom + eps
      const cards = [...document.querySelectorAll('.aps-party-card:not(.is-empty)')].map((card, i) => {
        const name = card.querySelector('.aps-party-name')
        const level = card.querySelector('.aps-party-lv')
        const nameBox = rect(name)
        const levelBox = rect(level)
        const cardBox = rect(card)
        const range = document.createRange()
        range.selectNodeContents(name)
        if ([...range.getClientRects()].some(r => !contains(nameBox, r))) violations.push(`card ${i}: name is clipped`)
        if (nameBox.right > levelBox.left + eps && nameBox.bottom > levelBox.top + eps &&
          nameBox.top < levelBox.bottom - eps) violations.push(`card ${i}: name overlaps level`)
        for (const node of card.querySelectorAll('.aps-party-main > *, .ap-bar-label, .ap-bar-num, .aps-chips > *')) {
          if (!contains(cardBox, rect(node))) violations.push(`card ${i}: ${node.className} exceeds card`)
        }
        const bars = [...card.querySelectorAll('.ap-bar')].map((bar) => {
          const track = rect(bar)
          const css = getComputedStyle(bar)
          const innerRight = track.right - parseFloat(css.borderRightWidth)
          const fill = rect(bar.querySelector('.ap-bar-fill'))
          const ghost = rect(bar.querySelector('.ap-bar-ghost'))
          if (fill.right > innerRight + eps) violations.push(`card ${i}: fill exceeds track by ${(fill.right - innerRight).toFixed(2)}px`)
          if (ghost.right > innerRight + eps) violations.push(`card ${i}: ghost exceeds track`)
          if (fill.width < -eps || bar.clientWidth < 1) violations.push(`card ${i}: collapsed track`)
          const value = Number(bar.getAttribute('aria-valuenow'))
          const max = Number(bar.getAttribute('aria-valuemax'))
          const expected = Math.min(1, Math.max(0, value / max)) * bar.clientWidth
          if (Math.abs(fill.width - expected) > Math.max(1, parseFloat(css.borderLeftWidth))) {
            violations.push(`card ${i}: fill ratio does not match value ${value}/${max}`)
          }
          const num = bar.parentElement.querySelector('.ap-bar-num')
          if (num && track.right > rect(num).left + eps) violations.push(`card ${i}: track overlaps number`)
          return { kind: bar.className, value, max, track, fill, ghost, number: num ? rect(num) : null }
        })
        return { name: name.textContent, nameBox, levelBox, cardBox, bars }
      })
      const grid = document.querySelector('.aps-party-grid')
      const errors = (window.__AP_LOG ?? []).filter(s => /uncaught|rejection/.test(s))
      if (grid.scrollWidth > grid.clientWidth + eps) violations.push('party grid overflows horizontally')
      if (errors.length) violations.push(...errors)
      return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        compact: document.documentElement.classList.contains('ap-compact'),
        grid: { clientWidth: grid.clientWidth, scrollWidth: grid.scrollWidth, clientHeight: grid.clientHeight, scrollHeight: grid.scrollHeight },
        cards, violations }
    })
  }

  const reports = []
  const viewports = [
    { name: 'desktop-1280', width: 1280, height: 900, dpr: 1 },
    { name: 'desktop-retina', width: 1280, height: 900, dpr: 2 },
    { name: 'desktop-1024', width: 1024, height: 768, dpr: 1 },
    { name: 'desktop-1920', width: 1920, height: 1080, dpr: 1 },
    { name: 'mobile-390', width: 390, height: 844, dpr: 3 },
    { name: 'mobile-320', width: 320, height: 740, dpr: 2 },
    { name: 'landscape-844', width: 844, height: 390, dpr: 3 },
    { name: 'touch-390', width: 390, height: 844, dpr: 3, touch: true },
    { name: 'touch-320', width: 320, height: 740, dpr: 2, touch: true },
  ]

  async function setViewport(vp) {
    await page.cdp('Emulation.setDeviceMetricsOverride', {
      width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: false,
    })
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: !!vp.touch, maxTouchPoints: vp.touch ? 5 : 1 })
    await page.waitForFunction(({ width, height, dpr }) =>
      innerWidth === width && innerHeight === height && devicePixelRatio === dpr, vp)
    const expected = await page.evaluate(async ({ width, height, dpr }) => {
      window.dispatchEvent(new Event('resize'))
      const { computeUIScale } = await import('/src/client/ui/scale.ts')
      return computeUIScale(width, height, dpr)
    }, vp)
    await page.waitForFunction(({ cssPerUnit, compact }) =>
      Number(document.documentElement.style.getPropertyValue('--ap-ui-scale')) === cssPerUnit &&
      document.documentElement.classList.contains('ap-compact') === compact, expected)
    await page.evaluate(async (touch) => {
      const { applyDocumentSettings } = await import('/src/client/core/settings.ts')
      window.__AP.save.settings.touchControls = touch ? 'on' : 'off'
      applyDocumentSettings(window.__AP.save.settings)
    }, !!vp.touch)
  }

  async function record(name) {
    const report = await measureParty()
    reports.push({ name, ...report })
    await page.screenshot({ path: resolve(output, `${phase}-${name}.png`) })
    console.log(`${name}: ${report.violations.length ? 'FAIL' : 'PASS'} (${report.violations.length} violations)`)
    if (report.violations.length) console.log(report.violations.slice(0, 8).join('\n'))
  }

  for (const vp of viewports) {
    await setViewport(vp)
    await openParty()
    await record(vp.name)
    await closeParty()
  }

  if (phase === 'after') {
    await page.evaluate(async () => {
      const { maxHp } = await import('/src/shared/creature.ts')
      const ctx = window.__AP
      ctx.save.party.forEach((c, i) => {
        c.hp = i === 0 ? maxHp(c) : i === 1 ? Math.floor(maxHp(c) / 2) : i === 2 ? 1 : i === 3 ? 0 : maxHp(c)
      })
      const limit = ctx.data.config.net.nameMaxLen
      ctx.save.party[5].nickname = '\u667a\u7075'.repeat(Math.ceil(limit / 2)).slice(0, limit)
    })
    for (const vp of [viewports[1], viewports[5], viewports[6], viewports[8]]) {
      await setViewport(vp)
      for (const mode of ['view', 'select', 'battleSwitch']) {
        await openParty(mode)
        await record(`${vp.name}-states-${mode}`)
        await closeParty()
      }
    }

    await setViewport(viewports[6])
    await openParty()
    await setViewport(viewports[5])
    await page.waitForFunction(() => document.querySelector('.aps-party-grid').style.getPropertyValue('--cols') === '1')
    for (let index = 1; index < 6; index++) {
      await page.keyboard.press('ArrowDown', { delay: 100 })
      await page.waitForFunction((index) => [...document.querySelectorAll('.aps-party-card')].findIndex(c => c.classList.contains('is-active')) === index, index)
    }
    const keyboard = await page.evaluate(() => {
      const grid = document.querySelector('.aps-party-grid')
      const active = grid.querySelector('.is-active')
      const g = grid.getBoundingClientRect(), c = active.getBoundingClientRect()
      return { index: [...grid.children].indexOf(active), scrollTop: grid.scrollTop,
        fullyVisible: c.top >= g.top - 1 && c.bottom <= g.bottom + 1,
        focusedInside: !!document.activeElement.closest('.aps-party') }
    })
    assert.equal(keyboard.index, 5)
    assert.ok(keyboard.fullyVisible, 'Keyboard navigation must scroll the selected card into view')
    assert.ok(keyboard.focusedInside)
    await page.screenshot({ path: resolve(output, `${phase}-keyboard-last-card.png`) })
    await page.keyboard.press('Enter', { delay: 100 })
    await page.waitForSelector('.aps-popup-layer', { state: 'visible' })
    await page.keyboard.press('x', { delay: 100 })
    await page.waitForSelector('.aps-popup-layer', { state: 'detached' })
    await page.waitForFunction(() => !document.querySelector('.aps-party').classList.contains('is-busy'))
    await setViewport(viewports[1])
    assert.equal(await page.evaluate(() => document.querySelector('.aps-party-grid').style.getPropertyValue('--cols')), '2')
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.aps-party-card')].findIndex(c => c.classList.contains('is-active'))), 5)
    await page.keyboard.press('x', { delay: 100 })
    await page.waitForSelector('.aps-party', { state: 'detached' })
    await writeFile(resolve(output, 'keyboard-report.json'), `${JSON.stringify(keyboard, null, 2)}\n`)
    console.log('keyboard, popup and live orientation: PASS')

    const savedParty = await page.evaluate(() => window.__AP.save.party)
    await page.evaluate(() => { window.__AP.save.party = [] })
    for (const vp of [viewports[2], viewports[8]]) {
      await setViewport(vp)
      await openParty()
      assert.ok(await page.evaluate(() => document.querySelectorAll('.aps-party-card.is-empty').length === window.__AP.data.config.party.maxParty))
      await record(`${vp.name}-empty`)
      await closeParty()
    }
    await page.evaluate((party) => { window.__AP.save.party = party }, savedParty)
  }

  await writeFile(resolve(output, `${phase}-layout-report.json`), `${JSON.stringify(reports, null, 2)}\n`)
  const violations = reports.flatMap(r => r.violations.map(v => `${r.name}: ${v}`))
  assert.deepEqual(violations, [], 'Party content must fit without hiding names or painting over numbers')
}
