// Interiors (kind 'interior') stamped from content/world/layouts/{interiors,gyms}.json, wired to the
// overworld door that leads into them and to each other (multi-floor buildings via stairs warps).
import type { PropPlacement, RegionDef } from '../types.ts'
import { F_RESERVED, addFlag, canPlace, fmt, idx, newDraft, placeProp, type MapDraft } from './grid.ts'
import { interiorFileOf, type WorldContent } from './data.ts'
import { provenanceSink } from './provenance.ts'
import { propSize } from './collision.ts'
import type { InteriorTemplate } from './schema.ts'
import { addAnchor, tid, type AnchorMap, type DoorLink } from './ctx.ts'
import { resolveToken } from './towns.ts'

/** Stamps one interior template into a fresh draft (also used for lazily generated frontier interiors). */
export function stampInterior(wc: WorldContent, tplId: string, tpl: InteriorTemplate, mapId: string, name: string, parent: string, region: RegionDef, problems: string[]): MapDraft {
  const layouts = wc.interiorLayouts
  const palette = { ...layouts.palette, ...tpl.palette }
  const where = `interior ${tplId}`
  const d = newDraft({ id: mapId, nameZh: name, kind: 'interior', w: tpl.w, h: tpl.h, fill: 0, outdoor: false, music: tpl.music, parent })
  for (let y = 0; y < tpl.h; y++) {
    const row = tpl.rows[y].r
    for (let x = 0; x < tpl.w; x++) {
      const entry = layouts.legend[row[x]]
      if (!entry) throw new Error(`${where}: layout char "${row[x]}" missing from legend`)
      const i = idx(d, x, y)
      d.terrain[i] = tid(resolveToken(entry.terrain, palette, where))
      d.elevation[i] = entry.elev ?? 0
      if (entry.prop) {
        const p: PropPlacement = { prop: resolveToken(entry.prop, palette, where), x, y, rot: entry.rot ?? 0 }
        if (canPlace(d, p, { anyTerrain: true })) placeProp(d, p)
        else problems.push(`${where}: legend prop at ${x},${y} does not fit`)
      }
    }
  }
  const prov = provenanceSink()
  const file = prov ? interiorFileOf(tplId) : null
  if (prov && file) prov.region({ map: mapId, template: tplId, file, x: 0, y: 0, w: tpl.w, h: tpl.h, mirror: false })
  for (const [pi, pr] of tpl.props.entries()) {
    const p: PropPlacement = { prop: pr.prop, x: pr.x, y: pr.y, rot: pr.rot ?? 0 }
    if (pr.scale !== undefined) p.scale = pr.scale
    if (pr.variant !== undefined) p.variant = pr.variant
    if (canPlace(d, p, { anyTerrain: true })) {
      placeProp(d, p)
      if (prov && file) {
        const [fw, fh] = propSize(p.prop, p.rot)
        prov.add({ kind: 'prop', map: mapId, x: p.x, y: p.y, w: fw, h: fh, label: p.prop, rot: p.rot, template: tplId, file, pointer: `/templates/${tplId}/props/${pi}`, transform: { ox: 0, oy: 0, mirror: false, tw: tpl.w, fw } })
      }
    } else problems.push(`${where}: prop ${pr.prop} at ${pr.x},${pr.y} does not fit`)
  }
  d.regions = [region]
  d.spawn = { x: tpl.arrive[0], y: tpl.arrive[1], facing: 'up' }
  return d
}

/** Builds every interior reachable through the overworld doors and links all warps. */
export function buildInteriors(wc: WorldContent, doors: DoorLink[], overworldId: string, regionFor: (link: DoorLink) => RegionDef, anchors: AnchorMap, problems: string[]): MapDraft[] {
  const out: MapDraft[] = []
  for (const link of doors) {
    const tpls = link.floors.map((id) => {
      const t = wc.interiorLayouts.templates[id]
      if (!t) throw new Error(`town ${link.townId}: unknown interior template "${id}"`)
      return t
    })
    const base = regionFor(link)
    const drafts = tpls.map((tpl, k) => {
      const name = k === 0 && link.nameZh ? link.nameZh : fmt(tpl.nameZh, { town: link.townNameZh })
      const region: RegionDef = { ...base, id: link.mapIds[k], nameZh: name, music: tpl.music, biome: tpl.biome ?? base.biome }
      return stampInterior(wc, link.floors[k], tpl, link.mapIds[k], name, overworldId, region, problems)
    })
    tpls.forEach((tpl, k) => {
      const d = drafts[k]
      if (tpl.exit) {
        d.warps.push({ x: tpl.exit[0], y: tpl.exit[1], toMap: overworldId, toX: link.door.front.x, toY: link.door.front.y, facing: link.door.facing, kind: 'door' })
        addFlag(d, idx(d, tpl.exit[0], tpl.exit[1]), F_RESERVED)
      } else if (k === 0) problems.push(`interior ${link.floors[k]}: ground floor has no exit`)
      const nextTpl = tpls[k + 1]
      const firstBelow = tpls.length - link.belowCount
      const underground = k >= firstBelow
      if (k + 1 === firstBelow && link.belowCount > 0 || underground && nextTpl) {
        // Going down: this floor's `down` stairs pair with the next floor's `up` stairs.
        const down = tpl.links?.down, up = nextTpl?.links?.up
        if (down && up) {
          d.warps.push({ x: down.x, y: down.y, toMap: link.mapIds[k + 1], toX: up.arrive[0], toY: up.arrive[1], facing: up.facing, kind: 'stairs' })
          drafts[k + 1].warps.push({ x: up.x, y: up.y, toMap: link.mapIds[k], toX: down.arrive[0], toY: down.arrive[1], facing: down.facing, kind: 'stairs' })
        } else problems.push(`interior ${link.floors[k]}: stairs links do not match the floor list`)
      } else if (underground) {
        // The pairing with the floor above was made there; an underground floor must have its way back up.
        if (!tpl.links?.up) problems.push(`interior ${link.floors[k]}: stairs links do not match the floor list`)
      } else {
        const up = tpl.links?.up
        if (up && nextTpl?.links?.down) {
          const down = nextTpl.links.down
          d.warps.push({ x: up.x, y: up.y, toMap: link.mapIds[k + 1], toX: down.arrive[0], toY: down.arrive[1], facing: down.facing, kind: 'stairs' })
          drafts[k + 1].warps.push({ x: down.x, y: down.y, toMap: link.mapIds[k], toX: up.arrive[0], toY: up.arrive[1], facing: up.facing, kind: 'stairs' })
        } else if (up || (k > 0 && !tpl.links?.down)) problems.push(`interior ${link.floors[k]}: stairs links do not match the floor list`)
      }
      if (underground && tpl.links?.up) d.spawn = { x: tpl.links.up.arrive[0], y: tpl.links.up.arrive[1], facing: tpl.links.up.facing }
      else if (k > 0 && tpl.links?.down) d.spawn = { x: tpl.links.down.arrive[0], y: tpl.links.down.arrive[1], facing: tpl.links.down.facing }
      addAnchor(anchors, problems, `${link.mapIds[k]}:entrance`, link.mapIds[k], d.spawn.x, d.spawn.y)
      for (const [name, [x, y]] of Object.entries(tpl.anchors)) addAnchor(anchors, problems, `${link.mapIds[k]}:${name}`, link.mapIds[k], x, y)
    })
    out.push(...drafts)
  }
  return out
}
