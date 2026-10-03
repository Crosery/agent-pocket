// Reference validation for content/world/frontier/*.json (called by validateWorldContent).
import { CONTENT, type Content } from '../../content/index.ts'
import { WORLD_CONTENT, type WorldContent } from '../data.ts'
import { FRONTIER_CONTENT, type FrontierContent } from './config.ts'

const WEATHER = new Set(['clear', 'rain', 'snow', 'sand', 'fog', 'aurora', 'ash'])

export function validateFrontierContent(fc: FrontierContent = FRONTIER_CONTENT, wc: WorldContent = WORLD_CONTENT, c: Content = CONTENT): string[] {
  const errs: string[] = []
  const bgm = new Set(c.audio.bgm.map((b) => b.id))
  const terrain = (where: string, key: string) => { if (!c.terrainByKey[key]) errs.push(`${where}: unknown terrain "${key}"`) }
  const prop = (where: string, key: string) => { if (!c.props[key]) errs.push(`${where}: unknown prop "${key}"`) }
  const biome = (where: string, id: string) => { if (!c.biomeById[id]) errs.push(`${where}: unknown biome "${id}"`) }
  const g = fc.gen

  // gen.json
  if (!(g.chunkSize >= 16) || wc.world.overworld.width % g.chunkSize !== 0 || wc.world.overworld.height % g.chunkSize !== 0) {
    errs.push(`frontier.gen.chunkSize ${g.chunkSize}: must be >= 16 and divide the core continent size`)
  }
  for (const [k, v] of Object.entries(g.cache)) if (!(v >= 1)) errs.push(`frontier.gen.cache.${k}: must be >= 1`)
  for (const k of [g.roads.terrain, g.roads.bridge, g.roads.stairs, g.causeways.terrain]) terrain('frontier.gen', k)
  if (c.terrainByKey[g.roads.stairs] && !c.terrainByKey[g.roads.stairs].stairs) errs.push('frontier.gen.roads.stairs: terrain lacks the stairs flag')
  for (const k of [g.roads.terrain, g.roads.bridge, g.causeways.terrain]) if (c.terrainByKey[k] && !c.terrainByKey[k].walkable) errs.push(`frontier.gen: road terrain "${k}" must be walkable`)
  prop('frontier.gen.rivers.rapidsProp', g.rivers.rapidsProp)
  prop('frontier.gen.decor.seaStacks', g.decor.seaStacks.prop)
  for (const s of g.causeways.specs) s.zones.forEach((z) => { if (!wc.regions.some((r) => r.id === z)) errs.push(`frontier.gen.causeways.${s.id}: unknown zone "${z}"`) })
  const L = g.levels
  for (let k = 1; k < L.curve.length; k++) if (L.curve[k][0] <= L.curve[k - 1][0]) errs.push('frontier.gen.levels.curve: distances must increase')
  for (const [name, arr] of Object.entries({ dangerLevelBonus: L.dangerLevelBonus, rareBoost: L.rareBoost, encounterRate: L.encounterRate, roaming: L.roaming })) {
    if (arr.length !== L.dangerDistances.length) errs.push(`frontier.gen.levels.${name}: one entry per danger tier`)
  }
  for (const id of Object.keys(g.rarityDefaults)) if (!c.rarityById[id]) errs.push(`frontier.gen.rarityDefaults: unknown rarity "${id}"`)

  // biomes.json
  const fb = fc.biomes
  for (const r of [...fb.rules, ...fb.seaRules]) biome('frontier.biomes.rules', r.biome)
  for (const list of [fb.rules, fb.seaRules]) {
    const last = list[list.length - 1]
    if (!last || Object.keys(last).some((k) => k !== 'biome')) errs.push('frontier.biomes: the last rule of each list must be an unconditional fallback')
  }
  for (const b of c.biomes) {
    const s = fb.biomes[b.id]
    if (!s) { errs.push(`frontier.biomes: no spec for biome "${b.id}"`); continue }
    if (!wc.scatter.biomes[b.id]) errs.push(`scatter.biomes: no rules for biome "${b.id}" (frontier)`)
    for (const k of [s.beach, s.ledge, s.road]) terrain(`frontier.biomes.${b.id}`, k)
    if (c.terrainByKey[s.ledge] && !c.terrainByKey[s.ledge].ledge) errs.push(`frontier.biomes.${b.id}: ledge terrain "${s.ledge}" lacks ledge:true`)
    if (!bgm.has(s.music)) errs.push(`frontier.biomes.${b.id}: unknown music "${s.music}"`)
    for (const [w] of s.weather) if (!WEATHER.has(w)) errs.push(`frontier.biomes.${b.id}: unknown weather "${w}"`)
    for (const h of b.encounterHabitats ?? []) biome(`biomes.${b.id}.encounterHabitats`, h)
  }
  for (const id of Object.keys(fb.biomes)) biome('frontier.biomes.biomes', id)

  // sites.json
  const sc = fc.sites
  const templates = { ...wc.pois.templates, ...sc.templates }
  const words = { ...wc.pois.lore.words, ...sc.lore.words }
  const loreTemplates = { ...wc.pois.lore.templates, ...sc.lore.templates }
  const loreKeys = (where: string, text: string, extra: string[] = []) => {
    for (const m of text.matchAll(/\{(\w+)\}/g)) if (m[1] !== 'biome' && !extra.includes(m[1]) && !words[m[1]]?.length) errs.push(`${where}: unknown word pool "{${m[1]}}"`)
  }
  for (const b of [...Object.keys(sc.lore.biomeWords), ...Object.keys(fc.names.biomeWords)]) biome('frontier lore.biomeWords', b)
  if (!sc.kinds.some((k) => k.type === 'hamlet')) errs.push('frontier.sites.kinds: needs a hamlet kind (gateways)')
  const kindIds = new Set<string>()
  for (const k of sc.kinds) {
    if (kindIds.has(k.id) || k.id.includes(':')) errs.push(`frontier.sites.kinds: bad or duplicate id "${k.id}"`)
    kindIds.add(k.id)
    if (k.type === 'poi' && k.template !== '*' && !templates[k.template ?? '']) errs.push(`frontier.sites.kinds.${k.id}: unknown template "${k.template}"`)
    for (const b of Object.keys(k.biomes ?? {})) biome(`frontier.sites.kinds.${k.id}`, b)
  }
  sc.landmarkPool.forEach((id) => { if (!templates[id]) errs.push(`frontier.sites.landmarkPool: unknown template "${id}"`) })
  for (const [id, t] of Object.entries(sc.templates)) {
    const w = `frontier poi ${id}`
    t.names.forEach((n) => loreKeys(w, n))
    if (t.biomes !== 'any') t.biomes.forEach((b) => biome(w, b))
    t.ground?.forEach((gr) => terrain(w, gr.terrain))
    t.parts.forEach((p) => { prop(w, p.prop); p.on?.forEach((k) => terrain(w, k)) })
    if (t.sign) {
      const list = loreTemplates[t.sign]
      if (!list?.length) errs.push(`${w}: unknown lore template "${t.sign}"`)
      else list.forEach((x) => loreKeys(`${w} lore.${t.sign}`, x, ['name']))
    }
    if (t.nest) { terrain(w, t.nest.terrain); for (const [b, k] of Object.entries(t.nest.byBiome ?? {})) { biome(w, b); terrain(w, k) } }
  }
  prop('frontier.sites.dungeon.mouthProp', sc.dungeon.mouthProp)
  if (c.props[sc.dungeon.mouthProp] && !c.props[sc.dungeon.mouthProp].door) errs.push('frontier.sites.dungeon.mouthProp: prop has no door')
  terrain('frontier.sites.dungeon.padTerrain', sc.dungeon.padTerrain)
  if (sc.dungeon.floors[0] < 1 || sc.dungeon.floors[0] > sc.dungeon.floors[1]) errs.push('frontier.sites.dungeon.floors: bad range')
  for (const n of [...(sc.hamlet.names ?? []), ...sc.gateway.names]) loreKeys('frontier.sites hamlet names', n)

  // names.json
  for (const b of Object.keys(fc.names.region.byBiome)) biome('frontier.names.region.byBiome', b)
  if (!fc.names.region.fallback.length || !fc.names.province.patterns.length) errs.push('frontier.names: empty pools')

  // decor.json
  const dc = fc.decor
  prop('frontier.decor.signposts', dc.signposts.prop)
  for (const t of dc.services.shopTiers) t.items.forEach((it) => { if (!c.items[it]) errs.push(`frontier.decor.services.shopTiers: unknown item "${it}"`) })
  for (const k of ['hamlet', 'landmark', 'dungeon']) if (!dc.placeDescriptions[k]) errs.push(`frontier.decor.placeDescriptions: missing "${k}"`)
  for (const sp of [...dc.villagers.sprites, ...dc.residents.sprites, dc.services.nurse.sprite, dc.services.box.sprite, dc.services.clerk.sprite]) {
    if (!c.characterById[sp]) errs.push(`frontier.decor: unknown character sprite "${sp}"`)
  }
  if (dc.villagers.perHamlet[0] > dc.villagers.perHamlet[1] || dc.items.perChunk[0] > dc.items.perChunk[1]) errs.push('frontier.decor: bad range')
  return errs
}
