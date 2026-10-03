import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PropDef } from '../src/shared/types.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

interface NatureSpec {
  propsFile: string
  modelsDir: string
  export: { magFilter: number; minFilter: number }
  defaults: { emissivePrefix: string; foliageMaterial: string; maxTris: number; maxBytes: number; heightTolerance: number; fit: unknown; margin: number }
  textures: Record<string, { gen: string; tiles?: string[] }>
  materials: Record<string, { tex: string; emit?: number; emitTex?: string }>
  props: Record<string, { budget?: number; fit?: unknown; margin?: number; materials: Record<string, string>; parts: { shape: string; mat: string; tile?: number }[] }>
}

interface Gltf {
  accessors: { count: number; min?: number[]; max?: number[] }[]
  meshes: { primitives: { attributes: Record<string, number>; indices?: number; material?: number }[] }[]
  materials?: { name?: string; emissiveFactor?: number[]; emissiveTexture?: unknown; doubleSided?: boolean }[]
  samplers?: { magFilter?: number; minFilter?: number }[]
  images?: { mimeType?: string }[]
}

const readJson = <T>(rel: string): T => JSON.parse(readFileSync(ROOT + rel, 'utf8')) as T
const spec = readJson<NatureSpec>('tools/blender/nature_spec.json')
const props = new Map(readJson<PropDef[]>(spec.propsFile).map((p) => [p.key, p]))
const keys = Object.keys(spec.props)

function readGlb(path: string): Gltf {
  const buf = readFileSync(path)
  assert.equal(buf.readUInt32LE(0), 0x46546c67, `${path}: bad magic`)
  assert.equal(buf.readUInt32LE(4), 2, `${path}: not glTF 2`)
  const len = buf.readUInt32LE(12)
  assert.equal(buf.readUInt32LE(16), 0x4e4f534a, `${path}: first chunk must be JSON`)
  return JSON.parse(buf.subarray(20, 20 + len).toString('utf8')) as Gltf
}

test('nature spec references resolve and keys are modelled props', () => {
  for (const key of keys) {
    const def = props.get(key)
    assert.ok(def, `${key} is not in ${spec.propsFile}`)
    assert.ok(!def.billboard, `${key} is a billboard prop and must not be modelled`)
    const p = spec.props[key]
    for (const [name, mkey] of Object.entries(p.materials)) {
      const m = spec.materials[mkey]
      assert.ok(m, `${key}: material ${mkey} missing`)
      assert.equal((m.emit ?? 0) > 0, name.startsWith(spec.defaults.emissivePrefix), `${key}: ${name} emissive/prefix mismatch`)
      for (const t of [m.tex, m.emitTex].filter((x): x is string => !!x)) assert.ok(spec.textures[t], `${mkey}: texture ${t} missing`)
    }
    for (const part of p.parts) {
      assert.ok(part.mat in p.materials, `${key}: part material ${part.mat} not declared`)
      const tex = spec.textures[spec.materials[p.materials[part.mat]].tex]
      const tiles = tex.gen === 'atlas' ? tex.tiles!.length : 1
      assert.ok((part.tile ?? 0) < tiles, `${key}: tile ${part.tile} out of range`)
    }
  }
  for (const [tkey, t] of Object.entries(spec.textures)) {
    if (t.gen === 'atlas') for (const tile of t.tiles ?? []) assert.ok(spec.textures[tile], `${tkey}: atlas tile ${tile} missing`)
  }
})

test('nature GLBs match PropDef size, budgets and material conventions', () => {
  const d = spec.defaults
  for (const key of keys) {
    const path = `${ROOT}${spec.modelsDir}/${key}.glb`
    assert.ok(existsSync(path), `${key}: ${path} missing — run tools/blender/nature.py`)
    assert.ok(statSync(path).size <= d.maxBytes, `${key}: ${statSync(path).size} bytes > ${d.maxBytes}`)
    const g = readGlb(path)
    const def = props.get(key)!
    let tris = 0
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (const mesh of g.meshes) {
      for (const prim of mesh.primitives) {
        const pos = g.accessors[prim.attributes.POSITION]
        tris += (prim.indices !== undefined ? g.accessors[prim.indices].count : pos.count) / 3
        for (let i = 0; i < 3; i++) {
          lo[i] = Math.min(lo[i], pos.min![i])
          hi[i] = Math.max(hi[i], pos.max![i])
        }
        assert.ok(prim.attributes.TEXCOORD_0 !== undefined, `${key}: primitive without UVs`)
      }
    }
    const budget = spec.props[key].budget ?? d.maxTris
    assert.ok(tris <= budget, `${key}: ${tris} tris > ${budget}`)
    // glTF is Y-up: height along Y, ground at y = 0, footprint along X (width) and Z (depth)
    assert.ok(Math.abs(hi[1] - lo[1] - def.height) <= d.heightTolerance * Math.max(def.height, 1), `${key}: height ${hi[1] - lo[1]} vs ${def.height}`)
    assert.ok(Math.abs(lo[1]) < 1e-3, `${key}: not grounded (${lo[1]})`)
    const fit = spec.props[key].fit ?? d.fit
    if (fit === 'box') {
      assert.ok(hi[0] - lo[0] <= def.footprint[0] + 1e-3, `${key}: wider than footprint`)
      assert.ok(hi[2] - lo[2] <= def.footprint[1] + 1e-3, `${key}: deeper than footprint`)
      assert.ok(Math.abs(hi[0] + lo[0]) < 1e-2 && Math.abs(hi[2] + lo[2]) < 1e-2, `${key}: not centred on footprint`)
    }
    for (const s of g.samplers ?? []) {
      assert.deepEqual([s.magFilter, s.minFilter], [spec.export.magFilter, spec.export.minFilter], `${key}: sampler filters`)
    }
    assert.ok((g.images ?? []).every((im) => im.mimeType === 'image/png'), `${key}: images must be embedded PNG`)
    const mats = g.materials ?? []
    const names = mats.map((m) => m.name ?? '')
    for (const m of mats) {
      const emissive = (m.emissiveFactor ?? [0, 0, 0]).some((v) => v > 0)
      assert.equal(emissive, (m.name ?? '').startsWith(d.emissivePrefix), `${key}: ${m.name} emissive/prefix mismatch`)
    }
    if (def.light) assert.ok(names.some((n) => n.startsWith(d.emissivePrefix)), `${key}: light prop without ${d.emissivePrefix} material`)
    if (def.sway) assert.ok(names.includes(d.foliageMaterial), `${key}: sway prop without ${d.foliageMaterial} material`)
  }
})
