import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, t } from '../src/shared/content/index.ts'
import { sanitizeSettings } from '../src/client/core/save-sanitize.ts'
import { INPUT_CONFIG } from '../src/client/core/input-config.ts'
import { buttonRect, clampRing, computeTouchLayout, driveStick, inStickZone, rectsOverlap } from '../src/client/core/touch-layout.ts'

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
  assert.equal(landscape.insets.left, 0, 'the stick spawns under the thumb and reserves no corner')
  assert.ok(landscape.insets.right > 0, 'the button cluster still does')
  const core = Math.max(...T.buttons.filter((b) => !b.worldOnly).map((b) => b.bottom + (b.size === 'large' ? T.buttonSize : T.smallButtonSize)))
  assert.equal(portrait.insets.bottom, T.margin + core + T.insetGap)
})

test('touch tuning is sane and every button resolves a label', () => {
  assert.ok(T.tap.slopPx > 0 && T.tap.maxMs > T.tap.stickHoldMs, 'a tap must be able to end before the hold timer fires')
  assert.ok(T.zoneWidthFraction > 0 && T.zoneWidthFraction <= 0.6)
  assert.equal(T.zoneWidthFraction, 0.5, 'the stick zone is the whole left half')
  assert.ok(T.stick.fadeMs > 0 && T.stick.edgePadPx >= 0)
  assert.equal(T.style.idleOpacity, 0, 'no resting stick: it is invisible until a thumb lands')
  assert.ok(T.hint.opacity > 0 && T.hint.opacity < 0.7 && T.hint.loopMs > 0, 'the hint is faint')
  for (const spot of [T.hint.portrait, T.hint.landscape]) assert.ok(spot.x > 0 && spot.x < T.zoneWidthFraction && spot.y > 0 && spot.y < 1, 'the hint sits inside the stick half')
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

test('stick zone: the whole half opposite the buttons, any height, mirrored for left-handed', () => {
  for (const vp of VIEWPORTS) {
    for (let y = 0; y <= vp.height; y += vp.height / 8) {
      // The zone is a function of x only: every height of the left half starts the stick.
      for (const x of [0, 1, vp.width * 0.25, vp.width * 0.4999]) assert.ok(inStickZone(x, vp.width, 'right', T.zoneWidthFraction), `${vp.name} x=${x} y=${y}`)
      for (const x of [vp.width * 0.5, vp.width * 0.75, vp.width]) assert.ok(!inStickZone(x, vp.width, 'right', T.zoneWidthFraction), `${vp.name} right half x=${x}`)
    }
    assert.ok(inStickZone(vp.width * 0.75, vp.width, 'left', T.zoneWidthFraction))
    assert.ok(!inStickZone(vp.width * 0.25, vp.width, 'left', T.zoneWidthFraction))
  }
})

test('stick ring: spawns neutral under the thumb, trails it past the radius, and is drawn inside the screen', () => {
  const R = T.stickRadius
  const vp = { width: 390, height: 844 }
  const land = { x: 120, y: 500 }
  const neutral = driveStick(land, land, R, T.follow)
  assert.deepEqual([neutral.dx, neutral.dy, neutral.dist], [0, 0, 0])
  // inside the ring the base stays put
  const inside = driveStick(land, { x: land.x + R / 2, y: land.y }, R, true)
  assert.deepEqual(inside.origin, land)
  assert.equal(inside.dist, R / 2)
  // past it the base trails the thumb at exactly one radius
  const far = driveStick(land, { x: land.x + 3 * R, y: land.y }, R, true)
  assert.equal(far.dist, R)
  assert.equal(far.origin.x, land.x + 2 * R)
  const back = driveStick(far.origin, { x: far.origin.x - R, y: land.y }, R, true)
  assert.equal(back.dx, -R, 'reversing needs one ring of travel, not three')
  // without follow the knob just clamps
  assert.deepEqual(driveStick(land, { x: land.x + 3 * R, y: land.y }, R, false).origin, land)
  // the ring never leaves the screen, wherever the thumb lands
  const pad = T.stick.edgePadPx
  for (const p of [{ x: 0, y: 0 }, { x: 3, y: 840 }, { x: 389, y: 10 }, { x: 195, y: 422 }, { x: -50, y: 900 }]) {
    const c = clampRing(p, R, vp, pad)
    assert.ok(c.x - R >= pad - 1e-9 && c.x + R <= vp.width - pad + 1e-9 && c.y - R >= pad - 1e-9 && c.y + R <= vp.height - pad + 1e-9, JSON.stringify(c))
  }
  assert.deepEqual(clampRing({ x: 200, y: 400 }, R, vp, pad), { x: 200, y: 400 }, 'a thumb in the open leaves the ring where it is')
})

test('the tutorial text for touch points at the left half, not at a fixed stick', () => {
  assert.match(t('tutorial.tip.move.bodyTouch'), /左半边/)
  assert.match(t('tutorial.manual.move.bodyTouch'), /左半边/)
  assert.doesNotMatch(t('tutorial.device.touch.move'), /摇杆/)
})

test('the server greeting has a touch variant that names the chat icon, not the T key', () => {
  assert.match(t('net.motd'), /按 T/)
  assert.doesNotMatch(t('net.motdTouch'), /\bT\b/)
  assert.match(t('net.motdTouch'), /聊天图标/)
})
