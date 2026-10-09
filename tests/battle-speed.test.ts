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
import { battleMs, battleSpeedScale, createHolds, stageSteps } from '../src/client/battle/speed.ts'

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
  assert.match(scene, /holds\.advance\(dt, pace\(\)\)/, 'scene holds')
  assert.match(scene, /stageSteps\(dt, pace\(\), BATTLE_UI\.stage\.maxDtSec\)/, 'stage timelines and vfx')
  assert.doesNotMatch(scene, /left -= dt \* 1000/, 'no raw wait countdown left in the scene')
  assert.match(scene, /paced: boolean|paced\?: boolean/)
  assert.match(read('src/client/battle/index.ts'), /paced: true/, 'battles are paced, cutscenes are not')

  const view = read('src/client/battle/view.ts')
  assert.equal((view.match(/battleMs\(dt, pace\(\)\)/g) ?? []).length, 2, 'level-up panel and ability banners')
  assert.doesNotMatch(view, /left -= dt \* 1000/)
  assert.match(view, /createMessageBox\(audio, settings, pace\)/, 'message auto-advance')
  assert.equal((view.match(/barSpeed\)/g) ?? []).length, 2, 'both status panels get the bar speed')
  assert.match(read('src/client/battle/message.ts'), /held \+= battleMs\(dt, pace\(\)\)/)
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
