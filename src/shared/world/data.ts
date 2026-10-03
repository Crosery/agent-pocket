// Loader for content/world/** (everything except story/). Data only enters the generator here.
import type {
  CavesFile, ClimateFile, DungeonsFile, GroundItemRules, InteriorTemplate, LayoutFile, PoisFile, RegionSpec, RouteSpec,
  ScatterFile, TownSpec, TownTemplate, Vec2, WildsFile, WorldSpec,
} from './schema.ts'

import worldJson from '../../../content/world/world.json' with { type: 'json' }
import regionsJson from '../../../content/world/regions.json' with { type: 'json' }
import townsJson from '../../../content/world/towns.json' with { type: 'json' }
import routesJson from '../../../content/world/routes.json' with { type: 'json' }
import scatterJson from '../../../content/world/scatter.json' with { type: 'json' }
import itemsJson from '../../../content/world/items.json' with { type: 'json' }
import townLayoutsJson from '../../../content/world/layouts/towns.json' with { type: 'json' }
import interiorLayoutsJson from '../../../content/world/layouts/interiors.json' with { type: 'json' }
import gymLayoutsJson from '../../../content/world/layouts/gyms.json' with { type: 'json' }
import cavesJson from '../../../content/world/layouts/caves.json' with { type: 'json' }
import climateJson from '../../../content/world/climate.json' with { type: 'json' }
import wildsJson from '../../../content/world/wilds.json' with { type: 'json' }
import poisJson from '../../../content/world/pois.json' with { type: 'json' }
import dungeonsJson from '../../../content/world/dungeons.json' with { type: 'json' }

export interface WorldContent {
  world: WorldSpec
  regions: RegionSpec[]
  towns: TownSpec[]
  routes: RouteSpec[]
  scatter: ScatterFile
  items: GroundItemRules
  townLayouts: LayoutFile<TownTemplate>
  /** Interiors and gyms merged (gyms.json templates are ordinary interiors). */
  interiorLayouts: LayoutFile<InteriorTemplate>
  caves: CavesFile
  climate: ClimateFile
  wilds: WildsFile
  pois: PoisFile
  dungeons: DungeonsFile
}

function mergeInteriors(a: LayoutFile<InteriorTemplate>, b: LayoutFile<InteriorTemplate>): LayoutFile<InteriorTemplate> {
  return {
    legend: { ...a.legend, ...b.legend },
    palette: { ...a.palette, ...b.palette },
    templates: { ...a.templates, ...b.templates },
  }
}

export const WORLD_CONTENT: WorldContent = {
  world: worldJson as unknown as WorldSpec,
  regions: regionsJson as unknown as RegionSpec[],
  towns: townsJson as unknown as TownSpec[],
  routes: routesJson as unknown as RouteSpec[],
  scatter: scatterJson as unknown as ScatterFile,
  items: itemsJson as unknown as GroundItemRules,
  townLayouts: townLayoutsJson as unknown as LayoutFile<TownTemplate>,
  interiorLayouts: mergeInteriors(
    interiorLayoutsJson as unknown as LayoutFile<InteriorTemplate>,
    gymLayoutsJson as unknown as LayoutFile<InteriorTemplate>,
  ),
  caves: cavesJson as unknown as CavesFile,
  climate: climateJson as unknown as ClimateFile,
  wilds: wildsJson as unknown as WildsFile,
  pois: poisJson as unknown as PoisFile,
  dungeons: dungeonsJson as unknown as DungeonsFile,
}

/**
 * Copy of the content with every layout-space coordinate (overworld.layout) mapped into overworld tiles:
 * town centres, region control points and peaks, islands, lakes, rivers, quest spots, cave and route hints.
 * Radii scale with the mean factor; level heights and template sizes do not scale.
 */
export function scaleLayout(wc: WorldContent): WorldContent {
  const ow = wc.world.overworld
  const L = ow.layout
  const [x0, y0, x1, y1] = L.box ?? [0, 0, ow.width, ow.height]
  const sx = (x1 - x0) / L.width, sy = (y1 - y0) / L.height
  const sr = (sx + sy) / 2
  const X = (x: number) => Math.round(x0 + x * sx)
  const Y = (y: number) => Math.round(y0 + y * sy)
  const P = ([x, y]: Vec2): Vec2 => [X(x), Y(y)]
  const R = (r: number) => r * sr
  return {
    ...wc,
    world: {
      ...wc.world,
      overworld: {
        ...ow,
        islands: ow.islands.map((s) => ({ ...s, x: X(s.x), y: Y(s.y), radius: R(s.radius) })),
        lakes: ow.lakes.map((l) => ({ ...l, x: X(l.x), y: Y(l.y), radius: R(l.radius) })),
        rivers: ow.rivers.map((r) => ({ ...r, points: r.points.map(P) })),
        spots: ow.spots.map((s) => ({ ...s, near: P(s.near) })),
      },
    },
    regions: wc.regions.map((r) => ({
      ...r,
      points: r.points.map(P),
      peaks: r.peaks?.map((pk) => ({
        ...pk, x: X(pk.x), y: Y(pk.y), radius: R(pk.radius),
        crater: pk.crater ? { ...pk.crater, radius: R(pk.crater.radius) } : undefined,
      })),
    })),
    towns: wc.towns.map((t) => ({ ...t, x: X(t.x), y: Y(t.y) })),
    routes: wc.routes.map((r) => (r.via ? { ...r, via: r.via.map(P) } : r)),
    caves: { ...wc.caves, caves: wc.caves.caves.map((c) => ({ ...c, ends: c.ends.map((e) => ({ ...e, near: P(e.near) })) })) },
  }
}

/** Horizontally mirrored copy of a town template (buildings keep facing south; east/west exits swap names). */
export function mirrorTownTemplate(t: TownTemplate, footprint: (prop: string, rot: number) => [number, number]): TownTemplate {
  const mx = (x: number) => t.w - 1 - x
  const swap: Record<string, string> = { east: 'west', west: 'east' }
  const rotMirror = (r: number) => ((r === 1 ? 3 : r === 3 ? 1 : r) as 0 | 1 | 2 | 3)
  return {
    ...t,
    square: [mx(t.square[0]), t.square[1]],
    exits: Object.fromEntries(Object.entries(t.exits).map(([k, [x, y]]) => [swap[k] ?? k, [mx(x), y]])),
    rows: t.rows.map((row) => ({ r: [...row.r].reverse().join('') })),
    buildings: t.buildings.map((b) => ({ ...b, x: t.w - b.x - footprint(b.prop, 0)[0] })),
    props: t.props.map((p) => {
      const rot = rotMirror(p.rot ?? 0)
      return { ...p, rot, x: t.w - p.x - footprint(p.prop, rot)[0] }
    }),
    signs: t.signs.map((s) => ({ ...s, x: mx(s.x) })),
    anchors: Object.fromEntries(Object.entries(t.anchors).map(([k, [x, y]]) => [k, [mx(x), y]])),
  }
}
