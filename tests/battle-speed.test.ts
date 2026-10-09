// Battle speed: the multiplier table lives in content, every battle time consumer reads it through
// src/client/battle/speed.ts, and holds shrink in proportion. Consumers that need a DOM are checked by source
// (the UI modules import CSS, which node cannot load) and by the timed run in the browser QA.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CONTENT } from '../src/shared/content/index.ts'
import { sanitizeSettings } from '../src/client/core/save-sanitize.ts'
import { BATTLE_UI } from '../src/client/battle/config.ts'
import { advanceTypewriter, createTypewriter } from '../src/client/ui/textflow.ts'
import { anyMatch, battleMs, battleSec, battleSpeedScale, createHolds, gatedDt, stageSteps } from '../src/client/battle/speed.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8')
const SCALES = CONTENT.config.battleSpeeds
const at = (battleSpeed: number) => ({ battleSpeed })

test('the scale table is ascending, starts at 1x and holds the default', () => {
  assert.deepEqual(SCALES, [1, 1.5, 2])
  assert.equal(CONTENT.config.defaultSettings.battleSpeed, 1)
  assert.ok(SCALES.every((v, i) => v > 0 && (i === 0 || v > SCALES[i - 1])))
})

test('settings keep a configured speed and fall back to the default otherwise', () => {
  const d = CONTENT.config.defaultSettings
  for (const v of SCALES) assert.equal(sanitizeSettings({ ...d, battleSpeed: v }, CONTENT).battleSpeed, v)
  for (const bad of [0, 3, -1, '2', null, NaN, undefined]) assert.equal(sanitizeSettings({ ...d, battleSpeed: bad }, CONTENT).battleSpeed, 1)
  assert.equal(sanitizeSettings({}, CONTENT).battleSpeed, 1)
  assert.equal(battleSpeedScale(at(7)), 1)
})

test('battle time is real time times the multiplier', () => {
  for (const v of SCALES) assert.ok(Math.abs(battleMs(0.25, at(v)) - 250 * v) < 1e-9)
})

test('message typing runs on battle seconds: a faster battle types proportionally more characters per second', () => {
  const cps = 20
  for (const v of SCALES) {
    const tw = createTypewriter('x'.repeat(400))
    for (let i = 0; i < 10; i++) advanceTypewriter(tw, battleSec(0.1, at(v)), cps, '', 0)
    assert.ok(Math.abs(tw.shown - cps * v) <= 1.5, `${v}x typed ${tw.shown}`)
  }
})

test('scene holds (after-intro, end hold, faint settle, evolution holds) elapse in proportion to the multiplier', async () => {
  for (const v of SCALES) {
    for (const ms of [BATTLE_UI.timing.afterIntroMs, BATTLE_UI.timing.faintSettleMs, BATTLE_UI.timing.endHoldMs, BATTLE_UI.evolve.startHoldMs]) {
      const holds = createHolds()
      let done = false
      const p = holds.wait(ms).then(() => { done = true })
      let real = 0
      const frame = 1 / 60
      while (!done && real < 10) {
        holds.advance(frame, at(v))
        real += frame
        await Promise.resolve()
      }
      await p
      const expected = ms / 1000 / v
      assert.ok(real >= expected - 1e-9 && real <= expected + frame + 1e-9, `${ms}ms at ${v}x ended after ${real.toFixed(3)}s, expected ~${expected.toFixed(3)}s`)
    }
  }
})

test('stage updates carry the scaled frame in steps no longer than the stage limit', () => {
  const max = BATTLE_UI.stage.maxDtSec
  for (const v of SCALES) {
    for (const dt of [1 / 144, 1 / 60, 1 / 30, max]) {
      const steps = stageSteps(dt, at(v), max)
      assert.ok(Math.abs(steps.reduce((a, b) => a + b, 0) - dt * v) < 1e-9, `${dt}s at ${v}x`)
      assert.ok(steps.every((s) => s > 0 && s <= max + 1e-9))
    }
  }
})

test('every battle time consumer takes its clock from the battle speed module', () => {
  const scene = read('src/client/battle/scene.ts')
  assert.match(scene, /holds\.advance\(battleDt, pace\(\)\)/, 'scene holds')
  assert.match(scene, /stageSteps\(battleDt, pace\(\), BATTLE_UI\.stage\.maxDtSec\)/, 'stage timelines and vfx')
  assert.doesNotMatch(scene, /left -= dt \* 1000/, 'no raw wait countdown left in the scene')
  assert.match(scene, /paced: boolean|paced\?: boolean/)
  assert.match(read('src/client/battle/index.ts'), /paced: true/, 'battles are paced, cutscenes are not')

  const view = read('src/client/battle/view.ts')
  assert.equal((view.match(/battleMs\(dt, pace\(\)\)/g) ?? []).length, 2, 'level-up panel and ability banners')
  assert.doesNotMatch(view, /left -= dt \* 1000/)
  assert.match(view, /createMessageBox\(audio, settings, pace\)/, 'message auto-advance')
  assert.equal((view.match(/barSpeed\)/g) ?? []).length, 2, 'both status panels get the bar speed')
  assert.match(read('src/client/battle/message.ts'), /held \+= battleMs\(dt, pace\(\)\)/)
  assert.match(read('src/client/battle/message.ts'), /advanceTypewriter\(tw, battleSec\(dt, pace\(\)\)/, 'message typing')
  assert.match(read('src/client/battle/status-panel.ts'), /hpBar\(\{[^}]*speed\s*\}\)/, 'hp bar drain')
  assert.match(read('src/client/battle/status-panel.ts'), /expBar\(\{[^}]*speed\s*\}\)/, 'exp bar fill')
  assert.match(read('src/client/ui/widgets.ts'), /rate \* \(opts\?\.speed\?\.\(\) \?\? 1\) \* dt/)
})

test('the settings screen offers exactly the configured speeds with a 中文 label', () => {
  const field = CONTENT.config.battleSpeeds
  const screens = JSON.parse(read('content/screens.json')).settings.fields.find((f: { key: string }) => f.key === 'battleSpeed')
  assert.deepEqual(screens.options, field)
  const text = JSON.parse(read('content/text/zh-CN/screens.json')).settings
  assert.equal(text.field.battleSpeed, '战斗速度')
  assert.match(text.speedValue, /\{value\}/)
})

test('an overlay stops the battle clock: gated time never reaches holds, typing or stage steps', async () => {
  assert.equal(gatedDt(0.016, false), 0.016)
  assert.equal(gatedDt(0.016, true), 0)
  const holds = createHolds()
  let fired = false
  void holds.wait(100).then(() => { fired = true })
  for (let i = 0; i < 600; i++) holds.advance(gatedDt(0.016, true), at(2))
  await Promise.resolve()
  assert.equal(fired, false, 'ten seconds behind an overlay leave a 100 ms hold untouched')
  for (let i = 0; i < 4; i++) holds.advance(gatedDt(0.016, false), at(2))
  await Promise.resolve()
  assert.equal(fired, true, 'it elapses once the overlay is gone')
  assert.deepEqual(stageSteps(gatedDt(0.25, true), at(2), 1 / 30), [])
  const tw = createTypewriter('0123456789')
  for (let i = 0; i < 100; i++) advanceTypewriter(tw, battleSec(gatedDt(0.1, true), at(2)), 20, '', 0)
  assert.equal(tw.shown, 0, 'message typing stands still')
})

test('the pause selectors come from content and any single match holds the battle', () => {
  const sel = BATTLE_UI.pause.selectors
  assert.ok(sel.length >= 2 && sel.every((q) => typeof q === 'string' && q.length > 0))
  assert.equal(anyMatch(sel, () => false), false)
  for (const hit of sel) assert.equal(anyMatch(sel, (q) => q === hit), true)
  assert.ok(sel.some((q) => /aps-screen/.test(q)), 'kit screens (type chart, bag, party)')
  assert.ok(sel.some((q) => /ap-tip-open/.test(q)), 'tip cards that carry a button')
})

test('the scene gates every battle time consumer on one pause check, including the stuck-animation guard', () => {
  const scene = read('src/client/battle/scene.ts')
  assert.match(scene, /const battleDt = gatedDt\(dt, paused\(\)\)/)
  for (const use of ['holds.advance(battleDt', 'stageSteps(battleDt', 'view.update(battleDt', 'render(stage.view, battleDt']) assert.ok(scene.includes(use), use)
  assert.match(scene, /if \(paused\(\)\) \{ timer = arm\(\); return \}/, 'the wall-clock guard waits out an overlay')
  assert.match(scene, /view\.overlayOpen\(\)/)
  assert.match(read('src/client/battle/view.ts'), /overlayOpen: \(\) => effects\.open/)
})
