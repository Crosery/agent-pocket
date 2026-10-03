// Renders generated maps to PNG for visual inspection (no browser needed).
//   node sandbox/world-png.ts [outDir] [scale] [mapId...]
// Terrain colours come from TerrainDef.minimap, shaded by elevation; props are drawn darker,
// warps magenta, anchors yellow, ground items cyan, gate tiles red.
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { CONTENT } from '../src/shared/content/index.ts'
import { buildWorld, worldAnchors, worldBuildInfo } from '../src/shared/world/index.ts'
import { buildCollision, propRect } from '../src/shared/world/collision.ts'
import type { GameMap } from '../src/shared/types.ts'

// Optional crop for close-ups: CROP=x,y,w,h (tiles, overworld only).
const crop = process.env.CROP ? process.env.CROP.split(',').map(Number) : null
const outDir = process.argv[2] ?? '/tmp/ap-world'
const scale = Number(process.argv[3] ?? 3)
const only = process.argv.slice(4)

function crc32(buf: Uint8Array): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    rgb.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => { raw[y * (w * 3 + 1) + 1 + i] = v })
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const hex = (s: string): [number, number, number] => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]

function renderField(map: GameMap, color: (i: number) => [number, number, number]): Buffer {
  const W = map.width * scale, H = map.height * scale
  const rgb = new Uint8Array(W * H * 3)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = color(Math.floor(y / scale) * map.width + Math.floor(x / scale))
    const o = (y * W + x) * 3
    rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]
  }
  return png(W, H, rgb)
}

function cropMap(map: GameMap, x0: number, y0: number, w: number, h: number): GameMap {
  const sub = <T extends Uint8Array>(a: T) => {
    const out = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = a[(y0 + y) * map.width + x0 + x]
    return out
  }
  const inC = (p: { x: number; y: number }) => p.x >= x0 && p.y >= y0 && p.x < x0 + w && p.y < y0 + h
  return {
    ...map, width: w, height: h, terrain: sub(map.terrain), elevation: sub(map.elevation), region: sub(map.region),
    props: map.props.filter(inC).map((p) => ({ ...p, x: p.x - x0, y: p.y - y0 })),
    warps: map.warps.filter(inC).map((p) => ({ ...p, x: p.x - x0, y: p.y - y0 })),
    items: map.items.filter(inC).map((p) => ({ ...p, x: p.x - x0, y: p.y - y0 })),
  }
}

function render(map: GameMap, anchors: { x: number; y: number }[]): Buffer {
  const W = map.width * scale, H = map.height * scale
  const rgb = new Uint8Array(W * H * 3)
  const put = (tx: number, ty: number, c: [number, number, number], inset = 0) => {
    for (let y = ty * scale + inset; y < (ty + 1) * scale - inset; y++) for (let x = tx * scale + inset; x < (tx + 1) * scale - inset; x++) {
      const o = (y * W + x) * 3
      rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]
    }
  }
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    const i = y * map.width + x
    const t = CONTENT.terrain[map.terrain[i]]
    const [r, g, b] = hex(t?.minimap ?? '#ff00ff')
    const e = map.elevation[i]
    const f = 0.62 + e * 0.06
    const edge = (x > 0 && map.elevation[i - 1] !== e) || (y > 0 && map.elevation[i - map.width] !== e)
    const k = edge ? f * 0.7 : f
    put(x, y, [Math.min(255, r * k), Math.min(255, g * k), Math.min(255, b * k)])
  }
  for (const p of map.props) {
    const rr = propRect(p)
    const def = CONTENT.props[p.prop]
    const big = rr.w * rr.h > 2
    for (let y = rr.y; y < rr.y + rr.h; y++) for (let x = rr.x; x < rr.x + rr.w; x++) {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue
      put(x, y, big ? [120, 60, 40] : def?.collide ? [24, 48, 24] : [90, 130, 70], big || scale < 3 ? 0 : 1)
    }
  }
  for (const it of map.items) put(it.x, it.y, it.hidden ? [0, 120, 160] : [0, 230, 255])
  for (const a of anchors) put(a.x, a.y, [255, 220, 0])
  for (const w of map.warps) put(w.x, w.y, [255, 0, 255])
  return png(W, H, rgb)
}

const world = buildWorld(process.env.SEED ? Number(process.env.SEED) : undefined)
const anchors = worldAnchors(world)
mkdirSync(outDir, { recursive: true })
for (const map of Object.values(world.maps)) {
  if (only.length && !only.includes(map.id)) continue
  let own = Object.values(anchors).filter((a) => a.map === map.id)
  const file = `${outDir}/${map.id}${crop && map.kind === 'overworld' ? '-crop' : ''}.png`
  if (crop && map.kind === 'overworld') {
    const [cx, cy, cw, ch] = crop
    own = own.filter((a) => a.x >= cx && a.y >= cy && a.x < cx + cw && a.y < cy + ch).map((a) => ({ ...a, x: a.x - cx, y: a.y - cy }))
    writeFileSync(file, render(cropMap(map, cx, cy, cw, ch), own))
    console.log(file)
    continue
  }
  writeFileSync(file, render(map, own))
  console.log(file)
  if (map.kind !== 'overworld') continue
  const palette = map.regions.map((_, k) => [(k * 97) % 200 + 40, (k * 57) % 200 + 40, (k * 151) % 200 + 40] as [number, number, number])
  writeFileSync(`${outDir}/${map.id}-regions.png`, renderField(map, (i) => palette[map.region[i]]))
  let peak = 1
  for (const e of map.elevation) if (e > peak) peak = e
  writeFileSync(`${outDir}/${map.id}-elev.png`, renderField(map, (i) => {
    const t = CONTENT.terrain[map.terrain[i]]
    const v = 30 + Math.round(map.elevation[i] * 220 / peak)
    return t?.stairs ? [255, 60, 60] : t?.swim ? [40, 60, 140] : [v, v, v]
  }))
  const info = worldBuildInfo(world)
  const col = buildCollision(map)
  writeFileSync(`${outDir}/${map.id}-reach.png`, renderField(map, (i) => {
    if (col[i] === 1) return [20, 20, 20]
    if (col[i] === 2) return info.surfReach[i] ? [40, 70, 160] : [20, 30, 70]
    if (info.walkReach[i]) return CONTENT.terrain[map.terrain[i]]?.stairs ? [255, 255, 0] : [90, 170, 90]
    return info.surfReach[i] ? [80, 140, 220] : [220, 40, 40]
  }))
  console.log(map.regions.map((r, k) => `${k}:${r.id}=${palette[k].join(',')}`).join('  '))
}
