// Asset pipeline contract: prompt/pipeline data shape, job list in sync with content, manifest in sync with
// disk, and every processed asset matching its spec (size, alpha, sheet layout). Missing optional assets are
// reported as diagnostics only (the client has procedural fallbacks).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative } from 'node:path'
import { inflateSync } from 'node:zlib'
import { CONTENT } from '../src/shared/content/index.ts'
import pipelineJson from '../assets_src/pipeline.json' with { type: 'json' }
import templatesJson from '../assets_src/prompts/templates.json' with { type: 'json' }
import jobsJson from '../assets_src/prompts/jobs.json' with { type: 'json' }

interface SourceSpec { file: string; id: string; path?: string; where?: Record<string, unknown>; exclude?: string[]; fields?: Record<string, string>; groupCount?: Record<string, string> }
interface LookupSpec { key: string; values: Record<string, string>; default?: string }
interface KindSpec { source?: SourceSpec; static?: { id: string }[]; lookups?: Record<string, LookupSpec>; variant: string; quality: string; prompt: string; process: string; out: string }
interface Job { id: string; kind: string; prompt: string; variant: string; quality: string; process: string; out: string; images?: string[] }
interface ManifestSpec { dir: string; ext: string[]; recursive?: boolean }

const ROOT = new URL('..', import.meta.url).pathname
const pipeline = pipelineJson as unknown as {
  sheet: { bottomMargin: number }
  portrait: { out: number }
  texture: { size: number; sizes: Record<string, number> }
  tuft: { size: number }
  icon: { size: number }
  backdrop: { width: number; height: number }
  creature: { topMargin: number; bottomMargin: number; sideMargin: number; palette: number }
  manifest: Record<string, ManifestSpec>
}
const templates = templatesJson as unknown as { kinds: Record<string, KindSpec> }
const jobs = jobsJson as unknown as Job[]
const MANIFEST_KINDS = ['creatures', 'characters', 'portraits', 'textures', 'models', 'items', 'bgm', 'ui']

interface Png { width: number; height: number; colorType: number; rgba?: Uint8Array }

function readPng(path: string, decode = false): Png {
  const buf = readFileSync(path)
  assert.equal(buf.toString('latin1', 1, 4), 'PNG', `${path} is not a PNG`)
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const depth = buf[24]
  const colorType = buf[25]
  if (!decode) return { width, height, colorType }
  assert.equal(depth, 8, `${path}: bit depth ${depth}`)
  assert.ok(colorType === 6 || colorType === 2, `${path}: colour type ${colorType}`)
  assert.equal(buf[28], 0, `${path}: interlaced`)
  const idat: Buffer[] = []
  for (let off = 8; off < buf.length;) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len))
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const px = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]
      const a = x >= bpp ? px[y * stride + x - bpp] : 0
      const b = y > 0 ? px[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0
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
  if (bpp === 4) return { width, height, colorType, rgba: px }
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgba.set(px.subarray(i * 3, i * 3 + 3), i * 4)
    rgba[i * 4 + 3] = 255
  }
  return { width, height, colorType, rgba }
}

function expectedIds(spec: KindSpec): string[] {
  if (spec.static) return spec.static.map((r) => r.id)
  const src = spec.source!
  let data: unknown = JSON.parse(readFileSync(join(ROOT, src.file), 'utf8'))
  for (const part of src.path ? src.path.split('.') : []) data = (data as Record<string, unknown>)[part]
  const out: string[] = []
  for (const rec of data as Record<string, unknown>[]) {
    if (Object.entries(src.where ?? {}).some(([k, v]) => rec[k] !== v)) continue
    const id = rec[src.id]
    if (typeof id !== 'string' || !id || (src.exclude ?? []).includes(id) || out.includes(id)) continue
    out.push(id)
  }
  return out
}

function scan(spec: ManifestSpec): string[] {
  const base = join(ROOT, 'public/assets', spec.dir)
  if (!existsSync(base)) return []
  const ids: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        if (spec.recursive) walk(p)
        continue
      }
      const ext = extname(name).toLowerCase()
      if (!spec.ext.includes(ext) || name.startsWith('.') || name.startsWith('_') || name.endsWith(`.part${ext}`)) continue
      ids.push(relative(base, p).slice(0, -ext.length).split('\\').join('/'))
    }
  }
  walk(base)
  return ids.sort()
}

test('prompt templates and pipeline config are well-formed', () => {
  const processes = new Set(['sheet', 'portrait', 'texture', 'tuft', 'icon', 'backdrop', 'keyart', 'logo', 'creature'])
  for (const [kind, spec] of Object.entries(templates.kinds)) {
    assert.ok(spec.source || spec.static, `${kind}: needs source or static`)
    assert.ok(['square', 'landscape', 'portrait'].includes(spec.variant), `${kind}: variant ${spec.variant}`)
    assert.ok(['low', 'medium', 'high', 'auto'].includes(spec.quality), `${kind}: quality ${spec.quality}`)
    assert.ok(processes.has(spec.process), `${kind}: unknown process ${spec.process}`)
    assert.ok(spec.out.startsWith('public/assets/') && spec.out.includes('{id}'), `${kind}: out ${spec.out}`)
    if (spec.source) assert.ok(existsSync(join(ROOT, spec.source.file)), `${kind}: missing ${spec.source.file}`)
  }
  assert.deepEqual(Object.keys(pipeline.manifest).sort(), [...MANIFEST_KINDS].sort())
})

test('job list is in sync with content (run tools/build_jobs.py when this fails)', () => {
  for (const [kind, spec] of Object.entries(templates.kinds)) {
    const got = jobs.filter((j) => j.kind === kind).map((j) => j.id)
    assert.deepEqual(got, expectedIds(spec), `jobs for ${kind}`)
  }
  for (const j of jobs) {
    assert.ok(!/\{[a-zA-Z0-9_.]+\}/.test(j.prompt), `${j.kind}/${j.id}: unresolved placeholder`)
    assert.ok(!j.out.includes('{'), `${j.kind}/${j.id}: unresolved out path`)
  }
  // job ids come straight from content, e.g. every character sheet / portrait flag
  assert.deepEqual(jobs.filter((j) => j.kind === 'character').map((j) => j.id), CONTENT.characters.map((c) => c.id))
})

test('manifest.json matches the files on disk (run tools/build_manifest.py when this fails)', () => {
  const path = join(ROOT, 'public/assets/manifest.json')
  assert.ok(existsSync(path), 'manifest missing')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string[]>
  for (const [kind, spec] of Object.entries(pipeline.manifest)) assert.deepEqual(manifest[kind], scan(spec), `manifest.${kind}`)
})

/** Spec of one creature sprite: square creatureSize RGBA, binary alpha, feet on the bottom margin, inside the
 *  side/top margins, at most `creature.palette` colours. Returns the violations. */
function creatureProblems(png: Png): string[] {
  const s = CONTENT.config.sprites.creatureSize
  const c = pipeline.creature
  const out: string[] = []
  if (png.width !== s || png.height !== s) return [`size ${png.width}x${png.height}, expected ${s}x${s}`]
  if (png.colorType !== 6) out.push('not RGBA')
  const rgba = png.rgba!
  const colours = new Set<number>()
  let x0 = s, x1 = -1, y0 = s, y1 = -1
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4
      const a = rgba[i + 3]
      if (a !== 0 && a !== 255) out.push(`non-binary alpha at ${x},${y}`)
      if (a !== 255) continue
      colours.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2])
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
  }
  if (y1 < 0) return [...out, 'empty sprite']
  if (y1 !== s - 1 - c.bottomMargin) out.push(`feet on row ${y1}, expected ${s - 1 - c.bottomMargin}`)
  if (y0 < c.topMargin || x0 < c.sideMargin || x1 > s - 1 - c.sideMargin) out.push(`bbox ${x0},${y0}-${x1},${y1} outside the margins`)
  if (colours.size > c.palette) out.push(`${colours.size} colours > ${c.palette}`)
  return out.slice(0, 5)
}

test('creature prompts: every (stage, family size) in the roster has its own stage hint', () => {
  const spec = templates.kinds.creature
  const hint: LookupSpec | undefined = spec?.lookups?.stageHint
  assert.ok(spec?.source && hint, 'creature kind with a stageHint lookup')
  const roster = JSON.parse(readFileSync(join(ROOT, spec.source.file), 'utf8')) as { id: string; family: string; stage: number; design: string }[]
  const family = new Map<string, number>()
  for (const r of roster) family.set(r.family, (family.get(r.family) ?? 0) + 1)
  for (const r of roster) {
    assert.ok(r.design, `${r.id}: design missing`)
    const key: string = hint.key.replace('{stage}', String(r.stage)).replace('{familySize}', String(family.get(r.family)))
    assert.ok(hint.values[key], `${r.id}: no stage hint for ${key}`)
  }
  for (const j of jobs.filter((x) => x.kind === 'creature')) {
    const design = roster.find((r) => r.id === j.id)!.design
    assert.ok(j.prompt.includes(design), `${j.id}: prompt must embed its design`)
    assert.equal(j.out, `public/assets/creatures/${j.id}.png`)
    // reference images: the style anchor always, plus the family identity sheet when one exists
    // (refs are private and absent from other checkouts; there only check jobs.json names a subset, in order)
    const fam = roster.find((r) => r.id === j.id)!.family
    const cand = ['assets_src/refs/creature/_style.png', `assets_src/refs/creature/${fam}.png`]
    const want = existsSync(join(ROOT, 'assets_src/refs')) ? cand.filter((p) => existsSync(join(ROOT, p))) : cand.filter((p) => (j.images ?? []).includes(p))
    assert.deepEqual(j.images, want, `${j.id}: reference images`)
    assert.ok(j.prompt.startsWith('REFERENCE IMAGES: Image 1 '), `${j.id}: prompt must explain its reference images`)
  }
})

let python = true
try { execFileSync('python3', ['--version'], { stdio: 'ignore' }) } catch { python = false }
test('process_creature.py turns the reference render into a spec sprite', { skip: !python && 'python3 unavailable' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'creature-'))
  try {
    const out = join(dir, 'ref.png')
    const rep = JSON.parse(execFileSync('python3', [join(ROOT, 'tools/process_creature.py'), join(ROOT, 'assets_src/creature_reference.png'), out], { encoding: 'utf8' })) as { keyLikePixels: number; sprite: [number, number] }
    assert.deepEqual(creatureProblems(readPng(out, true)), [])
    assert.equal(rep.keyLikePixels, 0, 'magenta fringe left on the sprite')
    const inner = CONTENT.config.sprites.creatureSize - pipeline.creature.topMargin - pipeline.creature.bottomMargin
    assert.ok(Math.max(...rep.sprite) >= inner * 0.6, `sprite ${rep.sprite} too small`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('processed assets match their specs', (t) => {
  const { sheetCell, sheetFrames, sheetRows } = CONTENT.config.sprites
  const rows = Object.keys(sheetRows).length
  let present = 0
  const missing: string[] = []
  for (const j of jobs) {
    const path = join(ROOT, j.out)
    if (!existsSync(path)) {
      missing.push(`${j.kind}/${j.id}`)
      continue
    }
    present++
    const sprite = ['sheet', 'portrait', 'tuft', 'icon', 'logo', 'creature'].includes(j.process)
    const png = readPng(path, j.process === 'sheet' || j.process === 'tuft' || j.process === 'creature')
    const tag = `${j.kind}/${j.id}`
    if (sprite) assert.equal(png.colorType, 6, `${tag}: must be RGBA`)
    if (j.process === 'sheet') {
      assert.deepEqual([png.width, png.height], [sheetCell * sheetFrames, sheetCell * rows], `${tag}: sheet size`)
      const rgba = png.rgba!
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < sheetFrames; c++) {
          let lowest = -1
          for (let y = 0; y < sheetCell; y++) {
            for (let x = 0; x < sheetCell; x++) {
              const a = rgba[(((r * sheetCell + y) * png.width) + c * sheetCell + x) * 4 + 3]
              assert.ok(a === 0 || a === 255, `${tag}: non-binary alpha`)
              if (a) lowest = y
            }
          }
          assert.equal(lowest, sheetCell - 1 - pipeline.sheet.bottomMargin, `${tag}: r${r}c${c} feet not on the cell baseline`)
        }
      }
    } else if (j.process === 'portrait') {
      assert.deepEqual([png.width, png.height], [pipeline.portrait.out, pipeline.portrait.out], `${tag}: portrait size`)
    } else if (j.process === 'texture') {
      const s = pipeline.texture.sizes[j.id] ?? pipeline.texture.size
      assert.deepEqual([png.width, png.height], [s, s], `${tag}: texture size`)
    } else if (j.process === 'tuft') {
      assert.deepEqual([png.width, png.height], [pipeline.tuft.size, pipeline.tuft.size], `${tag}: tuft size`)
      const rgba = png.rgba!
      let bottom = false
      for (let x = 0; x < png.width; x++) bottom ||= rgba[((png.height - 1) * png.width + x) * 4 + 3] === 255
      assert.ok(bottom, `${tag}: tuft must stand on the bottom row`)
    } else if (j.process === 'icon') {
      assert.deepEqual([png.width, png.height], [pipeline.icon.size, pipeline.icon.size], `${tag}: icon size`)
    } else if (j.process === 'creature') {
      assert.deepEqual(creatureProblems(png), [], `${tag}: creature sprite spec`)
    } else if (j.process === 'backdrop') {
      assert.deepEqual([png.width, png.height], [pipeline.backdrop.width, pipeline.backdrop.height], `${tag}: backdrop size`)
    } else if (j.process === 'keyart') {
      const raw = join(ROOT, 'assets_src', 'raw', j.kind, `${j.id}.png`)
      if (existsSync(raw)) {
        const src = readPng(raw)
        assert.deepEqual([png.width, png.height], [src.width, src.height], `${tag}: key art keeps its source size`)
      }
    }
  }
  // large rosters (creatures) are summarised as a count instead of listing every id
  const byKind = new Map<string, string[]>()
  for (const m of missing) byKind.set(m.split('/')[0], [...(byKind.get(m.split('/')[0]) ?? []), m])
  const list = [...byKind].map(([k, ids]) => (ids.length > 12 ? `${k}: ${ids.length} missing` : ids.join(', ')))
  t.diagnostic(`${present}/${jobs.length} pipeline assets present${missing.length ? `; missing: ${list.join(', ')}` : ''}`)
})
