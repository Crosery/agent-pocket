// Reference validation for content/world/** (terrain/prop/biome/music/type/character/template ids, grid
// shapes, palette tokens, links). Returns human-readable problems; empty = consistent.
import { CONTENT, type Content } from '../content/index.ts'
import { WORLD_CONTENT, mirrorTownTemplate, type WorldContent } from './data.ts'
import { propSize } from './collision.ts'
import type { InteriorTemplate, LegendEntry, TownTemplate } from './schema.ts'
import { validateFrontierContent } from './frontier/validate.ts'
import { validateFrontierPack } from './frontier/content/validate.ts'

export function validateWorldContent(wc: WorldContent = WORLD_CONTENT, c: Content = CONTENT): string[] {
  const errs: string[] = []
  const ow = wc.world.overworld
  const bgm = new Set(c.audio.bgm.map((b) => b.id))
  const terrain = (where: string, key: string) => { if (!c.terrainByKey[key]) errs.push(`${where}: unknown terrain "${key}"`) }
  const prop = (where: string, key: string) => { if (!c.props[key]) errs.push(`${where}: unknown prop "${key}"`) }
  const music = (where: string, id: string) => { if (!bgm.has(id)) errs.push(`${where}: unknown music "${id}"`) }
  const biome = (where: string, id: string) => { if (!c.biomeById[id]) errs.push(`${where}: unknown biome "${id}"`) }
  const dup = (label: string, ids: string[]) => {
    const seen = new Set<string>()
    for (const id of ids) { if (seen.has(id)) errs.push(`${label}: duplicate id "${id}"`); seen.add(id) }
  }
  const regionIds = new Set(wc.regions.map((r) => r.id))
  const region = (where: string, id: string) => { if (!regionIds.has(id)) errs.push(`${where}: unknown region "${id}"`) }

  for (const def of Object.values(c.props)) {
    if (!def.doorSpan) continue
    const [lo, hi] = def.doorSpan
    const col = Math.floor(def.footprint[0] / 2) + (def.door?.[0] ?? 0)
    if (!def.door || !Number.isInteger(lo) || !Number.isInteger(hi) || lo > 0 || hi < 0 ||
      col + lo < 0 || col + hi >= def.footprint[0]) {
      errs.push(`prop ${def.key}: doorSpan must include the primary door and stay inside the footprint`)
    }
  }

  // world.json
  if (ow.width > 2048 || ow.height > 2048) errs.push('overworld: larger than 2048x2048')
  const L = ow.layout
  const box = L?.box
  if (box && (box[2] <= box[0] || box[3] <= box[1] || box[2] > ow.width || box[3] > ow.height)) errs.push('world.overworld.layout: bad box')
  const collider1 = (where: string, key: string) => {
    prop(where, key)
    const def = c.props[key]
    if (def && (!def.collide || def.footprint[0] !== 1 || def.footprint[1] !== 1)) errs.push(`${where}: "${key}" must be a 1x1 colliding prop`)
  }
  ow.shallowBorder.forEach((p) => collider1('world.overworld.shallowBorder', p.prop))
  collider1('world.overworld.hydrology.rapidsProp', ow.hydrology.rapidsProp)
  for (const k of [ow.hydrology.riverTerrain, ow.hydrology.bankTerrain, ow.hydrology.lakeTerrain, ow.hydrology.lakeRimTerrain]) terrain('world.overworld.hydrology', k)
  if (!(ow.coarse >= 1)) errs.push('world.overworld: coarse must be >= 1')
  if (ow.levelMap) {
    const lm = ow.levelMap
    if (lm.length !== ow.maxLevel + 1 || lm.some((v) => !Number.isInteger(v)) || lm[0] !== 0) {
      errs.push('world.overworld.levelMap: needs maxLevel + 1 integers starting at 0')
    } else {
      for (let i = 1; i < lm.length; i++) if (lm[i] < lm[i - 1] || lm[i] - lm[i - 1] > 1) errs.push(`world.overworld.levelMap: step ${i - 1} -> ${i} must rise by 0 or 1`)
      if (ow.seaLevel + 1 <= ow.maxLevel && lm[ow.seaLevel + 1] !== ow.seaLevel + 1) errs.push('world.overworld.levelMap: the first level above the sea is kept (coast cliffs and islands stand on it)')
    }
  }
  if (ow.startFlat) {
    const sf = ow.startFlat
    const finite = [sf.radius, sf.transition, sf.level, sf.jitter, sf.minPatch, sf.noise?.scale].every((v) => Number.isFinite(v))
    if (!finite || sf.radius < 0 || sf.jitter < 0 || sf.minPatch < 0 || !(sf.transition > 0) || !(sf.noise.scale > 0)) {
      errs.push('world.overworld.startFlat: radius, jitter, minPatch >= 0, transition > 0 and a noise scale are required')
    } else {
      if (sf.level < 0 || sf.level > ow.maxLevel) errs.push('world.overworld.startFlat: level must be within maxLevel')
      // The smoothstep cap climbs at most 1.5 * rise / transition per tile; it must stay inside the slope envelope.
      const rise = ow.maxLevel + 0.5 - (sf.level + 0.99)
      if ((1.5 * rise) / sf.transition > ow.slope / Math.SQRT2) errs.push('world.overworld.startFlat: transition too short for the slope envelope')
    }
  }
  if (!wc.world.text.dungeonSign) errs.push('world.text: missing dungeonSign')
  for (const k of [ow.seaTerrain, ow.seaShallowTerrain, ow.outOfBounds, ow.beach.terrain, ow.exitStubTerrain, ow.bridgeTerrain, ow.stairsTerrain]) terrain('world.overworld', k)
  if (c.terrainByKey[ow.stairsTerrain] && !c.terrainByKey[ow.stairsTerrain].stairs) errs.push(`world.overworld: stairsTerrain "${ow.stairsTerrain}" lacks the stairs flag`)
  music('world.overworld', ow.music)
  for (const k of Object.values(ow.signProps)) prop('world.overworld.signProps', k)
  prop('world.overworld.caveMouthProp', ow.caveMouthProp)
  if (c.props[ow.caveMouthProp] && !c.props[ow.caveMouthProp].door) errs.push('world.overworld: caveMouthProp has no door')
  if (!(ow.caveMouthTries >= 1)) errs.push('world.overworld: caveMouthTries must be >= 1')
  ow.beach.regions.forEach((r) => region('world.beach', r))
  ow.islands.forEach((s) => { region(`island ${s.id}`, s.region); if (!wc.regions.find((r) => r.id === s.region)?.water) errs.push(`island ${s.id}: region must be a water region`) })
  ow.lakes.forEach((l) => { terrain(`lake ${l.id}`, l.terrain); terrain(`lake ${l.id}`, l.rimTerrain) })
  ow.rivers.forEach((r) => { terrain(`river ${r.id}`, r.terrain); terrain(`river ${r.id}`, r.bankTerrain); if (r.points.length < 2) errs.push(`river ${r.id}: needs 2+ points`) })
  dup('world.spots', ow.spots.map((s) => s.name))
  if (!c.config.time.phases.some((p) => p.id === wc.world.encounters.nightPhase)) errs.push(`world.encounters: unknown phase "${wc.world.encounters.nightPhase}"`)

  // regions.json
  dup('regions', wc.regions.map((r) => r.id))
  for (const r of wc.regions) {
    const w = `region ${r.id}`
    biome(w, r.biome); music(w, r.music)
    if (r.points.length < 1) errs.push(`${w}: needs control points`)
    if (r.levelRange[0] > r.levelRange[1] || r.levelRange[0] < 1 || r.levelRange[1] > c.config.party.maxLevel) errs.push(`${w}: bad levelRange`)
    for (const p of r.peaks ?? []) if (p.crater) terrain(w, p.crater.terrain)
  }
  if (!wc.regions.some((r) => !r.water)) errs.push('regions: need at least one land region')

  // scatter.json
  for (const b of c.biomes) if (!wc.scatter.biomes[b.id]) errs.push(`scatter: no rules for biome "${b.id}"`)
  for (const [id, b] of Object.entries(wc.scatter.biomes)) {
    const w = `scatter.${id}`
    biome(w, id)
    terrain(w, b.ground)
    b.layers.forEach((l) => { terrain(w, l.terrain); l.on?.forEach((t) => terrain(w, t)) })
    b.props.forEach((p) => { prop(w, p.prop); p.on?.forEach((t) => terrain(w, t)) })
    if (!b.border.length) errs.push(`${w}: border list is empty`)
    for (const p of b.border) {
      prop(w, p.prop)
      const def = c.props[p.prop]
      if (def && (!def.collide || def.footprint[0] !== 1 || def.footprint[1] !== 1)) errs.push(`${w}: border prop "${p.prop}" must be a 1x1 colliding prop`)
    }
  }

  // layouts
  const checkLegend = (where: string, legend: Record<string, LegendEntry>) => {
    for (const [ch, e] of Object.entries(legend)) {
      if (ch.length !== 1) errs.push(`${where}: legend key "${ch}" must be one character`)
      if (!e.terrain.startsWith('@')) terrain(where, e.terrain)
      if (e.prop && !e.prop.startsWith('@')) prop(where, e.prop)
    }
  }
  const checkGrid = (where: string, t: { w: number; h: number; rows: { r: string }[] }, legend: Record<string, LegendEntry>, palette: Record<string, string>) => {
    if (t.rows.length !== t.h) errs.push(`${where}: ${t.rows.length} rows, expected ${t.h}`)
    const used = new Set<string>()
    t.rows.forEach((row, y) => {
      if ([...row.r].length !== t.w) errs.push(`${where}: row ${y} has ${[...row.r].length} cells, expected ${t.w}`)
      for (const ch of row.r) used.add(ch)
    })
    for (const ch of used) {
      const e = legend[ch]
      if (!e) { errs.push(`${where}: char "${ch}" missing from legend`); continue }
      if (e.terrain.startsWith('@')) { const v = palette[e.terrain.slice(1)]; if (v === undefined) errs.push(`${where}: palette lacks "${e.terrain.slice(1)}"`); else terrain(where, v) }
      if (e.prop?.startsWith('@')) { const v = palette[e.prop.slice(1)]; if (v === undefined) errs.push(`${where}: palette lacks "${e.prop.slice(1)}"`); else prop(where, v) }
    }
  }
  const inside = (where: string, t: { w: number; h: number }, [x, y]: [number, number], what: string) => {
    if (x < 0 || y < 0 || x >= t.w || y >= t.h) errs.push(`${where}: ${what} (${x},${y}) out of bounds`)
  }
  checkLegend('layouts/towns', wc.townLayouts.legend)
  checkLegend('layouts/interiors', wc.interiorLayouts.legend)
  for (const [id, t] of Object.entries(wc.townLayouts.templates)) {
    const w = `town layout ${id}`
    t.buildings.forEach((b) => prop(w, b.prop))
    t.props.forEach((p) => prop(w, p.prop))
    for (const [k, p] of Object.entries(t.anchors)) inside(w, t, p, `anchor ${k}`)
    for (const [k, p] of Object.entries(t.exits)) {
      inside(w, t, p, `exit ${k}`)
      if (p[0] !== 0 && p[1] !== 0 && p[0] !== t.w - 1 && p[1] !== t.h - 1) errs.push(`${w}: exit ${k} is not on the edge`)
    }
    inside(w, t, t.square, 'square')
  }
  for (const [id, t] of Object.entries(wc.interiorLayouts.templates)) {
    const w = `interior ${id}`
    checkGrid(w, t, wc.interiorLayouts.legend, { ...wc.interiorLayouts.palette, ...t.palette })
    music(w, t.music)
    if (t.biome) biome(w, t.biome)
    t.props.forEach((p) => prop(w, p.prop))
    inside(w, t, t.arrive, 'arrive')
    if (t.exit) inside(w, t, t.exit, 'exit')
    for (const [k, p] of Object.entries(t.anchors)) inside(w, t, p, `anchor ${k}`)
    for (const [k, l] of Object.entries(t.links ?? {})) { inside(w, t, [l.x, l.y], `link ${k}`); inside(w, t, l.arrive, `link ${k} arrive`) }
  }

  // towns.json
  dup('towns', wc.towns.map((t) => t.id))
  const starts = wc.towns.filter((t) => t.start)
  if (starts.length !== 1) errs.push(`towns: exactly one start town required (found ${starts.length})`)
  const badgeIds: string[] = []
  const tplById: Record<string, TownTemplate> = {}
  for (const t of wc.towns) {
    const w = `town ${t.id}`
    region(w, t.region)
    if (wc.regions.find((r) => r.id === t.region)?.water) errs.push(`${w}: region must be land`)
    music(w, t.music)
    const base = wc.townLayouts.templates[t.layout]
    if (!base) { errs.push(`${w}: unknown layout "${t.layout}"`); continue }
    const tpl = t.mirror ? mirrorTownTemplate(base, propSize) : base
    tplById[t.id] = tpl
    const palette = { ...wc.townLayouts.palette, ...t.palette }
    checkGrid(w, tpl, wc.townLayouts.legend, palette)
    const slots = new Set(tpl.buildings.map((b) => b.slot))
    for (const k of Object.keys(t.buildings ?? {})) if (!slots.has(k)) errs.push(`${w}: building "${k}" not in layout ${t.layout}`)
    for (const b of tpl.buildings) {
      const bs = t.buildings?.[b.slot]
      const p = bs?.prop ?? b.prop
      prop(w, p)
      if (!c.props[p]?.door) continue
      const floors = bs?.floors ?? (bs?.interior ? [bs.interior] : [])
      if (!floors.length) errs.push(`${w}: building "${b.slot}" has a door but no interior`)
      floors.forEach((f, k) => {
        const it: InteriorTemplate | undefined = wc.interiorLayouts.templates[f]
        if (!it) { errs.push(`${w}: unknown interior "${f}"`); return }
        if (k === 0 && !it.exit) errs.push(`${w}: ground floor "${f}" has no exit`)
        if (k + 1 < floors.length && !it.links?.up) errs.push(`${w}: floor "${f}" has no up link`)
        if (k > 0 && !it.links?.down) errs.push(`${w}: floor "${f}" has no down link`)
      })
    }
    for (const s of tpl.signs) {
      if (t.signs[s.slot] === undefined && !(`${s.slot}Sign` in wc.world.text)) errs.push(`${w}: no text for sign "${s.slot}"`)
    }
    if (t.gym) {
      if (!c.typeById[t.gym.type]) errs.push(`${w}: unknown gym type "${t.gym.type}"`)
      if (!c.characterById[t.gym.leader]) errs.push(`${w}: unknown leader sheet "${t.gym.leader}"`)
      badgeIds.push(t.gym.badge)
    }
    if (t.start) {
      const home = tpl.buildings.find((b) => b.slot === t.home)
      if (!home || !c.props[t.buildings?.[home.slot]?.prop ?? home.prop]?.door) errs.push(`${w}: start town needs a "home" slot with a door`)
    }
  }
  dup('badges', badgeIds)

  // routes.json
  dup('routes', wc.routes.map((r) => r.id))
  for (const r of wc.routes) {
    const w = `route ${r.id}`
    biome(w, r.biome); music(w, r.music); terrain(w, r.terrain)
    for (const [town, exit] of [[r.from, r.fromExit], [r.to, r.toExit]]) {
      const tpl = tplById[town]
      if (!tpl) errs.push(`${w}: unknown town "${town}"`)
      else if (!tpl.exits[exit]) errs.push(`${w}: town ${town} has no exit "${exit}"`)
    }
    if (r.gate) region(w, r.gate.region)
    if (r.levelRange[0] > r.levelRange[1]) errs.push(`${w}: bad levelRange`)
  }

  // caves
  dup('caves', wc.caves.caves.map((cv) => cv.id))
  for (const cv of wc.caves.caves) {
    const w = `cave ${cv.id}`
    biome(w, cv.biome); cv.habitats.forEach((h) => biome(w, h)); music(w, cv.music)
    for (const k of [cv.floor, cv.wall, cv.mat]) terrain(w, k)
    cv.accents.forEach((a) => terrain(w, a.terrain))
    cv.props.forEach((p) => prop(w, p.prop))
    if (cv.ends.length < 2) errs.push(`${w}: needs two ends`)
    cv.ends.forEach((e) => region(w, e.region))
  }

  // climate.json
  for (const r of wc.climate.rules) biome('climate.rules', r.biome)
  if (wc.climate.rules.some((r) => r.t || r.m || r.weird || r.elev || r.sea) && Object.keys(wc.climate.rules[wc.climate.rules.length - 1]).length !== 1) {
    errs.push('climate.rules: the last rule must be an unconditional fallback')
  }

  // wilds.json
  const wl = wc.wilds
  for (const [b, pool] of Object.entries(wl.names)) { biome('wilds.names', b); if (!pool.prefix.length || !pool.suffix.length) errs.push(`wilds.names.${b}: empty pool`) }
  // Every biome the core continent can produce (frontier-only biomes are named by frontier/names.json).
  const coreBiomes = new Set([...wc.climate.rules.map((r) => r.biome), ...wc.regions.map((r) => r.biome)])
  for (const b of coreBiomes) if (!wl.names[b]) errs.push(`wilds.names: no pool for biome "${b}"`)
  for (const [b, m] of Object.entries(wl.biomeMusic)) { biome('wilds.biomeMusic', b); music('wilds.biomeMusic', m) }
  for (const b of Object.keys(wl.biomeWeather)) biome('wilds.biomeWeather', b)
  if (!wl.tiers.length || wl.tiers[0].minDist !== 0) errs.push('wilds.tiers: first tier must start at minDist 0')
  for (let k = 1; k < wl.tiers.length; k++) if (wl.tiers[k].minDist <= wl.tiers[k - 1].minDist) errs.push('wilds.tiers: must be sorted by minDist')
  if (wl.maxRegions > 200) errs.push('wilds.maxRegions: overworld region index is 8-bit (keep <= 200)')

  // pois.json
  const pz = wc.pois
  const loreKeys = (where: string, text: string, extra: string[] = []) => {
    for (const m of text.matchAll(/\{(\w+)\}/g)) {
      const k = m[1]
      if (k !== 'biome' && !extra.includes(k) && !pz.lore.words[k]?.length) errs.push(`${where}: unknown word pool "{${k}}"`)
    }
  }
  const loreSign = (where: string, key: string) => {
    const list = pz.lore.templates[key]
    if (!list?.length) { errs.push(`${where}: unknown lore template "${key}"`); return }
    list.forEach((t) => loreKeys(`${where} lore.${key}`, t, ['name']))
  }
  for (const b of Object.keys(pz.lore.biomeWords)) biome('pois.lore.biomeWords', b)
  const hs = pz.hamlets
  hs.names.forEach((n) => loreKeys('pois.hamlets.names', n))
  terrain('pois.hamlets.plaza', hs.plaza.terrain); hs.plaza.centerProps.forEach((k) => prop('pois.hamlets.plaza', k))
  terrain('pois.hamlets.road', hs.road)
  const interiorOk = (where: string, id: string) => {
    const it = wc.interiorLayouts.templates[id]
    if (!it) errs.push(`${where}: unknown interior "${id}"`)
    else if (!it.exit) errs.push(`${where}: interior "${id}" has no exit`)
  }
  const doorProp = (where: string, key: string) => { prop(where, key); if (c.props[key] && !c.props[key].door) errs.push(`${where}: prop "${key}" has no door`) }
  for (const h of hs.buildings.house) { doorProp('pois.hamlets.house', h.prop); h.interiors.forEach((i) => interiorOk('pois.hamlets.house', i)) }
  for (const b of [hs.buildings.center, hs.buildings.shop]) { doorProp('pois.hamlets.buildings', b.prop); interiorOk('pois.hamlets.buildings', b.interior) }
  terrain('pois.hamlets.fields', hs.fields.terrain); hs.fields.crops.forEach((k) => prop('pois.hamlets.fields', k)); prop('pois.hamlets.fields', hs.fields.fence)
  hs.decor.forEach((d) => prop('pois.hamlets.decor', d.prop))
  loreSign('pois.hamlets.sign', hs.sign)
  music('pois.hamlets', hs.music)
  for (const [id, t] of Object.entries(pz.templates)) {
    const w = `poi ${id}`
    t.names.forEach((n) => loreKeys(w, n))
    if (t.biomes !== 'any') t.biomes.forEach((b) => biome(w, b))
    t.ground?.forEach((g) => terrain(w, g.terrain))
    t.parts.forEach((p) => { prop(w, p.prop); p.on?.forEach((k) => terrain(w, k)) })
    if (t.sign) loreSign(w, t.sign)
    if (t.nest) { terrain(w, t.nest.terrain); for (const [b, k] of Object.entries(t.nest.byBiome ?? {})) { biome(w, b); terrain(w, k) } }
    if (t.count[0] > t.count[1]) errs.push(`${w}: bad count`)
  }

  // dungeons.json
  const dg = wc.dungeons
  doorProp('dungeons.mouthProp', dg.mouthProp)
  prop('dungeons.stairsProp', dg.stairsProp)
  if (!dg.floorName.includes('{floor}')) errs.push('dungeons.floorName: needs {floor}')
  dup('dungeons.styles', dg.styles.map((st) => st.id))
  if (dg.floors[0] < 1 || dg.floors[0] > dg.floors[1]) errs.push('dungeons.floors: bad range')
  for (const st of dg.styles) {
    const w = `dungeon style ${st.id}`
    if (st.biomes !== 'any') st.biomes.forEach((b) => biome(w, b))
    st.habitats.forEach((b) => biome(w, b))
    st.names.forEach((n) => loreKeys(w, n))
    for (const k of [st.floor, st.wall, st.mat]) terrain(w, k)
    st.accents.forEach((a) => terrain(w, a.terrain))
    st.props.forEach((p) => prop(w, p.prop))
    music(w, st.music)
    if (st.algo === 'walk' && !st.walk) errs.push(`${w}: algo "walk" needs walk settings`)
  }

  // items.json
  if (!wc.items.bands.length) errs.push('items: needs at least one band')
  for (let k = 1; k < wc.items.bands.length; k++) if (wc.items.bands[k].maxLevel <= wc.items.bands[k - 1].maxLevel) errs.push('items: bands must be sorted by maxLevel')

  // all map ids that will exist must be unique
  const mapIds = [ow.id, ...wc.caves.caves.map((cv) => cv.id)]
  for (const t of wc.towns) {
    const tpl = tplById[t.id]
    if (!tpl) continue
    for (const b of tpl.buildings) {
      const bs = t.buildings?.[b.slot]
      const floors = bs?.floors ?? (bs?.interior ? [bs.interior] : [])
      const baseId = bs?.mapId ?? `${t.id}-${b.slot}`
      if (floors.length === 1) mapIds.push(baseId)
      else floors.forEach((_, k) => mapIds.push(`${baseId}-${k + 1}f`))
    }
  }
  dup('map ids', mapIds)
  errs.push(...validateFrontierContent(undefined, wc, c))
  errs.push(...validateFrontierPack(undefined, c))
  return errs
}
