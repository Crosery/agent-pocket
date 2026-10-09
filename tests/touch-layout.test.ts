import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, t } from '../src/shared/content/index.ts'
import { sanitizeSettings } from '../src/client/core/save-sanitize.ts'
import { INPUT_CONFIG } from '../src/client/core/input-config.ts'
import { buttonRect, computeTouchLayout, rectsOverlap } from '../src/client/core/touch-layout.ts'

const T = INPUT_CONFIG.touch
const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '360x780', width: 360, height: 780 },
  { name: '844x390', width: 844, height: 390 },
  { name: '667x375', width: 667, height: 375 },
  { name: '932x430', width: 932, height: 430 },
]
const HANDS = ['right', 'left'] as const
const SIZES = ['small', 'normal', 'large'] as const

test('every touch button is at least 44px, inside the screen, and clear of the others', () => {
  const safe = { left: 0, right: 0, bottom: 0 }
  for (const vp of VIEWPORTS) for (const hand of HANDS) for (const size of SIZES) {
    const layout = computeTouchLayout(T, vp, hand, size, T.insetGap)
    const rects = layout.buttons.map((b) => ({ b, r: buttonRect(layout, b, T, vp, safe) }))
    for (const { b, r } of rects) {
      const where = `${vp.name} ${hand} ${size} ${b.def.action}`
      assert.ok(b.size >= 44, `${where}: ${b.size}px < 44`)
      assert.ok(r.left >= 0 && r.top >= 0 && r.right <= vp.width && r.bottom <= vp.height, `${where}: off screen ${JSON.stringify(r)}`)
    }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      assert.ok(!rectsOverlap(rects[i].r, rects[j].r, 4), `${vp.name} ${hand} ${size}: ${rects[i].b.def.action} touches ${rects[j].b.def.action}`)
    }
  }
})

test('left-handed layout mirrors the right-handed one', () => {
  const vp = VIEWPORTS[0]
  const right = computeTouchLayout(T, vp, 'right', 'normal', T.insetGap)
  const left = computeTouchLayout(T, vp, 'left', 'normal', T.insetGap)
  for (let i = 0; i < right.buttons.length; i++) {
    const a = buttonRect(right, right.buttons[i], T, vp), b = buttonRect(left, left.buttons[i], T, vp)
    assert.ok(Math.abs(a.left - (vp.width - b.right)) < 1e-6 && Math.abs(a.top - b.top) < 1e-6, right.buttons[i].def.action)
  }
  assert.equal(right.insets.left, left.insets.right)
  assert.equal(right.insets.right, left.insets.left)
})

test('the pad reserves the bottom only in portrait; world-only buttons never reserve space', () => {
  const portrait = computeTouchLayout(T, VIEWPORTS[0], 'right', 'normal', T.insetGap)
  const landscape = computeTouchLayout(T, VIEWPORTS[2], 'right', 'normal', T.insetGap)
  assert.ok(portrait.portrait && portrait.insets.bottom > 0)
  assert.ok(!landscape.portrait && landscape.insets.bottom === 0)
  assert.ok(landscape.insets.left > 0 && landscape.insets.right > 0)
  const core = Math.max(...T.buttons.filter((b) => !b.worldOnly).map((b) => b.bottom + (b.size === 'large' ? T.buttonSize : T.smallButtonSize)))
  assert.equal(portrait.insets.bottom, T.margin + Math.max(2 * T.stickRadius, core) + T.insetGap)
})

test('touch tuning is sane and every button resolves a label', () => {
  assert.ok(T.tap.slopPx > 0 && T.tap.maxMs > T.tap.stickHoldMs, 'a tap must be able to end before the hold timer fires')
  assert.ok(T.zoneWidthFraction > 0 && T.zoneWidthFraction <= 0.6)
  assert.ok(T.zoneHeightFraction.portrait > 0 && T.zoneHeightFraction.landscape > 0)
  for (const k of ['small', 'normal', 'large'] as const) assert.ok(T.sizes[k] > 0)
  for (const b of T.buttons) assert.notEqual(t(b.label), b.label, b.label)
  const seen = new Set<string>()
  for (const b of T.buttons) { assert.ok(!seen.has(b.action), `duplicate ${b.action}`); seen.add(b.action) }
})

test('phone defaults: touch-only migration lowers quality once, desktop keeps the default', () => {
  const id = CONTENT.config.settingsMigrations?.find((m) => m.touchOnly)?.id
  assert.ok(id, 'a touchOnly settings migration exists')
  const phone = sanitizeSettings({}, CONTENT, true)
  assert.equal(phone.quality, 'medium')
  assert.ok(phone.migrations?.includes(id))
  const desktop = sanitizeSettings({}, CONTENT, false)
  assert.equal(desktop.quality, CONTENT.config.defaultSettings.quality)
  assert.ok(!desktop.migrations?.includes(id), 'stays pending so the same save is migrated if it is later opened on a phone')
  const chosen = sanitizeSettings({ quality: 'high', migrations: phone.migrations }, CONTENT, true)
  assert.equal(chosen.quality, 'high', 'an applied migration never overrides the player later')
})
