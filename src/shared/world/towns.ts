// Town stamping: template grid -> terrain/props, buildings with door warps (interiors built later),
// signs, anchors and exits. Templates and per-town palettes come from content/world.
import type { Dir, PropPlacement } from '../types.ts'
import { CONTENT } from '../content/index.ts'
import { mirrorTownTemplate } from './data.ts'
import { DIR_DX, DIR_DY, opposite, propDoors, propRect, propSize } from './collision.ts'
import { F_KEEP, F_PATH, F_RESERVED, F_TOWN, addFlag, canPlace, fmt, idx, inside, placeProp } from './grid.ts'
import { townRect, type TownPad } from './macro.ts'
import type { InteriorTemplate, TownSpec, TownTemplate } from './schema.ts'
import { addAnchor, tid, type DoorLink, type OwCtx, type TownExit } from './ctx.ts'


export interface StampedTown {
  spec: TownSpec
  tpl: TownTemplate
  pad: TownPad
  square: { x: number; y: number }
  exits: Record<string, TownExit>
}

export function townTemplate(spec: TownSpec, ctxTemplates: Record<string, TownTemplate>): TownTemplate {
  const base = ctxTemplates[spec.layout]
  if (!base) throw new Error(`town ${spec.id}: unknown layout "${spec.layout}"`)
  return spec.mirror ? mirrorTownTemplate(base, propSize) : base
}

export function resolveToken(token: string, palette: Record<string, string>, where: string): string {
  if (!token.startsWith('@')) return token
  const v = palette[token.slice(1)]
  if (v === undefined) throw new Error(`${where}: palette has no "${token.slice(1)}"`)
  return v
}

function edgeDir(x: number, y: number, w: number, h: number): Dir {
  if (x === 0) return 'left'
  if (x === w - 1) return 'right'
  if (y === 0) return 'up'
  return 'down'
}

export function interiorTemplate(ctx: OwCtx, id: string): InteriorTemplate {
  const t = ctx.wc.interiorLayouts.templates[id]
  if (!t) throw new Error(`unknown interior template "${id}"`)
  return t
}

/** Sign text for a template sign slot: explicit town text, else world.text['<slot>Sign'] formatted. */
function signText(ctx: OwCtx, spec: TownSpec, slot: string): string | null {
  if (spec.signs[slot] !== undefined) return spec.signs[slot]
  const fmtKey = `${slot}Sign` as keyof typeof ctx.wc.world.text
  const f = ctx.wc.world.text[fmtKey]
  if (!f) return null
  const gym = spec.gym
  return fmt(f, {
    town: spec.nameZh,
    type: gym ? CONTENT.typeById[gym.type]?.nameZh ?? gym.type : '',
    leader: gym ? CONTENT.characterById[gym.leader]?.nameZh ?? gym.leader : '',
  })
}

export function placeSign(ctx: OwCtx, x: number, y: number, text: string, kind: 'sign' | 'board' | 'plaque', forbid = 0): boolean {
  const { d } = ctx
  const prop = ctx.spec.signProps[kind]
  const p: PropPlacement = { prop, x, y, rot: 0 }
  if (!canPlace(d, p, { forbid })) return false
  placeProp(d, p)
  d.signs.push({ x, y, text, kind })
  addFlag(d, idx(d, x, y), F_RESERVED)
  return true
}

export function stampTowns(ctx: OwCtx): StampedTown[] {
  const { d } = ctx
  const out: StampedTown[] = []
  const legend = ctx.wc.townLayouts.legend
  for (const pad of ctx.macro.pads) {
    const spec = pad.town
    const tpl = townTemplate(spec, ctx.wc.townLayouts.templates)
    const rect = townRect(spec, tpl.w, tpl.h)
    const palette = { ...ctx.wc.townLayouts.palette, ...spec.palette }
    const where = `town ${spec.id}`
    const biome = ctx.wc.regions[pad.region].biome
    const anchorBase = `town:${spec.id}`

    for (let ty = 0; ty < tpl.h; ty++) {
      const row = tpl.rows[ty].r
      for (let tx = 0; tx < tpl.w; tx++) {
        const x = rect.x + tx, y = rect.y + ty
        if (!inside(d, x, y)) continue
        const entry = legend[row[tx]]
        if (!entry) throw new Error(`${where}: layout char "${row[tx]}" missing from legend`)
        const i = idx(d, x, y)
        d.terrain[i] = tid(resolveToken(entry.terrain, palette, where))
        d.elevation[i] = pad.level + (entry.elev ?? 0)
        addFlag(d, i, F_TOWN)
        if (entry.prop) {
          const p: PropPlacement = { prop: resolveToken(entry.prop, palette, where), x, y, rot: entry.rot ?? 0 }
          if (canPlace(d, p, { anyTerrain: true })) placeProp(d, p)
          else ctx.problems.push(`${where}: legend prop at ${tx},${ty} does not fit`)
        }
      }
    }

    for (const b of tpl.buildings) {
      const bs = spec.buildings?.[b.slot]
      const p: PropPlacement = { prop: bs?.prop ?? b.prop, x: rect.x + b.x, y: rect.y + b.y, rot: 0 }
      if (!canPlace(d, p, { anyTerrain: true })) { ctx.problems.push(`${where}: building ${b.slot} does not fit`); continue }
      placeProp(d, p)
      const entries = propDoors(p)
      const door = entries[0]
      if (!door) continue
      const floors = bs?.floors ?? (bs?.interior ? [bs.interior] : [])
      if (!floors.length) { ctx.problems.push(`${where}: building ${b.slot} has a door but no interior`); continue }
      const baseId = bs?.mapId ?? `${spec.id}-${b.slot}`
      const mapIds = floors.length === 1 ? [baseId] : floors.map((_, k) => `${baseId}-${k + 1}f`)
      const first = interiorTemplate(ctx, floors[0])
      const link: DoorLink = { townId: spec.id, townNameZh: spec.nameZh, slot: b.slot, floors, mapIds, door, biome, nameZh: bs?.nameZh }
      ctx.doors.push(link)
      for (const entry of entries) {
        d.warps.push({ x: entry.x, y: entry.y, toMap: mapIds[0], toX: first.arrive[0], toY: first.arrive[1], facing: opposite(entry.facing), kind: 'door' })
        addFlag(d, idx(d, entry.x, entry.y), F_RESERVED)
        if (inside(d, entry.front.x, entry.front.y)) {
          addFlag(d, idx(d, entry.front.x, entry.front.y), F_RESERVED | F_KEEP)
        }
      }
      if (inside(d, door.front.x, door.front.y)) addAnchor(ctx.anchors, ctx.problems, `${anchorBase}:${b.slot}`, d.id, door.front.x, door.front.y)
      if (spec.start && spec.home === b.slot) {
        d.spawn = { x: door.front.x, y: door.front.y, facing: door.facing }
        addAnchor(ctx.anchors, ctx.problems, 'spawn', d.id, door.front.x, door.front.y)
      }
    }

    for (const pr of tpl.props) {
      const p: PropPlacement = { prop: pr.prop, x: rect.x + pr.x, y: rect.y + pr.y, rot: pr.rot ?? 0 }
      if (pr.scale !== undefined) p.scale = pr.scale
      if (pr.variant !== undefined) p.variant = pr.variant
      if (canPlace(d, p, { anyTerrain: true })) placeProp(d, p)
      else ctx.problems.push(`${where}: prop ${pr.prop} at ${pr.x},${pr.y} does not fit`)
    }

    for (const s of tpl.signs) {
      const text = signText(ctx, spec, s.slot)
      if (text === null) { ctx.problems.push(`${where}: no text for sign "${s.slot}"`); continue }
      if (!placeSign(ctx, rect.x + s.x, rect.y + s.y, text, s.kind)) ctx.problems.push(`${where}: sign ${s.slot} does not fit`)
    }

    const square = { x: rect.x + tpl.square[0], y: rect.y + tpl.square[1] }
    addAnchor(ctx.anchors, ctx.problems, anchorBase, d.id, square.x, square.y)
    for (const [name, [ax, ay]] of Object.entries(tpl.anchors)) {
      addAnchor(ctx.anchors, ctx.problems, `${anchorBase}:${name}`, d.id, rect.x + ax, rect.y + ay)
      addFlag(d, idx(d, rect.x + ax, rect.y + ay), F_RESERVED)
    }

    const exits: Record<string, TownExit> = {}
    for (const [name, [ex, ey]] of Object.entries(tpl.exits)) {
      const dir = edgeDir(ex, ey, tpl.w, tpl.h)
      const x = rect.x + ex, y = rect.y + ey
      exits[name] = { x, y, dir, out: { x: x + DIR_DX[dir], y: y + DIR_DY[dir] } }
      addAnchor(ctx.anchors, ctx.problems, `${anchorBase}:exit-${name}`, d.id, x, y)
    }
    out.push({ spec, tpl, pad, square, exits })
  }
  return out
}

/** Carves a short path through the town margin for every exit no route starts from. */
export function stubUnusedExits(ctx: OwCtx, towns: StampedTown[], used: Set<string>): void {
  const { d } = ctx
  const t = tid(ctx.spec.exitStubTerrain)
  for (const town of towns) {
    for (const [name, ex] of Object.entries(town.exits)) {
      if (used.has(`${town.spec.id}:${name}`)) continue
      for (let k = 1; k <= ctx.spec.townMargin; k++) {
        const x = ex.x + DIR_DX[ex.dir] * k, y = ex.y + DIR_DY[ex.dir] * k
        if (!inside(d, x, y)) break
        const i = idx(d, x, y)
        if (d.occ[i] || !CONTENT.terrain[d.terrain[i]]?.walkable) break
        d.terrain[i] = t
        addFlag(d, i, F_PATH | F_KEEP)
      }
    }
  }
}
