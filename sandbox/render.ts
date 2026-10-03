/// <reference types="vite/client" />
// Dev sandbox for the HD-2D renderer (src/client/render). Builds a procedural test map covering every terrain
// key, elevation, stairs, water, lava, tall grass and every prop key (or the real world with ?world=1 when
// src/shared/world/index.ts exists), then walks a character around it.
//
// URL params: ?t=<minutes> &speed=<game minutes per real second, 0 = frozen> &w=<weather> &wi=<0..1>
//             &zoom=<0..2> &x=&y= (start tile) &q=<low|medium|high|ultra> &interior=1 &world=1 &ref=1
//             &gen=<size> synthetic noise overworld (e.g. 1024) with every biome, towns and scattered nature
//             &biome=<id> start in that biome of the synthetic map
//             &bench=1 autopilot across the map (&bsec=seconds, &bspeed=tiles/s); results in window.__ap.bench
//             infinite world (?world=1): &x=&y= may be any integer (negative too); &biome=<id> jumps to the nearest
//             tile of that biome around x/y (&bscan=<tiles> search radius); &bench=1&bdir=<dx>,<dy> walks a straight
//             line (default 1,0) through freshly generated frontier; &map=<id> opens any map incl. fx: interiors
// Keys: WASD/arrows move (Shift run) · Z zoom · R weather · [ ] time · 1-4 quality · F flash · G shake
//       B battle transition · I iris · O fade · E world fx · H hop · N toggle names
import * as THREE from 'three'
import { CONTENT } from '../src/shared/content/index.ts'
import type { Dir, GameMap, PropPlacement, RegionDef, Settings } from '../src/shared/types.ts'
import type { Actor, AssetStore, CreatureActor, WorldFx } from '../src/client/contracts.ts'
import { createRenderer, createWorldView, footprintRect, RENDER, renderPattern } from '../src/client/render/index.ts'
import { createNoise, fbm2, hash01, mulberry32, seedOf, type FbmSpec } from '../src/client/render/noise.ts'
import { getMap, terrainAt as worldTerrainAt } from '../src/shared/world/worldapi.ts'
import scatterJson from '../content/world/scatter.json'

const errorsEl = document.getElementById('errors')!
const logError = (msg: string) => { errorsEl.textContent += `${msg}\n` }
window.addEventListener('error', (e) => logError(`error: ${e.message}`))
window.addEventListener('unhandledrejection', (e) => logError(`rejection: ${String(e.reason?.stack ?? e.reason)}`))
const origError = console.error.bind(console)
console.error = (...a: unknown[]) => { logError(a.map(String).join(' ').slice(0, 400)); origError(...a) }

const params = new URLSearchParams(location.search)
/** Automation hook for screenshot scripts: frame counter + phase timings. */
const probe = { frames: 0, phase: 'boot', timings: {} as Record<string, number>, bench: null as null | Record<string, unknown>, benchLive: null as null | Record<string, number>, error: '', gen: null as null | Record<string, unknown> }
;(window as unknown as { __ap: typeof probe }).__ap = probe
const mark = (phase: string) => { probe.timings[phase] = Math.round(performance.now()); probe.phase = phase }
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d)

// ---------------------------------------------------------------------------
// Asset store: the core store when present, else a minimal local canvas store.
// ---------------------------------------------------------------------------

const coreAssets = import.meta.glob('../src/client/core/assets.ts')
const worldMods = import.meta.glob('../src/shared/world/index.ts')

function localStore(): AssetStore {
  const cache = new Map<string, THREE.Texture>()
  const tex = (key: string, make: () => HTMLCanvasElement) => {
    let t = cache.get(key)
    if (!t) {
      t = new THREE.CanvasTexture(make())
      t.colorSpace = THREE.SRGBColorSpace
      t.magFilter = t.minFilter = THREE.NearestFilter
      t.generateMipmaps = false
      cache.set(key, t)
    }
    return t
  }
  const terrainColor = (key: string) => CONTENT.terrainByKey[key]?.minimap ?? CONTENT.terrainByKey[CONTENT.biomes.find((b) => b.cliff === key)?.groundTerrain ?? '']?.minimap ?? RENDER.terrain.fallbackColor
  const blob = (w: number, h: number, color: string) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h
    const g = c.getContext('2d')!
    g.fillStyle = color
    g.beginPath(); g.ellipse(w / 2, h * 0.62, w * 0.3, h * 0.34, 0, 0, Math.PI * 2); g.fill()
    return c
  }
  return {
    manifest: { creatures: [], characters: [], portraits: [], textures: [], models: [], items: [], bgm: [], ui: [] },
    async init() {},
    has: () => false,
    creatureTexture: (id) => tex(`c:${id}`, () => blob(128, 128, CONTENT.rarityById[CONTENT.species[id]?.rarity ?? '']?.color ?? '#ffffff')),
    creatureImageUrl: () => '',
    characterTexture: (id) => tex(`ch:${id}`, () => {
      const s = CONTENT.config.sprites, rows = Math.max(...Object.values(s.sheetRows)) + 1
      const c = document.createElement('canvas'); c.width = s.sheetCell * s.sheetFrames; c.height = s.sheetCell * rows
      const g = c.getContext('2d')!
      for (let r = 0; r < rows; r++) for (let f = 0; f < s.sheetFrames; f++) g.drawImage(blob(s.sheetCell, s.sheetCell, '#e86a6a'), f * s.sheetCell, r * s.sheetCell)
      return c
    }),
    characterImageUrl: () => '',
    portraitUrl: () => null,
    terrainTexture: (key) => tex(`t:${key}`, () => renderPattern({ id: key.startsWith('cliff') ? 'stone' : 'noise', color: terrainColor(key) })),
    textureUrl: () => null,
    itemIconUrl: () => '',
    loadModel: async () => null,
    bgmUrl: () => null,
    uiUrl: () => null,
  }
}

/** ?ref=1: use the chroma-keyed reference walk sheet for every character (art direction check). */
async function referenceSheet(): Promise<THREE.Texture | null> {
  const img = new Image()
  img.src = '/assets_src/walk_sheet_reference.png'
  try { await img.decode() } catch { return null }
  const s = CONTENT.config.sprites, rows = Math.max(...Object.values(s.sheetRows)) + 1
  const c = document.createElement('canvas'); c.width = s.sheetCell * s.sheetFrames; c.height = s.sheetCell * rows
  const g = c.getContext('2d')!
  g.imageSmoothingEnabled = false
  g.drawImage(img, 0, 0, c.width, c.height)
  const d = g.getImageData(0, 0, c.width, c.height)
  for (let i = 0; i < d.data.length; i += 4) if (d.data[i] > 170 && d.data[i + 2] > 170 && d.data[i + 1] < 110) d.data[i + 3] = 0
  g.putImageData(d, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.magFilter = t.minFilter = THREE.NearestFilter
  t.generateMipmaps = false
  return t
}

// ---------------------------------------------------------------------------
// Procedural test maps (terrain/props chosen generically from CONTENT + render.json)
// ---------------------------------------------------------------------------

const T = CONTENT.terrain
const surf = (k: string) => RENDER.terrain.surfaces[k]
const pickT = (pred: (t: (typeof T)[number]) => boolean, fallback = 1) => (T.find(pred) ?? T[fallback])
const deepWater = pickT((t) => surf(t.key)?.kind === 'water' && (surf(t.key)?.deep ?? 0) >= 0.5)
const shallowWater = pickT((t) => surf(t.key)?.kind === 'water' && (surf(t.key)?.deep ?? 1) < 0.5)
const lavaT = pickT((t) => surf(t.key)?.kind === 'lava')
const stairsT = pickT((t) => !!t.stairs)
const wallT = pickT((t) => surf(t.key)?.kind === 'wall')
const voidT = pickT((t) => surf(t.key)?.kind === 'none', 0)
const grassKinds = T.filter((t) => t.tallGrass)
const plainGround = (biomeIdx: number) => CONTENT.terrainByKey[CONTENT.biomes[biomeIdx % CONTENT.biomes.length].groundTerrain] ?? T[1]
const pathT = pickT((t) => t.walkable && !t.liquid && t.speed > 1 && !surf(t.key))
const pavedT = T.filter((t) => t.walkable && !t.liquid && t.speed > 1)[1] ?? pathT

interface Draft { w: number; h: number; terrain: Uint8Array; elevation: Uint8Array; region: Uint8Array; props: PropPlacement[] }
function draft(w: number, h: number, fill: number): Draft {
  return { w, h, terrain: new Uint8Array(w * h).fill(fill), elevation: new Uint8Array(w * h), region: new Uint8Array(w * h), props: [] }
}
const setT = (d: Draft, x: number, y: number, id: number) => { if (x >= 0 && y >= 0 && x < d.w && y < d.h) d.terrain[y * d.w + x] = id }
const setE = (d: Draft, x: number, y: number, e: number) => { if (x >= 0 && y >= 0 && x < d.w && y < d.h) d.elevation[y * d.w + x] = e }
const rect = (d: Draft, x0: number, y0: number, w: number, h: number, f: (x: number, y: number) => void) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) f(x, y) }
const place = (d: Draft, prop: string, x: number, y: number, rot: 0 | 1 | 2 | 3 = 0, variant?: number) => { if (CONTENT.props[prop]) d.props.push({ prop, x, y, rot, variant }) }
const propsWhere = (pred: (p: (typeof CONTENT.props)[string]) => boolean) => Object.values(CONTENT.props).filter(pred).map((p) => p.key)
const regionsFor = (): RegionDef[] => CONTENT.biomes.map((b) => ({ id: b.id, nameZh: b.nameZh, biome: b.id, music: '', encounters: [], encounterRate: 0, roamingDensity: 0 }))

function toMap(d: Draft, id: string, kind: GameMap['kind'], spawn: { x: number; y: number }): GameMap {
  return {
    id, nameZh: id, kind, width: d.w, height: d.h, terrain: d.terrain, elevation: d.elevation, region: d.region,
    regions: regionsFor(), props: d.props, warps: [], npcs: [], signs: [], items: [], lights: [],
    spawn: { ...spawn, facing: 'down' }, outdoor: kind === 'overworld', music: '',
  }
}

function overworldTestMap(): GameMap {
  const W = 96, H = 92
  const d = draft(W, H, plainGround(0).id)
  const rnd = (() => { let s = 12345; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296) })()

  // town plateau (level 1) with a stairs flight on its south edge
  rect(d, 12, 14, 30, 20, (x, y) => setE(d, x, y, 1))
  for (const x of [26, 27]) { setT(d, x, 34, stairsT.id); setE(d, x, 34, 0) }
  rect(d, 26, 16, 2, 18, (x, y) => setT(d, x, y, pathT.id))
  rect(d, 14, 24, 26, 2, (x, y) => setT(d, x, y, pavedT.id))
  rect(d, 26, 35, 2, 8, (x, y) => setT(d, x, y, pathT.id))
  // NE highland (levels 2-3) + stairs
  rect(d, 48, 4, 18, 14, (x, y) => setE(d, x, y, 2))
  rect(d, 52, 6, 10, 7, (x, y) => setE(d, x, y, 3))
  rect(d, 48, 4, 18, 14, (x, y) => (d.region[y * W + x] = 7))
  setT(d, 56, 13, stairsT.id); setE(d, 56, 13, 2)
  setT(d, 56, 18, stairsT.id); setE(d, 56, 18, 1)
  rect(d, 55, 18, 3, 1, (x, y) => setE(d, x, y, x === 56 ? 1 : 2))
  setE(d, 56, 19, 1); setE(d, 56, 20, 0); setT(d, 56, 20, stairsT.id)
  rect(d, 54, 19, 5, 1, (x, y) => { if (x !== 56) setE(d, x, y, 1) })
  // lake: shallow rim, deep centre, bridge
  for (let y = 22; y < 48; y++) for (let x = 0; x < 12; x++) {
    const r = Math.hypot((x - 4) / 7.5, (y - 35) / 12)
    if (r < 1) setT(d, x, y, r < 0.72 ? deepWater.id : shallowWater.id)
  }
  // tall grass meadow south of town, one patch per tall-grass terrain
  grassKinds.forEach((g, i) => rect(d, 14 + i * 7, 46, 6, 6, (x, y) => { if (rnd() > 0.12) setT(d, x, y, g.id) }))
  // themed biome strip to the east
  const bands = CONTENT.biomes.length
  for (let b = 0; b < bands; b++) {
    const y0 = 22 + b * 6
    if (y0 + 6 > H) break
    rect(d, 66, y0, 30, 6, (x, y) => { d.region[y * W + x] = b; setT(d, x, y, plainGround(b).id); setE(d, x, y, b % 2) })
  }
  rect(d, 80, 70, 5, 4, (x, y) => setT(d, x, y, lavaT.id))
  // terrain swatches: every key, alternating levels
  T.forEach((t, i) => {
    if (t.id === voidT.id) return
    const x0 = 2 + (i % 16) * 4, y0 = 56 + Math.floor(i / 16) * 4
    rect(d, x0, y0, 3, 3, (x, y) => { setT(d, x, y, t.id); setE(d, x, y, t.stairs ? 0 : i % 2) })
  })
  // void hole to check map-edge skirts
  rect(d, 70, 4, 4, 4, (x, y) => setT(d, x, y, voidT.id))

  // town props
  const buildings = propsWhere((p) => !!p.door && p.footprint[0] <= 8)
  let bx = 14
  for (const k of buildings.slice(0, 4)) {
    const def = CONTENT.props[k]
    if (bx + def.footprint[0] > 26) break
    place(d, k, bx, 23 - def.footprint[1], 0)
    bx += def.footprint[0] + 1
  }
  bx = 29
  for (const k of buildings.slice(4, 7)) {
    const def = CONTENT.props[k]
    if (bx + def.footprint[0] > 41) break
    place(d, k, bx, 23 - def.footprint[1], 0)
    bx += def.footprint[0] + 1
  }
  const lights = propsWhere((p) => !!p.light?.nightOnly && p.footprint[0] === 1 && p.height > 2 && p.height < 3)
  for (const x of [17, 22, 31, 36]) place(d, lights[0] ?? 'lamp', x, 26)
  for (const y of [28, 31]) { place(d, lights[0] ?? 'lamp', 25, y); place(d, lights[0] ?? 'lamp', 28, y) }
  const fountains = propsWhere((p) => !!p.light && p.footprint[0] === 3)
  if (fountains[0]) place(d, fountains[0], 32, 28)
  const decor = propsWhere((p) => !p.door && p.footprint[0] <= 2 && p.height < 1.3 && !p.sway && !p.light)
  for (let i = 0; i < 10; i++) place(d, decor[i % decor.length], 14 + (i % 5) * 2, 28 + Math.floor(i / 5) * 3)
  const trees = propsWhere((p) => !!p.sway && p.height > 2.5)
  const small = propsWhere((p) => !!p.sway && p.height <= 1)
  // forest ring + scattered nature
  for (let i = 0; i < 260; i++) {
    const x = Math.floor(rnd() * 66), y = Math.floor(rnd() * 54)
    const inTown = x >= 11 && x <= 42 && y >= 13 && y <= 35
    const inLake = x < 13 && y > 20 && y < 49
    const inHigh = x >= 47 && y < 19
    if (inTown || inLake || (x >= 25 && x <= 29 && y >= 34)) continue
    if (y >= 45 && y <= 52 && x >= 13 && x < 14 + grassKinds.length * 7) continue
    const r = rnd()
    place(d, r < 0.55 ? trees[Math.floor(rnd() * trees.length)] : small[Math.floor(rnd() * small.length)], x, y, 0)
  }
  for (let i = 0; i < 12; i++) place(d, trees[i % trees.length], 49 + (i * 5) % 16, 4 + (i * 3) % 12)
  // themed strip props: everything without a door, cycling along the bands
  const themed = propsWhere((p) => !p.door && p.footprint[0] <= 2 && p.footprint[1] <= 2)
  themed.forEach((k, i) => place(d, k, 67 + (i * 3) % 27, 23 + Math.floor((i * 3) / 27) * 6 + ((i % 2) ? 2 : 0)))
  // prop gallery: every prop key, row-packed by footprint
  let gx = 2, gy = 69, rowH = 0
  for (const def of Object.values(CONTENT.props)) {
    const [w, h] = def.footprint
    if (gx + w > 78) { gx = 2; gy += rowH + 2; rowH = 0 }
    if (gy + h >= H) break
    place(d, def.key, gx, gy, 0)
    gx += w + 1
    rowH = Math.max(rowH, h)
  }
  return toMap(d, 'render-test', 'overworld', { x: 26, y: 38 })
}

function interiorTestMap(): GameMap {
  const W = 18, H = 13
  const d = draft(W, H, voidT.id)
  const floors = T.filter((t) => t.walkable && !t.liquid && !t.tallGrass && !t.encounter && !t.stairs && t.speed <= 1.0 && t.speed >= 1.0)
  const floor = floors.find((t) => surf(t.key)?.kind === 'glossy') ?? floors[0]
  const carpet = floors[floors.length - 1]
  rect(d, 1, 1, W - 2, H - 2, (x, y) => {
    const edge = x === 1 || y === 1 || x === W - 2 || y === H - 2
    setT(d, x, y, edge ? wallT.id : floor.id)
  })
  setT(d, 8, H - 2, floor.id); setT(d, 9, H - 2, floor.id)
  rect(d, 6, 6, 6, 3, (x, y) => setT(d, x, y, carpet.id))
  const furniture = propsWhere((p) => !p.door && !p.sway && p.height <= 2.4 && p.footprint[0] <= 4 && p.footprint[1] <= 2 && !p.light?.nightOnly)
  let x = 2
  for (const k of furniture) {
    const def = CONTENT.props[k]
    if (x + def.footprint[0] > W - 2) break
    place(d, k, x, 2, 0)
    x += def.footprint[0]
  }
  const rest = furniture.slice(furniture.findIndex((k) => !d.props.some((p) => p.prop === k)))
  x = 2
  for (const k of rest.slice(0, 6)) { place(d, k, x, 9, 0); x += CONTENT.props[k].footprint[0] + 1 }
  const m = toMap(d, 'render-interior', 'interior', { x: 9, y: 10 })
  m.lights = [{ x: 9, y: 6.5, h: 2.4, color: RENDER.interior.sun, intensity: 1.2, radius: 8, nightOnly: false }]
  return m
}


// ---------------------------------------------------------------------------
// Synthetic large overworld (?gen=1024): warped Voronoi biomes, noise elevation terraces, sea + lakes, paths, city
// blocks with buildings and lamps, biome nature scatter. Test data for the streaming renderer only.
// ---------------------------------------------------------------------------

interface SynthMap { map: GameMap; sites: { x: number; y: number; biome: string }[] }
interface ScatterNoise { scale: number; octaves: number; gain?: number; lacunarity?: number; salt?: string }
interface ScatterTable {
  biomes: Record<string, {
    ground: string
    layers: { terrain: string; noise: ScatterNoise; min: number; on?: string[]; pathDist?: number[] }[]
    props: { prop: string; density: number; noise?: ScatterNoise; min?: number; on?: string[]; avoidPath?: number }[]
  }>
}
const SCATTER = scatterJson as unknown as ScatterTable
const specCache = new Map<ScatterNoise, FbmSpec>()
const specOf = (s: ScatterNoise): FbmSpec => {
  let v = specCache.get(s)
  if (!v) { v = { scale: s.scale, octaves: s.octaves, gain: s.gain, lacunarity: s.lacunarity, salt: (seedOf(s.salt ?? '') % 997) + 1 }; specCache.set(s, v) }
  return v
}

function synthMap(size: number): SynthMap {
  const W = size, H = size
  const tk = (k: string) => CONTENT.terrainByKey[k]?.id ?? 1
  const d = draft(W, H, tk('grass'))
  const rnd = mulberry32(20261002)
  const n = createNoise(77)
  const biomes = CONTENT.biomes.map((b) => b.id)
  // biome sites on a jittered grid, every biome present
  const grid = Math.max(3, Math.round(size / 170))
  const order = biomes.flatMap(() => biomes).slice(0, grid * grid)
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
  const sites: SynthMap['sites'] = []
  for (let gy = 0; gy < grid; gy++) for (let gx = 0; gx < grid; gx++) {
    sites.push({ x: (gx + 0.2 + rnd() * 0.6) * W / grid, y: (gy + 0.2 + rnd() * 0.6) * H / grid, biome: order[gy * grid + gx] ?? biomes[(gx + gy) % biomes.length] })
  }
  const biomeIdx = (id: string) => CONTENT.biomes.findIndex((b) => b.id === id)
  const lift: Record<string, [number, number]> = { snow: [3, 8], volcano: [2, 7], highland: [2, 6], ruins: [1, 4], forest: [1, 4], meadow: [0, 3], desert: [0, 3], city: [1, 1], coast: [0, 2], swamp: [0, 1] }
  const siteOf = new Uint8Array(W * H)
  const F = (x: number, y: number, scale: number, oct = 3, salt = 0) => fbm2(n, x, y, { scale, octaves: oct, salt })
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const wx = x + (F(x, y, 90, 2, 1) - 0.5) * 110, wy = y + (F(x, y, 90, 2, 2) - 0.5) * 110
    let best = 0, bd = Infinity
    for (let s = 0; s < sites.length; s++) { const dd = (sites[s].x - wx) ** 2 + (sites[s].y - wy) ** 2; if (dd < bd) { bd = dd; best = s } }
    siteOf[y * W + x] = best
  }
  const T = d.terrain, E = d.elevation, R = d.region
  const onPath = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    const b = sites[siteOf[i]].biome
    R[i] = Math.max(0, biomeIdx(b))
    const [lo, hi] = lift[b] ?? [0, 3]
    const h = F(x, y, 110, 4, 3)
    let lvl = Math.round(lo + (hi - lo) * Math.min(1, Math.max(0, (h - 0.25) / 0.55)))
    const sea = F(x, y, 380, 3, 4)
    const lake = F(x, y, 46, 2, 5)
    // ground + noise layers straight from the worldgen scatter table (route-only layers skipped)
    const sb = SCATTER.biomes[b]
    let t = sb?.ground ?? 'grass'
    for (const l of sb?.layers ?? []) {
      if (l.pathDist || (l.on && !l.on.includes(t))) continue
      if (fbm2(n, x, y, specOf(l.noise)) > l.min) t = l.terrain
    }
    if (b === 'city' && (x % 14 < 2 || y % 14 < 2)) t = 'cobble'
    // winding paths (ridge lines of a noise field)
    const pth = Math.abs(F(x, y, 160, 2, 15) - 0.5)
    if (pth < 0.008 && b !== 'city') { t = b === 'snow' ? 'snow' : 'path'; onPath[i] = 1 }
    // water: sea on low continental noise, lakes, swamp pools, lava pools
    if (sea < 0.3) { t = sea < 0.26 ? 'water' : 'shallow'; lvl = 0 }
    else if (sea < 0.33 && b !== 'city') { t = 'sand'; lvl = Math.min(lvl, 1) }
    else if (lake > 0.74 && b !== 'city' && b !== 'volcano') { t = b === 'snow' ? 'ice' : lake > 0.77 ? 'water' : 'shallow' }
    else if (b === 'swamp' && F(x, y, 10, 2, 16) > 0.68) t = 'shallow'
    else if (b === 'volcano' && F(x, y, 22, 2, 17) > 0.74) t = 'lava'
    T[i] = tk(t)
    E[i] = lvl
  }
  // lakes / pools sit flat at the lowest level of their surroundings
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x
    if (!CONTENT.terrain[T[i]]?.liquid) continue
    E[i] = Math.min(E[i], E[i - 1], E[i - W])
  }
  // props
  const occupied = new Uint8Array(W * H)
  const free = (x: number, y: number, w: number, h: number) => {
    if (x < 1 || y < 1 || x + w >= W - 1 || y + h >= H - 1) return false
    const e = E[y * W + x]
    for (let j = y; j < y + h; j++) for (let k = x; k < x + w; k++) {
      const i = j * W + k
      const t = CONTENT.terrain[T[i]]
      if (occupied[i] || !t?.walkable || t.liquid || E[i] !== e || t.key === 'path' || t.key === 'cobble') return false
    }
    return true
  }
  const put = (prop: string, x: number, y: number, rot: 0 | 1 | 2 | 3 = 0) => {
    const def = CONTENT.props[prop]
    if (!def) return false
    const w = rot & 1 ? def.footprint[1] : def.footprint[0], h = rot & 1 ? def.footprint[0] : def.footprint[1]
    if (!free(x, y, w, h)) return false
    for (let j = y; j < y + h; j++) for (let k = x; k < x + w; k++) occupied[j * W + k] = 1
    d.props.push({ prop, x, y, rot })
    return true
  }
  // city blocks: one building per 14x14 block, lamps at crossings
  const buildings = ['house_small', 'house_large', 'shop', 'center', 'house_small', 'lab', 'tower', 'datacenter', 'house_large', 'gym']
  for (let by = 0; by < H; by += 14) for (let bx = 0; bx < W; bx += 14) {
    const ci = (by + 7) * W + (bx + 7)
    if (ci >= W * H || sites[siteOf[ci]].biome !== 'city') continue
    const k = buildings[Math.floor(hash01(bx, by, 3) * buildings.length)]
    const def = CONTENT.props[k]
    if (def) put(k, bx + 2 + Math.max(0, Math.floor((12 - def.footprint[0]) / 2)), by + 2 + Math.max(0, Math.floor((12 - def.footprint[1]) / 2)))
    put('lamp', bx + 2, by + 2)
    if (hash01(bx, by, 5) < 0.5) put('bench', bx + 9, by + 12 - 1)
    if (hash01(bx, by, 6) < 0.4) put('tree_oak', bx + 12, by + 3)
  }
  const nearPath = (x: number, y: number, r: number) => {
    for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++) if (onPath[(y + j) * W + x + k]) return true
    return false
  }
  const pad = 4
  for (let y = pad; y < H - pad; y++) for (let x = pad; x < W - pad; x++) {
    const i = y * W + x
    if (occupied[i]) continue
    const list = SCATTER.biomes[sites[siteOf[i]].biome]?.props
    if (!list) continue
    const u = hash01(x, y, 11)
    const tKey = CONTENT.terrain[T[i]]?.key ?? ''
    let acc = 0
    for (const r of list) {
      if (r.on && !r.on.includes(tKey)) continue
      const dd = r.noise ? (fbm2(n, x, y, specOf(r.noise)) > (r.min ?? 0.5) ? r.density : 0) : r.density
      acc += dd
      if (u < acc) { if (!(r.avoidPath && nearPath(x, y, Math.min(pad, r.avoidPath)))) put(r.prop, x, y); break }
    }
  }
  const m = toMap(d, `synth-${size}`, 'overworld', { x: Math.floor(W / 2), y: Math.floor(H / 2) })
  // spawn on a free walkable tile near the centre
  for (let r = 0; r < 200; r++) {
    const x = Math.floor(W / 2) + r, y = Math.floor(H / 2)
    const t = CONTENT.terrain[T[y * W + x]]
    if (t?.walkable && !t.liquid && !occupied[y * W + x]) { m.spawn = { x, y, facing: 'down' }; break }
  }
  return { map: m, sites }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const canvas = document.getElementById('c') as HTMLCanvasElement
  const overlay = document.getElementById('overlay')!
  const hud = document.getElementById('hud')!
  const settings: Settings = { ...CONTENT.config.defaultSettings }
  const q = params.get('q')
  if (q && q in CONTENT.config.render.internalHeight) settings.quality = q as Settings['quality']

  let assets: AssetStore
  const coreLoader = coreAssets['../src/client/core/assets.ts']
  if (coreLoader) {
    const mod = (await coreLoader()) as { createAssetStore(): AssetStore }
    assets = mod.createAssetStore()
  } else assets = localStore()
  await assets.init()
  mark('assets')
  if (params.get('ref') === '1') {
    const ref = await referenceSheet()
    if (ref) assets = { ...assets, characterTexture: () => ref, has: assets.has.bind(assets) }
  }

  const renderer = createRenderer(canvas, settings)
  const resize = () => renderer.resize(innerWidth, innerHeight)
  addEventListener('resize', resize)
  resize()
  const world = createWorldView(renderer, assets, overlay)

  let map: GameMap
  let synth: SynthMap | null = null
  const worldLoader = worldMods['../src/shared/world/index.ts']
  if (params.has('gen')) {
    const t0 = performance.now()
    synth = synthMap(Math.max(64, Number(params.get('gen')) || 1024))
    map = synth.map
    probe.gen = { ms: Math.round(performance.now() - t0), size: map.width, props: map.props.length }
    const want = params.get('biome')
    const site = want ? synth.sites.find((s) => s.biome === want) : null
    if (site) {
      // nearest free walkable tile to the site centre
      for (let r = 0; r < 120; r++) {
        const x = Math.floor(site.x) + (r % 2 ? -1 : 1) * (r >> 1), y = Math.floor(site.y)
        if (x < 2 || x >= map.width - 2) continue
        const t = CONTENT.terrain[map.terrain[y * map.width + x]]
        if (t?.walkable && !t.liquid) { map.spawn = { x, y, facing: 'down' }; break }
      }
    }
  } else if (params.get('world') === '1' && worldLoader) {
    const mod = (await worldLoader()) as { buildWorld(): { maps: Record<string, GameMap>; startMap: string } }
    const w = mod.buildWorld()
    map = getMap(w as never, params.get('map') ?? w.startMap) ?? w.maps[w.startMap]
    const p = map.infinite
    const want = params.get('biome')
    if (p && want) {
      // ring scan of cheap samples around the requested start for a walkable tile of that biome
      const ox = num('x', map.spawn.x), oy = num('y', map.spawn.y), max = num('bscan', 3000)
      let hit: { x: number; y: number } | null = null
      for (let r = 0; r <= max && !hit; r += 24) {
        const n = Math.max(1, Math.round((2 * Math.PI * r) / 24))
        for (let k = 0; k < n && !hit; k++) {
          const x = Math.round(ox + Math.cos((k / n) * Math.PI * 2) * r), y = Math.round(oy + Math.sin((k / n) * Math.PI * 2) * r)
          const sm = p.sample(x, y)
          const t = CONTENT.terrain[sm.terrain]
          if (sm.biome === want && t?.walkable && !t.liquid) hit = { x, y }
        }
      }
      if (hit) { params.set('x', String(hit.x)); params.set('y', String(hit.y)) }
      probe.gen = { biome: want, found: hit }
    }
    if (p) map.spawn = { x: num('x', map.spawn.x), y: num('y', map.spawn.y), facing: 'down' }
  } else map = params.get('interior') === '1' ? interiorTestMap() : overworldTestMap()
  // &near=<prop key>: start next to the instance of that prop closest to the requested / spawn position
  const nearKey = params.get('near')
  if (nearKey) {
    const ox = num('x', map.spawn.x), oy = num('y', map.spawn.y)
    let best: PropPlacement | null = null, bd = Infinity
    for (const p of map.props) if (p.prop === nearKey) { const d = (p.x - ox) ** 2 + (p.y - oy) ** 2; if (d < bd) { bd = d; best = p } }
    if (best) { map.spawn = { x: best.x, y: Math.min(map.height - 2, best.y + 2), facing: 'down' }; params.set('x', String(best.x)); params.set('y', String(map.spawn.y)) }
  }
  const loading = document.getElementById('loading')!
  mark('mapReady')
  const loadT0 = performance.now()
  await world.loadMap(map, { onProgress: (p) => { loading.textContent = `loading ${(p * 100) | 0}%` } })
  probe.timings.loadMapMs = Math.round(performance.now() - loadT0)
  loading.remove()
  mark('loaded')
  Object.assign(window, { __apScene: () => world.renderView().scene, __apWorld: world, __apRenderer: renderer })

  const playable = CONTENT.characters.find((c) => c.playable) ?? CONTENT.characters[0]
  const player = world.createActor({ sheet: playable.id, name: playable.nameZh, kind: 'player' })
  Object.assign(window, { __apPlayer: player })
  const pos = { x: num('x', map.spawn.x) + 0.5, y: num('y', map.spawn.y) + 0.5 }
  // free walkable tiles (no prop footprint) in a spiral around the spawn, for NPCs and creatures
  const blocked = new Set<number>()
  for (const p of map.infinite ? [] : map.props) {
    const def = CONTENT.props[p.prop]
    if (!def || !def.collide) continue
    const r = footprintRect(p, def)
    for (let y = r.y0; y < r.y0 + r.d; y++) for (let x = r.x0; x < r.x0 + r.w; x++) blocked.add(y * map.width + x)
  }
  const used = new Set<number>([Math.floor(pos.y) * map.width + Math.floor(pos.x)])
  const freeSpot = (minDist: number) => {
    for (let r = minDist; r < 24; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
      const x = Math.floor(pos.x) + dx, y = Math.floor(pos.y) + dy, i = y * map.width + x
      if (!map.infinite && (x < 0 || y < 0 || x >= map.width || y >= map.height)) continue
      if (used.has(i) || blocked.has(i)) continue
      const t = CONTENT.terrain[map.infinite ? worldTerrainAt(map, x, y) : map.terrain[i]]
      if (!t?.walkable || t.liquid) continue
      used.add(i)
      return { x: x + 0.5, y: y + 0.5 }
    }
    return { x: pos.x, y: pos.y }
  }
  const npcs: Actor[] = []
  CONTENT.characters.filter((c) => !c.playable).slice(0, 3).forEach((c, i) => {
    const a = world.createActor({ sheet: c.id, name: c.nameZh, kind: 'npc' })
    const { x: nx, y: ny } = freeSpot(2 + i)
    a.setPosition(nx, ny, world.elevationAt(nx, ny))
    a.setFacing((['down', 'left', 'right'] as Dir[])[i])
    npcs.push(a)
  })
  const creatures: { c: CreatureActor; x: number; y: number; t: number }[] = []
  CONTENT.speciesList.slice(0, 4).forEach((s, i) => {
    const c = world.createCreatureActor(s.id, i === 1)
    const testMap = map.id === 'render-test'
    const spot = testMap ? { x: 15.5 + i * 7, y: 48.5 } : freeSpot(4)
    const { x, y } = spot
    if (map.kind === 'interior') return void c.dispose()
    c.setPosition(x, y, world.elevationAt(x, y))
    const r = CONTENT.rarityById[s.rarity]
    c.setAura(r?.aura ? r.color : i === 1 ? CONTENT.rarities.find((x) => x.aura)?.color ?? null : null)
    creatures.push({ c, x, y, t: i })
  })
  world.setGroundItems([{ id: 'a', x: Math.floor(pos.x) + 2, y: Math.floor(pos.y) + 1 }, { id: 'b', x: 30, y: 47 }])

  let minutes = num('t', CONTENT.config.time.startMinutes)
  const speed = num('speed', params.has('t') ? 0 : 1440 / CONTENT.config.time.dayRealSeconds)
  let zoom = num('zoom', 1)
  world.setZoom(zoom)
  const weathers = Object.keys(RENDER.weather)
  let weatherIdx = Math.max(0, weathers.indexOf(params.get('w') ?? 'clear'))
  const applyWeather = () => world.setWeather({ kind: weathers[weatherIdx] as never, intensity: num('wi', 1) })
  applyWeather()

  const keys = new Set<string>()
  let transition: { kind: 'battle' | 'iris' | 'fade'; t: number } | null = null
  const fxKinds = Object.keys(RENDER.fx.kinds) as WorldFx[]
  let fxIdx = 0
  addEventListener('keydown', (e) => {
    keys.add(e.code)
    const s = renderer.settings
    switch (e.code) {
      case 'KeyZ': zoom = (zoom + 1) % CONTENT.config.camera.zoomDistances.length; world.setZoom(zoom); break
      case 'KeyR': weatherIdx = (weatherIdx + 1) % weathers.length; applyWeather(); break
      case 'BracketLeft': minutes -= 60; break
      case 'BracketRight': minutes += 60; break
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
        renderer.applySettings({ ...s, quality: (['low', 'medium', 'high', 'ultra'] as const)[Number(e.code.slice(5)) - 1] }); resize(); break
      case 'KeyN': renderer.applySettings({ ...s, showNames: !s.showNames }); break
      case 'KeyF': renderer.flash(); break
      case 'KeyG': renderer.shake(0.25, 400); break
      case 'KeyB': transition = { kind: 'battle', t: 0 }; break
      case 'KeyI': transition = { kind: 'iris', t: 0 }; break
      case 'KeyO': transition = { kind: 'fade', t: 0 }; break
      case 'KeyE': world.spawnFx(fxKinds[fxIdx++ % fxKinds.length], pos.x, pos.y, world.elevationAt(pos.x, pos.y)); break
      case 'KeyH': player.hop(); player.bubble('!'); break
    }
  })
  addEventListener('keyup', (e) => keys.delete(e.code))

  // ?bench=1: autopilot through every biome site (synthetic map) or along a square loop, measuring frames
  const bench = params.get('bench') === '1' ? (() => {
    const speedT = num('bspeed', CONTENT.config.movement.runSpeed)
    const seconds = num('bsec', 40)
    const pts: { x: number; y: number }[] = []
    // visit one site per biome in nearest-neighbour order (synthetic sites, or the largest region of each biome)
    const tour = (sites: { x: number; y: number; biome: string }[]) => {
      const seen = new Set<string>()
      let cur = { x: pos.x, y: pos.y }
      for (let k = 0; k < sites.length; k++) {
        let best = null as null | { x: number; y: number; biome: string }, bd = Infinity
        for (const s2 of sites) { if (seen.has(s2.biome)) continue; const dd = Math.hypot(s2.x - cur.x, s2.y - cur.y); if (dd < bd) { bd = dd; best = s2 } }
        if (!best) break
        seen.add(best.biome); pts.push(best); cur = best
      }
    }
    if (synth) tour(synth.sites)
    else if (map.infinite) {
      const [dx, dy] = (params.get('bdir') ?? '1,0').split(',').map(Number)
      const l = Math.hypot(dx, dy) || 1
      pts.push({ x: pos.x + (dx / l) * 1e6, y: pos.y + (dy / l) * 1e6 })
    } else if (map.width >= 256) {
      const acc = new Map<number, { x: number; y: number; n: number }>()
      for (let y = 0; y < map.height; y += 4) for (let x = 0; x < map.width; x += 4) {
        const r = map.region[y * map.width + x]
        const a = acc.get(r) ?? { x: 0, y: 0, n: 0 }
        a.x += x; a.y += y; a.n++
        acc.set(r, a)
      }
      const regions = [...acc.entries()].filter(([r]) => map.regions[r]).sort((a, b) => b[1].n - a[1].n)
      tour(regions.map(([r, a]) => ({ x: a.x / a.n, y: a.y / a.n, biome: map.regions[r].biome })))
    } else for (const [dx, dy] of [[20, 0], [20, 20], [0, 20], [0, 0]]) pts.push({ x: Math.min(map.width - 2, pos.x + dx), y: Math.min(map.height - 2, pos.y + dy) })
    return { speedT, seconds, pts, i: 0, t: 0, frames: [] as number[], cpu: [] as number[], build: [] as number[], calls: [] as number[], tris: [] as number[], geo: [] as number[], tex: [] as number[], slots: [] as number[], dist: 0, start: 0, done: false,
      spikes: [] as Record<string, number>[], samples: [] as Record<string, number>[], lastSample: 0, progSeen: 0 }
  })() : null

  let last = performance.now()
  let fpsAcc = 0, fpsN = 0, fps = 0
  const frame = (now: number) => {
    try { step(now) } catch (e) { probe.error = String((e as Error)?.stack ?? e); throw e }
    requestAnimationFrame(frame)
  }
  const step = (now: number) => {
    const cpu0 = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    fpsAcc += dt; fpsN++
    if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0 }
    minutes = (minutes + speed * dt + 1440) % 1440

    let ax = 0, ay = 0
    if (keys.has('KeyA') || keys.has('ArrowLeft')) ax -= 1
    if (keys.has('KeyD') || keys.has('ArrowRight')) ax += 1
    if (keys.has('KeyW') || keys.has('ArrowUp')) ay -= 1
    if (keys.has('KeyS') || keys.has('ArrowDown')) ay += 1
    if (bench && !bench.done && bench.pts.length) {
      const target = bench.pts[bench.i % bench.pts.length]
      const dx = target.x - pos.x, dy = target.y - pos.y
      if (Math.hypot(dx, dy) < 2) bench.i++
      else { ax = dx; ay = dy }
    }
    const running = keys.has('ShiftLeft') || keys.has('ShiftRight') || !!bench
    const moving = ax !== 0 || ay !== 0
    if (moving) {
      const len = Math.hypot(ax, ay)
      const sp = bench ? bench.speedT : running ? CONTENT.config.movement.runSpeed : CONTENT.config.movement.walkSpeed
      const nx = pos.x + (ax / len) * sp * dt, ny = pos.y + (ay / len) * sp * dt
      if (map.infinite || (nx > 0 && ny > 0 && nx < map.width && ny < map.height)) { pos.x = nx; pos.y = ny }
      player.setFacing(Math.abs(ax) > Math.abs(ay) ? (ax < 0 ? 'left' : 'right') : ay < 0 ? 'up' : 'down')
    }
    player.setMoving(moving, running)
    const elev = world.elevationAt(pos.x, pos.y)
    player.setPosition(pos.x, pos.y, elev)
    player.update(dt)
    for (const n of npcs) n.update(dt)
    for (const cr of creatures) {
      cr.t += dt
      const ox = Math.sin(cr.t * 0.6) * 1.5
      cr.c.setFacingLeft(Math.cos(cr.t * 0.6) < 0)
      cr.c.setMoving(Math.abs(Math.cos(cr.t * 0.6)) > 0.3)
      cr.c.setPosition(cr.x + ox, cr.y, world.elevationAt(cr.x + ox, cr.y))
      cr.c.update(dt)
    }

    world.update(dt, { x: pos.x, y: pos.y, elev }, minutes)
    if (transition) {
      transition.t += dt / 1.4
      const k = transition.t < 1 ? transition.t : 2 - transition.t
      renderer.setTransition(transition.kind, Math.max(0, Math.min(1, k)))
      if (transition.t >= 2) { transition = null; renderer.setTransition('none', 0) }
    }
    renderer.render(world.renderView(), dt)
    const info = renderer.gl.info.render
    const mem = renderer.gl.info.memory
    const st = world.streaming
    const hh = Math.floor(minutes / 60), mm = Math.floor(minutes % 60)
    hud.textContent = `fps ${fps.toFixed(0)}  calls ${info.calls}  tris ${(info.triangles / 1000).toFixed(1)}k\n`
      + `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}  ${weathers[weatherIdx]}  q=${renderer.settings.quality}  `
      + `${renderer.internal.width}x${renderer.internal.height}@${renderer.internal.scale}\n`
      + `pos ${pos.x.toFixed(1)},${pos.y.toFixed(1)} e=${elev.toFixed(2)}  map ${map.width}x${map.height}  load ${world.loadMs.toFixed(0)}ms\n`
      + (st ? `chunks ${st.complete}/${st.slots} pend ${st.pending}  build ${st.buildMs.toFixed(1)}ms peak ${st.peakMs.toFixed(1)}  geo ${mem.geometries} tex ${mem.textures}` : '')
      + (world.worldGen ? `\nworld gen: prefetched ${world.worldGen.prefetched} ensured ${world.worldGen.ensured} last ${world.worldGen.lastMs.toFixed(1)}ms max ${world.worldGen.maxMs.toFixed(1)}ms retain ${world.worldGen.retainMs.toFixed(1)}ms` : '')
    if (bench && !bench.done) {
      if (bench.start === 0) { bench.start = now; st && (st.peakMs = 0) }
      else {
        bench.frames.push(dt * 1000)
        bench.cpu.push(performance.now() - cpu0)
        bench.build.push(st?.buildMs ?? 0)
        bench.calls.push(info.calls); bench.tris.push(info.triangles)
        bench.geo.push(mem.geometries); bench.tex.push(mem.textures); bench.slots.push(st?.slots ?? 0)
        bench.dist += moving ? bench.speedT * dt : 0
        const cpuMs = performance.now() - cpu0
        const progs = renderer.gl.info.programs ?? []
        const newProgs = progs.length > bench.progSeen ? progs.slice(bench.progSeen).map((p) => (p as unknown as { name: string }).name).join(',') : ''
        bench.progSeen = progs.length
        if (dt * 1000 > 34 || cpuMs > 12) bench.spikes.push({ t: +((now - bench.start) / 1000).toFixed(2), frameMs: +(dt * 1000).toFixed(1), cpuMs: +cpuMs.toFixed(1), buildMs: +(st?.buildMs ?? 0).toFixed(1), jobs: st?.jobs ?? 0, prog: progs.length, newProgs } as unknown as Record<string, number>)
        if (now - bench.lastSample > 10000) { bench.lastSample = now; bench.samples.push({ t: Math.round((now - bench.start) / 1000), geo: mem.geometries, tex: mem.textures, slots: st?.slots ?? 0, prog: renderer.gl.info.programs?.length ?? 0 }) }
      }
      probe.benchLive = { t: Math.round(now - bench.start), frames: bench.frames.length, site: bench.i }
      if (now - bench.start > bench.seconds * 1000) {
        bench.done = true
        const sorted = (a: number[]) => [...a].sort((x, y) => x - y)
        const pct = (a: number[], q: number) => { const s2 = sorted(a); return s2[Math.min(s2.length - 1, Math.floor(s2.length * q))] ?? 0 }
        const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)
        const max = (a: number[]) => a.reduce((x, y) => Math.max(x, y), 0)
        const elapsed = bench.frames.reduce((x, y) => x + y, 0) / 1000
        probe.bench = {
          seconds: +elapsed.toFixed(1), frames: bench.frames.length, fps: +(bench.frames.length / elapsed).toFixed(1),
          frameMsP50: +pct(bench.frames, 0.5).toFixed(2), frameMsP99: +pct(bench.frames, 0.99).toFixed(2), frameMsMax: +max(bench.frames).toFixed(2),
          cpuMsP50: +pct(bench.cpu, 0.5).toFixed(2), cpuMsP99: +pct(bench.cpu, 0.99).toFixed(2),
          buildMsP99: +pct(bench.build, 0.99).toFixed(2), buildMsMax: +max(bench.build).toFixed(2), framesOver8msBuild: bench.build.filter((b) => b > 8).length,
          calls: Math.round(avg(bench.calls)), callsMax: max(bench.calls), trisK: Math.round(avg(bench.tris) / 1000),
          geometries: { start: bench.geo[0], end: bench.geo[bench.geo.length - 1], max: max(bench.geo) },
          textures: { start: bench.tex[0], end: bench.tex[bench.tex.length - 1], max: max(bench.tex) },
          slotsMax: max(bench.slots), tiles: Math.round(bench.dist), sitesVisited: bench.i,
          totalBuilt: st?.totalBuilt, totalDisposed: st?.totalDisposed, worldGen: world.worldGen, compileTimeouts: world.compileTimeouts, end: { x: Math.round(pos.x), y: Math.round(pos.y) },
          stageMs: st?.stageMs.map((v) => +v.toFixed(2)), stageMaxMs: st?.stageMaxMs.map((v) => +v.toFixed(2)), programs: renderer.gl.info.programs?.length ?? 0,
          spikes: bench.spikes.slice(0, 12), samples: bench.samples,
          heapMB: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory ? Math.round((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576) : null,
        }
      }
    }
    probe.frames++
  }
  requestAnimationFrame(frame)
}

main().catch((e) => logError(String(e?.stack ?? e)))
