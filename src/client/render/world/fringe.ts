// Soft terrain transitions: where a higher-priority terrain (grass, snow, forest floor ...) meets a lower one (path,
// sand, rock ...) at the same height, a band of the higher terrain's texture is laid over the lower tile's edge and cut
// by a pixel-art noise mask (alpha-tested, so it stays crisp at the low internal resolution). Corners get radial
// patches. Priorities, band width and mask shape come from content/render.json "fringe".
import * as THREE from 'three'
import { CONTENT } from '../../../shared/content/index.ts'
import { RENDER, uvModeOf } from '../config.ts'
import { mulberry32 } from '../noise.ts'
import { configurePixelTexture, createCanvas } from '../sprite-utils.ts'
import type { UvRect } from './atlas.ts'
import { applySnowDust, type ClimateGrid, type ClimateSample } from './climate.ts'
import { hash2 } from './coords.ts'
import { TERRAIN_KIND, terrainTint, type TerrainSampler } from './terrain.ts'

export interface FringeLayer {
  readonly material: THREE.MeshLambertMaterial
  /** Fringe geometry of one chunk (null when no edge in it blends). */
  build(sampler: TerrainSampler, cx: number, cy: number, size: number, rect: (key: string) => UvRect, climate: ClimateGrid | null): THREE.BufferGeometry | null
  dispose(): void
}

/** Pixel mask: alpha in all channels, row 0 (canvas top) = inner end of the band, bottom row = the shared edge. */
function maskCanvas(): HTMLCanvasElement {
  const F = RENDER.fringe
  const along = Math.max(4, Math.round(F.mask[0])), across = Math.max(2, Math.round(F.mask[1]))
  const W = along * 2, H = across
  const c = createCanvas(W, H)
  const g = c.getContext('2d')!
  const img = g.createImageData(W, H)
  const rnd = mulberry32(0x5f3759df)
  // smoothed 1D noise for the cover depth along the edge (wraps over W)
  const knots = Array.from({ length: W / 4 }, () => rnd())
  const depth = (i: number) => {
    const t = i / 4, k = Math.floor(t), f = t - k
    const a = knots[k % knots.length], b = knots[(k + 1) % knots.length]
    const s = f * f * (3 - 2 * f)
    return 0.5 + (a + (b - a) * s - 0.5) * 2 * F.jag
  }
  for (let i = 0; i < W; i++) {
    const d = Math.max(0.12, Math.min(0.95, depth(i) + (rnd() - 0.5) * F.jag * 0.35))
    for (let j = 0; j < H; j++) {
      const fromEdge = (H - 1 - j + 0.5) / H
      let on = fromEdge < d
      if (!on && rnd() < F.specks * (1 - fromEdge)) on = true
      const k = (j * W + i) * 4
      const v = on ? 255 : 0
      img.data[k] = v; img.data[k + 1] = v; img.data[k + 2] = v; img.data[k + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  return c
}

const DIRS = [
  { dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
] as const
const CORNERS = [
  { dx: 1, dy: -1 }, { dx: -1, dy: -1 }, { dx: 1, dy: 1 }, { dx: -1, dy: 1 },
] as const

export function createFringeLayer(atlasTexture: THREE.Texture): FringeLayer {
  const F = RENDER.fringe
  const mask = configurePixelTexture(new THREE.CanvasTexture(maskCanvas()))
  mask.colorSpace = THREE.NoColorSpace
  mask.wrapS = THREE.RepeatWrapping
  mask.wrapT = THREE.ClampToEdgeWrapping
  mask.channel = 1
  const material = new THREE.MeshLambertMaterial({
    map: atlasTexture, alphaMap: mask, alphaTest: F.alphaTest, vertexColors: true,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  })
  material.name = 'terrain-fringe'
  applySnowDust(material, false)
  const prio: number[] = []
  for (const t of CONTENT.terrain) prio[t.id] = F.priorities[t.key] ?? 0
  const alongScale = 1 / 2 // mask texture spans two tiles along the edge
  const _rgb = [1, 1, 1]
  const _cs: ClimateSample = { dry: 0, autumn: 0, blossom: 0, snow: 0 }

  return {
    material,
    build(sampler, cx, cy, size, rect, climate) {
      const B = sampler.bounds
      const x0 = cx * size, y0 = cy * size
      const x1 = B ? Math.min(B.x1, x0 + size) : x0 + size, y1 = B ? Math.min(B.y1, y0 + size) : y0 + size
      const pos: number[] = [], nrm: number[] = [], uv: number[] = [], uv1: number[] = [], col: number[] = []
      const flat = (tx: number, ty: number) => {
        if (!sampler.inside(tx, ty)) return false
        const k = sampler.kindAt(tx, ty)
        return (k === TERRAIN_KIND.normal || k === TERRAIN_KIND.glossy) && !sampler.ramp(tx, ty)
      }
      const P = (tx: number, ty: number) => prio[sampler.terrainId(tx, ty)] ?? 0
      const w = F.width

      /** Quad over the receiver tile (rx, ry): corners in local coords + mask v per corner, textured as `key`. */
      const quad = (rx: number, ry: number, y: number, key: string, corners: [number, number, number][], alongAxis: 'x' | 'z') => {
        const r = rect(key)
        const mode = uvModeOf(key)
        const fu = mode === 'mirror' ? (rx & 1) === 1 : mode === 'flip' ? hash2(rx, ry, 41) < 0.5 : false
        const fv = mode === 'mirror' ? (ry & 1) === 1 : mode === 'flip' ? hash2(ry, rx, 43) < 0.5 : false
        const base = pos.length / 3
        for (const [lx, lz, mv] of corners) {
          const x = rx + lx, z = ry + lz
          pos.push(x, y, z)
          nrm.push(0, 1, 0)
          uv.push(fu ? r.u1 - (r.u1 - r.u0) * lx : r.u0 + (r.u1 - r.u0) * lx, fv ? r.v0 + (r.v1 - r.v0) * lz : r.v1 - (r.v1 - r.v0) * lz)
          uv1.push((alongAxis === 'x' ? x : z) * alongScale, mv)
          const t = terrainTint(key, x, z, climate, _rgb, _cs)
          col.push(t[0], t[1], t[2])
        }
        // (0,1,2) (0,2,3) wound to face +y
        const ax = pos[base * 3], az = pos[base * 3 + 2]
        const bx = pos[(base + 1) * 3], bz = pos[(base + 1) * 3 + 2]
        const cxp = pos[(base + 2) * 3], czp = pos[(base + 2) * 3 + 2]
        const up = (bz - az) * (cxp - ax) - (bx - ax) * (czp - az)
        if (up >= 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
        else idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
      }
      const idx: number[] = []

      for (let ty = y0; ty < y1; ty++) for (let tx = x0; tx < x1; tx++) {
        if (!flat(tx, ty)) continue
        const pt = P(tx, ty)
        if (pt <= 0) continue
        const top = sampler.topAt(tx, ty, 0.5, 0.5)
        const higher = (nx: number, ny: number) => flat(nx, ny) && P(nx, ny) > pt && Math.abs(sampler.topAt(nx, ny, 0.5, 0.5) - top) < 0.01
        const edgeHit = [false, false, false, false]
        DIRS.forEach((d, k) => {
          const nx = tx + d.dx, ny = ty + d.dy
          if (!higher(nx, ny)) return
          edgeHit[k] = true
          const key = sampler.terrain(nx, ny)!.key
          const y = top + F.lift * (1 + P(nx, ny) * 0.05)
          // band corners (lx, lz, maskV): maskV 0 on the shared edge, 1 at the inner end
          if (d.dy === -1) quad(tx, ty, y, key, [[0, 0, 0], [1, 0, 0], [1, w, 1], [0, w, 1]], 'x')
          else if (d.dy === 1) quad(tx, ty, y, key, [[0, 1, 0], [1, 1, 0], [1, 1 - w, 1], [0, 1 - w, 1]], 'x')
          else if (d.dx === 1) quad(tx, ty, y, key, [[1, 0, 0], [1, 1, 0], [1 - w, 1, 1], [1 - w, 0, 1]], 'z')
          else quad(tx, ty, y, key, [[0, 0, 0], [0, 1, 0], [w, 1, 1], [w, 0, 1]], 'z')
        })
        CORNERS.forEach((d) => {
          const nx = tx + d.dx, ny = ty + d.dy
          // only outer corners: both orthogonal neighbours lower (their edges are not fringed)
          if (edgeHit[d.dy < 0 ? 0 : 1] || edgeHit[d.dx > 0 ? 2 : 3] || !higher(nx, ny)) return
          const key = sampler.terrain(nx, ny)!.key
          const y = top + F.lift * (1 + P(nx, ny) * 0.05)
          const cxl = d.dx > 0 ? 1 : 0, czl = d.dy > 0 ? 1 : 0
          const ix = d.dx > 0 ? 1 - w : w, iz = d.dy > 0 ? 1 - w : w
          quad(tx, ty, y, key, [[cxl, czl, 0], [ix, czl, 1], [ix, iz, 1.4], [cxl, iz, 1]], 'x')
        })
      }
      if (!idx.length) return null
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
      geo.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2))
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
      geo.setIndex(idx)
      geo.computeBoundingSphere()
      return geo
    },
    dispose() { material.dispose(); mask.dispose() },
  }
}
