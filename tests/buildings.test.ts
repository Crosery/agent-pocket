// Contract checks for the procedural building/structure GLBs (tools/blender/buildings.py):
// spec ↔ content/props.json consistency and, per exported model, size/tri budget, footprint/height,
// facade orientation (+Z), door placement on the world's door tile, NEAREST samplers and EMIT_ glow maps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PropDef } from '../src/shared/types.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const GL_NEAREST = 9728
const GL_TRIANGLES = 4

interface VerifyLimits {
  footprintTol: number; heightTol: number; minZ: number; maxTris: number; maxBytes: number
  doorFacadeTol: number; doorCover: number
}
interface PartSpec { type: string; mat?: string; mats?: Record<string, string>; node?: string }
interface BuildingSpec { verify?: Partial<VerifyLimits>; nodes?: Record<string, unknown>; parts: PartSpec[] }
interface BuildingsSpec {
  defaults: { verify: VerifyLimits; parts: Record<string, Record<string, unknown>>; patterns: Record<string, unknown> }
  glyphs: Record<string, string[]>
  textures: Record<string, { pattern: string; size: number; colors: Record<string, unknown> }>
  materials: Record<string, { tex: string; emitTex?: string; emit?: number; uv?: string }>
  buildings: Record<string, BuildingSpec>
}
interface Gltf {
  nodes: { mesh?: number; name?: string; translation?: number[]; rotation?: number[]; scale?: number[] }[]
  accessors: { count: number; min?: number[]; max?: number[] }[]
  meshes: { primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[]
  materials?: { name?: string; emissiveFactor?: number[]; emissiveTexture?: unknown }[]
  samplers?: { magFilter?: number; minFilter?: number }[]
}

const readJson = <T>(rel: string): T => JSON.parse(readFileSync(ROOT + rel, 'utf8')) as T
const spec = readJson<BuildingsSpec>('tools/blender/buildings_spec.json')
const props = new Map(readJson<PropDef[]>('content/props.json').map((p) => [p.key, p]))
const keys = Object.keys(spec.buildings)
const EMIT_PREFIX = 'EMIT_'

function readGlb(path: string): Gltf {
  const buf = readFileSync(path)
  assert.equal(buf.readUInt32LE(0), 0x46546c67, `${path}: bad magic`)
  assert.equal(buf.readUInt32LE(4), 2, `${path}: not glTF 2`)
  const len = buf.readUInt32LE(12)
  assert.equal(buf.readUInt32LE(16), 0x4e4f534a, `${path}: first chunk must be JSON`)
  return JSON.parse(buf.subarray(20, 20 + len).toString('utf8')) as Gltf
}

type Box = { min: number[]; max: number[] }
const emptyBox = (): Box => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] })
function grow(b: Box, min: number[], max: number[], t: number[]): void {
  for (let i = 0; i < 3; i++) {
    b.min[i] = Math.min(b.min[i], min[i] + t[i])
    b.max[i] = Math.max(b.max[i], max[i] + t[i])
  }
}

test('buildings spec references only defined props, materials, textures and glyphs', () => {
  for (const key of keys) {
    assert.ok(props.has(key), `${key}: no PropDef in content/props.json`)
    const b = spec.buildings[key]
    assert.ok(b.parts.length > 0, `${key}: no parts`)
    const nodes = new Set(['', ...Object.keys(b.nodes ?? {})])
    for (const p of b.parts) {
      const mats = [...(p.mat ? [p.mat] : []), ...Object.values(p.mats ?? {})]
      assert.ok(mats.length > 0, `${key}/${p.type}: no material`)
      for (const m of mats) assert.ok(m in spec.materials, `${key}/${p.type}: unknown material ${m}`)
      assert.ok(nodes.has(p.node ?? ''), `${key}/${p.type}: undeclared node ${p.node}`)
    }
    if (props.get(key)!.door) assert.ok(b.parts.some((p) => p.type === 'door'), `${key}: PropDef door but no door part`)
  }
  for (const [id, m] of Object.entries(spec.materials)) {
    assert.ok(m.tex in spec.textures, `material ${id}: unknown texture ${m.tex}`)
    if (m.emitTex) assert.ok(m.emitTex in spec.textures, `material ${id}: unknown emitTex ${m.emitTex}`)
    assert.equal(id.startsWith(EMIT_PREFIX), (m.emit ?? 0) > 0, `material ${id}: EMIT_ prefix iff emit > 0`)
  }
  for (const [id, t] of Object.entries(spec.textures)) {
    assert.ok(t.size >= 8 && (t.size & (t.size - 1)) === 0, `texture ${id}: size must be a power of two`)
    const glyph = t.colors.glyph
    if (typeof glyph === 'string') assert.ok(glyph in spec.glyphs, `texture ${id}: unknown glyph ${glyph}`)
  }
})

for (const key of keys) {
  test(`building model ${key} matches its PropDef`, () => {
    const prop = props.get(key)!
    const limits: VerifyLimits = { ...spec.defaults.verify, ...spec.buildings[key].verify }
    const path = `${ROOT}public/assets/models/${prop.model}.glb`
    assert.ok(existsSync(path), `${path} missing — run tools/blender/buildings.py`)
    assert.ok(statSync(path).size <= limits.maxBytes, `${key}: ${statSync(path).size} bytes > ${limits.maxBytes}`)
    const g = readGlb(path)

    const box = emptyBox()
    let tris = 0
    for (const node of g.nodes) {
      if (node.mesh === undefined) continue
      assert.ok(!node.rotation && !node.scale, `${key}: node ${node.name} must carry translation only`)
      const t = node.translation ?? [0, 0, 0]
      for (const prim of g.meshes[node.mesh].primitives) {
        assert.equal(prim.mode ?? GL_TRIANGLES, GL_TRIANGLES)
        const pos = g.accessors[prim.attributes.POSITION]
        grow(box, pos.min!, pos.max!, t)
        tris += (prim.indices !== undefined ? g.accessors[prim.indices].count : pos.count) / 3
      }
    }
    assert.ok(tris <= limits.maxTris, `${key}: ${tris} tris > ${limits.maxTris}`)

    // glTF is Y-up with the facade on +Z; footprint [w, d] = (X, Z), origin at the footprint centre.
    const [w, d] = prop.footprint
    const tol = limits.footprintTol
    assert.ok(box.min[0] >= -w / 2 - tol && box.max[0] <= w / 2 + tol, `${key}: x [${box.min[0]}, ${box.max[0]}] vs width ${w}`)
    assert.ok(box.min[2] >= -d / 2 - tol && box.max[2] <= d / 2 + tol, `${key}: z [${box.min[2]}, ${box.max[2]}] vs depth ${d}`)
    assert.ok(Math.abs(box.max[1] - prop.height) <= limits.heightTol * prop.height, `${key}: height ${box.max[1]} vs ${prop.height}`)
    assert.ok(box.min[1] >= limits.minZ, `${key}: min y ${box.min[1]} < ${limits.minZ}`)

    for (const s of g.samplers ?? []) {
      assert.equal(s.magFilter, GL_NEAREST, `${key}: magFilter must be NEAREST`)
      assert.equal(s.minFilter, GL_NEAREST, `${key}: minFilter must be NEAREST`)
    }
    const materials = g.materials ?? []
    for (const m of materials) {
      assert.ok(m.name && m.name in spec.materials, `${key}: unexpected material ${m.name}`)
      if (m.name.startsWith(EMIT_PREFIX)) assert.ok(m.emissiveTexture && m.emissiveFactor, `${key}: ${m.name} lacks an emissive map`)
    }

    if (prop.door) {
      const doorPart = spec.buildings[key].parts.find((p) => p.type === 'door')!
      const doorMat = doorPart.mats?.door ?? doorPart.mat
      const matIndex = materials.findIndex((m) => m.name === doorMat)
      assert.ok(matIndex >= 0, `${key}: door material ${doorMat} not exported`)
      const doorBox = emptyBox()
      const root = g.nodes.find((n) => n.mesh !== undefined && !n.translation)!
      for (const prim of g.meshes[root.mesh!].primitives) {
        if (prim.material !== matIndex) continue
        const pos = g.accessors[prim.attributes.POSITION]
        grow(doorBox, pos.min!, pos.max!, [0, 0, 0])
      }
      assert.ok(doorBox.max[2] > 0 && Math.abs(doorBox.max[2] - d / 2) <= limits.doorFacadeTol,
        `${key}: door front z=${doorBox.max[2]} should sit on the +Z facade (${d / 2})`)
      const tileX = Math.floor(w / 2) + prop.door[0] - (w - 1) / 2
      assert.ok(doorBox.min[0] <= tileX - limits.doorCover && doorBox.max[0] >= tileX + limits.doorCover,
        `${key}: door x [${doorBox.min[0]}, ${doorBox.max[0]}] must cover door tile centre ${tileX}`)
      const [lo, hi] = prop.doorSpan ?? [0, 0]
      for (let lane = lo; lane <= hi; lane++) {
        assert.ok(doorBox.min[0] <= tileX + lane - limits.doorCover && doorBox.max[0] >= tileX + lane + limits.doorCover,
          `${key}: exported opening does not cover entry lane ${lane}`)
      }
    }
  })
}
