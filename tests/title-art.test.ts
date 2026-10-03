import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCREENS, validateTitleArt, type TitleArtConfig } from '../src/client/ui/screens/config.ts'
import { panMargins, pickArtFit, placeTitleArt, type Size } from '../src/client/ui/screens/title-art.ts'

const here = dirname(fileURLToPath(import.meta.url))
const art = SCREENS.title.art

// Size of the shipped key art from its PNG header (falls back to a 4:3 art when the asset is absent).
function keyArtSize(): Size {
  const file = join(here, '..', 'public', 'assets', 'ui', `${SCREENS.title.keyArt}.png`)
  if (!existsSync(file)) return { w: 1536, h: 1152 }
  const b = readFileSync(file)
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

// Viewport window (in viewport px of the un-transformed layer) visible at the zoomed-in end of the pan.
function panEndWindow(box: Size, pan: TitleArtConfig['pan']): [number, number, number, number] {
  const cx = box.w / 2
  const cy = box.h / 2
  const tx = pan.x * box.w
  const ty = pan.y * box.h
  return [cx - (cx + tx) / pan.scale, cy - (cy + ty) / pan.scale, cx + (box.w - cx - tx) / pan.scale, cy + (box.h - cy - ty) / pan.scale]
}

test('content title.art validates', () => {
  assert.deepEqual(validateTitleArt(art), [])
})

test('validateTitleArt rejects a pan that exposes an edge and unsorted fits', () => {
  const bad: TitleArtConfig = {
    pan: { x: 0.05, y: 0, scale: 1.02 },
    fits: [{ minAspect: 0, focus: [0.5, 0.5], keep: [0.1, 0.1, 0.9, 0.9] }, { minAspect: 1, focus: [0.5, 0.5], keep: [0.6, 0.1, 0.4, 0.9] }],
  }
  const errs = validateTitleArt(bad).join('\n')
  assert.match(errs, /pan/)
  assert.match(errs, /minAspect must decrease/)
  assert.match(errs, /keep must be/)
  assert.match(errs, /last fit needs minAspect 0/)
})

test('pickArtFit takes the first fit whose minAspect the viewport reaches', () => {
  assert.equal(pickArtFit(art.fits, 99), art.fits[0])
  assert.equal(pickArtFit(art.fits, 0.01), art.fits[art.fits.length - 1])
})

test('the key art always covers the viewport', () => {
  const img = keyArtSize()
  for (const [w, h] of [[1600, 1000], [1920, 1080], [1280, 960], [2560, 1080], [390, 844], [768, 1024], [1000, 1000], [3840, 1080], [320, 900]]) {
    const p = placeTitleArt(img, { w, h }, art)
    assert.ok(p.x <= 1e-6 && p.y <= 1e-6, `${w}x${h}: art starts inside the viewport`)
    assert.ok(p.x + p.w >= w - 1e-6 && p.y + p.h >= h - 1e-6, `${w}x${h}: art ends inside the viewport`)
    assert.ok(Math.abs(p.w / p.h - img.w / img.h) < 1e-9, `${w}x${h}: aspect kept`)
  }
})

test('the cast (keep rect) stays on screen through the whole pan at the target viewports', () => {
  const img = keyArtSize()
  for (const [w, h] of [[1600, 1000], [1920, 1080], [1280, 960], [2560, 1080], [390, 844], [768, 1024]]) {
    const box = { w, h }
    const p = placeTitleArt(img, box, art)
    const [x0, y0, x1, y1] = pickArtFit(art.fits, w / h).keep
    const keep = [p.x + x0 * p.w, p.y + y0 * p.h, p.x + x1 * p.w, p.y + y1 * p.h]
    for (const win of [[0, 0, w, h], panEndWindow(box, art.pan)]) {
      assert.ok(keep[0] >= win[0] - 0.5 && keep[1] >= win[1] - 0.5 && keep[2] <= win[2] + 0.5 && keep[3] <= win[3] + 0.5,
        `${w}x${h}: keep ${keep.map(Math.round)} outside window ${win.map(Math.round)}`)
    }
  }
})

test('panMargins grows with zoom and translation', () => {
  assert.deepEqual(panMargins({ x: 0, y: 0, scale: 1 }), [0, 0])
  const [mx, my] = panMargins({ x: 0.01, y: 0, scale: 1.04 })
  assert.ok(mx > my && my > 0)
})
