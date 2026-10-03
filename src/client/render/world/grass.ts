// Instanced tall-grass tufts per chunk: wind sway + bending away from nearby actors.
import * as THREE from 'three'
import { CONTENT } from '../../../shared/content/index.ts'
import type { TerrainDef } from '../../../shared/types.ts'
import type { AssetStore } from '../../contracts.ts'
import { RENDER, type Vec3 } from '../config.ts'
import { configurePixelTexture, createCanvas } from '../sprite-utils.ts'
import type { TerrainAtlas } from './atlas.ts'
import type { ClimateGrid } from './climate.ts'
import { hash2 } from './coords.ts'
import { terrainTint, type TerrainSampler } from './terrain.ts'
import { applyWind } from './wind.ts'

export interface GrassBender { x: number; y: number; z: number; r: number }

export interface GrassLayer {
  readonly group: THREE.Group
  /** Whole-map build into `group` (battle dioramas). */
  build(sampler: TerrainSampler, chunk: number, perTile: number): void
  /** Tufts of one chunk (streamed overworld); the caller owns the meshes. Climate tints follow the ground. */
  buildChunk(sampler: TerrainSampler, cx: number, cy: number, chunk: number, perTile: number, climate: ClimateGrid | null): THREE.InstancedMesh[]
  disposeChunk(meshes: THREE.InstancedMesh[]): void
  setBenders(list: GrassBender[]): void
  /** Hide chunks farther than radius from (x, z). */
  cull(x: number, z: number, radius: number): void
  /** Re-derive tuft textures if base terrain textures (re)loaded. */
  refresh(): void
  dispose(): void
}

function tuftGeometry(): THREE.BufferGeometry {
  const G = RENDER.grass
  const planes: THREE.BufferGeometry[] = []
  for (let i = 0; i < G.planes; i++) {
    const p = new THREE.PlaneGeometry(G.width, G.height)
    p.translate(0, G.height / 2, 0)
    p.rotateY((i / G.planes) * Math.PI)
    planes.push(p)
  }
  const pos: number[] = [], uv: number[] = [], idx: number[] = []
  let base = 0
  for (const p of planes) {
    pos.push(...(p.getAttribute('position').array as Float32Array))
    uv.push(...(p.getAttribute('uv').array as Float32Array))
    for (const i of p.getIndex()!.array) idx.push(i + base)
    base += p.getAttribute('position').count
    p.dispose()
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  const nrm = new Float32Array(pos.length)
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  geo.setIndex(idx)
  return geo
}

/** Blades drawn from the base terrain color: dark roots, bright tips. */
function deriveTuft(avg: Vec3, seed: number): HTMLCanvasElement {
  const G = RENDER.grass
  const s = G.texSize
  const c = createCanvas(s, s)
  const g = c.getContext('2d')!
  const img = g.createImageData(s, s)
  let r = seed >>> 0
  const rnd = () => { r = (Math.imul(r ^ (r >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return r / 4294967296 }
  for (let b = 0; b < G.blades; b++) {
    const x0 = 1 + rnd() * (s - 2)
    const h = s * (0.55 + rnd() * 0.45)
    const lean = (rnd() - 0.5) * s * 0.35
    const tone = 0.85 + rnd() * 0.3
    for (let j = 0; j < h; j++) {
      const t = j / h
      const x = Math.round(x0 + lean * t * t)
      const y = s - 1 - j
      const k = (G.rootShade + (G.tipLight - G.rootShade) * t) * tone
      for (let w = 0; w < (t < 0.5 ? 2 : 1); w++) {
        const xi = Math.min(s - 1, Math.max(0, x + w))
        const i = (y * s + xi) * 4
        img.data[i] = Math.min(255, avg[0] * k * 255)
        img.data[i + 1] = Math.min(255, avg[1] * k * 255)
        img.data[i + 2] = Math.min(255, avg[2] * k * 255)
        img.data[i + 3] = 255
      }
    }
  }
  g.putImageData(img, 0, 0)
  return c
}

export function createGrassLayer(assets: AssetStore, atlas: TerrainAtlas): GrassLayer {
  const G = RENDER.grass
  const group = new THREE.Group()
  group.name = 'grass'
  const geometry = tuftGeometry()
  const maxB = Math.max(1, G.maxBenders)
  const benders = Array.from({ length: maxB }, () => new THREE.Vector4(0, -1e4, 0, 0))
  const uniforms = {
    uBenders: { value: benders },
    uBendStrength: { value: G.bendStrength },
    uGrassHeight: { value: G.height },
    uBendSink: { value: G.bendSink },
    uBendCore: { value: G.bendCore },
    uBendLevel: { value: CONTENT.config.world.levelHeight * 1.5 },
  }
  const grassKeys = CONTENT.terrain.filter((t) => t.tallGrass)
  const materials = new Map<string, { material: THREE.MeshLambertMaterial; derived: boolean; avgKey: string }>()
  const chunks: { mesh: THREE.InstancedMesh; cx: number; cz: number }[] = []

  // a real `<key>_tuft` file, or (render.json grass.assetTufts) the asset store's placeholder tuft art for keys
  // whose derived blades would read wrong (pink-tipped sakura, purple lavender, neon glitch grass ...)
  const assetTufts = new Set(G.assetTufts ?? [])
  const ownTuft = (key: string) => [`${key}_tuft`, `terrain/${key}_tuft`].find((id) => assets.has('textures', id)) ?? (assetTufts.has(key) ? `${key}_tuft` : undefined)

  function materialFor(t: TerrainDef): THREE.MeshLambertMaterial {
    const hit = materials.get(t.key)
    if (hit) return hit.material
    const own = ownTuft(t.key)
    const map = own ? configurePixelTexture(assets.terrainTexture(`${t.key}_tuft`)) : configurePixelTexture(new THREE.CanvasTexture(deriveTuft(atlas.averageColor(t.key), t.id * 7919)))
    const material = new THREE.MeshLambertMaterial({ map, alphaTest: G.alphaTest, side: THREE.DoubleSide })
    applyWind(material, 'grass', {
      uniforms,
      pars: `uniform vec4 uBenders[${maxB}];\nuniform float uBendStrength, uGrassHeight, uBendSink, uBendCore, uBendLevel;`,
      body: `
  vec2 apBend = vec2(0.0);
  float apSink = 0.0;
  for (int i = 0; i < ${maxB}; i++) {
    vec4 b = uBenders[i];
    if (b.w <= 0.0) continue;
    vec2 d = apRoot.xz - b.xz;
    float dist = length(d);
    float f = (1.0 - smoothstep(b.w * uBendCore, b.w, dist)) * (1.0 - step(uBendLevel, abs(apRoot.y - b.y)));
    apBend += (dist > 1e-3 ? d / dist : vec2(0.0)) * f;
    apSink = max(apSink, f);
  }
  float apK = clamp(position.y / uGrassHeight, 0.0, 1.0);
  transformed.xz += apBend * uBendStrength * apK;
  transformed.y *= 1.0 - apSink * uBendSink * apK;`,
    })
    materials.set(t.key, { material, derived: !own, avgKey: atlas.averageColor(t.key).join(',') })
    return material
  }

  function clear(): void {
    for (const c of chunks) { group.remove(c.mesh); c.mesh.dispose() }
    chunks.length = 0
  }

  const _m = new THREE.Matrix4()
  const _c = new THREE.Color()
  const _rgb = [1, 1, 1]

  const layer: GrassLayer = {
    group,
    build(sampler, chunk, perTile) {
      clear()
      const map = sampler.map
      const cw = Math.ceil(map.width / chunk), ch = Math.ceil(map.height / chunk)
      for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
        for (const mesh of layer.buildChunk(sampler, cx, cy, chunk, perTile, null)) {
          group.add(mesh)
          chunks.push({ mesh, cx: (cx + 0.5) * chunk, cz: (cy + 0.5) * chunk })
        }
      }
    },
    buildChunk(sampler, cx, cy, chunk, perTile, climate) {
      const out: THREE.InstancedMesh[] = []
      if (!grassKeys.length || perTile <= 0) return out
      const B = sampler.bounds
      const n = Math.max(1, Math.round(perTile))
      const grid = Math.ceil(Math.sqrt(n))
      const byKey = new Map<string, { t: TerrainDef; tiles: [number, number][] }>()
      const xe = B ? Math.min(B.x1, (cx + 1) * chunk) : (cx + 1) * chunk, ye = B ? Math.min(B.y1, (cy + 1) * chunk) : (cy + 1) * chunk
      for (let ty = cy * chunk; ty < ye; ty++) for (let tx = cx * chunk; tx < xe; tx++) {
        const t = sampler.terrain(tx, ty)
        if (!t?.tallGrass) continue
        let e = byKey.get(t.key)
        if (!e) { e = { t, tiles: [] }; byKey.set(t.key, e) }
        e.tiles.push([tx, ty])
      }
      for (const { t, tiles } of byKey.values()) {
        const mesh = new THREE.InstancedMesh(geometry, materialFor(t), tiles.length * n)
        let k = 0
        for (const [tx, ty] of tiles) {
          const y = sampler.topAt(tx, ty, 0.5, 0.5)
          const tint = terrainTint(t.key, tx + 0.5, ty + 0.5, climate, _rgb)
          for (let i = 0; i < n; i++) {
            const gx = i % grid, gy = Math.floor(i / grid)
            const jx = (hash2(tx, ty, i * 2 + 1) - 0.5) * G.jitter, jz = (hash2(tx, ty, i * 2 + 2) - 0.5) * G.jitter
            const x = tx + (gx + 0.5) / grid + jx
            const z = ty + (gy + 0.5) / grid + jz
            const s = 1 + (hash2(tx, ty, i + 50) - 0.5) * 2 * G.scaleJitter
            _m.makeScale(s, s, s).setPosition(x, y, z)
            mesh.setMatrixAt(k, _m)
            const cj = 1 + (hash2(tx, ty, i + 90) - 0.5) * 2 * G.colorJitter
            mesh.setColorAt(k, _c.setRGB(cj * tint[0], cj * (1 + (hash2(tx, ty, i + 130) - 0.5) * G.colorJitter) * tint[1], cj * tint[2]))
            k++
          }
        }
        mesh.instanceMatrix.needsUpdate = true
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
        mesh.computeBoundingSphere()
        mesh.receiveShadow = true
        mesh.castShadow = false
        mesh.name = 'grass'
        out.push(mesh)
      }
      return out
    },
    disposeChunk(meshes) { for (const m of meshes) { m.removeFromParent(); m.dispose() } },
    setBenders(list) {
      for (let i = 0; i < maxB; i++) {
        const b = list[i]
        if (b) benders[i].set(b.x, b.y, b.z, b.r * G.bendRadius)
        else benders[i].set(0, -1e4, 0, 0)
      }
    },
    cull(x, z, radius) {
      for (const c of chunks) c.mesh.visible = Math.hypot(c.cx - x, c.cz - z) < radius
    },
    refresh() {
      for (const [key, m] of materials) {
        if (!m.derived) continue
        const avg = atlas.averageColor(key)
        const sig = avg.join(',')
        if (sig === m.avgKey) continue
        m.avgKey = sig
        const old = m.material.map
        m.material.map = configurePixelTexture(new THREE.CanvasTexture(deriveTuft(avg, (CONTENT.terrainByKey[key]?.id ?? 0) * 7919)))
        old?.dispose()
      }
    },
    dispose() {
      clear()
      geometry.dispose()
      for (const m of materials.values()) { m.material.map?.dispose(); m.material.dispose() }
      materials.clear()
    },
  }
  return layer
}
