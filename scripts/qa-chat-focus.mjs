// Real-browser regression for issue #11: chat focus / game-input deadlock.
// Run through ego-browser with the goal's existing TaskSpace and an isolated development save slot:
//   ego-browser nodejs <<'EOF'
//   const { runChatFocusQA } = await import('/abs/path/scripts/qa-chat-focus.mjs')
//   const task = await taskSpace(<spaceId>)
//   await runChatFocusQA({ task, slot: '1100000011', phase: 'after', baseUrl: 'http://127.0.0.1:5311' })
//   EOF
// After every step the script reads document.activeElement and chat.isOpen and requires them to agree
// (chat open <=> focus is inside the chat box; chat closed <=> focus is back on the page), and it keeps probing
// with real arrow keys that the player can actually walk. Every scenario runs even if an earlier one failed;
// the function throws at the end when any check failed. The report lands in output/11/<phase>-report.json.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const output = fileURLToPath(new URL('../output/11/', import.meta.url))

export async function runChatFocusQA({ task, slot, phase = 'after', baseUrl }) {
  assert.match(slot ?? '', /^\d{10}$/, 'An isolated development save slot is required')
  assert.match(phase, /^[a-z0-9-]+$/)
  await mkdir(output, { recursive: true })
  const page = task.page('p1')
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
  if (baseUrl) {
    await page.goto(`${baseUrl}/?dev=1&skipTitle=1&reset=1&slot=${slot}`)
    await page.waitForFunction(() => !!window.__ap && window.__AP?.overworld.free && document.querySelector('#ap-loading')?.hidden,
      undefined, { timeout: 60000 })
  }
  const url = new URL(await page.url())
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.searchParams.get('dev'), '1')
  assert.equal(url.searchParams.get('slot'), slot, 'Refusing to drive a different save slot')

  const report = { phase, scenarios: [] }
  let scenario = null
  const sleep = (ms) => page.waitForTimeout(ms)
  /** Waits until the game loop has certainly consumed what was just sent (the harness page can run rAF slowly). */
  const tick = async (frames = 10) => {
    await page.evaluate((n) => new Promise((resolve) => {
      let count = 0
      const cap = setTimeout(resolve, 5000)
      const step = () => { if (++count >= n) { clearTimeout(cap); resolve(count) } else requestAnimationFrame(step) }
      requestAnimationFrame(step)
    }), frames)
    await sleep(60)
  }
  /** Map loads hitch the render loop for a while; keys pressed during a hitch are only seen once frames flow again. */
  const calm = () => page.evaluate(() => new Promise((resolve) => {
    let smooth = 0, last = performance.now()
    const deadline = last + 20000
    const tick = (now) => {
      smooth = now - last > 45 ? 0 : smooth + 1
      last = now
      if (smooth >= 30 || now > deadline) resolve(smooth)
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }))

  /** Where the game thinks input goes versus where the browser keeps focus. */
  const probe = () => page.evaluate(() => {
    const ctx = window.__AP
    const a = document.activeElement
    const name = !a ? 'none' : a === document.body ? 'body'
      : `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}${typeof a.className === 'string' && a.className.trim() ? `.${a.className.trim().split(/\s+/).join('.')}` : ''}`
    const p = window.__ap.pos()
    const field = document.querySelector('.ap-chat-box .ap-field')
    return {
      active: name,
      neutral: a === document.body || a?.id === 'ap-canvas',
      inChatBox: !!a?.closest?.('.ap-chat-box'),
      isField: a === field,
      chatOpen: ctx.chat.isOpen,
      chatClass: document.querySelector('.ap-chat').classList.contains('is-open'),
      blocking: ctx.ui.isBlocking(),
      free: ctx.overworld.free,
      collapsed: document.querySelector('.ap-chat').classList.contains('is-collapsed'),
      draft: field.value,
      hidden: document.hidden,
      keysSeen: (window.__qaKeys ?? []).length,
      x: p.x, y: p.y,
    }
  })

  /** Reads the state, requires the focus/open invariants, then the scenario's own expectations. */
  async function check(step, expect = {}) {
    const s = await probe()
    scenario.steps.push({ step, ...s })
    const where = `[${scenario.name}] ${step}: ${JSON.stringify(s)}`
    assert.equal(s.chatOpen, s.chatClass, `${where} -> chat.isOpen disagrees with the panel being drawn open`)
    assert.equal(s.chatOpen, s.inChatBox, `${where} -> chat.isOpen must be true exactly when focus is inside the chat box`)
    if (!s.chatOpen && !expect.modal && !expect.hudFocus) assert.ok(s.neutral, `${where} -> chat is closed but focus stays on ${s.active}`)
    if (expect.chatOpen !== undefined) assert.equal(s.chatOpen, expect.chatOpen, `${where} -> chatOpen`)
    if (expect.blocking !== undefined) assert.equal(s.blocking, expect.blocking, `${where} -> ui blocking`)
    if (expect.free !== undefined) assert.equal(s.free, expect.free, `${where} -> overworld.free`)
    if (expect.collapsed !== undefined) assert.equal(s.collapsed, expect.collapsed, `${where} -> chat collapsed`)
    if (expect.draft !== undefined) assert.equal(s.draft, expect.draft, `${where} -> chat draft`)
    return s
  }

  /**
   * Holds `key` (then the other directions if something solid or a wandering NPC blocks it) with real key
   * events and returns how far the player moved. A dead input system moves in none of them.
   */
  async function walk(step, key, expectMove, ms = 500) {
    const order = [key, ...['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].filter((k) => k !== key)]
    let moved = 0
    let b = null
    for (const k of expectMove ? order : [key]) {
      const a = await probe()
      await page.keyboard.down(k)
      await sleep(ms)
      await page.keyboard.up(k)
      await sleep(120)
      b = await probe()
      moved = Math.hypot(b.x - a.x, b.y - a.y)
      scenario.steps.push({ step: `walk ${k}`, moved: +moved.toFixed(2) })
      if (moved > 0.3) break
    }
    if (expectMove) assert.ok(moved > 0.3, `[${scenario.name}] ${step}: no arrow key moved the player ${JSON.stringify(b)}`)
    else assert.ok(moved < 0.05, `[${scenario.name}] ${step}: player moved ${moved.toFixed(2)} while chat should own the keys`)
    return moved
  }

  /** A pixel that really is the game canvas (no HUD layer on top of it). */
  const canvasPoint = () => page.evaluate(() => {
    for (const [fx, fy] of [[0.5, 0.3], [0.5, 0.25], [0.4, 0.35], [0.6, 0.35], [0.5, 0.45]]) {
      const x = Math.round(innerWidth * fx), y = Math.round(innerHeight * fy)
      if (document.elementFromPoint(x, y)?.id === 'ap-canvas') return { x, y }
    }
    return null
  })
  async function clickCanvas(label) {
    const pt = await canvasPoint()
    assert.ok(pt, 'no clear canvas pixel to click')
    await page.mouse.click(pt.x, pt.y, { label })
    await tick()
  }
  /** Records, after the game's own listener ran, which keydowns reached the window and whether the game claimed them. */
  const hookKeys = () => page.evaluate(() => {
    window.__qaKeys = []
    if (window.__qaKeyHook) return
    window.__qaKeyHook = true
    window.addEventListener('keydown', (e) => window.__qaKeys.push({ key: e.key, prevented: e.defaultPrevented }))
  })

  /** Presses T and waits for the chat; the first key after a page load is occasionally dropped by the harness, so it may retry once. */
  async function openChat(label) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await page.keyboard.press('t')
      await tick()
      if ((await probe()).chatOpen) return
      scenario.steps.push({ step: `${label}: T did not open the chat (attempt ${attempt})` })
    }
  }

  async function reset() {
    await page.keyboard.up('ArrowRight').catch(() => {})
    await page.keyboard.up('ArrowLeft').catch(() => {})
    // A broken build can leave a modal that Esc no longer reaches; fall back to the cancel key, then to a reload.
    for (const key of ['Escape', 'Escape', 'x', 'x']) {
      if (!(await probe()).blocking) break
      await page.keyboard.press(key)
      await tick()
    }
    if ((await probe()).blocking) {
      await page.reload()
      await page.waitForFunction(() => !!window.__ap && window.__AP?.overworld.free && document.querySelector('#ap-loading')?.hidden,
        undefined, { timeout: 60000 })
      await hookKeys()
    }
    await page.evaluate(async () => {
      const ctx = window.__AP
      ctx.chat.close()
      ctx.chat.setCollapsed(false)
      document.activeElement?.blur?.()
      await window.__ap.tp(513, 877)
    })
    await page.waitForFunction(() => window.__AP.overworld.free && window.__ap.pos().map === 'overworld' &&
      document.querySelector('#ap-loading')?.hidden, undefined, { timeout: 30000 })
    await calm()
    const s = await probe()
    assert.ok(!s.chatOpen && s.free && s.neutral, `could not reach a clean start state: ${JSON.stringify(s)}`)
  }

  async function run(name, fn) {
    scenario = { name, ok: true, steps: [] }
    report.scenarios.push(scenario)
    try {
      await reset()
      await fn()
      console.log(`PASS ${name}`)
    } catch (err) {
      scenario.ok = false
      scenario.error = String(err.message).split('\n')[0]
      console.log(`FAIL ${name}\n     ${scenario.error}`)
      await page.screenshot({ path: `${output}${phase}-fail-${report.scenarios.length}.png` }).catch(() => {})
    }
  }

  await calm()
  await hookKeys()

  await run('1 T -> click canvas -> arrows move, chat closed', async () => {
    await check('start', { chatOpen: false, free: true })
    await openChat('T')
    const open = await check('after T', { chatOpen: true })
    assert.ok(open.isField, 'T must put focus in the chat input')
    await clickCanvas('click game canvas')
    await check('after click canvas', { chatOpen: false, free: true })
    await walk('after click canvas', 'ArrowRight', true)
    await check('after walking', { chatOpen: false })
  })

  await run('2 T -> click canvas -> Esc opens the menu, Esc closes it, arrows move', async () => {
    await openChat('T')
    await check('after T', { chatOpen: true })
    await clickCanvas('click game canvas')
    await check('after click canvas', { chatOpen: false })
    await page.keyboard.press('Escape')
    await tick()
    await check('first Esc after click', { chatOpen: false, blocking: true, modal: true })
    await page.keyboard.press('Escape')
    await tick()
    await check('second Esc', { chatOpen: false, blocking: false })
    await walk('after menu closed', 'ArrowLeft', true)
  })

  await run('3 T -> type -> click canvas -> T reopens with the draft kept', async () => {
    await openChat('T')
    await page.keyboard.type('hello focus')
    await check('typed', { chatOpen: true, draft: 'hello focus' })
    await clickCanvas('click game canvas')
    await check('after click canvas', { chatOpen: false, draft: 'hello focus' })
    await openChat('T')
    const again = await check('T again', { chatOpen: true, draft: 'hello focus' })
    assert.ok(again.isField, 'reopened chat must focus the input')
    await page.keyboard.press('Escape')
    await tick()
    await check('Esc closes', { chatOpen: false, blocking: false })
    await walk('after Esc', 'ArrowRight', true)
  })

  await run('4 keyboard moves -> click the Chat button -> Esc -> arrows move', async () => {
    await walk('keyboard warm-up', 'ArrowRight', true, 400)
    await page.click('.ap-chat-open', { label: 'click chat button' })
    await tick()
    const open = await check('after Chat button', { chatOpen: true })
    assert.ok(open.isField, 'the Chat button must hand focus to the input')
    await page.keyboard.press('Escape')
    await tick()
    await check('Esc after Chat button', { chatOpen: false, blocking: false })
    await walk('after Esc', 'ArrowLeft', true)
  })

  await run('5 keyboard moves -> click the Collapse button -> Space / Z reach the game', async () => {
    await walk('keyboard warm-up', 'ArrowRight', true, 400)
    await page.hover('.ap-chat-open', { label: 'reveal collapse button' })
    const before = await check('before collapse', { chatOpen: false, collapsed: false })
    await page.click('.ap-chat-collapse', { label: 'click collapse button' })
    await tick()
    const collapsed = await check('after Collapse button', { chatOpen: false, collapsed: true })
    assert.ok(collapsed.neutral, `the HUD button must not keep focus (active: ${collapsed.active})`)
    await hookKeys()
    await page.keyboard.press('Space')
    await tick()
    await page.keyboard.press('z')
    await tick()
    await check('after Space / Z', { chatOpen: false, collapsed: true })
    const keys = await page.evaluate(() => window.__qaKeys)
    scenario.steps.push({ step: 'keydowns seen by window', keys })
    for (const key of [' ', 'z']) {
      assert.ok(keys.some((k) => k.key === key && k.prevented), `[${scenario.name}] "${key === ' ' ? 'Space' : key}" never reached the game (seen: ${JSON.stringify(keys)})`)
    }
    assert.equal(before.collapsed, false)
    await walk('arrows after Space / Z', 'ArrowLeft', true)
  })

  await run('6 T -> click a chat control (channel / tab) -> still open, Esc closes, arrows move', async () => {
    await openChat('T')
    await check('after T', { chatOpen: true })
    await page.click('.ap-chat-chan', { label: 'click channel button' })
    await tick()
    const chan = await check('after channel button', { chatOpen: true })
    assert.ok(chan.isField, 'clicking a chat control must leave the input focused')
    await page.click('.ap-chat-box .ap-tab.is-active', { label: 'click the already active tab' })
    await tick()
    const tab = await check('after active tab', { chatOpen: true })
    assert.ok(tab.isField, 'clicking the active tab must leave the input focused')
    await page.keyboard.press('Escape')
    await tick()
    await check('Esc', { chatOpen: false, blocking: false })
    await walk('after Esc', 'ArrowRight', true)
  })

  await run('7 T -> Esc closes only the chat (no pause menu), arrows move', async () => {
    await openChat('T')
    await check('after T', { chatOpen: true })
    await page.keyboard.press('Escape')
    await tick()
    await check('after Esc', { chatOpen: false, blocking: false, free: true })
    await walk('after Esc', 'ArrowLeft', true)
  })

  await run('8 chat open while focus rests on a chat control: held arrows release the chat (watchdog)', async () => {
    await openChat('T')
    await check('after T', { chatOpen: true })
    // A control inside the box legitimately keeps the chat open; the player only wants to walk.
    await page.evaluate(() => document.querySelector('.ap-chat-box .ap-chat-input-row button:last-of-type').focus())
    await tick()
    const stuck = await probe()
    scenario.steps.push({ step: 'focus parked on chat control', ...stuck })
    assert.ok(stuck.inChatBox && !stuck.isField, `could not park focus on a chat control: ${JSON.stringify(stuck)}`)
    await page.evaluate(() => { window.__AP_LOG.length = 0 })
    await page.keyboard.down('ArrowRight')
    await sleep(3500)
    await page.keyboard.up('ArrowRight')
    await tick()
    const after = await check('after holding an arrow', { chatOpen: false, free: true })
    const warned = await page.evaluate(() => window.__AP_LOG.filter((l) => l.startsWith('warn:')))
    scenario.steps.push({ step: 'console warnings', warned })
    assert.ok(warned.some((l) => /chat/i.test(l)), `[${scenario.name}] watchdog should warn on the console: ${JSON.stringify(warned)}`)
    assert.ok(after.neutral)
    await walk('after watchdog', 'ArrowLeft', true)
  })

  await run('9 sibling: text prompt -> click away -> Esc still closes it', async () => {
    await page.evaluate(() => { window.__qaPrompt = 'pending'; window.__AP.ui.prompt('QA prompt', '', 8).then((v) => { window.__qaPrompt = v }) })
    await tick()
    const s = await check('prompt open', { chatOpen: false, blocking: true, modal: true })
    assert.equal(s.active, 'input.ap-field', 'prompt must focus its field')
    await page.evaluate(() => document.activeElement.blur())
    await tick()
    await page.keyboard.press('Escape')
    await tick()
    await check('Esc after the field lost focus', { chatOpen: false, blocking: false })
    assert.equal(await page.evaluate(() => window.__qaPrompt), null, 'Esc must cancel the prompt')
    await walk('after prompt', 'ArrowRight', true)
  })

  await run('10 sibling: save-code panel -> click away -> Esc still closes it', async () => {
    await page.evaluate(async () => {
      const { promptSaveCode } = await import('/src/client/ui/screens/savecode.ts')
      window.__qaCode = 'pending'
      promptSaveCode({ ctx: window.__AP }).then((v) => { window.__qaCode = v })
    })
    await tick()
    const s = await check('save-code open', { chatOpen: false, blocking: true, modal: true })
    assert.equal(s.active, 'textarea.aps-code-area', 'save-code panel must focus its textarea')
    await page.evaluate(() => document.activeElement.blur())
    await tick()
    await page.keyboard.press('Escape')
    await tick()
    await check('Esc after the textarea lost focus', { chatOpen: false, blocking: false })
    assert.equal(await page.evaluate(() => window.__qaCode), null, 'Esc must cancel the import panel')
    await walk('after save-code', 'ArrowLeft', true)
  })

  await run('11 keyboard: focus the Chat button + Enter -> Esc returns focus to it, arrows still walk, Esc again opens the menu', async () => {
    await page.focus('.ap-chat-open')
    await page.keyboard.press('Enter')
    await tick()
    const open = await check('after Enter on Chat button', { chatOpen: true })
    assert.ok(open.isField, 'keyboard activation must hand focus to the input')
    await page.keyboard.press('Escape')
    await tick()
    const closed = await check('Esc', { chatOpen: false, blocking: false, hudFocus: true })
    assert.ok(closed.active.includes('ap-chat-open'), `keyboard users get focus back on the Chat button (active: ${closed.active})`)
    await walk('arrows with the Chat button focused', 'ArrowRight', true)
    await page.keyboard.press('Escape')
    await tick()
    await check('Esc on the focused Chat button', { chatOpen: false, blocking: true, modal: true })
  })

  report.consoleLog = await page.evaluate(() => (window.__AP_LOG ?? []).slice(-40))
  const failed = report.scenarios.filter((s) => !s.ok)
  report.summary = { total: report.scenarios.length, failed: failed.length }
  await writeFile(`${output}${phase}-report.json`, `${JSON.stringify(report, null, 2)}\n`)
  await page.screenshot({ path: `${output}${phase}-final.png` })
  console.log(`\n${report.summary.total - failed.length}/${report.summary.total} scenarios passed (${phase})`)
  if (failed.length) throw new Error(`${failed.length} scenario(s) failed: ${failed.map((s) => s.name.split(' ')[0]).join(', ')}`)
  return report
}
