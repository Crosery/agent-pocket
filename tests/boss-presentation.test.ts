// Boss battle presentation (issue #32): every boss has a scale, an idle theme and an intro clip (or an explicit static
// fallback), the manifest matches the files on disk, and the pure intro helpers behave.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTENT } from '../src/shared/content/index.ts'
import { expandSteps } from '../src/client/render/battle/config.ts'
import { BOSS_PRES, bossEntry, bossTheme, themeGlyphs, validateBossPresentation, type BossPresentation } from '../src/client/render/battle/boss-config.ts'
import { createSkipGate, shouldSkipClip } from '../src/client/battle/boss-intro-core.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = (p: string) => join(ROOT, 'public', p)

test('the boss presentation content is valid against bosses.json and species.json', () => {
  assert.deepEqual(validateBossPresentation(CONTENT), [])
})

test('every boss is scaled up and every scale is inside the configured range', () => {
  const [lo, hi] = BOSS_PRES.scaleRange
  assert.ok(lo >= 1.3 && hi <= 1.6, 'issue #32: roughly 1.3x to 1.6x')
  for (const id of Object.keys(CONTENT.bosses)) {
    const e = bossEntry(id)
    assert.ok(e, `${id} has an entry`)
    assert.ok(e.scale >= lo && e.scale <= hi, `${id}: ${e.scale}`)
  }
})

test('each theme has its particle steps expand with defaults and the glyphs reach the atlas', () => {
  for (const [name, th] of Object.entries(BOSS_PRES.themes)) {
    const steps = expandSteps(th.steps, null)
    assert.equal(steps.length, th.steps.length, name)
    for (const s of steps) assert.equal(s.fx, 'particles')
  }
  const glyphs = themeGlyphs()
  for (const th of Object.values(BOSS_PRES.themes)) for (const s of th.steps) for (const ch of s.chars ?? '') assert.ok(glyphs.includes(ch))
  assert.equal(bossTheme('astra')?.everyMs, BOSS_PRES.themes[BOSS_PRES.bosses.astra.theme].everyMs)
  assert.equal(bossTheme('not-a-boss'), null)
})

test('every recorded clip exists, is a web-ready mp4 under the size cap and its manifest numbers match the file', () => {
  let clips = 0
  for (const [id, b] of Object.entries(BOSS_PRES.bosses)) {
    const c = b.intro
    if (!c) continue
    clips++
    const mp4 = pub(c.src), jpg = pub(c.poster)
    assert.ok(existsSync(mp4), `${id}: ${c.src}`)
    assert.ok(existsSync(jpg), `${id}: ${c.poster}`)
    assert.equal(statSync(mp4).size, c.bytes, `${id}: recorded bytes`)
    assert.ok(c.bytes <= BOSS_PRES.intro.maxBytes, `${id}: ${c.bytes} bytes`)
    const head = readFileSync(mp4).subarray(0, 65536)
    assert.equal(head.subarray(4, 8).toString('latin1'), 'ftyp', `${id}: mp4 container`)
    const moov = head.indexOf('moov'), mdat = head.indexOf('mdat')
    assert.ok(moov > 0 && (mdat < 0 || moov < mdat), `${id}: faststart (moov before mdat) so it can play while loading`)
    assert.ok(readFileSync(jpg).subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), `${id}: poster is a jpeg`)
    assert.ok(c.source.prompt.length > 40 && /^[0-9a-f]{16}$/.test(c.source.taskId) && Number.isInteger(c.source.seed), `${id}: source recorded`)
    assert.ok(existsSync(join(ROOT, c.source.firstFrame)), `${id}: first frame ${c.source.firstFrame}`)
  }
  assert.ok(clips >= 1)
})

test('validation catches a bad scale, an unknown theme and an oversized clip', () => {
  const bad = structuredClone(BOSS_PRES) as BossPresentation
  bad.bosses.astra.scale = 2.4
  bad.bosses.deepseek.theme = 'nope'
  const clip = structuredClone(BOSS_PRES.bosses.kimi.intro!)
  clip.bytes = BOSS_PRES.intro.maxBytes + 1
  bad.bosses.kimi.intro = clip
  const errs = validateBossPresentation(CONTENT, bad).join('\n')
  assert.match(errs, /astra\.scale/)
  assert.match(errs, /deepseek\.theme/)
  assert.match(errs, /kimi\.intro\.bytes/)
})

test('Save-Data and 2G connections skip the clip, normal ones try it', () => {
  assert.equal(shouldSkipClip(undefined), false)
  assert.equal(shouldSkipClip({ effectiveType: '4g' }), false)
  assert.equal(shouldSkipClip({ saveData: true }), true)
  assert.equal(shouldSkipClip({ effectiveType: '2g' }), true)
  assert.equal(shouldSkipClip({ effectiveType: 'slow-2g' }), true)
  assert.equal(shouldSkipClip({ saveData: true }, { ...BOSS_PRES.intro, skipOnSaveData: false }), false)
})

test('a skip releases every pending wait at once and later waits return immediately', async () => {
  const gate = createSkipGate()
  const t0 = Date.now()
  const waits = Promise.all([gate.wait(5000), gate.wait(5000)])
  setTimeout(() => gate.fire(), 20)
  await waits
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(gate.skipped, true)
  const t1 = Date.now()
  await gate.wait(5000)
  assert.ok(Date.now() - t1 < 100)
  let called = 0
  gate.onSkip(() => called++)
  assert.equal(called, 0, 'listeners added after the skip are not retro-fired')
})
