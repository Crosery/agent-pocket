// Client runtime of the world-event / rarity / research layer (rules: src/shared/gameplay/*; tunables:
// content/events/client.json). Owned by the overworld controller, which feeds it the player's place and provides
// a handful of services (NPC layer, scripts, wild battles, weather):
//   - scheduler: one tickEvents() per eventSlot (spawn.json scheduler.checkEveryMinutes in-game minutes), start /
//     end handling, walk-away ending of local events, modifiers (encounter boosts, weather override, ambience);
//   - start effects: flags, start announcements (toast + news log flag), banners, revealPlace, queued scripts, and the
//     event's presence on its anchor map — temporary NPCs / pop-up trainers, visible event spawns, scattered items —
//     re-materialised deterministically after map changes and reloads (startActions with eventSalt);
//   - rarity spawns: tall-grass picks (pickGrassEncounter) and visible roamer picks (pickVisibleSpawn) for roaming.ts;
//   - roaming UR legends: legendsNear() -> HUD sense pill / ambience, legend encounter event + visible legend roamer,
//     battle bookkeeping (onLegendBattleEnd with the carried hp), minimap pings;
//   - rumors (town visits / ambient) logged in SaveData.flags, ScriptStep hooks (triggerEvent, revealPlace),
//     research from battles (research.ts observer), HUD (event chips, sense pill, ambience overlays), dev hooks.
import type {
  BattleSideInit, Creature, EventCondition, FieldWeatherKind, GameMap, NpcDef, RegionDef, ScriptStep, TownDef, TrainerDef,
} from '../../shared/types.ts'
import type { BattleOutcome, GameContext, MinimapMarker } from '../contracts.ts'
import type { IRng } from '../../shared/contracts.ts'
import { t } from '../../shared/content/index.ts'
import { Rng, hashString } from '../../shared/rng.ts'
import { createCreature } from '../../shared/creature.ts'
import { GAMEPLAY } from '../../shared/gameplay/data.ts'
import {
  activeEvents, dayOf, endEvent, eventAppliesAt, eventContext, eventDescription, eventFocus, eventModifiers, eventParams, eventRng,
  eventSalt, eventSlot, eventTitle, evaluateCondition, expandFlag, modifierValue, NO_MODIFIERS, pickRumor, realDateOf, resolvePlaceRef,
  rumorFlag, startActions, tickEvents, triggerEvent, type ActiveEvent, type EventAnchor, type EventContext, type EventModifiers,
  type StartActions,
} from '../../shared/gameplay/events.ts'
import {
  fleeFor, legendsNear, onLegendBattleEnd, pickGrassEncounter, pickVisibleSpawn, resolveSpawnEffect, rollShinyFor, snapToFree,
  speciesBehavior, type NearLegend, type WildPick,
} from '../../shared/gameplay/spawns.ts'
import { distanceFromOrigin, regionAt, worldOrigin } from '../../shared/world/worldapi.ts'
import { STORY_CONTENT } from '../../shared/world/story.ts'
import { createEventHud } from '../ui/event-hud.ts'
import { grassEncounterRate, textOrKey } from './config.ts'
import { auraCueColor, cueDef, GPC, pingColor } from './gameplay-config.ts'
import { placeById, placesNear, realPlaceId, revealedPlaces } from './places.ts'
import {
  createAmbienceEmitter, createCuePlayer, createSpecialLayer, cutsPassage, roamPickOf, specialSpecOf, standable, type Special,
} from './rarity-spawns.ts'
import { createResearchObserver, researchState, researchSummary, scriptResearch } from './research.ts'
import type { RoamPick } from './roaming.ts'
import { addItem } from './save-ops.ts'
import { eventBenefits } from './event-details.ts'

export interface GameplayPlace { map: GameMap; x: number; y: number; region: RegionDef | null }

export interface GameplayDeps {
  readonly ctx: GameContext
  rng: IRng
  /** Current map, player position and region (null before the first map is entered). */
  place(): GameplayPlace | null
  /** Current field weather (incl. overrides). */
  weather(): FieldWeatherKind
  /** Weather forced by active events / a visible legend (null = none); applied on outdoor maps. */
  setEventWeather(kind: FieldWeatherKind | null): void
  /** Runtime NPCs on the current map (kept across object streaming until removed). */
  npcs: { add(defs: readonly NpcDef[]): void; remove(ids: readonly string[]): void }
  /** Tile reserved by an NPC / warp (no spawns or items there). */
  reserved(tx: number, ty: number): boolean
  runScript(steps: ScriptStep[]): Promise<void>
  /** Wild battle with a prepared creature (locks the overworld, blackout on loss); null when it could not start. */
  startWild(cr: Creature, opts: { flee?: BattleSideInit['flee'] }): Promise<BattleOutcome | null>
}

interface ScatterItem { id: string; event: string; startedAt: number; x: number; y: number; item: string; qty: number; hidden: boolean }
interface Materialized { npcs: string[]; trainers: string[] }

const MINUTE_SEC = (c: GameContext['data']) => c.config.time.dayRealSeconds / (24 * 60)
const keyOf = (ev: ActiveEvent) => `${ev.id}@${ev.startedAt}`

export function createGameplayRuntime(deps: GameplayDeps) {
  const { ctx, rng } = deps
  const world = ctx.data.world
  const rules = GAMEPLAY.spawn
  const cues = createCuePlayer(ctx)
  const ambience = createAmbienceEmitter(ctx, rng)
  const hudRoot = ctx.hud.overlay.parentElement ?? ctx.ui.root
  const hud = createEventHud(hudRoot, ctx.ui)
  const research = createResearchObserver(ctx, () => ({ timeOfDay: ctx.clock.timeOfDay, weather: deps.weather(), biome: deps.place()?.region?.biome ?? null }))

  let saveRef = ctx.save
  let lastSlot = Number.NaN
  let checkCooldown = 0
  let active: ActiveEvent[] = []
  let mods: EventModifiers = NO_MODIFIERS
  /** Modifiers for prices / rewards: inside buildings and dungeons evaluated at the last overworld spot, so a
   * region's sale or price surge reaches its shops (ambience / weather stay with `mods`). */
  let valueMods: EventModifiers = NO_MODIFIERS
  let lastCtx: EventContext | null = null
  let mapId: string | null = null
  const materialized = new Map<string, Materialized>()
  /** Pop-up trainers registered in world.trainers per event (kept across map changes until the event ends). */
  const eventTrainers = new Map<string, string[]>()
  let items: ScatterItem[] = []
  let glintT = 0
  const pending: ScriptStep[][] = []
  let scriptBusy = false
  let battleBusy = false
  let bannerAt = -Infinity
  let hudT = 0
  let legendT = 0
  let sensed: NearLegend | null = null
  const senseToastAt = new Map<string, number>()
  let legendAmbience: string[] = []
  let legendWeather: FieldWeatherKind | null = null
  let lastWeather: FieldWeatherKind | null | undefined
  let lastTown: string | null = null
  let rumorAt = -Infinity
  let ambientRumorAt = 0
  let overworldPos: { x: number; y: number } | null = null
  const nearCache = { key: '', ids: [] as string[], places: [] as TownDef[] }

  const special = createSpecialLayer({
    ctx, rng, cues,
    map: () => deps.place()?.map ?? null,
    reserved: (tx, ty) => deps.reserved(tx, ty),
  })

  const nowSec = () => performance.now() / 1000
  const minutes = () => ctx.save.clockMinutes
  const eventSeed = () => hashString(`${GPC.scheduler.seedSalt}:${world.seed >>> 0}:${ctx.save.playerId}`)
  const flagVars = () => ({ year: realDateOf(new Date()).year, day: dayOf(minutes()) })
  const expand = (f: string) => (f.includes('{') ? expandFlag(f, flagVars()) : f)
  const anchorOf = (p: GameplayPlace): EventAnchor => ({ map: p.map.id, x: Math.floor(p.x), y: Math.floor(p.y), ...(p.region ? { region: p.region.id } : {}) })
  const isOverworld = (m: GameMap) => m.id === world.startMap
  const speciesName = (id: string) => ctx.data.species[id]?.nameZh ?? id
  const legendTitle = (species: string) => t(`events.legend.${species}.title`)

  // -------------------------------------------------------------------------------------------- context

  function nearPlaces(p: GameplayPlace): TownDef[] {
    const cell = Math.max(1, GPC.places.nearCacheTiles)
    const key = `${p.map.id}:${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`
    if (nearCache.key !== key) {
      nearCache.key = key
      nearCache.places = placesNear(world, p.map, p.x, p.y, rules.scheduler.localRadius)
      nearCache.ids = nearCache.places.map((pl) => pl.id)
    }
    return nearCache.places
  }

  function distanceOf(p: GameplayPlace): number {
    if (isOverworld(p.map)) return distanceFromOrigin(world, p.x, p.y)
    return overworldPos ? distanceFromOrigin(world, overworldPos.x, overworldPos.y) : 0
  }

  function contextAt(p: GameplayPlace, region: RegionDef | null = p.region): EventContext {
    nearPlaces(p)
    return eventContext(ctx.save, {
      real: realDateOf(new Date()), weather: deps.weather(), biome: region?.biome ?? null, regionId: region?.id ?? null,
      regionDanger: region?.danger ?? 0, distance: distanceOf(p), outdoor: p.map.outdoor, nearPlaces: nearCache.ids,
      researchLevel: researchSummary(ctx.save).level,
    })
  }

  const areaLevelAt = (map: GameMap, x: number, y: number): [number, number] =>
    regionAt(map, x, y)?.levelRange ?? GPC.scheduler.fallbackAreaLevel

  // -------------------------------------------------------------------------------------------- start / presence

  /** Placement origin of an event: the place its condition gathers at (eventFocus), else its anchor. */
  function focusOf(ev: ActiveEvent, map: GameMap): { x: number; y: number } {
    const a = ev.anchor ?? { map: map.id, x: 0, y: 0 }
    const f = eventFocus(ev.def, placesNear(world, map, a.x, a.y, rules.scheduler.localRadius), a)
    return f ? { x: f.x, y: f.y } : { x: a.x, y: a.y }
  }

  /** Same event run => same actions (positions, trainers' parties, items) on every materialisation. */
  function actionsFor(ev: ActiveEvent, map: GameMap): StartActions {
    const at = focusOf(ev, map)
    return startActions(ev, { areaLevel: areaLevelAt(map, at.x, at.y), rng: new Rng(eventSalt(eventSeed(), ev)), at })
  }

  function freeTile(map: GameMap): (x: number, y: number) => boolean {
    const p = deps.place()
    const ptx = p ? Math.floor(p.x) : NaN, pty = p ? Math.floor(p.y) : NaN
    return (x, y) => !(x === ptx && y === pty) && standable(map, x, y, ctx) && !deps.reserved(x, y)
  }

  function materialize(ev: ActiveEvent, map: GameMap, given?: StartActions): void {
    if (!ev.anchor || ev.anchor.map !== map.id || materialized.has(ev.id)) return
    const a = given ?? actionsFor(ev, map)
    const free = freeTile(map)
    const snap = (x: number, y: number, r: number) => snapToFree(x, y, free, r)
    // Stationary blockers (NPCs, pop-up trainers) never take a tile that cuts a walkway (causeways, bridges, door
    // lanes) nor one another's tile.
    const taken = new Set<string>()
    const takenAt = (x: number, y: number) => taken.has(`${x},${y}`) || deps.reserved(x, y)
    const snapBlocker = (x: number, y: number) => {
      const at = snapToFree(x, y, (tx, ty) => free(tx, ty) && !taken.has(`${tx},${ty}`) && !cutsPassage(map, tx, ty, takenAt), GPC.special.snapRadius)
      if (at) taken.add(`${at.x},${at.y}`)
      return at
    }
    const won = STORY_CONTENT.meta.flags.trainerWon
    const npcDefs: NpcDef[] = []
    const trainers: TrainerDef[] = []
    for (const n of a.npcs) {
      const at = snapBlocker(n.x, n.y)
      if (at) npcDefs.push({ ...n, x: at.x, y: at.y })
    }
    for (const tr of a.trainers) {
      const at = snapBlocker(tr.npc.x, tr.npc.y)
      if (!at) continue
      world.trainers[tr.trainer.id] = tr.trainer
      trainers.push(tr.trainer)
      npcDefs.push({ ...tr.npc, x: at.x, y: at.y })
      if (ev.startedAt === minutes()) delete ctx.save.flags[won + tr.trainer.id]
    }
    if (npcDefs.length) deps.npcs.add(npcDefs)
    materialized.set(ev.id, { npcs: npcDefs.map((n) => n.id), trainers: trainers.map((x) => x.id) })
    if (trainers.length) eventTrainers.set(ev.id, [...new Set([...(eventTrainers.get(ev.id) ?? []), ...trainers.map((x) => x.id)])])
    if (GPC.special.mapKinds.includes(map.kind)) {
      const origin = focusOf(ev, map)
      const area = areaLevelAt(map, origin.x, origin.y)
      a.spawns.forEach((eff, k) => {
        const r = new Rng(eventSalt(eventSeed(), ev) ^ Math.imul(k + 1, 0x9e3779b1))
        resolveSpawnEffect(eff, area, r, { mods, research: researchState(ctx.save) }).forEach((v, i) => {
          const tag = `ev:${ev.id}:${k}.${i}`
          const ang = r.next() * Math.PI * 2
          const dist = rules.scheduler.placeRing[0] + r.next() * Math.max(0, rules.scheduler.placeRing[1] - rules.scheduler.placeRing[0])
          if (ctx.save.flags[GPC.flags.spawnTaken + tag] === ev.startedAt) return
          const at = snap(Math.round(origin.x + Math.cos(ang) * dist), Math.round(origin.y + Math.sin(ang) * dist), GPC.special.snapRadius)
          if (!at || special.find(tag)) return
          special.spawn(specialSpecOf(tag, v, r, ctx, map.id), at.x + 0.5, at.y + 0.5, { cue: ev.startedAt === minutes() })
        })
      })
    }
    for (const it of a.items) {
      if (ctx.save.flags[GPC.flags.itemTaken + it.id] === ev.startedAt) continue
      const at = snap(it.x, it.y, GPC.items.snapRadius)
      if (at) items.push({ ...it, x: at.x, y: at.y, event: ev.id, startedAt: ev.startedAt })
    }
  }

  function clearFlagsWithPrefix(prefix: string): void {
    for (const k of Object.keys(ctx.save.flags)) if (k.startsWith(prefix)) delete ctx.save.flags[k]
  }

  function dematerialize(id: string, cue: boolean): void {
    const m = materialized.get(id)
    if (m) {
      deps.npcs.remove([...m.npcs])
      materialized.delete(id)
    }
    for (const tid of [...(m?.trainers ?? []), ...(eventTrainers.get(id) ?? [])]) {
      delete world.trainers[tid]
      delete ctx.save.flags[STORY_CONTENT.meta.flags.trainerWon + tid]
    }
    eventTrainers.delete(id)
    special.removeWhere((s) => s.tag.startsWith(`ev:${id}:`), cue)
    items = items.filter((it) => it.event !== id)
  }

  function onStarted(ev: ActiveEvent, p: GameplayPlace): void {
    const def = ev.def
    const map = p.map
    const a = actionsFor(ev, map)
    for (const f of a.flags) ctx.save.flags[expand(f.flag)] = f.value
    const title = eventTitle(def)
    const S = GPC.start
    if (def.hidden) {
      ctx.ui.toast(t('events.ui.hiddenFound', { name: title }), S.hiddenToastKind)
      ctx.audio.playSfx(S.hiddenSfx)
    } else ctx.audio.playSfx(S.startSfx)
    const params = eventParams(def)
    for (const key of a.rumors) ctx.ui.toast(textOrKey(key, params), S.rumorToastKind)
    ctx.save.flags[GPC.flags.news + def.id] = Math.max(1, Math.floor(minutes()))
    if (!def.hidden && def.tag && S.bannerTags.includes(def.tag) && nowSec() - bannerAt > S.bannerCooldownSec) {
      bannerAt = nowSec()
      ctx.hud.showBanner(title, eventDescription(def))
    } else if (!def.hidden && !a.rumors.length) ctx.ui.toast(t('events.ui.started', { name: title }), S.rumorToastKind)
    for (const ref of a.reveals) revealPlace(ref)
    for (const steps of a.scripts) pending.push(steps)
    materialize(ev, map, a)
  }

  function onEnded(ev: ActiveEvent): void {
    dematerialize(ev.id, true)
    clearFlagsWithPrefix(`${GPC.flags.spawnTaken}ev:${ev.id}:`)
    clearFlagsWithPrefix(`${GPC.flags.itemTaken}ev:${ev.id}:`)
    if (!ev.def.hidden && ev.def.trigger !== 'legend' && ev.def.scope !== 'local') ctx.ui.toast(t('events.ui.ended', { name: eventTitle(ev.def) }), GPC.start.rumorToastKind)
  }

  function refreshMods(p: GameplayPlace): void {
    mods = eventModifiers(active, anchorOf(p), minutes())
    if (isOverworld(p.map) || !overworldPos) valueMods = mods
    else {
      const ow = world.maps[world.startMap]
      const r = ow ? regionAt(ow, overworldPos.x, overworldPos.y) : null
      valueMods = eventModifiers(active, { map: world.startMap, x: Math.floor(overworldPos.x), y: Math.floor(overworldPos.y), ...(r ? { region: r.id } : {}) }, minutes())
    }
    const weather = mods.weather ?? legendWeather
    if (weather !== lastWeather) { lastWeather = weather; deps.setEventWeather(weather) }
    const amb = [...mods.ambience, ...legendAmbience]
    ambience.set(amb)
    hud.setAmbience(amb)
  }

  function tick(p: GameplayPlace): void {
    const ectx = contextAt(p)
    lastCtx = ectx
    const r = tickEvents(ctx.save.events ?? {}, ectx, eventRng(eventSeed(), minutes()), { anchor: anchorOf(p) })
    let state = r.state
    for (const ev of r.ended) onEnded(ev)
    for (const ev of r.started) onStarted(ev, p)
    for (const ev of r.active) {
      if (ev.def.scope !== 'local' || ev.def.trigger === 'legend' || !ev.anchor || ev.anchor.map !== p.map.id) continue
      if (Math.hypot(ev.anchor.x - p.x, ev.anchor.y - p.y) > GPC.scheduler.localEndDistance) state = endEvent(ev.id, state, minutes())
    }
    ctx.save.events = state
    active = activeEvents(state, minutes())
    refreshMods(p)
  }

  /** Where nothing is scheduled (interiors, caves) events whose time ran out still end: chips and modifiers stop. */
  function expire(p: GameplayPlace): void {
    const now = minutes()
    const done = active.filter((ev) => ev.endsAt <= now)
    if (!done.length) return
    const state = { ...(ctx.save.events ?? {}) }
    for (const ev of done) {
      const st = state[ev.id]
      if (st) { state[ev.id] = { ...st }; delete state[ev.id].activeUntil }
      onEnded(ev)
    }
    ctx.save.events = state
    active = activeEvents(state, now)
    refreshMods(p)
  }

  // -------------------------------------------------------------------------------------------- script hooks

  async function scriptTriggerEvent(id: string): Promise<boolean> {
    const p = deps.place()
    if (!p) return false
    const r = triggerEvent(id, ctx.save.events ?? {}, contextAt(p), { check: 'progress', anchor: anchorOf(p) })
    if (!r.started) return false
    ctx.save.events = r.state
    onStarted(r.started, p)
    active = activeEvents(ctx.save.events, minutes())
    refreshMods(p)
    return true
  }

  function revealPlace(ref: string): TownDef | null {
    const ow = world.maps[world.startMap]
    const p = deps.place()
    const from = p && isOverworld(p.map) ? { x: p.x, y: p.y } : overworldPos ?? ow?.spawn
    if (!ow || !from) return null
    const places = placesNear(world, ow, from.x, from.y, GPC.places.revealSearchRadius)
    const known = ctx.save.discoveredPlaces ?? []
    const seen = places.filter((pl) => known.includes(realPlaceId(pl.id))).map((pl) => pl.id)
    const res = resolvePlaceRef(ref, places, from, seen)
    if (!res) return null
    const id = realPlaceId(res.id)
    if (!known.includes(id)) ctx.save.discoveredPlaces = [...known, id]
    ctx.save.flags[GPC.flags.revealed + id] = Math.max(1, Math.floor(minutes()))
    ctx.ui.toast(t('events.ui.placeRevealed', { place: res.nameZh }), 'success')
    ctx.audio.playSfx(GPC.start.startSfx)
    return { ...res, id }
  }

  // -------------------------------------------------------------------------------------------- legends

  let legendModsKey = ''
  /** Re-applies modifiers when the legend ambience / weather changed. */
  function syncLegendMods(p: GameplayPlace): void {
    const key = `${legendAmbience.join(',')}|${legendWeather ?? ''}`
    if (key === legendModsKey) return
    legendModsKey = key
    refreshMods(p)
  }

  function legendTick(p: GameplayPlace, canBattle: boolean): void {
    legendStep(p, canBattle)
    syncLegendMods(p)
  }

  function legendStep(p: GameplayPlace, canBattle: boolean): void {
    const L = rules.legends
    if (!GPC.legends.mapKinds.includes(p.map.kind) || !isOverworld(p.map)) {
      setSense(null)
      return
    }
    const near = legendsNear(worldOrigin(world), p, minutes(), world.seed, ctx.save.legends ?? {})
    const best = near.find((n) => n.proximity !== 'far') ?? null
    setSense(best)
    const roamer = special.list.find((s) => s.legend)
    if (roamer) {
      // A visible legend drags its ambience / weather along even when its roaming position moved on.
      const def = GAMEPLAY.legends.find((l) => l.species === roamer.legend)
      if (def) { legendAmbience = def.cue ? [def.cue] : []; legendWeather = def.weather ?? null }
      const keep = near.some((n) => n.legend.species === roamer.legend && n.proximity === 'appear')
      if (!keep && Math.hypot(roamer.x - p.x, roamer.y - p.y) > L.appearRadius * GPC.legends.despawnBeyondMul) {
        special.remove(roamer, roamer.cues.flee)
        ctx.save.events = endEvent(`legend-${roamer.legend}`, ctx.save.events ?? {}, minutes())
      }
      return
    }
    if (!best || best.proximity !== 'appear' || !canBattle) return
    const lg = best.legend
    const ectx = contextAt(p)
    if (!evaluateCondition(lg.def.when as EventCondition, ectx)) return
    const at = snapToFree(lg.x, lg.y, freeTile(p.map), L.snapRadius)
    if (!at) return
    const tr = triggerEvent(`legend-${lg.species}`, ctx.save.events ?? {}, ectx, { check: 'all', anchor: { map: p.map.id, x: at.x, y: at.y, ...(p.region ? { region: p.region.id } : {}) } })
    if (tr.started) {
      ctx.save.events = tr.state
      onStarted(tr.started, p)
      active = activeEvents(ctx.save.events, minutes())
    } else if (tr.reason !== 'active') return
    const b = speciesBehavior(lg.species, ctx.data)
    const cr = createCreature(lg.species, lg.level, { rng, shiny: rollShinyFor(lg.species, rng, { mods, research: researchState(ctx.save) }), caughtMap: p.map.id }, ctx.data)
    if (lg.hp !== undefined) cr.hp = Math.max(1, Math.min(cr.hp, lg.hp))
    const flee = fleeFor(lg.species, mods)
    special.spawn({
      tag: `legend:${lg.species}`, creature: cr, ...(flee ? { flee } : {}), aura: auraCueColor(b.cues.aura, ctx.data.species[lg.species]?.rarity ?? '', ctx.data),
      roaming: true, avoidPlayer: b.avoidPlayer, speedMul: b.roamSpeed > 0 ? b.roamSpeed : 1, noticeRadius: b.noticeRadius,
      cues: { spawn: b.cues.spawn, notice: b.cues.notice, flee: b.cues.flee }, legend: lg.species,
    }, at.x + 0.5, at.y + 0.5)
    ctx.ui.toast(t('events.ui.legendNear', { title: legendTitle(lg.species) }), 'warn')
  }

  function setSense(n: NearLegend | null): void {
    sensed = n
    const def = n?.legend.def
    legendAmbience = def && GPC.legends.senseAmbience && def.cue ? [def.cue] : []
    legendWeather = def && n?.proximity === 'appear' && def.weather ? def.weather : null
    const p = deps.place()
    if (!n || !p) { hud.setSense(null); return }
    const title = legendTitle(n.legend.species)
    hud.setSense({ text: t('events.ui.legendSense', { title }), angle: Math.atan2(n.legend.y - p.y, n.legend.x - p.x), color: pingColor('legend', speciesBehavior(n.legend.species, ctx.data).cues.ping) })
    const last = senseToastAt.get(n.legend.species) ?? -Infinity
    if (nowSec() - last > GPC.legends.senseToastCooldownSec) {
      senseToastAt.set(n.legend.species, nowSec())
      ctx.ui.toast(t('events.ui.legendSense', { title }), 'info')
    }
  }

  function afterLegendBattle(s: Special, outcome: BattleOutcome): void {
    const species = s.legend!
    const tr = research.last
    const hpLeft = tr?.foeUid ? tr.foeHp.get(tr.foeUid) ?? 0 : 0
    ctx.save.legends = onLegendBattleEnd(ctx.save.legends ?? {}, species, outcome.result, { hpLeft, minutes: minutes() })
    const name = speciesName(species)
    if (outcome.result === 'caught') ctx.ui.toast(t('events.ui.legendCaught', { name }), 'success')
    else if (outcome.result === 'win') ctx.ui.toast(t('events.ui.legendDefeated', { name }), 'info')
    else {
      ctx.ui.toast(t('events.ui.legendFled', { name }), 'warn')
      ctx.ui.toast(t('events.ui.legendRest', { name }), 'info')
    }
    special.remove(s, outcome.result === 'caught' ? null : s.cues.flee)
    ctx.save.events = endEvent(`legend-${species}`, ctx.save.events ?? {}, minutes())
    setSense(null)
  }

  async function battleSpecial(s: Special): Promise<void> {
    battleBusy = true
    try {
      if (s.legend) research.expectLegend()
      const outcome = await deps.startWild(s.creature, { ...(s.flee ? { flee: s.flee } : {}) })
      if (!outcome) return
      if (s.legend) { afterLegendBattle(s, outcome); return }
      const ev = active.find((a) => s.tag.startsWith(`ev:${a.id}:`))
      if (ev) ctx.save.flags[GPC.flags.spawnTaken + s.tag] = ev.startedAt
      special.remove(s, outcome.result === 'fled' ? s.cues.flee : null)
    } finally {
      battleBusy = false
    }
  }

  // -------------------------------------------------------------------------------------------- rumors

  function tellRumor(p: GameplayPlace): boolean {
    const ectx = lastCtx ?? contextAt(p)
    const r = pickRumor(ectx, ctx.save.events ?? {}, rng)
    if (!r) return false
    const def = GAMEPLAY.eventById[r.event]
    ctx.ui.toast(`${t('events.ui.rumorPrefix')}${textOrKey(r.text, def ? eventParams(def) : {})}`, GPC.rumors.toastKind)
    ctx.save.flags[rumorFlag(r.event)] = Math.max(1, Math.floor(minutes()))
    rumorAt = minutes()
    return true
  }

  function rumorTick(p: GameplayPlace): void {
    const R = GPC.rumors
    const town = p.region?.isTown ? p.region.id : null
    if (town && town !== lastTown && minutes() - rumorAt >= R.cooldownMinutes && rng.chance(R.townEnterChance)) tellRumor(p)
    lastTown = town
    if (p.map.outdoor && minutes() - ambientRumorAt >= R.ambientEveryMinutes) {
      ambientRumorAt = minutes()
      if (minutes() - rumorAt >= R.cooldownMinutes && rng.chance(R.ambientChance)) tellRumor(p)
    }
  }

  // -------------------------------------------------------------------------------------------- items / hud

  function itemsTick(dt: number, p: GameplayPlace, free: boolean): void {
    if (!items.length) return
    const I = GPC.items
    glintT -= dt
    const glint = glintT <= 0
    if (glint) glintT = I.glintEverySec
    for (const it of [...items]) {
      const x = it.x + 0.5, y = it.y + 0.5
      const d = Math.hypot(x - p.x, y - p.y)
      if (glint && (!it.hidden || d <= I.hiddenGlintRadius)) ctx.world.spawnFx(it.hidden ? I.hiddenFx : I.visibleFx, x, y, ctx.world.elevationAt(x, y))
      if (!free || d > I.pickupRadius) continue
      items.splice(items.indexOf(it), 1)
      ctx.save.flags[GPC.flags.itemTaken + it.id] = it.startedAt
      const def = ctx.data.items[it.item]
      if (!def || !addItem(ctx, it.item, it.qty)) continue
      ctx.audio.playSfx(I.sfx)
      const params = { name: ctx.save.name, currency: t('common.money'), item: def.nameZh, qty: it.qty }
      ctx.ui.toast(t(it.qty > 1 ? 'world.item.foundQty' : 'world.item.found', params), 'success')
    }
  }

  function hudTick(p: GameplayPlace): void {
    const H = GPC.hud
    const at = anchorOf(p)
    const chips = active
      .filter((ev) => ev.def.tag && H.chipTags.includes(ev.def.tag) && eventAppliesAt(ev, at))
      .sort((a, b) => (b.def.priority ?? 0) - (a.def.priority ?? 0))
      .map((ev) => ({
        id: ev.id, title: eventTitle(ev.def), tag: ev.def.tag ?? '', color: H.tagColors[ev.def.tag ?? ''] ?? H.defaultColor,
        sub: t('events.ui.endsIn', { minutes: Math.max(1, Math.ceil(ev.endsAt - minutes())) }),
        description: eventDescription(ev.def), scope: t(`hud.events.scope.${ev.def.scope}`),
        benefits: eventBenefits(ev, minutes(), ctx.data),
      }))
    hud.setChips(chips)
    if (sensed) setSense(sensed)
  }

  // -------------------------------------------------------------------------------------------- lifecycle

  function resetForSave(): void {
    saveRef = ctx.save
    lastSlot = Number.NaN
    active = []
    mods = NO_MODIFIERS
    valueMods = NO_MODIFIERS
    lastCtx = null
    pending.length = 0
    rumorAt = -Infinity
    ambientRumorAt = minutes()
    lastWeather = undefined
    lastTown = null
  }

  function onMapEntered(): void {
    if (ctx.save !== saveRef) resetForSave()
    const p = deps.place()
    special.clear()
    items = []
    materialized.clear()
    setSense(null)
    if (!p) return
    mapId = p.map.id
    active = activeEvents(ctx.save.events ?? {}, minutes())
    for (const ev of active) materialize(ev, p.map)
    refreshMods(p)
  }
  const offMap = ctx.events.on('map:entered', () => onMapEntered())

  function update(dt: number, o: { free: boolean; canBattle: boolean }): void {
    const p = deps.place()
    if (!p) { hud.setVisible(false); return }
    if (ctx.save !== saveRef) onMapEntered()
    if (p.map.id !== mapId) onMapEntered()
    hud.setVisible(true)
    if (isOverworld(p.map)) {
      overworldPos = { x: p.x, y: p.y }
      const d = distanceFromOrigin(world, p.x, p.y)
      if (d > (ctx.save.maxDistance ?? 0)) ctx.save.maxDistance = Math.floor(d)
    }
    checkCooldown -= dt
    const slot = eventSlot(minutes())
    // Scheduling / announcements wait while menus, dialogue or battles own the screen.
    if (slot !== lastSlot && checkCooldown <= 0 && o.free && GPC.scheduler.mapKinds.includes(p.map.kind)) {
      lastSlot = slot
      checkCooldown = GPC.scheduler.minCheckRealSec
      tick(p)
      rumorTick(p)
    } else if (!GPC.scheduler.mapKinds.includes(p.map.kind)) expire(p)
    if (pending.length && o.free && !scriptBusy && !battleBusy) {
      const steps = pending.shift()!
      scriptBusy = true
      void deps.runScript(steps).catch((err: unknown) => console.error('[gameplay] event script failed', err)).finally(() => { scriptBusy = false })
    }
    const touched = special.update(dt, p, o.free && o.canBattle && !battleBusy && !scriptBusy)
    if (touched) void battleSpecial(touched)
    legendT -= dt
    if (legendT <= 0 && o.free) { legendT = GPC.legends.checkSec; legendTick(p, o.canBattle) }
    itemsTick(dt, p, o.free)
    ambience.update(dt, p)
    hudT -= dt
    if (hudT <= 0) { hudT = GPC.hud.refreshSec; hudTick(p); attachDebug() }
  }

  // -------------------------------------------------------------------------------------------- encounters

  /** Tall-grass step encounter (replaces encounters.rollEncounter): rate x event modifier, rarity weighting, flee. */
  function rollGrass(region: RegionDef, o: { repelActive: boolean; leadLevel: number }): WildPick | null {
    if (!(region.encounterRate > 0) || !region.encounters.length) return null
    if (!rng.chance(grassEncounterRate(region.encounterRate, modifierValue(mods, 'encounterRate')))) return null
    const p = deps.place()
    const ectx = p ? contextAt(p, region) : lastCtx
    if (!ectx) return null
    const pick = pickGrassEncounter(region.encounters, ectx, rng, { mods, research: researchState(ctx.save) })
    if (!pick || (o.repelActive && pick.level < o.leadLevel)) return null
    return pick
  }

  /** Visible roamer for roaming.ts: per-rarity caps over the visible area, SSR conditions, aura / flee / cues. */
  function roamPick(region: RegionDef, x: number, y: number, present: readonly { x: number; y: number; creature: Creature }[]): RoamPick | null {
    const p = deps.place()
    const base = lastCtx ?? (p ? contextAt(p) : null)
    if (!base) return null
    const ectx: EventContext = { ...base, biome: region.biome, regionId: region.id, regionDanger: region.danger ?? 0 }
    const half = rules.visible.areaTiles / 2
    const counts: Record<string, number> = {}
    for (const r of present) {
      if (Math.abs(r.x - x) > half || Math.abs(r.y - y) > half) continue
      const rar = ctx.data.species[r.creature.speciesId]?.rarity ?? ''
      counts[rar] = (counts[rar] ?? 0) + 1
    }
    const v = pickVisibleSpawn(region.encounters, ectx, rng, { mods, research: researchState(ctx.save), present: counts })
    return v ? roamPickOf(v, ctx, MINUTE_SEC(ctx.data)) : null
  }

  function markers(): MinimapMarker[] {
    const p = deps.place()
    if (!p) return []
    const M = GPC.markers
    const out: MinimapMarker[] = []
    for (const s of special.list) out.push({ x: s.x, y: s.y, kind: s.legend ? M.legendRoamer : M.eventRoamer, ...(s.legend ? { label: speciesName(s.legend) } : {}) })
    for (const it of items) if (!it.hidden) out.push({ x: it.x + 0.5, y: it.y + 0.5, kind: 'item' })
    for (const pin of revealedPlaces(ctx.save, minutes()).slice(0, Math.max(1, GPC.places.revealPinsMax))) {
      const pl = placeById(world, pin.id)
      if (!pl || pl.map !== p.map.id) continue
      if (Math.hypot(pl.x + 0.5 - p.x, pl.y + 0.5 - p.y) <= GPC.places.revealPinReachTiles) { delete ctx.save.flags[pin.flag]; continue }
      out.push({ x: pl.x + 0.5, y: pl.y + 0.5, kind: M.revealPin, label: pl.nameZh })
    }
    if (sensed && !special.list.some((s) => s.legend)) {
      const lg = sensed.legend
      const d = Math.hypot(lg.x - p.x, lg.y - p.y)
      const k = d > M.senseClampTiles ? M.senseClampTiles / d : 1
      out.push({ x: p.x + (lg.x - p.x) * k, y: p.y + (lg.y - p.y) * k, kind: M.legendRoamer, label: legendTitle(lg.species) })
    }
    for (const ev of active) {
      if (!ev.anchor || ev.anchor.map !== p.map.id || ev.def.hidden || ev.def.scope === 'global' || ev.def.trigger === 'legend') continue
      out.push({ x: ev.anchor.x + 0.5, y: ev.anchor.y + 0.5, kind: M.revealPin, label: eventTitle(ev.def) })
    }
    return out
  }

  // -------------------------------------------------------------------------------------------- dev hooks

  /** Dev hooks (?dev=1) at window[debug.global][debug.key]; re-attached when the global is replaced (debug.ts). */
  function createDebug(): Record<string, unknown> | null {
    if (typeof location === 'undefined' || new URLSearchParams(location.search).get('dev') !== '1') return null
    return {
      /** Starts any event now (ignores its trigger, chance and environment). */
      start(id: string): boolean {
        const p = deps.place()
        const def = GAMEPLAY.eventById[id]
        if (!p || !def) return false
        const r = triggerEvent(id, ctx.save.events ?? {}, contextAt(p), { anchor: anchorOf(p), defs: [{ ...def, when: {} }] })
        if (!r.started) return false
        ctx.save.events = r.state
        onStarted({ ...r.started, def }, p)
        active = activeEvents(ctx.save.events, minutes())
        refreshMods(p)
        return true
      },
      end(id: string): void { ctx.save.events = endEvent(id, ctx.save.events ?? {}, minutes()); lastSlot = Number.NaN },
      active: () => active.map((a) => ({ id: a.id, endsAt: a.endsAt, anchor: a.anchor })),
      mods: () => mods,
      /** Visible spawn of a species next to the player with its tier behaviour. */
      spawn(species: string, level = 10): boolean {
        const p = deps.place()
        if (!p || !ctx.data.species[species]) return false
        const b = speciesBehavior(species, ctx.data)
        const rar = ctx.data.species[species].rarity
        const k = special.list.length
        const at = snapToFree(p.x + 3 + (k % 3) * 2, p.y + Math.floor(k / 3) * 2 - 1, freeTile(p.map), GPC.special.snapRadius)
        if (!at) return false
        const flee = fleeFor(species, mods)
        special.spawn({
          tag: `ev:debug:${k}`, creature: createCreature(species, level, { rng, caughtMap: p.map.id }, ctx.data), ...(flee ? { flee } : {}),
          aura: auraCueColor(b.cues.aura, rar, ctx.data), roaming: true, avoidPlayer: b.avoidPlayer, speedMul: b.roamSpeed || 1,
          noticeRadius: b.noticeRadius, cues: { spawn: b.cues.spawn, notice: b.cues.notice, flee: b.cues.flee },
        }, at.x + 0.5, at.y + 0.5)
        return true
      },
      /** Nearest roaming legends (proximity) at the player's position. */
      legends: () => {
        const p = deps.place()
        return p ? legendsNear(worldOrigin(world), p, minutes(), world.seed, ctx.save.legends ?? {}).map((n) => ({ species: n.legend.species, x: n.legend.x, y: n.legend.y, distance: Math.round(n.distance), proximity: n.proximity })) : []
      },
      /** Summons a roaming legend next to the player (its encounter event + visible legend roamer). */
      summon(species?: string): boolean {
        const p = deps.place()
        const lg = GAMEPLAY.legends.find((l) => l.species === species) ?? GAMEPLAY.legends[0]
        if (!p || !lg || special.list.some((s) => s.legend)) return false
        const at = snapToFree(p.x + 3, p.y, freeTile(p.map), rules.legends.snapRadius)
        if (!at) return false
        const id = `legend-${lg.species}`
        const def = GAMEPLAY.eventById[id]
        if (def) {
          const r = triggerEvent(id, ctx.save.events ?? {}, contextAt(p), { anchor: { map: p.map.id, x: at.x, y: at.y }, defs: [{ ...def, when: {} }] })
          if (r.started) { ctx.save.events = r.state; onStarted({ ...r.started, def }, p); active = activeEvents(ctx.save.events, minutes()) }
        }
        const b = speciesBehavior(lg.species, ctx.data)
        const level = areaLevelAt(p.map, p.x, p.y)[1] + lg.levelBonus
        const flee = fleeFor(lg.species, mods)
        special.spawn({
          tag: `legend:${lg.species}`, creature: createCreature(lg.species, level, { rng, caughtMap: p.map.id }, ctx.data), ...(flee ? { flee } : {}),
          aura: auraCueColor(b.cues.aura, ctx.data.species[lg.species]?.rarity ?? '', ctx.data), roaming: true, avoidPlayer: b.avoidPlayer,
          speedMul: b.roamSpeed > 0 ? b.roamSpeed : 1, noticeRadius: b.noticeRadius, cues: { spawn: b.cues.spawn, notice: b.cues.notice, flee: b.cues.flee }, legend: lg.species,
        }, at.x + 0.5, at.y + 0.5)
        legendAmbience = lg.cue ? [lg.cue] : []
        legendWeather = lg.weather ?? null
        ctx.ui.toast(t('events.ui.legendNear', { title: legendTitle(lg.species) }), 'warn')
        refreshMods(p)
        return true
      },
      /** Wild battle with the species' flee rule (forceFlee: flees from turn 1 on). */
      battle(species: string, level = 10, forceFlee = false): boolean {
        if (!ctx.data.species[species] || battleBusy) return false
        const flee = forceFlee ? { chancePerTurn: 1, afterTurn: 1 } : fleeFor(species, mods)
        battleBusy = true
        void deps.startWild(createCreature(species, level, { rng, caughtMap: deps.place()?.map.id }, ctx.data), flee ? { flee } : {})
          .then((o) => console.info('[gameplay] debug battle', o?.result)).finally(() => { battleBusy = false })
        return true
      },
      research: (species: string, task: string, amount = 1) => scriptResearch(ctx, species, task, amount),
      specials: () => special.list.map((x) => ({ tag: x.tag, species: x.creature.speciesId, x: Math.round(x.x * 10) / 10, y: Math.round(x.y * 10) / 10, aura: x.aura, legend: x.legend ?? null })),
      rumor: () => { const p = deps.place(); return p ? tellRumor(p) : false },
      reveal: (ref: string) => revealPlace(ref),
      cue: (key: string) => { const p = deps.place(); if (p) cues.play(key, p); return !!cueDef(key) },
      ambience: (list: string[]) => { legendAmbience = list; const p = deps.place(); if (p) refreshMods(p) },
      state: () => ({ events: ctx.save.events, legends: ctx.save.legends, research: ctx.save.research, discovered: ctx.save.discoveredPlaces }),
    }
  }
  const debugHooks = createDebug()
  const debugRoot = () => globalThis as unknown as Record<string, Record<string, unknown> | undefined>
  function attachDebug(): void {
    if (!debugHooks) return
    const g = debugRoot()
    const root = (g[GPC.debug.global] ??= {})
    if (root[GPC.debug.key] !== debugHooks) root[GPC.debug.key] = debugHooks
  }
  const offDebug = () => {
    const root = debugRoot()[GPC.debug.global]
    if (root && root[GPC.debug.key] === debugHooks) delete root[GPC.debug.key]
  }

  return {
    update,
    rollGrass,
    roamPick,
    markers,
    /** Plays a cue at a position (roaming.ts deps.cue). */
    cue: (key: string | null | undefined, at: { x: number; y: number; actor?: { bubble(text: string, ms?: number): void } | null }) => cues.play(key, at),
    /** Product of active event modifiers for a runtime quantity (shop price, money, exp, catch rate, ...). */
    modifier: (target: Parameters<typeof modifierValue>[1], q?: Parameters<typeof modifierValue>[2]) => modifierValue(valueMods, target, q),
    get mods(): EventModifiers { return mods },
    /** Modifiers for prices and battle rewards (see valueMods). */
    get valueMods(): EventModifiers { return valueMods },
    triggerEvent: scriptTriggerEvent,
    revealPlace: async (ref: string) => revealPlace(ref),
    research,
    dispose(): void {
      offMap()
      offDebug()
      research.dispose()
      special.clear()
      hud.dispose()
    },
  }
}

export type GameplayRuntime = ReturnType<typeof createGameplayRuntime>
