// Dev automation (?dev=1) and the F3 debug overlay.
//   &skipTitle=1                 start straight in the world (debug save: random party from content/game.json debug)
//   &slot=<n> &reset=1           save slot (two clients in one browser) / wipe that slot first
//   &map=<id>&x=<n>&y=<n>        start position          &t=<minutes>   clock (frozen per debug.freezeClockWithTime)
//   &weather=<kind>              force field weather     &evolve=1      evolution cutscene for the party lead
//   &battle=wild|trainer [&species=<id>&level=<n> | &trainer=<id>]
//   &battle=boss&boss=<bossId> [&level=<n>]   boss sandbox: sensible team + counter items, boss at its recommended level
//   &screen=party|bag|dex|box|map|quests|settings|shop
// Infinite overworld: &map=<overworld>&x/y accept any integer tile (negative included). window.__ap (dev only):
//   boss(id, level?) · pos() · tp(x, y, map?) · region() · gates() · places(radius?) · discover(id) · fly(id) · fog() · distance() · roamers()
import type { FieldWeatherKind, SaveData, World } from '../shared/types.ts'
import type { GameContext, SaveManager, Screens } from './contracts.ts'
import { CONTENT, t } from '../shared/content/index.ts'
import { Rng } from '../shared/rng.ts'
import { createCreature, maxHp } from '../shared/creature.ts'
import { STORY_CONTENT } from '../shared/world/story.ts'
import { distanceFromOrigin, getMap, isInfinite, regionAt } from '../shared/world/worldapi.ts'
import { fogPagesFor, resolvePlace } from './world/explore.ts'
import { GAME } from './world/config.ts'
import type { OverworldExt } from './world/controller.ts'
import { keyItemOf } from './world/save-ops.ts'

export interface DebugParams {
  dev: boolean
  skipTitle: boolean
  slot: number
  reset: boolean
  map: string | null
  x: number | null
  y: number | null
  time: number | null
  weather: FieldWeatherKind | null
  battle: 'wild' | 'trainer' | 'boss' | null
  species: string | null
  boss: string | null
  level: number | null
  trainer: string | null
  screen: string | null
  evolve: boolean
}

export function readDebugParams(search: string): DebugParams {
  const q = new URLSearchParams(search)
  const dev = q.get('dev') === '1'
  const num = (k: string): number | null => {
    const v = q.get(k)
    if (v === null || v.trim() === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const flag = (k: string) => dev && q.get(k) === '1'
  const str = (k: string) => (dev ? q.get(k) : null)
  const weather = str('weather')
  const battle = str('battle')
  return {
    dev,
    skipTitle: flag('skipTitle'),
    slot: dev ? Math.max(0, Math.floor(num('slot') ?? 0)) : 0,
    reset: flag('reset'),
    map: str('map'),
    x: dev ? num('x') : null,
    y: dev ? num('y') : null,
    time: dev ? num('t') : null,
    // Field weather kinds the game tunes (content/game.json region.weatherIntensity).
    weather: weather && weather in GAME.region.weatherIntensity ? (weather as FieldWeatherKind) : null,
    battle: battle === 'wild' || battle === 'trainer' || battle === 'boss' ? battle : null,
    species: str('species'),
    boss: str('boss'),
    level: dev ? num('level') : null,
    trainer: str('trainer'),
    screen: str('screen'),
    evolve: flag('evolve'),
  }
}

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
export function debugSave(saves: SaveManager, world: World, _dbg: DebugParams): SaveData {
  const D = GAME.debug
  const avatar = CONTENT.characters.find((c) => c.playable) ?? CONTENT.characters[0]
  const s = saves.newGame({ name: avatar?.nameZh ?? '', avatar: avatar?.id ?? '' })
  const rng = new Rng((Date.now() ^ 0x5eed) >>> 0)
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
  const rng = new Rng((Date.now() ^ 0xb055) >>> 0)
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
    /** Visible roamers with their species country and distance to the player. */
    roamers: () => ow.roamerInfo().map((r) => ({ ...r, country: CONTENT.species[r.speciesId]?.country ?? '', dist: Math.hypot(r.x - ow.player.x, r.y - ow.player.y) })),
  }
  ;(window as unknown as { __ap: typeof hooks }).__ap = hooks
}

/** F3 overlay: fps, draw calls, position, region, terrain, time, weather, network. */
export function createDebugOverlay(ctx: GameContext, ow: OverworldExt, root: HTMLElement) {
  const el = document.createElement('pre')
  el.id = 'ap-debug'
  el.hidden = true
  root.append(el)
  let frames = 0
  let acc = 0
  let refresh = 0
  let fps = 0
  let frameMs = 0

  const render = () => {
    const info = ctx.renderer.gl.info.render
    const p = ow.player
    const region = ow.region
    el.textContent = [
      t('game.debug.title'),
      t('game.debug.fps', { fps: fps.toFixed(0), ms: frameMs.toFixed(1) }),
      t('game.debug.calls', { calls: info.calls, tris: (info.triangles / 1000).toFixed(1) }),
      t('game.debug.pos', { map: p.map, x: p.x.toFixed(2), y: p.y.toFixed(2), elev: p.elev.toFixed(2) }),
      t('game.debug.region', { region: region?.nameZh ?? '-', terrain: ow.terrainName || '-' }),
      t('game.debug.time', { clock: ctx.clock.label(), tod: t(`hud.tod.${ctx.clock.timeOfDay}`), weather: t(`game.weather.${ow.weather}`) }),
      t('game.debug.net', { status: t(`hud.net.${ctx.net.status}`), n: ctx.net.online, near: ctx.net.remotePlayers().size }),
      t('game.debug.player', { mode: t(`game.mode.${ow.mode}`), repel: ctx.save.repelSteps, roamers: ow.roamerCount }),
    ].join('\n')
  }

  return {
    el,
    toggle(): void { el.hidden = !el.hidden; if (!el.hidden) render() },
    update(dt: number): void {
      frames++
      acc += dt
      if (el.hidden) return
      refresh -= dt * 1000
      if (refresh > 0) return
      refresh = GAME.debug.overlayRefreshMs
      if (acc > 0) { fps = frames / acc; frameMs = (acc / frames) * 1000 }
      frames = 0
      acc = 0
      render()
    },
  }
}
