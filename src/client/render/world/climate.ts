// Climate fields: large-scale noise maps (dryness, autumn patches, blossom patches, snow cover) over the overworld,
// shaped per biome and elevation by content/render.json "fields". The CPU grid tints terrain vertices, grass, decor
// and prop instances; the RGBA texture drives the snow-dusting shader patch on prop / terrain tops.
// Finite maps get one grid over the whole map. The infinite overworld uses a toroidal window: cell (i, j) lives in
// slot (i mod N, j mod N) of both the CPU cache and the repeat-wrapped texture, computed on first use from the
// TerrainSampler's ensured tiles — so values never depend on what was streamed before.
import * as THREE from 'three'
import { CONTENT } from '../../../shared/content/index.ts'
import type { BiomeDef, GameMap } from '../../../shared/types.ts'
import { RENDER, hexToRgb, type FieldName, type FieldNoise, type FieldsConfig, type Vec2 } from '../config.ts'
import { clamp01, createNoise, fbm2, seedOf, smoothstep, type Noise } from '../noise.ts'
import { biomeAt, levelAt } from './coords.ts'
import type { TerrainSampler, TileRect } from './terrain.ts'

/** Climate values at a point (all 0..1; lush = 1 - dry). */
export interface ClimateSample { dry: number; autumn: number; blossom: number; snow: number }

export interface ClimateGrid {
  readonly cols: number
  readonly rows: number
  readonly cell: number
  /** Bilinear sample of one field at world (x, z). */
  sample(field: FieldName, x: number, z: number): number
  /** All fields at once. */
  sampleAll(x: number, z: number, out?: ClimateSample): ClimateSample
  /** RGBA = snow, dry, autumn, blossom (linear filtered); null for maps without climate. */
  readonly texture: THREE.DataTexture | null
  /** Computes every cell a tile rect samples (rolling window: call before GPU reads it). */
  touch(rect: TileRect): void
  /** Uploads cells computed since the last flush (rolling window; once per frame). */
  flush(): void
  dispose(): void
}

/** Tile reads the climate needs (a TerrainSampler, or a finite map). */
export interface ClimateSource {
  biome(tx: number, ty: number): BiomeDef | null
  level(tx: number, ty: number): number
  /** Finite source rect (coords are clamped into it); null = unbounded. */
  readonly bounds: TileRect | null
}

const mapSource = (map: GameMap): ClimateSource => ({
  biome: (x, y) => biomeAt(map, x, y), level: (x, y) => levelAt(map, x, y),
  bounds: map.infinite ? null : { x0: 0, y0: 0, x1: map.width, y1: map.height },
})

const CHANNEL: Record<Exclude<FieldName, 'lush'>, number> = { snow: 0, dry: 1, autumn: 2, blossom: 3 }

/** Value of a FieldNoise at (x, z): fbm remapped by smoothstep(lo, hi). */
export function fieldNoise(n: Noise, spec: FieldNoise, x: number, z: number, bias = 0): number {
  return smoothstep(spec.lo, spec.hi, fbm2(n, x, z, spec) + bias)
}

/** Pure per-point climate (no grid): used to fill the grid and by tests. */
export function climateAt(src: GameMap | ClimateSource, noise: Noise, x: number, z: number, cfg: FieldsConfig = RENDER.fields): ClimateSample {
  const s = 'regions' in src ? mapSource(src) : src
  const B = s.bounds
  const tx = B ? Math.min(B.x1 - 1, Math.max(B.x0, Math.floor(x))) : Math.floor(x)
  const ty = B ? Math.min(B.y1 - 1, Math.max(B.y0, Math.floor(z))) : Math.floor(z)
  const biome = s.biome(tx, ty)
  const b = (biome && cfg.biomes[biome.id]) || {}
  const dry = fieldNoise(noise, cfg.dry, x, z, b.dry ?? 0)
  const autumn = fieldNoise(noise, cfg.autumn, x, z) * (b.autumn ?? 0)
  const blossom = fieldNoise(noise, cfg.blossom, x, z) * (b.blossom ?? 0)
  const line = b.snowLine ?? cfg.snow.line
  const jitter = (fbm2(noise, x, z, cfg.snow.noise) - 0.5) * cfg.snow.noiseAmount
  const level = s.level(tx, ty) + jitter
  const snow = Math.max(b.snow ?? 0, smoothstep(line - cfg.snow.band, line, level))
  return { dry, autumn: clamp01(autumn), blossom: clamp01(blossom), snow: clamp01(snow) }
}

export function climateNoise(map: GameMap): Noise { return createNoise(seedOf(`climate:${map.id}`)) }

/** Builds the climate grid of a map. Interiors and caves get an empty (all-zero) climate. `sampler` supplies the
 * tiles (required for infinite maps); `window` = toroidal cells per side for infinite maps. */
export function createClimate(map: GameMap, cfg: FieldsConfig = RENDER.fields, sampler: TerrainSampler | null = null,
  window = RENDER.streaming.infinite.climateWindow): ClimateGrid {
  if (map.infinite && map.kind === 'overworld' && map.outdoor) return createRollingClimate(map, sampler ?? mapSource(map), cfg, window)
  const outdoor = map.kind === 'overworld' && map.outdoor
  const cell = Math.max(1, cfg.cell)
  const cols = outdoor ? Math.ceil(map.width / cell) : 1
  const rows = outdoor ? Math.ceil(map.height / cell) : 1
  const data = new Float32Array(cols * rows * 4)
  if (outdoor) {
    const noise = climateNoise(map)
    const src = sampler ?? mapSource(map)
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const c = climateAt(src, noise, (i + 0.5) * cell, (j + 0.5) * cell, cfg)
      const k = (j * cols + i) * 4
      data[k] = c.snow; data[k + 1] = c.dry; data[k + 2] = c.autumn; data[k + 3] = c.blossom
    }
  }
  let texture: THREE.DataTexture | null = null
  if (outdoor) {
    const bytes = new Uint8Array(data.length)
    for (let i = 0; i < data.length; i++) bytes[i] = Math.round(data[i] * 255)
    texture = new THREE.DataTexture(bytes, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType)
    texture.magFilter = THREE.LinearFilter
    texture.minFilter = THREE.LinearFilter
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
    texture.generateMipmaps = false
    texture.needsUpdate = true
  }
  const at = (ch: number, x: number, z: number): number => {
    if (!outdoor) return 0
    const fx = Math.min(cols - 1, Math.max(0, x / cell - 0.5)), fz = Math.min(rows - 1, Math.max(0, z / cell - 0.5))
    const i0 = Math.floor(fx), j0 = Math.floor(fz)
    const i1 = Math.min(cols - 1, i0 + 1), j1 = Math.min(rows - 1, j0 + 1)
    const u = fx - i0, v = fz - j0
    const a = data[(j0 * cols + i0) * 4 + ch], b = data[(j0 * cols + i1) * 4 + ch]
    const c = data[(j1 * cols + i0) * 4 + ch], d = data[(j1 * cols + i1) * 4 + ch]
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v
  }
  return {
    cols, rows, cell, texture,
    sample(field, x, z) { return field === 'lush' ? 1 - at(CHANNEL.dry, x, z) : at(CHANNEL[field], x, z) },
    sampleAll(x, z, out = { dry: 0, autumn: 0, blossom: 0, snow: 0 }) {
      out.snow = at(0, x, z); out.dry = at(1, x, z); out.autumn = at(2, x, z); out.blossom = at(3, x, z)
      return out
    },
    touch() {},
    flush() {},
    dispose() { texture?.dispose() },
  }
}

function createRollingClimate(map: GameMap, src: ClimateSource, cfg: FieldsConfig, window: number): ClimateGrid {
  const cell = Math.max(1, cfg.cell)
  const N = Math.max(4, Math.round(window))
  const noise = climateNoise(map)
  const data = new Float32Array(N * N * 4)
  const bytes = new Uint8Array(N * N * 4)
  const tagI = new Int32Array(N * N).fill(-0x7fffffff), tagJ = new Int32Array(N * N).fill(-0x7fffffff)
  const texture = new THREE.DataTexture(bytes, N, N, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.generateMipmaps = false
  texture.needsUpdate = true
  let dirty = false
  const mod = (v: number) => ((v % N) + N) % N

  /** Slot offset (x4) of cell (i, j), computing it when the slot holds another cell. */
  function slot(i: number, j: number): number {
    const s = mod(j) * N + mod(i)
    if (tagI[s] !== i || tagJ[s] !== j) {
      const c = climateAt(src, noise, (i + 0.5) * cell, (j + 0.5) * cell, cfg)
      const k = s * 4
      data[k] = c.snow; data[k + 1] = c.dry; data[k + 2] = c.autumn; data[k + 3] = c.blossom
      for (let q = 0; q < 4; q++) bytes[k + q] = Math.round(data[k + q] * 255)
      tagI[s] = i; tagJ[s] = j
      dirty = true
    }
    return s * 4
  }
  const at = (ch: number, x: number, z: number): number => {
    const fx = x / cell - 0.5, fz = z / cell - 0.5
    const i0 = Math.floor(fx), j0 = Math.floor(fz)
    const u = fx - i0, v = fz - j0
    const a = data[slot(i0, j0) + ch], b = data[slot(i0 + 1, j0) + ch]
    const c = data[slot(i0, j0 + 1) + ch], d = data[slot(i0 + 1, j0 + 1) + ch]
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v
  }
  return {
    cols: N, rows: N, cell, texture,
    sample(field, x, z) { return field === 'lush' ? 1 - at(CHANNEL.dry, x, z) : at(CHANNEL[field], x, z) },
    sampleAll(x, z, out = { dry: 0, autumn: 0, blossom: 0, snow: 0 }) {
      out.snow = at(0, x, z); out.dry = at(1, x, z); out.autumn = at(2, x, z); out.blossom = at(3, x, z)
      return out
    },
    touch(r) {
      const i0 = Math.floor(r.x0 / cell - 0.5), i1 = Math.floor(r.x1 / cell - 0.5) + 1
      const j0 = Math.floor(r.y0 / cell - 0.5), j1 = Math.floor(r.y1 / cell - 0.5) + 1
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) slot(i, j)
    },
    flush() { if (dirty) { dirty = false; texture.needsUpdate = true } },
    dispose() { texture.dispose() },
  }
}

export const fieldValue = (c: ClimateSample, f: FieldName) => (f === 'lush' ? 1 - c.dry : c[f])

// ---------------------------------------------------------------------------
// Snow-dusting shader patch (shared uniforms, like the wind field)
// ---------------------------------------------------------------------------

const D = RENDER.fields.dust
export const climateUniforms = {
  uApField: { value: null as THREE.Texture | null },
  uApFieldSize: { value: new THREE.Vector2(1, 1) },
  uApDustColor: { value: new THREE.Color().setRGB(...hexToRgb(D.color), THREE.SRGBColorSpace) },
  uApDust: { value: D.amount },
  uApDustSlope: { value: new THREE.Vector2(...(D.slope as Vec2)) },
  uApDither: { value: D.pixels },
  uApClump: { value: new THREE.Vector2(D.clump, D.clumpMix) },
  /** Snow from the weather (render.json snowCover): extra coverage 0..1 on every up-facing surface. */
  uApWeather: { value: 0 },
}

/** Sets the weather snow coverage (0 = none). */
export function setSnowCover(level: number): void { climateUniforms.uApWeather.value = level }

/** Points the shared uniforms at a map's climate texture (null = no snow anywhere). */
export function bindClimate(grid: ClimateGrid | null, enabled: boolean): void {
  climateUniforms.uApField.value = grid?.texture ?? null
  climateUniforms.uApFieldSize.value.set((grid?.cols ?? 1) * (grid?.cell ?? 1), (grid?.rows ?? 1) * (grid?.cell ?? 1))
  climateUniforms.uApDust.value = enabled && grid?.texture ? D.amount : 0
}

/**
 * Patches a lit material so up-facing surfaces collect pixel-dithered snow from the climate snow field.
 * `root`: sample the field at the instance / object origin (props) instead of per vertex (terrain).
 */
export function applySnowDust<T extends THREE.Material>(material: T, root: boolean): T {
  if (material.userData.apDust) return material
  material.userData.apDust = true
  const prev = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer)
    Object.assign(shader.uniforms, climateUniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uApField;
uniform vec2 uApFieldSize;
varying float vApSnow;
varying float vApUp;
varying vec3 vApW;`)
      .replace('#include <project_vertex>', `{
  #ifdef USE_INSTANCING
    mat4 apM = modelMatrix * instanceMatrix;
  #else
    mat4 apM = modelMatrix;
  #endif
  vec4 apW = apM * vec4(transformed, 1.0);
  vApW = apW.xyz;
  ${root ? 'vec2 apS = (apM * vec4(0.0, 0.0, 0.0, 1.0)).xz;' : 'vec2 apS = apW.xz;'}
  vApSnow = texture2D(uApField, apS / uApFieldSize).r;
  vApUp = normalize(mat3(apM) * objectNormal).y;
}
#include <project_vertex>`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uApDustColor;
uniform float uApDust, uApDither, uApWeather;
uniform vec2 uApDustSlope, uApClump;
float apHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
varying float vApSnow;
varying float vApUp;
varying vec3 vApW;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float apCover = max(vApSnow * uApDust, uApWeather) * smoothstep(uApDustSlope.x, uApDustSlope.y, vApUp);
  vec3 apCell = floor(vApW * uApDither);
  // clumpy coverage: smooth value noise over pixel-snapped xz, roughened by a per-pixel hash
  vec2 apP = (apCell.xz + 0.5) / uApDither * uApClump.x;
  vec2 apI = floor(apP), apF = fract(apP);
  apF = apF * apF * (3.0 - 2.0 * apF);
  float apV = mix(mix(apHash(vec3(apI, 7.0)), apHash(vec3(apI + vec2(1.0, 0.0), 7.0)), apF.x),
                  mix(apHash(vec3(apI + vec2(0.0, 1.0), 7.0)), apHash(vec3(apI + vec2(1.0), 7.0)), apF.x), apF.y);
  float apT = mix(apHash(apCell), apV, uApClump.y);
  float apOn = step(apT, apCover * 1.15 - 0.05);
  float apLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = mix(diffuseColor.rgb, uApDustColor * (0.86 + 0.28 * clamp(apLum * 2.0, 0.0, 1.0)), apOn);
}`)
  }
  const prevKey = material.customProgramCacheKey.bind(material)
  material.customProgramCacheKey = () => `${prevKey()}|dust:${root ? 1 : 0}`
  return material
}

/** Biomes of the map that have a climate entry (validation helper). */
export function climateBiomesMissing(cfg: FieldsConfig = RENDER.fields): string[] {
  return CONTENT.biomes.filter((b) => !cfg.biomes[b.id]).map((b) => b.id)
}
