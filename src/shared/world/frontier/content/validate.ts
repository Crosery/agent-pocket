// Reference validation for content/world/frontier-content/*.json (+ the story bounty fields it reuses).
import { CONTENT, type Content } from '../../../content/index.ts'
import { GAMEPLAY } from '../../../gameplay/data.ts'
import { WORLD_CONTENT } from '../../data.ts'
import { FRONTIER_CONTENT } from '../config.ts'
import { bountyReward, FRONTIER_PACK, type FrontierPack } from './data.ts'
import type { ChallengeRole, Curve, ItemTier, Lines, SiteChances, TrainerClass } from './schema.ts'

const TIMES = new Set(['dawn', 'day', 'dusk', 'night'])
const WEATHER = new Set(['clear', 'rain', 'snow', 'sand', 'fog', 'aurora', 'ash'])

export function validateFrontierPack(p: FrontierPack = FRONTIER_PACK, c: Content = CONTENT): string[] {
  const errs: string[] = []
  const bgm = new Set(c.audio.bgm.map((b) => b.id))
  const kindIds = new Set(FRONTIER_CONTENT.sites.kinds.map((k) => k.id))
  const templates = new Set([...Object.keys(WORLD_CONTENT.pois.templates), ...Object.keys(FRONTIER_CONTENT.sites.templates)])
  const sprite = (w: string, id: string) => { if (!c.characterById[id]) errs.push(`${w}: unknown sprite "${id}"`) }
  const item = (w: string, id: string) => { if (!c.items[id]) errs.push(`${w}: unknown item "${id}"`) }
  const prop = (w: string, id: string) => { if (!c.props[id]) errs.push(`${w}: unknown prop "${id}"`) }
  const type = (w: string, id: string) => { if (!c.typeById[id]) errs.push(`${w}: unknown type "${id}"`) }
  const biome = (w: string, id: string) => { if (!c.biomeById[id]) errs.push(`${w}: unknown biome "${id}"`) }
  const nonEmpty = (w: string, a: readonly unknown[] | undefined) => { if (!a || !a.length) errs.push(`${w}: must not be empty`) }
  const lines = (w: string, a: readonly Lines[] | undefined) => { nonEmpty(w, a); for (const l of a ?? []) if (!Array.isArray(l) || l.some((s) => typeof s !== 'string')) errs.push(`${w}: dialogue must be string[][]`) }
  const curve = (w: string, cv: Curve) => { nonEmpty(w, cv); for (let k = 1; k < cv.length; k++) if (cv[k][0] <= cv[k - 1][0]) errs.push(`${w}: distances must increase`) }
  const range = (w: string, r: readonly number[] | undefined) => { if (!r || r.length !== 2 || !(r[0] <= r[1])) errs.push(`${w}: must be [min, max]`) }
  const tiers = (w: string, t: readonly ItemTier[]) => {
    nonEmpty(w, t)
    t.forEach((x, i) => { if (i && x.minDistance <= t[i - 1].minDistance) errs.push(`${w}: minDistance must increase`); nonEmpty(`${w}[${i}].pool`, x.pool); for (const r of x.pool) { item(`${w}[${i}]`, r.item); range(`${w}[${i}].${r.item}.qty`, r.qty) } })
  }
  const chances = (w: string, s: SiteChances) => { for (const k of Object.keys(s)) if (!kindIds.has(k) && !templates.has(k)) errs.push(`${w}: "${k}" is neither a site kind nor a POI template`) }
  const klass = (w: string, k: TrainerClass) => {
    nonEmpty(`${w}.sprites`, k.sprites); k.sprites.forEach((s) => sprite(w, s)); nonEmpty(`${w}.names`, k.names)
    k.types.forEach((t) => type(w, t)); if (k.biomes !== 'any') k.biomes.forEach((b) => biome(w, b))
    lines(`${w}.intro`, k.intro); lines(`${w}.defeat`, k.defeat); nonEmpty(`${w}.after`, k.after)
    for (const id of Object.keys(k.items ?? {})) item(w, id)
  }
  const rarities = (w: string, tiers: ChallengeRole['rarity']) => {
    nonEmpty(w, tiers)
    for (const t of tiers) for (const r of Object.keys(t.weights)) if (!c.rarityById[r]) errs.push(`${w}: unknown rarity "${r}"`)
  }

  // common.json
  const C = p.common
  if (C.directions.length !== 8) errs.push('frontier-content.common.directions: 8 bearings expected')
  nonEmpty('frontier-content.common.distances', C.distances)
  for (const k of C.place.avoidTerrain) if (!c.terrainByKey[k]) errs.push(`frontier-content.common.place.avoidTerrain: unknown terrain "${k}"`)
  for (const [k, v] of Object.entries(C.templateAliases)) { if (!templates.has(k)) errs.push(`frontier-content.common.templateAliases: unknown template "${k}"`); nonEmpty(`templateAliases.${k}`, v) }
  for (const w of WEATHER) if (!(C.textKeys.weather.replace('{id}', w) in c.text)) errs.push(`frontier-content.common.textKeys.weather: missing text for "${w}"`)
  for (const tm of TIMES) if (!(C.textKeys.timeOfDay.replace('{id}', tm) in c.text)) errs.push(`frontier-content.common.textKeys.timeOfDay: missing text for "${tm}"`)
  nonEmpty('frontier-content.common.dangerNames', C.dangerNames)

  // villagers.json
  const V = p.villagers
  range('villagers.perHamlet', V.perHamlet)
  nonEmpty('villagers.archetypes', V.archetypes)
  for (const a of V.archetypes) {
    const w = `villagers.archetypes.${a.id}`
    a.sprites.forEach((s) => sprite(w, s)); nonEmpty(`${w}.names`, a.names); lines(`${w}.lines`, a.lines)
    if (a.role && !['gossip', 'sage', 'tips', 'gift'].includes(a.role)) errs.push(`${w}: unknown role "${a.role}"`)
    a.biomes?.forEach((b) => biome(w, b))
  }
  for (const [b, l] of Object.entries(V.biomeLines)) { if (b !== 'default') biome('villagers.biomeLines', b); lines(`villagers.biomeLines.${b}`, l) }
  for (const d of V.distanceLines) lines(`villagers.distanceLines.${d.minDistance}`, d.lines)
  const tags = new Set(GAMEPLAY.events.map((e) => e.tag).filter(Boolean))
  for (const tg of Object.keys(V.gossip.tagWeights)) if (!tags.has(tg)) errs.push(`villagers.gossip.tagWeights: no event has tag "${tg}"`)
  lines('villagers.gossip.none', V.gossip.none); lines('villagers.sage.notReady', V.sage.notReady)
  tiers('villagers.gift.tiers', V.gift.tiers)
  V.residents.sprites.forEach((s) => sprite('villagers.residents', s)); lines('villagers.residents.lines', V.residents.lines)
  for (const b of Object.keys(V.residents.biomeLines)) biome('villagers.residents.biomeLines', b)

  // trainers.json
  const T = p.trainers
  curve('trainers.party.size', T.party.size); curve('trainers.party.aiLevel', T.party.aiLevel); curve('trainers.party.rewardDistanceMul', T.party.rewardDistanceMul)
  rarities('trainers.party.rarity', T.party.rarity)
  curve('trainers.wander.count', T.wander.count); range('trainers.wander.sightRange', T.wander.sightRange)
  nonEmpty('trainers.classes', T.classes)
  if (!T.classes.some((k) => k.biomes === 'any')) errs.push('trainers.classes: at least one class must allow any biome')
  for (const k of T.classes) klass(`trainers.classes.${k.id}`, k)
  for (const b of c.biomes) if (!T.classes.some((k) => k.biomes === 'any' || k.biomes.includes(b.id))) errs.push(`trainers.classes: no class for biome "${b.id}"`)
  for (const [name, role] of [['guardians', T.guardians], ['bosses', T.bosses]] as const) {
    const w = `trainers.${name}`
    if (!bgm.has(role.music)) errs.push(`${w}: unknown music "${role.music}"`)
    rarities(`${w}.rarity`, role.rarity); tiers(`${w}.prizes`, role.prizes)
    for (const t of role.items) for (const id of Object.keys(t.items)) item(`${w}.items`, id)
    nonEmpty(`${w}.classes`, role.classes)
    if (!role.classes.some((k) => k.biomes === 'any')) errs.push(`${w}.classes: at least one class must allow any biome`)
    for (const k of role.classes) klass(`${w}.classes.${k.id}`, k)
    if (role.options.length !== 2) errs.push(`${w}.options: [accept, decline]`)
  }
  chances('trainers.guardians.sites', T.guardians.sites)

  // bounties.json (+ the story bounty kinds it reuses)
  const B = p.bounties
  range('bounties.perHamlet', B.perHamlet)
  if (!bountyReward(p)) errs.push('bounties: no reward table (bounties.json reward or story bounties.json reward)')
  for (const [kind, spec] of Object.entries(B.kinds)) {
    const w = `bounties.kinds.${kind}`
    const sk = p.story.kinds?.[spec.story]
    if (!sk) { errs.push(`${w}: story bounty kind "${spec.story}" missing in content/world/story/bounties.json`); continue }
    nonEmpty(`${w} (story ${spec.story}).names`, sk.names); nonEmpty(`${w} (story ${spec.story}).stages`, sk.stages)
    for (const k of spec.destKinds ?? []) if (!kindIds.has(k)) errs.push(`${w}.destKinds: unknown site kind "${k}"`)
    if (kind === 'deliver') (sk.parcels ?? []).forEach((id) => item(`${w}.parcels`, id))
    if (kind === 'hunt' && !p.story.kinds?.[B.outlawStory]?.trainer?.length) errs.push(`bounties.outlawStory: story kind "${B.outlawStory}" has no trainer personas`)
    if (kind === 'fetch') for (const band of sk.fetch?.bands ?? []) band.items.forEach((id) => item(`${w}.fetch`, id))
    if ((kind === 'deliver' || kind === 'visit') && !spec.destKinds?.length) errs.push(`${w}.destKinds: required`)
    if (kind === 'hunt') range(`${w}.road`, spec.road)
  }
  for (const g of Object.values(p.story.kinds ?? {})) for (const per of [...(g.giver ?? []), ...(g.partner ?? [])]) sprite('story bounties persona', per.sprite)
  prop('bounties.board.prop', B.board.prop)
  B.courier.sprites.forEach((s) => sprite('bounties.courier', s))
  for (const [k, v] of Object.entries(B.flags)) if (!/\{(quest|site)\}/.test(v)) errs.push(`bounties.flags.${k}: must contain {quest} or {site}`)

  // landmarks.json
  const L = p.landmarks
  chances('landmarks.keeper.sites', L.keeper.sites); L.keeper.sprites.forEach((s) => sprite('landmarks.keeper', s)); prop('landmarks.keeper.plaque', L.keeper.plaque.prop)
  for (const pat of L.keeper.lore.patterns) for (const m of pat.matchAll(/\{(\w+)\}/g)) if (!L.keeper.lore.words[m[1]] && !['landmark', 'biome', 'region', 'place', 'distance', 'name'].includes(m[1])) errs.push(`landmarks.keeper.lore: unknown word pool "${m[1]}"`)
  chances('landmarks.hermit.sites', L.hermit.sites); L.hermit.sprites.forEach((s) => sprite('landmarks.hermit', s)); curve('landmarks.hermit.requirement', L.hermit.requirement)
  chances('landmarks.merchant.sites', L.merchant.sites)
  for (const m of L.merchant.types) {
    const w = `landmarks.merchant.types.${m.id}`
    m.sprites.forEach((s) => sprite(w, s)); lines(`${w}.intro`, m.intro)
    if (!['rare', 'chips', 'exchange'].includes(m.stock)) errs.push(`${w}: unknown stock "${m.stock}"`)
    for (const tm of m.times ?? []) if (!TIMES.has(tm)) errs.push(`${w}: unknown time "${tm}"`)
    for (const wt of m.weathers ?? []) if (!WEATHER.has(wt)) errs.push(`${w}: unknown weather "${wt}"`)
    if ((m.times?.length || m.weathers?.length) && !m.closed?.length) errs.push(`${w}: gated merchants need closed lines`)
  }
  for (const t of L.merchantStock.rare) t.items.forEach((id) => item('landmarks.merchantStock.rare', id))
  curve('landmarks.merchantStock.maxChipPrice', L.merchantStock.maxChipPrice)
  L.exchange.valuables.forEach((id) => item('landmarks.exchange.valuables', id)); tiers('landmarks.exchange.prizes', L.exchange.prizes)
  chances('landmarks.watcher.sites', L.watcher.sites); L.watcher.sprites.forEach((s) => sprite('landmarks.watcher', s))
  if (!GAMEPLAY.research.tasks.some((tk) => tk.id === L.watcher.researchTask)) errs.push(`landmarks.watcher.researchTask: unknown task "${L.watcher.researchTask}"`)

  // wild.json / interiors.json
  const W = p.wild
  curve('wild.caches.chance', W.caches.chance); W.caches.nearProps.forEach((k) => prop('wild.caches.nearProps', k)); tiers('wild.caches.tiers', W.caches.tiers)
  curve('wild.hermitCamps.chance', W.hermitCamps.chance); W.hermitCamps.props.forEach((k) => prop('wild.hermitCamps.props', k))
  curve('wild.merchantCamps.chance', W.merchantCamps.chance); prop('wild.merchantCamps.prop', W.merchantCamps.prop)
  prop('wild.roadSigns.prop', W.roadSigns.prop)
  p.interiors.explorer.sprites.forEach((s) => sprite('interiors.explorer', s)); lines('interiors.explorer.lines', p.interiors.explorer.lines)
  return errs
}
