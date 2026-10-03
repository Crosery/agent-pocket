// Ground decor: non-colliding detail scattered per terrain key (grass sprigs, pebbles, tiny flowers, fallen leaves,
// mushrooms, shells, dry twigs and bones, snow mounds, embers, puddles), distributed by noise and climate fields and
// streamed per chunk as instanced meshes (one per kind x shape variant). Kinds and rules: render.json "decor".
import * as THREE from 'three'
import { CONTENT } from '../../../shared/content/index.ts'
import type { GameMap } from '../../../shared/types.ts'
import { RENDER, hexToRgb, type DecorKind, type DecorRule, type Vec3 } from '../config.ts'
import { createNoise, mulberry32, range, seedOf, smoothstep, type Noise } from '../noise.ts'
import { configurePixelTexture, createCanvas } from '../sprite-utils.ts'
import { fieldNoise, type ClimateGrid, type ClimateSample } from './climate.ts'
import { hash2 } from './coords.ts'
import { addBlob, addShard, addTube, GeoBuf } from './nature.ts'
import { patternTexture } from './patterns.ts'
import { TERRAIN_KIND, terrainTint, type TerrainSampler } from './terrain.ts'
import { applyWind } from './wind.ts'

export interface DecorLayer {
  /** Binds a map (rule noise seed). */
  setMap(map: GameMap): void
  /**
   * Instances of one chunk. `blocked(tx, ty)` = tile covered by a prop footprint; `density` = quality multiplier;
   * `avg(key)` = sRGB average colour of a terrain texture (for "$terrain" colours).
   */
  build(sampler: TerrainSampler, cx: number, cy: number, size: number, climate: ClimateGrid | null, blocked: (tx: number, ty: number) => boolean,
    density: number, avg: (key: string) => Vec3): THREE.InstancedMesh[]
  disposeChunk(meshes: THREE.InstancedMesh[]): void
  dispose(): void
}

// ---------------------------------------------------------------------------
// Unit shapes (origin on the ground, ~1 unit across; scaled by DecorKind.size). Attributes: position, normal, uv,
// color (fixed shade) and aTint (1 = multiplied by the instance colour, 0 = keeps its own colour, e.g. stems).
// ---------------------------------------------------------------------------

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

function cardTexture(kind: string): THREE.Texture {
  const s = 16
  const c = createCanvas(s, s)
  const g = c.getContext('2d')!
  const img = g.createImageData(s, s)
  const rnd = mulberry32(seedOf(kind))
  const put = (x: number, y: number, v: number, r = v, b = v) => {
    if (x < 0 || y < 0 || x >= s || y >= s) return
    const i = (Math.floor(y) * s + Math.floor(x)) * 4
    img.data[i] = r * 255; img.data[i + 1] = v * 255; img.data[i + 2] = b * 255; img.data[i + 3] = 255
  }
  if (kind === 'sprig') {
    for (let k = 0; k < 6; k++) {
      const x0 = 2 + rnd() * 12, h = 7 + rnd() * 8, lean = (rnd() - 0.5) * 6
      for (let j = 0; j < h; j++) { const t = j / h; put(x0 + lean * t * t, s - 1 - j, 0.55 + 0.5 * t) }
    }
  } else if (kind === 'leaf') {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const u = (x - 7.5) / 7.5, v = (y - 7.5) / 4.6
      const r = u * u + v * v
      if (r < 1) put(x, y, Math.abs(y - 7.5) < 0.6 ? 0.7 : 0.82 + 0.18 * (1 - r))
    }
  } else if (kind === 'blossom') {
    const cx = 7.5, cy = 7.5
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const dx = x - cx, dy = y - cy, a = Math.atan2(dy, dx), r = Math.hypot(dx, dy)
      const petal = 4.2 + 2.6 * Math.cos(a * 5)
      if (r < 2) put(x, y, 0.95, 1.0, 0.35)
      else if (r < petal) put(x, y, 0.88 + 0.12 * (1 - r / 7))
    }
  } else if (kind === 'shell') {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const dx = x - 7.5, dy = 15 - y, a = Math.atan2(dx, dy), r = Math.hypot(dx, dy)
      if (r < 13 && Math.abs(a) < 1.1) put(x, y, Math.floor((a + 1.1) * 4) % 2 ? 0.78 : 1)
    }
  }
  g.putImageData(img, 0, 0)
  return configurePixelTexture(new THREE.CanvasTexture(c))
}

function finish(b: GeoBuf, flat: boolean, tintOf: (v: number) => number): THREE.BufferGeometry {
  const g = b.toGeometry(flat, true, 1 / RENDER.props.patternUnits)
  // toGeometry de-indexes: rebuild aTint per emitted vertex from its source index order
  const t = new Float32Array(g.getAttribute('position').count)
  for (let k = 0; k < b.i.length; k++) t[k] = tintOf(b.i[k])
  g.setAttribute('aTint', new THREE.BufferAttribute(t, 1))
  return g
}

function cardsGeometry(planes: number, w: number, h: number, flatCards: number, seed: number): THREE.BufferGeometry {
  const rnd = mulberry32(seed)
  const pos: number[] = [], uv: number[] = [], nrm: number[] = [], col: number[] = [], idx: number[] = []
  const quad = (pts: Vec3[], shade: number[]) => {
    const base = pos.length / 3
    const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]]
    pts.forEach((p, i) => { pos.push(...p); uv.push(...uvs[i]); nrm.push(0, 1, 0); col.push(shade[i], shade[i], shade[i]) })
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  for (let i = 0; i < planes; i++) {
    const a = (i / planes) * Math.PI + rnd() * 0.4
    const dx = Math.cos(a) * w / 2, dz = Math.sin(a) * w / 2
    quad([[-dx, 0, -dz], [dx, 0, dz], [dx, h, dz], [-dx, h, -dz]], [0.8, 0.8, 1, 1])
  }
  for (let i = 0; i < flatCards; i++) {
    // lying quads (leaves / blossoms): random spot, angle and tiny height step
    const a = rnd() * Math.PI, r = 0.12 + rnd() * 0.3, ox = (rnd() - 0.5) * 0.7, oz = (rnd() - 0.5) * 0.7, y = 0.01 + i * 0.012 + h
    const c = Math.cos(a) * r, s = Math.sin(a) * r
    quad([[ox - c + s, y, oz - s - c], [ox + c + s, y, oz + s - c], [ox + c - s, y, oz + s + c], [ox - c - s, y, oz - s + c]], [1, 1, 1, 1])
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setAttribute('aTint', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill(1), 1))
  g.setIndex(idx)
  g.computeBoundingSphere()
  return g
}

function shapeGeometry(kind: DecorKind, variant: number, seed: number): THREE.BufferGeometry {
  const rnd = mulberry32(seed + variant * 7919)
  const noise: Noise = createNoise(seed ^ (variant * 31337))
  const b = new GeoBuf()
  const W: Vec3 = [1, 1, 1]
  switch (kind.shape) {
    case 'sprig': return cardsGeometry(3, 0.9, 1, 0, seed + variant)
    case 'leaf': return cardsGeometry(0, 0, 0, 3 + Math.floor(rnd() * 3), seed + variant)
    case 'blossom': return cardsGeometry(0, 0, 0, 3 + Math.floor(rnd() * 3), seed + variant)
    case 'shell': return cardsGeometry(0, 0, 0, 1 + Math.floor(rnd() * 2), seed + variant)
    case 'pebble': {
      const n = 1 + Math.floor(rnd() * 3)
      for (let i = 0; i < n; i++) {
        const r = (i === 0 ? 0.32 : 0.16 + rnd() * 0.12)
        const a = rnd() * Math.PI * 2, d = i === 0 ? 0 : 0.3 + rnd() * 0.15
        addBlob(b, [Math.cos(a) * d, r * 0.25, Math.sin(a) * d], [r, r * (0.5 + rnd() * 0.3), r * (0.8 + rnd() * 0.3)], { detail: 0, noise, amp: 0.3, freq: 1.7, offset: rnd() * 9, color: [0.85 + rnd() * 0.3, 0.85 + rnd() * 0.3, 0.85 + rnd() * 0.3], floor: 0 })
      }
      return finish(b, true, () => 1)
    }
    case 'mound': {
      addBlob(b, [0, 0, 0], [0.5, 0.32 + rnd() * 0.15, 0.45], { detail: 1, noise, amp: 0.25, freq: 1.5, offset: rnd() * 9, color: W, dome: true })
      return finish(b, false, () => 1)
    }
    case 'twig':
    case 'bone': {
      const knob = kind.shape === 'bone'
      if (knob) {
        // loose bones lying apart (never crossed)
        const n = 1 + Math.floor(rnd() * 2)
        for (let i = 0; i < n; i++) {
          const a = rnd() * Math.PI, L = (i === 0 ? 0.6 : 0.35) + rnd() * 0.2, r = 0.05
          const ox = i === 0 ? 0 : (rnd() - 0.5) * 0.7, oz = i === 0 ? 0 : (rnd() < 0.5 ? -1 : 1) * (0.2 + rnd() * 0.15)
          const dx = Math.cos(a) * L / 2, dz = Math.sin(a) * L / 2, oy = 0.04
          addTube(b, [[ox - dx, oy, oz - dz], [ox, oy + 0.01, oz], [ox + dx, oy, oz + dz]], [r, r * 0.9, r], { sides: 4, color: W })
          for (const s of [-1, 1]) addBlob(b, [ox + s * dx, oy, oz + s * dz], [0.07, 0.06, 0.07], { detail: 0, noise, amp: 0, freq: 1, offset: 0, color: W })
        }
        return finish(b, false, () => 1)
      }
      // one bent stick with a couple of short side branches
      const a0 = rnd() * Math.PI, L0 = 0.55 + rnd() * 0.35, r0 = 0.03, oy = 0.035
      const ux = Math.cos(a0), uz = Math.sin(a0), bow = (rnd() - 0.5) * 0.16
      const at = (t: number): Vec3 => [ux * L0 * (t - 0.5) - uz * bow * Math.sin(t * Math.PI), oy, uz * L0 * (t - 0.5) + ux * bow * Math.sin(t * Math.PI)]
      addTube(b, [at(0), at(0.5), at(1)], [r0, r0 * 1.05, r0 * 0.7], { sides: 4, color: W })
      const nb = 1 + Math.floor(rnd() * 2)
      for (let i = 0; i < nb; i++) {
        const t = 0.3 + rnd() * 0.45, p = at(t)
        const a = a0 + (rnd() < 0.5 ? -1 : 1) * (0.45 + rnd() * 0.4), L = 0.15 + rnd() * 0.18
        addTube(b, [p, [p[0] + Math.cos(a) * L, oy + 0.005, p[2] + Math.sin(a) * L]], [r0 * 0.7, r0 * 0.45], { sides: 3, color: W })
      }
      return finish(b, false, () => 1)
    }
    case 'shroom': {
      const n = 1 + Math.floor(rnd() * 3)
      const caps: [number, number][] = []
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2, d = i === 0 ? 0 : 0.25 + rnd() * 0.15, k = i === 0 ? 1 : 0.6
        const base: Vec3 = [Math.cos(a) * d, 0, Math.sin(a) * d], h = 0.55 * k
        addTube(b, [base, [base[0], h * 0.5, base[2]], [base[0], h, base[2]]], [0.09 * k, 0.07 * k, 0.07 * k], { sides: 5, color: [1, 0.97, 0.9] })
        const start = b.vc
        addBlob(b, [base[0], h * 0.9, base[2]], [0.28 * k, 0.22 * k, 0.28 * k], { detail: 1, noise, amp: 0.1, freq: 2, offset: i * 3, color: W, dome: true })
        caps.push([start, b.vc])
      }
      // stems keep their colour, caps take the instance colour
      return finish(b, false, (v) => (caps.some(([a, e]) => v >= a && v < e) ? 1 : 0))
    }
    case 'ember': {
      for (let i = 0; i < 3 + Math.floor(rnd() * 3); i++) {
        const x = (rnd() - 0.5) * 0.8, z = (rnd() - 0.5) * 0.8, r = 0.05 + rnd() * 0.05
        addBlob(b, [x, 0.02, z], [r, r * 0.6, r], { detail: 0, noise, amp: 0, freq: 1, offset: 0, color: [0.7 + rnd() * 0.6, 0.7 + rnd() * 0.6, 0.7 + rnd() * 0.6] })
      }
      return finish(b, true, () => 1)
    }
    case 'shard': {
      // a tiny cluster of ice / crystal shards (flat-shaded facets catch the light)
      const n = 2 + Math.floor(rnd() * 3), off = rnd() * Math.PI * 2
      for (let i = 0; i < n; i++) {
        const a = off + (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.6, lead = i === 0
        const tilt = lead ? rnd() * 10 : 18 + rnd() * 30
        const e = (90 - tilt) * Math.PI / 180
        const base: Vec3 = lead ? [0, -0.02, 0] : [Math.cos(a) * 0.12, -0.02, Math.sin(a) * 0.12]
        addShard(b, base, [Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)], (lead ? 0.9 : 0.45 + rnd() * 0.3), lead ? 0.14 : 0.09, 5, 0.3, [0.9 + rnd() * 0.2, 0.9 + rnd() * 0.2, 1], rnd() * Math.PI)
      }
      return finish(b, true, () => 1)
    }
    case 'puddle': {
      const n = 14
      const ctr = b.vert([0, 0.012, 0], W, [0, 0], [0, 1, 0])
      const rim: number[] = []
      const ox = rnd() * 9
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2
        const r = 0.5 * (1 + 0.35 * noise.noise2(Math.cos(a) * 1.3 + ox, Math.sin(a) * 1.3))
        rim.push(b.vert([Math.cos(a) * r, 0.012, Math.sin(a) * r * 0.75], W, [0, 0], [0, 1, 0]))
      }
      for (let j = 0; j < n; j++) b.tri(rim[j], rim[(j + 1) % n], ctr, [0, 1, 0])
      return finish(b, false, () => 1)
    }
  }
  return cardsGeometry(2, 0.5, 0.5, 0, seed)
}

const TINT_PATCH = (m: THREE.Material) => {
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, r) => {
    prev.call(m, shader, r)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTint;')
      .replace('#include <color_vertex>', `#include <color_vertex>
#if defined( USE_COLOR ) && defined( USE_INSTANCING_COLOR )
  vColor.xyz = color.xyz * mix(vec3(1.0), instanceColor.xyz, aTint);
#endif`)
  }
  const prevKey = m.customProgramCacheKey.bind(m)
  m.customProgramCacheKey = () => `${prevKey()}|decorTint`
}

/** Double-sided cards keep their up-facing normal on the back side too (three flips it, so the backs of upright
 * sprigs would be lit from below and render black). */
const KEEP_NORMAL_PATCH = (m: THREE.Material) => {
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, r) => {
    prev.call(m, shader, r)
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
      THREE.ShaderChunk.normal_fragment_begin.replace(/normal \*= faceDirection;/g, ''))
  }
  const prevKey = m.customProgramCacheKey.bind(m)
  m.customProgramCacheKey = () => `${prevKey()}|keepNormal`
}

function decorMaterial(id: string, k: DecorKind, own: THREE.Texture[]): THREE.Material {
  const card = k.shape === 'sprig' || k.shape === 'leaf' || k.shape === 'blossom' || k.shape === 'shell'
  const cardTex = card ? cardTexture(k.shape) : null
  if (cardTex) own.push(cardTex)
  let m: THREE.Material
  if (k.shape === 'ember') m = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true })
  else if (k.glossy) m = new THREE.MeshPhongMaterial({ map: patternTexture({ id: k.pattern ?? 'plain', color: '#ffffff' }), vertexColors: true, shininess: 90, specular: new THREE.Color(0.55, 0.6, 0.7) })
  else m = new THREE.MeshLambertMaterial({
    map: cardTex ?? patternTexture({ id: k.pattern ?? 'plain', color: '#ffffff' }),
    vertexColors: true, alphaTest: card ? 0.5 : 0, side: card ? THREE.DoubleSide : THREE.FrontSide,
  })
  m.name = `decor:${id}`
  TINT_PATCH(m)
  if (card) KEEP_NORMAL_PATCH(m)
  if (k.sway) applyWind(m, `decor-${k.shape}`)
  return m
}

export function createDecorLayer(): DecorLayer {
  const D = RENDER.decor
  const kinds = new Map<string, { def: DecorKind; material: THREE.Material; geos: THREE.BufferGeometry[]; colors: Vec3[] }>()
  const ownTextures: THREE.Texture[] = []
  for (const [id, def] of Object.entries(D.kinds)) {
    const nv = Math.max(1, def.variants ?? 1)
    kinds.set(id, {
      def,
      material: decorMaterial(id, def, ownTextures),
      geos: Array.from({ length: nv }, (_, v) => shapeGeometry(def, v, seedOf(id))),
      colors: def.colors.filter((c) => c !== '$terrain').map((c) => hexToRgb(c).map(lin) as unknown as Vec3),
    })
  }
  // rules indexed by terrain id
  const byTerrain: { rule: DecorRule; index: number; biomes: Set<string> | null; near: Set<number> | null }[][] = []
  D.rules.forEach((rule, index) => {
    if (!kinds.has(rule.kind)) return
    for (const key of rule.terrain) {
      const t = CONTENT.terrainByKey[key]
      if (!t) continue
      ;(byTerrain[t.id] ??= []).push({
        rule, index, biomes: rule.biomes ? new Set(rule.biomes) : null,
        near: rule.near ? new Set(rule.near.terrain.map((k) => CONTENT.terrainByKey[k]?.id ?? -1)) : null,
      })
    }
  })
  let noise = createNoise(1)
  const _m = new THREE.Matrix4()
  const _q = new THREE.Quaternion()
  const _s = new THREE.Vector3()
  const _p = new THREE.Vector3()
  const _up = new THREE.Vector3(0, 1, 0)
  const _rgb = [1, 1, 1]
  const _cs: ClimateSample = { dry: 0, autumn: 0, blossom: 0, snow: 0 }

  return {
    setMap(map) { noise = createNoise(seedOf(`decor:${map.id}`)) },
    build(sampler, cx, cy, size, climate, blocked, density, avg) {
      if (density <= 0) return []
      const B = sampler.bounds
      const x0 = cx * size, y0 = cy * size
      const x1 = B ? Math.min(B.x1, x0 + size) : x0 + size, y1 = B ? Math.min(B.y1, y0 + size) : y0 + size
      const items = new Map<string, { kind: string; v: number; m: number[]; c: number[] }>()
      const margin = D.margin
      for (let ty = y0; ty < y1; ty++) for (let tx = x0; tx < x1; tx++) {
        const tid = sampler.terrainId(tx, ty)
        const rules = byTerrain[tid]
        if (!rules) continue
        const k = sampler.kindAt(tx, ty)
        if ((k !== TERRAIN_KIND.normal && k !== TERRAIN_KIND.glossy) || sampler.ramp(tx, ty) || blocked(tx, ty)) continue
        const biome = sampler.biome(tx, ty)?.id ?? ''
        const top = sampler.topAt(tx, ty, 0.5, 0.5)
        let placed = 0
        for (const r of rules) {
          if (r.biomes && !r.biomes.has(biome)) continue
          let d = r.rule.density * density
          if (r.rule.noise) d *= fieldNoise(noise, r.rule.noise, tx + 0.5, ty + 0.5)
          if (r.rule.field && climate) d *= smoothstep(r.rule.field.lo, r.rule.field.hi, climate.sample(r.rule.field.name, tx + 0.5, ty + 0.5))
          else if (r.rule.field) d = 0
          if (r.rule.unless && climate) d *= 1 - smoothstep(r.rule.unless.lo, r.rule.unless.hi, climate.sample(r.rule.unless.name, tx + 0.5, ty + 0.5))
          if (d <= 0) continue
          if (r.near) {
            const dist = r.rule.near!.dist
            let ok = false
            for (let dy = -dist; dy <= dist && !ok; dy++) for (let dx = -dist; dx <= dist && !ok; dx++) {
              const id = sampler.terrainId(tx + dx, ty + dy)
              if (id >= 0 && r.near.has(id)) ok = true
            }
            if (!ok) continue
          }
          const n = Math.min(D.maxPerTile - placed, Math.floor(d) + (hash2(tx, ty, 300 + r.index) < d % 1 ? 1 : 0))
          if (n <= 0) continue
          const kd = kinds.get(r.rule.kind)!
          const terrainKey = tid
          for (let i = 0; i < n; i++) {
            const h = (s: number) => hash2(tx * 7 + i, ty * 13 + r.index, 400 + s)
            const x = tx + margin + h(0) * (1 - 2 * margin), z = ty + margin + h(1) * (1 - 2 * margin)
            const sc = range(kd.def.size, h(2))
            const v = Math.floor(h(3) * kd.geos.length) % kd.geos.length
            _q.setFromAxisAngle(_up, h(4) * Math.PI * 2)
            _s.set(sc * (0.85 + h(5) * 0.3), sc, sc * (0.85 + h(6) * 0.3))
            _p.set(x, top + D.lift, z)
            _m.compose(_p, _q, _s)
            const key = `${r.rule.kind}#${v}`
            let it = items.get(key)
            if (!it) { it = { kind: r.rule.kind, v, m: [], c: [] }; items.set(key, it) }
            const off = it.m.length
            it.m.length += 16
            _m.toArray(it.m, off)
            // colour: a listed colour or the terrain's own (tinted like the ground under it)
            const useTerrain = kd.def.colors.includes('$terrain') && (kd.colors.length === 0 || h(7) < 0.5)
            let r0: number, g0: number, b0: number
            if (useTerrain) {
              const tkey = CONTENT.terrain[terrainKey]?.key ?? ''
              const a = avg(tkey), t = terrainTint(tkey, x, z, climate, _rgb, _cs), s = kd.def.terrainShade ?? 1
              r0 = lin(a[0]) * t[0] * s; g0 = lin(a[1]) * t[1] * s; b0 = lin(a[2]) * t[2] * s
            } else {
              const col = kd.colors[Math.floor(h(8) * kd.colors.length) % kd.colors.length] ?? [1, 1, 1]
              r0 = col[0]; g0 = col[1]; b0 = col[2]
            }
            const j = 1 + (h(9) - 0.5) * 2 * (kd.def.colorJitter ?? 0.1)
            const glow = kd.def.emissive ?? 1
            it.c.push(r0 * j * glow, g0 * j * glow, b0 * j * glow)
            placed++
          }
          if (placed >= D.maxPerTile) break
        }
      }
      const out: THREE.InstancedMesh[] = []
      for (const it of items.values()) {
        const kd = kinds.get(it.kind)!
        const n = it.c.length / 3
        const mesh = new THREE.InstancedMesh(kd.geos[it.v], kd.material, n)
        mesh.instanceMatrix.array.set(it.m)
        mesh.instanceMatrix.needsUpdate = true
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(it.c), 3)
        mesh.computeBoundingSphere()
        mesh.castShadow = false
        mesh.receiveShadow = kd.def.shape !== 'ember'
        mesh.name = `decor:${it.kind}`
        out.push(mesh)
      }
      return out
    },
    disposeChunk(meshes) { for (const m of meshes) { m.removeFromParent(); m.dispose() } },
    dispose() {
      for (const k of kinds.values()) { for (const g of k.geos) g.dispose(); k.material.dispose() }
      for (const t of ownTextures) t.dispose()
      kinds.clear()
    },
  }
}
