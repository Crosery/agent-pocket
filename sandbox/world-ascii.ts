// Prints a downsampled ASCII overview of the overworld plus town/route/feature tables (used for docs/world.md).
//   node sandbox/world-ascii.ts [tilesPerChar=16] [seed]
// One character covers tilesPerChar x tilesPerChar tiles (majority glyph of the block).
import { CONTENT } from '../src/shared/content/index.ts'
import { WORLD_CONTENT, buildWorld, worldAnchors, worldBuildInfo, worldStats } from '../src/shared/world/index.ts'

const step = Number(process.argv[2] ?? 16)
const world = buildWorld(process.argv[3] ? Number(process.argv[3]) : undefined)
const ow = world.maps[world.startMap]
const anchors = worldAnchors(world)
const info = worldBuildInfo(world)
const cols = Math.floor(ow.width / step), rows = Math.floor(ow.height / step)
const peak = WORLD_CONTENT.world.overworld.maxLevel - 3

// One glyph per biome (first unused letter of its id); water '~', town/hamlet ground '#', high ground '^'.
const glyph = new Map<string, string>()
for (const b of CONTENT.biomes) glyph.set(b.id, [...b.id].find((ch) => ![...glyph.values()].includes(ch)) ?? '?')
const out: string[][] = []
for (let r = 0; r < rows; r++) {
  const line: string[] = []
  for (let c = 0; c < cols; c++) {
    const counts = new Map<string, number>()
    let maxElev = 0
    for (let y = r * step; y < (r + 1) * step; y++) for (let x = c * step; x < (c + 1) * step; x++) {
      const i = y * ow.width + x
      const t = CONTENT.terrain[ow.terrain[i]]
      const reg = ow.regions[ow.region[i]]
      maxElev = Math.max(maxElev, ow.elevation[i])
      const g = t.swim && !t.walkable ? '~' : reg.isTown ? '#' : glyph.get(reg.biome) ?? '?'
      counts.set(g, (counts.get(g) ?? 0) + 1)
    }
    let best = '?', n = -1
    for (const [g, k] of counts) if (k > n) { best = g; n = k }
    line.push(best !== '~' && best !== '#' && maxElev >= peak ? '^' : best)
  }
  out.push(line)
}
const put = (x: number, y: number, ch: string) => { const r = Math.floor(y / step), c = Math.floor(x / step); if (out[r]?.[c] !== undefined) out[r][c] = ch }
const f = info.features
for (const p of f.pois) if (p.landmark) put(p.x, p.y, '*')
for (const d of f.dungeons) if (d.mouth) put(d.mouth.x, d.mouth.y, 'D')
for (const h of f.hamlets) put(h.x, h.y, 'H')
const story = world.towns.filter((t) => (t.kind ?? 'town') === 'town')
story.forEach((t, k) => put(t.x, t.y, String(k)))
console.log(out.map((l) => l.join('')).join('\n'))
console.log(`\nlegend (1 char = ${step}x${step} tiles): ` + [...glyph].map(([b, g]) => `${g}=${b}`).join(' ') +
  ` ~=water #=town ground ^=elevation>=${peak} 0-9=story town H=hamlet D=dungeon mouth *=landmark POI`)

console.log('\n| # | town | id | region | square (x,y) | levels | gym |')
console.log('|---|---|---|---|---|---|---|')
story.forEach((t, k) => {
  const spec = WORLD_CONTENT.towns.find((s) => s.id === t.id)!
  console.log(`| ${k} | ${t.nameZh} | ${t.id} | ${spec.region} | ${t.x},${t.y} | ${t.levelRange?.join('-') ?? '-'} | ${spec.gym ? `${spec.gym.type} (${spec.gym.badge})` : '-'} |`)
})
console.log('\n| route | name | from → to | levels | trainer spots | gate |')
console.log('|---|---|---|---|---|---|')
for (const r of WORLD_CONTENT.routes) {
  const n = Object.keys(anchors).filter((k) => k.startsWith(`route:${r.id}:`)).length
  const gate = r.gate ? `gate:${r.gate.name} (${anchors[`gate:${r.gate.name}`]?.x},${anchors[`gate:${r.gate.name}`]?.y})` : '-'
  console.log(`| ${r.id} | ${r.nameZh} | ${r.from} → ${r.to} | ${r.levelRange.join('-')} | ${n} | ${gate} |`)
}
console.log('\n| region | name | levels |')
console.log('|---|---|---|')
for (const r of WORLD_CONTENT.regions) console.log(`| ${r.id} | ${r.nameZh} | ${r.levelRange.join('-')} |`)
for (const c of WORLD_CONTENT.caves.caves) {
  const m = (e: string) => anchors[`${c.id}:mouth-${e}`]
  console.log(`cave ${c.id} ${c.nameZh} lv${c.levelRange.join('-')} mouths ${c.ends.map((e) => `${e.region}@${m(e.id)?.x},${m(e.id)?.y}`).join(' / ')}`)
}
console.log('\n| hamlet | name | centre | levels | doors | services |')
console.log('|---|---|---|---|---|---|')
for (const h of f.hamlets) {
  const t = world.towns.find((x) => x.id === h.id)
  console.log(`| ${h.id} | ${h.nameZh} | ${h.x},${h.y} | ${t?.levelRange?.join('-') ?? '-'} | ${h.doors.length} | ${h.services ? 'yes' : '-'} |`)
}
console.log('\n| dungeon | name | style | floors | mouth | levels (B1F) |')
console.log('|---|---|---|---|---|---|')
for (const d of f.dungeons) {
  const lv = world.maps[d.floors[0]].regions[0].levelRange
  console.log(`| ${d.id} | ${d.nameZh} | ${d.style} | ${d.floors.length} | ${d.mouth?.x},${d.mouth?.y} | ${lv?.join('-')} |`)
}
const byTpl = new Map<string, number>()
for (const p of f.pois) byTpl.set(p.template, (byTpl.get(p.template) ?? 0) + 1)
console.log('\nPOIs: ' + [...byTpl].map(([k, n]) => `${k} ${n}`).join(', '))
const tiers = new Map<number, number>()
for (const w of f.wilds) tiers.set(w.danger, (tiers.get(w.danger) ?? 0) + 1)
console.log(`wild regions: ${f.wilds.length} (danger ${[...tiers].sort((a, b) => a[0] - b[0]).map(([d, n]) => `${d}:${n}`).join(' ')}), rivers ${f.rivers}, lakes ${f.lakes}, islands ${f.islands.length}`)
console.log(JSON.stringify(worldStats(world)), `anchors ${Object.keys(anchors).length}`)
