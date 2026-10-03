// Renders story NPC placement to PNG for visual inspection (no browser needed).
//   node sandbox/story-png.ts [outDir] [scale] [mapId...]      CROP=x,y,w,h for overworld close-ups
// Terrain from TerrainDef.minimap (blocked tiles darkened); NPC dots by role — trainers red with their sight
// line, gym leaders/champion orange, services green, quest givers yellow, villagers blue, conditional NPCs
// (hiddenIf/hiddenUnless) purple. Prints a per-map NPC summary.
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { CONTENT } from '../src/shared/content/index.ts'
import type { GameMap, NpcDef } from '../src/shared/types.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { DIR_DX, DIR_DY, buildCollision } from '../src/shared/world/collision.ts'
import { storyProblems } from '../src/shared/world/story.ts'

const outDir = process.argv[2] ?? '/tmp/ap-story'
const scale = Number(process.argv[3] ?? 4)
const only = process.argv.slice(4)
const crop = process.env.CROP ? process.env.CROP.split(',').map(Number) : null

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
  for (let y = 0; y < h; y++) Buffer.from(rgb.subarray(y * w * 3, (y + 1) * w * 3)).copy(raw, y * (w * 3 + 1) + 1)
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

function npcColor(n: NpcDef): [number, number, number] {
  if (n.hiddenIfFlag || n.hiddenUnlessFlag) return [170, 60, 220]
  switch (n.role) {
    case 'gymLeader': case 'champion': case 'rival': return [255, 140, 0]
    case 'trainer': return [230, 30, 30]
    case 'nurse': case 'clerk': case 'boxTerminal': case 'tutor': return [30, 200, 60]
    case 'questGiver': return [250, 220, 0]
    default: return [40, 110, 255]
  }
}

function render(map: GameMap, x0: number, y0: number, w: number, h: number): Buffer {
  const col = buildCollision(map)
  const W = w * scale, H = h * scale
  const rgb = new Uint8Array(W * H * 3)
  const paint = (tx: number, ty: number, c: [number, number, number], inset = 0) => {
    if (tx < x0 || ty < y0 || tx >= x0 + w || ty >= y0 + h) return
    for (let y = inset; y < scale - inset; y++) for (let x = inset; x < scale - inset; x++) {
      const o = (((ty - y0) * scale + y) * W + (tx - x0) * scale + x) * 3
      rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]
    }
  }
  for (let ty = y0; ty < y0 + h; ty++) for (let tx = x0; tx < x0 + w; tx++) {
    const i = ty * map.width + tx
    const base = hex(CONTENT.terrain[map.terrain[i]]?.minimap ?? '#000000')
    const k = col[i] === 1 ? 0.45 : 1
    paint(tx, ty, [base[0] * k, base[1] * k, base[2] * k])
  }
  for (const wp of map.warps) paint(wp.x, wp.y, [255, 0, 255])
  for (const n of map.npcs) {
    if (n.sightRange) for (let k = 1; k <= n.sightRange; k++) paint(n.x + DIR_DX[n.facing] * k, n.y + DIR_DY[n.facing] * k, [255, 170, 170], Math.max(1, scale >> 2))
    paint(n.x, n.y, npcColor(n))
  }
  return png(W, H, rgb)
}

const world = buildWorld()
mkdirSync(outDir, { recursive: true })
for (const m of Object.values(world.maps)) {
  if (only.length && !only.includes(m.id)) continue
  if (!only.length && m.npcs.length === 0) continue
  const [x0, y0, w, h] = m.id === world.startMap && crop ? crop : [0, 0, m.width, m.height]
  writeFileSync(`${outDir}/${m.id}.png`, render(m, x0, y0, w, h))
  const roles = new Map<string, number>()
  for (const n of m.npcs) roles.set(n.role, (roles.get(n.role) ?? 0) + 1)
  console.log(`${m.id.padEnd(22)} ${String(m.npcs.length).padStart(3)}  ${[...roles].map(([r, c]) => `${r}:${c}`).join(' ')}`)
}
const problems = storyProblems(world)
console.log(`trainers ${Object.keys(world.trainers).length}, quests ${world.quests.length}, problems ${problems.length}`)
for (const p of problems) console.log('  ' + p)
