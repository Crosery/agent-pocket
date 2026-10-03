// Builds the battle diorama as a tiny synthetic GameMap (terrain, elevation, tall grass, props, lights) from the
// layout data in content/battle-stage.json, so the overworld terrain / grass / prop renderers draw it with the
// exact same HD-2D look. Pure: runs in node tests.
import { CONTENT, type Content } from '../../../shared/content/index.ts'
import type { GameMap, LightDef, PropPlacement } from '../../../shared/types.ts'
import { hash2, hashString, valueNoise } from '../world/coords.ts'
import { STAGE, dioramaFor, type BattleStageContent, type DioramaDef, type Rect } from './config.ts'

export interface DioramaLayout {
  map: GameMap
  def: DioramaDef
  /** Tile-space world position of the stage origin (x, z). */
  origin: { x: number; z: number }
  ambient: string[]
  silhouettes: string
}

/** Positive inside the shape (distance-like, in tiles), jittered by value noise (frequency `scale`) when `noise` > 0. */
function shapeValue(x: number, z: number, tx: number, ty: number, op: { rect?: Rect; ellipse?: [number, number, number, number]; noise?: number; seed?: number }, scale: number): number {
  let f = -Infinity
  if (op.rect) {
    const [x0, z0, x1, z1] = op.rect
    f = Math.min(x - x0, x1 - x, z - z0, z1 - z)
  } else if (op.ellipse) {
    const [cx, cz, rx, rz] = op.ellipse
    f = (1 - Math.hypot((x - cx) / Math.max(1e-3, rx), (z - cz) / Math.max(1e-3, rz))) * Math.min(rx, rz)
  }
  if (op.noise) f += (valueNoise(tx * scale, ty * scale, op.seed ?? 0) - 0.5) * 2 * op.noise
  return f
}

export function buildDioramaMap(biome: string, indoor: boolean, s: BattleStageContent = STAGE, c: Content = CONTENT): DioramaLayout {
  const D = s.dioramas
  // biomes without a diorama of their own (frontier biomes) borrow the first encounter habitat that has one; their
  // own ground terrain still wins over the borrowed diorama's ground
  const own = indoor || !!D.biomes[biome]
  const base = own ? biome : (c.biomeById[biome]?.encounterHabitats ?? []).find((h) => D.biomes[h]) ?? biome
  const def = dioramaFor(base, indoor, s)
  const biomeDef = c.biomeById[biome] ?? c.biomes[0]
  const [W, H] = D.mapSize
  const ox = D.origin[0], oz = D.origin[1]
  const n = W * H
  const groundKey = (own ? [def.ground, biomeDef?.groundTerrain] : [biomeDef?.groundTerrain, def.ground]).concat(D.fallbackGround).find((k) => k !== undefined && c.terrainByKey[k])
  const ground = groundKey !== undefined ? c.terrainByKey[groundKey].id : c.terrain.findIndex((t) => !!t && t.walkable && !t.liquid)
  const terrain = new Uint8Array(n).fill(ground)
  const elevation = new Uint8Array(n)
  const region = new Uint8Array(n)
  const seed = (hashString(`${biome}|${indoor ? 'in' : 'out'}`) ^ (def.seed ?? 0)) >>> 0

  const local = (tx: number, ty: number) => ({ x: tx + 0.5 - ox, z: ty + 0.5 - oz })

  for (const op of def.paint) {
    const tid = op.terrain !== undefined ? c.terrainByKey[op.terrain]?.id : undefined
    for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
      const p = local(tx, ty)
      if (shapeValue(p.x, p.z, tx, ty, op, D.noiseScale) <= 0) continue
      const i = ty * W + tx
      if (tid !== undefined) terrain[i] = tid
      if (op.elevation !== undefined) elevation[i] = op.elevation
    }
  }

  // keep-clear spots: creature + trainer positions of both slots
  const spots = s.slots.flatMap((sl) => [sl.creature, sl.trainer])
  const nearSpot = (x: number, z: number, pad: number) => spots.some(([sx, sz]) => Math.hypot(x - sx, z - sz) < D.clear + pad)
  const inRect = (x: number, z: number, r: Rect) => x >= r[0] && x < r[2] && z >= r[1] && z < r[3]
  const openGround = (i: number) => {
    const t = c.terrain[terrain[i]]
    return !!t && t.walkable && !t.liquid && !t.stairs
  }

  for (const g of def.grass) {
    const gid = c.terrainByKey[g.terrain]?.id
    if (gid === undefined) continue
    const gs = hashString(g.terrain)
    for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
      const p = local(tx, ty)
      const i = ty * W + tx
      if (shapeValue(p.x, p.z, tx, ty, { rect: g.rect, noise: g.noise, seed: gs }, D.noiseScale) <= 0) continue
      if (!openGround(i) || nearSpot(p.x, p.z, 0)) continue
      if (hash2(tx, ty, gs + seed) < g.density) terrain[i] = gid
    }
  }

  const occupied = new Uint8Array(n)
  const props: PropPlacement[] = []
  const fits = (prop: string, tx: number, ty: number, scatter: boolean): boolean => {
    const pd = c.props[prop]
    if (!pd) return false
    const [fw, fd] = pd.footprint
    const lv = tx >= 0 && ty >= 0 && tx < W && ty < H ? elevation[ty * W + tx] : -1
    for (let y = ty; y < ty + fd; y++) for (let x = tx; x < tx + fw; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) return false
      const i = y * W + x
      if (occupied[i] || !openGround(i) || elevation[i] !== lv) return false
      if (scatter) {
        const p = local(x, y)
        if (nearSpot(p.x, p.z, D.scatterPad) || D.keepOut.some((r) => inRect(p.x, p.z, r))) return false
      }
    }
    return true
  }
  const occupy = (prop: string, tx: number, ty: number) => {
    const [fw, fd] = c.props[prop].footprint
    for (let y = ty; y < ty + fd; y++) for (let x = tx; x < tx + fw; x++) occupied[y * W + x] = 1
  }

  for (const p of def.props) {
    const tx = Math.floor(ox + p.at[0]), ty = Math.floor(oz + p.at[1])
    if (!fits(p.prop, tx, ty, false)) continue
    occupy(p.prop, tx, ty)
    props.push({ prop: p.prop, x: tx, y: ty, rot: p.rot ?? 0, scale: p.scale, variant: p.variant })
  }

  let r = seed || 1
  const rnd = () => { r = (Math.imul(r ^ (r >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return r / 4294967296 }
  for (const sc of def.scatter) {
    if (!sc.props.length) continue
    let placed = 0
    for (let attempt = 0; attempt < sc.count * D.scatterTries && placed < sc.count; attempt++) {
      const prop = sc.props[Math.floor(rnd() * sc.props.length)]
      const x = sc.rect[0] + rnd() * (sc.rect[2] - sc.rect[0])
      const z = sc.rect[1] + rnd() * (sc.rect[3] - sc.rect[1])
      const tx = Math.floor(ox + x), ty = Math.floor(oz + z)
      if (!fits(prop, tx, ty, true)) continue
      const spacing = sc.spacing ?? 0
      if (spacing > 0 && props.some((q) => Math.hypot(q.x - tx, q.y - ty) < spacing)) continue
      occupy(prop, tx, ty)
      const scl = sc.scale ? sc.scale[0] + rnd() * (sc.scale[1] - sc.scale[0]) : undefined
      props.push({ prop, x: tx, y: ty, rot: 0, scale: scl })
      placed++
    }
  }

  const lights: LightDef[] = (def.lights ?? []).map((l) => ({
    x: ox + l.at[0], y: oz + l.at[1], h: l.h, color: l.color, intensity: l.intensity, radius: l.radius, nightOnly: l.nightOnly,
  }))

  const kind = def.kind ?? (indoor ? 'interior' : 'overworld')
  const map: GameMap = {
    id: `battle:${biome}${indoor ? ':indoor' : ''}`,
    nameZh: biomeDef?.nameZh ?? biome,
    kind,
    width: W,
    height: H,
    terrain,
    elevation,
    region,
    regions: [{ id: biomeDef?.id ?? biome, nameZh: biomeDef?.nameZh ?? biome, biome: biomeDef?.id ?? biome, music: '', encounters: [], encounterRate: 0, roamingDensity: 0 }],
    props,
    warps: [],
    npcs: [],
    signs: [],
    items: [],
    lights,
    spawn: { x: ox, y: oz, facing: 'down' },
    outdoor: kind === 'overworld',
    music: '',
  }
  const silKey = def.silhouettes ?? (indoor ? 'indoor' : s.backdrop.silhouettes[biome] ? biome : base)
  return {
    map,
    def,
    origin: { x: ox, z: oz },
    ambient: def.ambient ?? (indoor ? [] : biomeDef?.ambient ?? []),
    silhouettes: s.backdrop.silhouettes[silKey] ? silKey : 'default',
  }
}
