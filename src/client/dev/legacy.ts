// The pre-registry debug surface (?dev=1 automation): debug save, start overrides, post-load actions and the
// window.__ap console hooks. Kept as aliases while QA scripts migrate to the command registry.
// Infinite overworld: &map=<overworld>&x/y accept any integer tile (negative included). window.__ap (dev only):
//   boss(id, level?) · pos() · tp(x, y, map?) · region() · gates() · places(radius?) · discover(id) · fly(id) · fog() · distance() · roamers()
//   clock(minutes?) sets / reads the in-game clock (load with &t=<minutes> to keep it frozen) · weather(kind|null) forces field weather
//   gameplay: the event runtime hooks (start / end / spawn / summon / legends ...)
import type { FieldWeatherKind, SaveData, World } from '../../shared/types.ts'
import type { GameContext, SaveManager, Screens } from '../contracts.ts'
import { CONTENT } from '../../shared/content/index.ts'
import type { IRng } from '../../shared/contracts.ts'
import { createCreature, maxHp } from '../../shared/creature.ts'
import { STORY_CONTENT } from '../../shared/world/story.ts'
import { distanceFromOrigin, getMap, isInfinite, regionAt } from '../../shared/world/worldapi.ts'
import { fogPagesFor, resolvePlace } from '../world/explore.ts'
import { GAME } from '../world/config.ts'
import type { OverworldExt } from '../world/controller.ts'
import { keyItemOf } from '../world/save-ops.ts'
import type { DebugParams } from './params.ts'

/** Dev only: mirrors console errors/warnings and uncaught errors into window.__AP_LOG for automation. */
export function installDevLog(): void {
  const log: string[] = []
  ;(window as unknown as { __AP_LOG: string[] }).__AP_LOG = log
  for (const level of ['error', 'warn'] as const) {
    const orig = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      log.push(`${level}: ${args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' ')}`)
      orig(...args)
    }
  }
  window.addEventListener('error', (e) => log.push(`uncaught: ${e.message}`))
  window.addEventListener('unhandledrejection', (e) => log.push(`rejection: ${e.reason instanceof Error ? e.reason.stack : String(e.reason)}`))
}

/** A ready-to-play save: random party at debug.partyLevel, key items by capability, stocked bag. */
export function debugSave(saves: SaveManager, world: World, rng: IRng): SaveData {
  const D = GAME.debug
  const avatar = CONTENT.characters.find((c) => c.playable) ?? CONTENT.characters[0]
  const s = saves.newGame({ name: avatar?.nameZh ?? '', avatar: avatar?.id ?? '' })
  const pool = CONTENT.speciesList
  const ball = CONTENT.itemList.find((it) => it.effect.kind === 'ball')?.id
  if (pool.length) {
    s.party = Array.from({ length: Math.min(D.partySize, CONTENT.config.party.maxParty) }, () =>
      createCreature(rng.pick(pool).id, D.partyLevel, { rng, otName: s.name, otId: s.playerId, ballId: ball, caughtMap: world.startMap }))
    s.dexCaught = [...new Set(s.party.map((c) => c.speciesId))]
    s.dexSeen = [...s.dexCaught]
    s.flags[STORY_CONTENT.meta.flags.starter] = s.party[0].speciesId
  }
  s.money = D.money
  for (const kind of D.keyItemKinds) {
    const item = keyItemOf(kind)
    if (item) s.bag[item.id] = 1
  }
  for (const [cat, qty] of Object.entries(D.categoryQty)) {
    for (const it of CONTENT.itemList) if (it.category === cat) s.bag[it.id] = qty
  }
  return s
}

/** Applies start overrides (position, clock) to the save that is about to be played. */
export function applyDebugStart(ctx: GameContext, world: World, dbg: DebugParams): void {
  const m = dbg.map ? getMap(world, dbg.map) : null
  if (m) {
    const x = dbg.x ?? m.spawn.x, y = dbg.y ?? m.spawn.y
    if (isInfinite(m) || (x >= 0 && y >= 0 && x < m.width && y < m.height)) ctx.save.position = { map: m.id, x: Math.floor(x), y: Math.floor(y), facing: m.spawn.facing }
  }
  if (dbg.time !== null) ctx.clock.minutes = Math.max(0, dbg.time)
}

/** Boss sandbox: swaps the party for the configured team at the boss's level and stocks every counter item. */
async function startBossSandbox(ctx: GameContext, ow: OverworldExt, bossId: string | null, level: number | null): Promise<boolean> {
  const def = (bossId && CONTENT.bosses[bossId]) || CONTENT.bossList[0]
  if (!def) return false
  const D = GAME.debug.boss
  const bossLevel = Math.max(1, Math.floor(level ?? def.level))
  const rng = ow.devHandles().rng.stream('debug')
  ctx.save.party = D.party.filter((id) => CONTENT.species[id]).map((id) => {
    const cr = createCreature(id, Math.max(1, bossLevel + D.levelOffset), { rng, otName: ctx.save.name, otId: ctx.save.playerId, caughtMap: ctx.save.position.map })
    for (const k of Object.keys(cr.ivs) as (keyof typeof cr.ivs)[]) cr.ivs[k] = CONTENT.config.creature.ivMax
    cr.hp = maxHp(cr)
    return cr
  })
  for (const it of CONTENT.itemList) if (it.effect.kind === 'bait') ctx.save.bag[it.id] = D.counterQty
  ctx.events.emit('party:changed', {})
  ctx.events.emit('bag:changed', {})
  await ow.startWildBattle(def.species, bossLevel)
  return true
}

/** Post-load actions: forced weather, evolution, a battle, or a screen. */
export async function runDebugActions(ctx: GameContext, ow: OverworldExt, world: World, dbg: DebugParams, screens: Screens): Promise<void> {
  if (dbg.weather) ow.setWeatherOverride(dbg.weather)
  if (dbg.evolve) {
    const lead = ctx.save.party[0]
    const to = lead ? CONTENT.species[lead.speciesId]?.evolvesTo : undefined
    if (lead && to && CONTENT.species[to.id]) {
      lead.level = Math.max(lead.level, to.level)
      await ctx.battle.evolve(0, to.id)
      ctx.events.emit('party:changed', {})
    }
  }
  if (dbg.battle === 'wild') {
    const map = ow.mapId ? getMap(world, ow.mapId) : null
    const region = map ? regionAt(map, ow.player.x, ow.player.y) : null
    const local = region?.encounters.map((e) => e.species).filter((id) => CONTENT.species[id]) ?? []
    const pool = local.length ? local : CONTENT.speciesList.map((sp) => sp.id)
    const species = dbg.species && CONTENT.species[dbg.species] ? dbg.species : pool[Math.floor(Math.random() * pool.length)]
    if (species) await ow.startWildBattle(species, Math.floor(dbg.level ?? GAME.debug.battleLevel))
  } else if (dbg.battle === 'boss') {
    await startBossSandbox(ctx, ow, dbg.boss, dbg.level)
  } else if (dbg.battle === 'trainer') {
    const onMap = ow.mapId ? getMap(world, ow.mapId)?.npcs.find((n) => n.trainer && world.trainers[n.trainer])?.trainer : undefined
    const id = dbg.trainer && world.trainers[dbg.trainer] ? dbg.trainer : onMap ?? Object.keys(world.trainers)[0]
    if (id) await ow.startTrainerBattle(id)
  }
  switch (dbg.screen) {
    case 'party': await screens.party('view'); break
    case 'bag': await screens.bag('field'); break
    case 'dex': await screens.dex(); break
    case 'box': await screens.box(); break
    case 'map': await screens.worldMap({ fly: false }); break
    case 'quests': await screens.quests(); break
    case 'settings': await screens.settings(); break
    case 'shop': await screens.shop(CONTENT.itemList.filter((it) => it.buyable).map((it) => it.id)); break
    default: break
  }
}

/** Dev-only console / automation hooks for the infinite world (window.__ap). */
export function installDebugHooks(ctx: GameContext, ow: OverworldExt, world: World, opts: { flyTo(id: string): Promise<void> }): void {
  const overworld = () => getMap(world, world.startMap)!
  const hooks = {
    pos: () => ({ ...ow.player, region: ow.region?.id ?? null, regionName: ow.region?.nameZh ?? null, danger: ow.region?.danger ?? null }),
    /** Teleport (with the normal map-enter flow) to a tile of any map (default: the overworld). */
    tp: (x: number, y: number, map = world.startMap) => ow.enterMap(map, Math.floor(x), Math.floor(y), 'down', true),
    region: (x = ow.player.x, y = ow.player.y) => {
      const m = getMap(world, ow.player.map)
      const r = m ? regionAt(m, x, y) : null
      return r ? { id: r.id, nameZh: r.nameZh, biome: r.biome, danger: r.danger ?? null, levelRange: r.levelRange ?? null } : null
    },
    /** Causeway gates of the frontier provider (land bridges from the core). */
    gates: () => (overworld().infinite as { gates?: unknown } | undefined)?.gates ?? [],
    places: (radius = 400) => {
      const p = overworld().infinite as { placesIn?: (x0: number, y0: number, x1: number, y1: number) => { id: string; nameZh: string; x: number; y: number; kind?: string }[] } | undefined
      const { x, y } = ow.player
      return p?.placesIn?.(x - radius, y - radius, x + radius, y + radius).map((t) => ({ id: t.id, nameZh: t.nameZh, x: t.x, y: t.y, kind: t.kind })) ?? []
    },
    discover: (id: string) => {
      if (!resolvePlace(world, id)) return false
      const list = ctx.save.discoveredPlaces ?? (ctx.save.discoveredPlaces = [])
      if (!list.includes(id)) list.push(id)
      return true
    },
    fly: (id: string) => opts.flyTo(id),
    fog: () => ({ pages: fogPagesFor(ctx.save, world).pageCount, version: fogPagesFor(ctx.save, world).version }),
    /** Starts a boss fight (sandbox team and counter items; level defaults to the boss's recommended level). */
    boss: (id: string, level?: number) => startBossSandbox(ctx, ow, id, level ?? null),
    distance: () => ({ now: distanceFromOrigin(world, ow.player.x, ow.player.y), max: ctx.save.maxDistance ?? 0 }),
    clock: (minutes?: number) => {
      if (minutes !== undefined) ctx.clock.minutes = minutes
      return ctx.clock.label()
    },
    weather: (kind: FieldWeatherKind | null) => ow.setWeatherOverride(kind),
    /** Visible roamers with their species country and distance to the player. */
    roamers: () => ow.roamerInfo().map((r) => ({ ...r, country: CONTENT.species[r.speciesId]?.country ?? '', dist: Math.hypot(r.x - ow.player.x, r.y - ow.player.y) })),
  }
  const gameplay = ow.devHandles().gameplayHooks
  ;(window as unknown as { __ap: typeof hooks & { gameplay?: Record<string, unknown> } }).__ap = gameplay ? { ...hooks, gameplay } : hooks
}
