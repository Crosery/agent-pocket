import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { measureHUD, setHUDViewport } from './qa-hud-layout.mjs'

const output = fileURLToPath(new URL('../output/ui-reference-fusion/', import.meta.url))

export async function runChatControlQA({ task, slot }) {
  const page = task.page('p1')
  const url = new URL(await page.url())
  assert.equal(url.origin, 'http://127.0.0.1:5175')
  assert.equal(url.searchParams.get('dev'), '1')
  assert.match(slot, /^\d{10}$/)
  assert.equal(url.searchParams.get('slot'), slot)
  await mkdir(output, { recursive: true })
  const checks = []
  for (const key of ['Enter', 'Space']) {
    await page.focus('.ap-chat-open')
    await page.keyboard.press(key)
    await page.waitForSelector('.ap-chat.is-open', { state: 'visible', timeout: 2000 })
    assert.ok(await page.evaluate(() => document.activeElement.matches('.ap-chat .ap-field')))
    assert.equal(await page.evaluate(() => document.querySelector('.ap-chat-open').getAttribute('aria-expanded')), 'true')
    assert.equal(await page.evaluate(() => window.__AP.ui.isBlocking()), false)
    const player = await page.evaluate(() => window.__AP.overworld.player)
    await page.focus('.ap-chat-chan')
    const channel = await page.evaluate(() => document.querySelector('.ap-chat-chan').textContent)
    await page.keyboard.press(key)
    assert.notEqual(await page.evaluate(() => document.querySelector('.ap-chat-chan').textContent), channel)
    assert.ok(await page.evaluate(() => document.activeElement.matches('.ap-chat .ap-field')))
    await page.focus('.ap-chat .ap-tab:nth-child(2)')
    await page.keyboard.press(key)
    assert.ok(await page.evaluate(() => document.querySelector('.ap-chat .ap-tab:nth-child(2)').getAttribute('aria-selected') === 'true'))
    await page.focus('.ap-chat-chan')
    await page.keyboard.press('ArrowDown')
    await page.screenshot({ path: `${output}chat-keyboard-${key.toLowerCase()}.png` })
    assert.deepEqual(await page.evaluate(() => window.__AP.overworld.player), player)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.ap-chat').classList.contains('is-open'))
    assert.ok(await page.evaluate(() => document.activeElement.matches('.ap-chat-open')))
    assert.equal(await page.evaluate(() => document.querySelector('.ap-chat-open').getAttribute('aria-expanded')), 'false')
    assert.equal(await page.evaluate(() => window.__AP.ui.isBlocking()), false)
    checks.push(`${key}: chat opens, native controls activate, arrows stay out of gameplay and Escape restores focus`)
  }
  return checks
}

export async function runReferenceFusionQA({ task, slot }) {
  const page = task.page('p1')
  const url = new URL(await page.url())
  assert.equal(url.origin, 'http://127.0.0.1:5175')
  assert.equal(url.searchParams.get('dev'), '1')
  assert.match(slot, /^\d{10}$/)
  assert.equal(url.searchParams.get('slot'), slot)
  await mkdir(output, { recursive: true })
  await page.evaluate(() => window.__AP.net.disconnect())
  await setHUDViewport(page, { width: 1280, height: 900, dpr: 2 })
  const design = await page.evaluate(() => {
    const quest = document.querySelector('.ap-quest')
    const objective = document.querySelector('.ap-objective')
    return {
      missionGroup: quest.parentElement === objective.parentElement && quest.parentElement.matches('.ap-hud-missions'),
      ribbon: getComputedStyle(document.querySelector('.ap-plate'), '::before').borderImageSource,
      missionFrame: getComputedStyle(quest.parentElement, '::before').borderImageSource,
      chatFrame: getComputedStyle(document.querySelector('.ap-chat-open'), '::before').borderImageSource,
      font: getComputedStyle(document.querySelector('.ap-hud')).fontFamily,
      backdrop: document.documentElement.style.getPropertyValue('--ap-hud-bg') ||
        getComputedStyle(document.documentElement).getPropertyValue('--ap-hud-bg'),
    }
  })
  assert.ok(design.missionGroup)
  assert.match(design.ribbon, /hud-ribbon\.png/)
  assert.match(design.missionFrame, /hud-frame\.png/)
  assert.match(design.chatFrame, /hud-frame\.png/)
  assert.match(design.font, /FusionPixel/)
  for (const id of ['hud-frame', 'hud-ribbon']) {
    assert.equal((await page.fetch(`/assets/ui/${id}.png`)).status, 200)
  }
  const checks = ['supplied transparent frames are loaded by the real field HUD', 'quest and objective share one frame', 'pixel font preserved']
  checks.push(...await runChatControlQA({ task, slot }))
  await page.evaluate(() => window.__apOnboarding.debugShow('menuHint'))
  await page.click('.ap-evtoggle')
  await page.waitForFunction(() => !document.querySelector('.ap-evdetails').hidden)
  assert.deepEqual((await measureHUD(page)).violations, [])
  const position = await page.evaluate(() => {
    const r = document.querySelector('.ap-evdetails').getBoundingClientRect()
    return { center: r.left + r.width / 2, width: r.width, top: r.top, bottom: r.bottom, vw: innerWidth }
  })
  assert.ok(Math.abs(position.center - position.vw / 2) <= 1)
  assert.ok(position.top > 900 / 2, 'Desktop reader should sit below the player, not cover the centre of the field')
  await page.screenshot({ path: `${output}final-events.png` })
  await page.focus('.ap-evclose')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.ap-evdetails').hidden)
  assert.ok(await page.evaluate(() => document.activeElement.matches('.ap-evtoggle')))
  assert.equal(await page.evaluate(() => window.__AP.ui.isBlocking()), false)
  checks.push('bottom-centred reader does not overlap tips; close button restores focus without opening the game menu')

  await page.click('.ap-evtoggle')
  await page.focus('.ap-evdetails')
  await page.keyboard.press('Escape')
  await page.focus('.ap-chat-open')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.ap-chat.is-open', { state: 'visible' })
  assert.ok(await page.evaluate(() => document.querySelector('.ap-evdetails').hidden))
  assert.ok(await page.evaluate(() => document.activeElement.matches('.ap-chat .ap-field')))
  await page.screenshot({ path: `${output}final-chat.png` })
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.ap-chat').classList.contains('is-open'))
  assert.ok(await page.evaluate(() => document.activeElement.matches('.ap-chat-open')))
  checks.push('chat opens from the keyboard and takes precedence over other reading windows')

  const ttl = await page.evaluate(async () => {
    const { TUTORIAL } = await import('/src/client/onboarding/config.ts')
    window.__apOnboarding.debugShow('menuHint')
    return { ttl: TUTORIAL.tips.layer.ttlSec * 1000, fade: TUTORIAL.tips.layer.fadeMs, start: performance.now() }
  })
  await page.waitForFunction(() => document.querySelector('.ap-tip').hidden, undefined, { timeout: ttl.ttl + ttl.fade + 3000 })
  const elapsed = await page.evaluate(start => performance.now() - start, ttl.start)
  assert.ok(elapsed <= ttl.ttl + ttl.fade + 1500)
  checks.push(`guide automatically disappears (${Math.round(elapsed)}ms observed, ${ttl.ttl}ms TTL plus fade)`)

  await page.evaluate(() => {
    const ctx = window.__AP
    ctx.save.avatar = 'hero_idol'
    ctx.save.name = 'crosery'
    ctx.overworld.refresh()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.waitForFunction(() => window.__AP.overworld.free && window.__AP.assets.characterTexture('hero_idol').image.width === 1024)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForSelector('.ap-banner', { state: 'hidden' })
  const layout = await measureHUD(page)
  assert.deepEqual(layout.violations, [])
  assert.ok(layout.stack.height <= 100 * 2.5 + 1)
  await page.screenshot({ path: `${output}final-desktop.png` })
  for (const vp of [
    { name: 'mobile', width: 390, height: 844, dpr: 3, touch: true },
    { name: 'landscape', width: 568, height: 320, dpr: 2, touch: true },
  ]) {
    await setHUDViewport(page, vp)
    await page.screenshot({ path: `${output}final-${vp.name}.png` })
    await page.click('.ap-evtoggle')
    await page.focus('.ap-evdetails')
    await page.keyboard.press('End')
    assert.deepEqual((await measureHUD(page)).violations, [])
    await page.screenshot({ path: `${output}final-${vp.name}-scrolled.png` })
    await page.keyboard.press('Escape')
  }
  await setHUDViewport(page, { width: 1280, height: 900, dpr: 2 })
  const errors = await page.evaluate(() => (window.__AP_LOG ?? []).filter(s => /uncaught|rejection|frame error/.test(s)))
  assert.deepEqual(errors, [])
  const report = { design, position, layout, guideExpiryMs: Math.round(elapsed), checks, errors }
  await writeFile(`${output}fusion-report.json`, `${JSON.stringify(report, null, 2)}\n`)
  console.log(checks.join('\n'))
  return report
}
