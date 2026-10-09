import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as {
  name: string; short_name: string; start_url: string; scope: string; display: string; display_override: string[]
  orientation: string; theme_color: string; background_color: string; lang: string
  icons: { src: string; sizes: string; type: string; purpose: string }[]
}
const html = readFileSync('index.html', 'utf8')

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { w: number; h: number } {
  const b = readFileSync(file)
  assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG', `${file} is a PNG`)
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

test('manifest installs full-screen and rotates freely', () => {
  assert.equal(manifest.display, 'fullscreen')
  assert.ok(manifest.display_override.includes('standalone'), 'falls back to standalone where fullscreen is not offered')
  assert.equal(manifest.orientation, 'any')
  assert.equal(manifest.lang, 'zh-CN')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.scope, '/')
  assert.ok(manifest.name && manifest.short_name)
})

test('manifest colours match the page theme', () => {
  const meta = /<meta name="theme-color" content="([^"]+)"/.exec(html)?.[1]
  assert.equal(manifest.theme_color, meta)
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i)
})

test('manifest icons exist at their declared size, with a maskable one', () => {
  for (const i of manifest.icons) {
    const edge = Number(i.sizes.split('x')[0])
    assert.deepEqual(pngSize(`public${i.src}`), { w: edge, h: edge }, i.src)
  }
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable' && Number(i.sizes.split('x')[0]) >= 512))
  assert.ok(manifest.icons.some((i) => i.purpose === 'any' && Number(i.sizes.split('x')[0]) >= 192))
  assert.deepEqual(pngSize('public/assets/pwa/apple-touch-icon.png'), { w: 180, h: 180 })
})

test('index.html links the manifest from the origin and the touch icon', () => {
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" vite-ignore \/>/, 'vite-ignore keeps the manifest off the CDN rewrite')
  assert.match(html, /<link rel="apple-touch-icon" href="\/assets\/pwa\/apple-touch-icon\.png"/)
})
