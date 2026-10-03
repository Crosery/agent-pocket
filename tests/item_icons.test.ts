// Item icon contract: every content item has a 32x32 binary-alpha icon at public/assets/items/<id>.png, chip items
// share one design per move type, other items are distinct, the manifest lists exactly the files on disk, and the
// icon prompt data (assets_src/prompts/items*.json) only refers to existing content.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { CONTENT } from '../src/shared/content/index.ts'
import iconCfgJson from '../assets_src/prompts/items.json' with { type: 'json' }
import iconDetailsJson from '../assets_src/prompts/items_details.json' with { type: 'json' }

interface IconCfg {
  paths: { out: string }
  categories: Record<string, string>
  categoryFallback: string
  chip: { category: string }
  process: { size: number }
  verify: { minOpaque: number }
}
const cfg = iconCfgJson as unknown as IconCfg
const details = iconDetailsJson as unknown as { items: Record<string, string>; chips: Record<string, string> }
const ROOT = new URL('..', import.meta.url).pathname
const iconPath = (id: string) => join(ROOT, cfg.paths.out.replace('{id}', id))
const ICON_DIR = join(iconPath('x'), '..')

interface Rgba { width: number; height: number; colorType: number; px: Uint8Array }

function decodePng(path: string): Rgba {
  const buf = readFileSync(path)
  assert.equal(buf.toString('latin1', 1, 4), 'PNG', `${path} is not a PNG`)
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const colorType = buf[25]
  assert.equal(buf[24], 8, `${path}: bit depth`)
  assert.equal(colorType, 6, `${path}: colour type ${colorType} (RGBA expected)`)
  assert.equal(buf[28], 0, `${path}: interlaced`)
  const idat: Buffer[] = []
  for (let off = 8; off < buf.length;) {
    const len = buf.readUInt32BE(off)
    if (buf.toString('latin1', off + 4, off + 8) === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len))
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const px = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]
      const a = x >= 4 ? px[y * stride + x - 4] : 0
      const b = y > 0 ? px[(y - 1) * stride + x] : 0
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0
      let pred = 0
      if (f === 1) pred = a
      else if (f === 2) pred = b
      else if (f === 3) pred = (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[y * stride + x] = (v + pred) & 0xff
    }
  }
  return { width, height, colorType, px }
}

const icons = new Map<string, Rgba>()
const icon = (id: string): Rgba => {
  let im = icons.get(id)
  if (!im) icons.set(id, (im = decodePng(iconPath(id))))
  return im
}
const same = (a: Rgba, b: Rgba) => a.px.length === b.px.length && a.px.every((v, i) => v === b.px[i])
const chipType = (id: string): string | null => {
  const e = CONTENT.items[id].effect
  return e.kind === 'chip' ? CONTENT.moves[e.move].type : null
}

test('every item has a 32x32 RGBA icon with binary alpha and a real silhouette', () => {
  const size = cfg.process.size
  for (const it of CONTENT.itemList) {
    assert.ok(existsSync(iconPath(it.id)), `missing icon for ${it.id}`)
    const im = icon(it.id)
    assert.deepEqual([im.width, im.height], [size, size], `${it.id}: size`)
    let opaque = 0
    for (let i = 3; i < im.px.length; i += 4) {
      assert.ok(im.px[i] === 0 || im.px[i] === 255, `${it.id}: alpha ${im.px[i]}`)
      opaque += im.px[i] === 255 ? 1 : 0
    }
    assert.ok(opaque >= cfg.verify.minOpaque, `${it.id}: only ${opaque} opaque pixels`)
  }
})

test('chip items share one icon per move type; all other items have their own icon', () => {
  const items = CONTENT.itemList
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const [a, b] = [items[i].id, items[j].id]
      const [ta, tb] = [chipType(a), chipType(b)]
      const identical = same(icon(a), icon(b))
      if (ta !== null && ta === tb) assert.ok(identical, `${a} / ${b}: same chip type, different icons`)
      else assert.ok(!identical, `${a} / ${b}: identical icons`)
    }
  }
})

test('manifest lists exactly the item icons on disk', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'public/assets/manifest.json'), 'utf8')) as { items: string[] }
  const files = readdirSync(ICON_DIR).filter((f) => f.endsWith('.png') && !f.startsWith('.') && !f.startsWith('_')).map((f) => f.slice(0, -4)).sort()
  assert.deepEqual(manifest.items, files)
  for (const it of CONTENT.itemList) assert.ok(manifest.items.includes(it.id), `manifest misses ${it.id}`)
  for (const f of files) assert.ok(CONTENT.items[f], `orphan icon ${f}.png (run tools/gen_item_icons.py process --prune)`)
})

test('icon prompt data refers only to existing content', () => {
  for (const id of Object.keys(details.items)) assert.ok(CONTENT.items[id], `items_details.items: unknown item ${id}`)
  for (const id of Object.keys(details.chips)) assert.ok(CONTENT.typeById[id], `items_details.chips: unknown type ${id}`)
  for (const it of CONTENT.itemList) {
    const tpl = it.effect.kind === 'chip' ? cfg.categories[cfg.chip.category] : cfg.categories[it.category] ?? cfg.categoryFallback
    assert.ok(tpl?.includes('{detail}'), `${it.id}: icon template for category ${it.category} lacks {detail}`)
  }
})
