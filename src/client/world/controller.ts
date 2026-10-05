// Overworld controller: player movement (free 8-dir, sub-tile collision sliding, stairs smoothing, run/bike/
// surf), map loading + warps, NPCs and trainer sight, interactions, scripts, wild encounters + roaming
// creatures, follower, region ambience (banner, music, weather), HUD/minimap/fog, multiplayer presence.
// All tile/object access goes through WorldApi, so the same code runs on finite maps and on the infinite
// overworld (any integer coordinate, negatives included): objects stream in around the player (stream.ts),
// one-way ledges are jumped with a hop, and exploration (fog pages, milestones, discoveries) lives in explore.ts.
import type { BattleSideInit, Dir, FieldWeatherKind, GameMap, GroundItemDef, NpcDef, QuestDef, RegionDef, ScriptStep } from '../../shared/types.ts'
import type { GameContext, MinimapMarker, OverworldController } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import { Rng } from '../../shared/rng.ts'
import { createCreature, creatureName, maxHp, rollShiny } from '../../shared/creature.ts'
import { propRect } from '../../shared/world/collision.ts'
import { collisionField, getMap, isInfinite, isLedgeDrop, objectsInRect, regionAt, terrainAt, warpAt } from '../../shared/world/worldapi.ts'
import { STORY_CONTENT } from '../../shared/world/story.ts'
import { frontierTrainer, registerFrontierRefs } from '../../shared/world/frontier/content/index.ts'
import { decodeExplored, encodeExplored, type MinimapHandle } from '../ui/minimap.ts'
import { UI_CONFIG } from '../ui/config.ts'
import { TUTORIAL } from '../onboarding/config.ts'
import { GAME, textOrKey } from './config.ts'
import { EXPLORE } from './explore-config.ts'
import { createExplorer, fogPagesFor, regionSubtitle, storeFogPages } from './explore.ts'
import { createObjectStream } from './stream.ts'
import { createBattleFlow } from './battles.ts'
import { firstConscious, nightPhaseOf } from './encounters.ts'
import { createGameplayRuntime } from './events-runtime.ts'
import { createLedgeGuard } from './ledge-guard.ts'
import { createFollower } from './follower.ts'
import { collectMarkers } from './markers.ts'
import { createQuestNavigator, type QuestNavigation } from './quest-navigation.ts'
import { DIR_VEC, dirTowards, facingFromAxis, moveBody, tilePassable, type MotionGrid } from './motion.ts'
import { createNpcLayer, type NpcRuntime } from './npcs.ts'
import { createPresence, type MultiplayerHooks } from './presence.ts'
import { createRoamingLayer, type Roamer } from './roaming.ts'
import { addItem, changeMoney, flagSet, healParty, ownedKeyItem, removeItem } from './save-ops.ts'
import { createScriptRunner, type ScriptHost } from './script.ts'

export type MoveMode = 'walk' | 'run' | 'bike' | 'surf'

export interface OverworldOptions {
  /** Optional multiplayer flows; read lazily because they load asynchronously. */
  multiplayer?: () => MultiplayerHooks | null
  /** Map-load progress (0..1) for a loading indicator; null when the load finished. */
  onLoadProgress?: (p: number | null, mapName: string) => void
  /** Quest tracker text (defaults to t('world.quest.hud')). */
  questText?: (def: QuestDef, stage: number) => string
}

export interface OverworldExt extends OverworldController {
  /** A battle scene owns the screen (the main loop must not render the overworld). */
  readonly battleActive: boolean
  /** Player can act (no script, warp, battle, modal UI or chat). */
  readonly free: boolean
  readonly mode: MoveMode
  readonly mapId: string | null
  readonly region: RegionDef | null
  readonly terrainName: string
  readonly roamerCount: number
  readonly weather: FieldWeatherKind
  readonly questNavigation: QuestNavigation | null
  setWeatherOverride(kind: FieldWeatherKind | null): void
  startWildBattle(speciesId: string, level: number): Promise<void>
  startTrainerBattle(trainerId: string): Promise<void>
  /** New-game intro (content/game.json newGame.introScript). */
  playIntro(): Promise<void>
  /** Writes the fog-of-war bits of the current map into save.exploredChunks. */
  storeExplored(): void
  dispose(): void
}

type Lock = 'external' | 'script' | 'warp' | 'battle' | 'prompt'

export function createOverworld(ctx: GameContext, opts: OverworldOptions = {}): OverworldExt {
  const P = GAME.player
  const rng = new Rng((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0)
  const locks = new Set<Lock>()
  const stream = createObjectStream()
  const navigator = createQuestNavigator(ctx.data.world, TUTORIAL.objective.navigation)
  let trailKey = ''
  const explorer = createExplorer(ctx.data.world, () => ctx.save, {
    toast: (text, kind) => ctx.ui.toast(text, kind),
    banner: (title, sub) => ctx.hud.showBanner(title, sub),
    sfx: (id) => ctx.audio.playSfx(id),
  })
  /** Ledge jump in progress (input frozen, position tweened, hop arc added to the elevation). */
  let hop: { fx: number; fy: number; tx: number; ty: number; t: number; dur: number; lift: number; e0: number; e1: number } | null = null

  let map: GameMap | null = null
  let grid: MotionGrid | null = null
  let actor: ReturnType<GameContext['world']['createActor']> | null = null
  let actorSheet = ''
  const player = { x: 0, y: 0, elev: 0, facing: 'down' as Dir, moving: false, running: false }
  let tile = { x: -1, y: -1 }
  let chunkKey = ''
  let bike = false
  let surf = false
  let battleActive = false
  let graceTiles = 0
  let strideAcc = 0
  let bumpCooldown = 0
  let splashT = 0
  let glintT = 0
  let markerT = 0
  let markers: MinimapMarker[] = []
  let regionKey: string | null = null
  let regionDef: RegionDef | null = null
  let ambienceT = 0
  let musicOverride: string | null = null
  let weatherOverride: FieldWeatherKind | null = null
  /** Weather forced by active world events / a visible roaming legend (outdoor maps only). */
  let eventWeather: FieldWeatherKind | null = null
  let weatherKind: FieldWeatherKind = GAME.region.defaultWeather
  const bannerAt = new Map<string, number>()
  let clockLabel = ''
  let moneyT = 0
  let questKey = ''
  let leadKey = ''
  let leadT = 0
  let disposed = false

  const isFree = () =>
    !!map && !hop && locks.size === 0 && !battleActive && !ctx.ui.isBlocking() && !(ctx.chat as { isOpen?: boolean }).isOpen
  const lock = (k: Lock) => { locks.add(k) }
  const unlock = (k: Lock) => { locks.delete(k) }
  const playerTile = () => ({ x: Math.floor(player.x), y: Math.floor(player.y) })
  const nowSec = () => performance.now() / 1000
  const lead = () => firstConscious(ctx.save.party)
  /** Refuses ledge drops into closed pockets the player could not walk out of (ledge-guard.ts). */
  const ledgeGuard = createLedgeGuard(() => EXPLORE.ledge.guard, {
    surf: () => surf || (!!ownedKeyItem(ctx.save, 'surf', ctx.data) && !!lead()),
    fly: () => !!map && GAME.fly.mapKinds.includes(map.kind) && ctx.save.badges.length >= GAME.fly.minBadges
      && !!ownedKeyItem(ctx.save, GAME.fly.keyItemKind, ctx.data),
  })
  let ledgeHintAt = -Infinity
  const terrainAtTile = (tx: number, ty: number) =>
    map && (map.infinite || (tx >= 0 && ty >= 0 && tx < map.width && ty < map.height)) ? ctx.data.terrain[terrainAt(map, tx, ty)] : undefined
  const colAt = (tx: number, ty: number) => grid?.field?.at(tx, ty) ?? 1
  const isWaterTile = (tx: number, ty: number) => colAt(tx, ty) === 2
  const params = () => ({ name: ctx.save.name, currency: t('common.money') })
  const say = (text: string) => ctx.ui.say([{ text }])

  // ---------------------------------------------------------------- sub-systems

  const npcs = createNpcLayer({ ctx, playerTile, field: () => grid?.field ?? null, rng })
  const follower = createFollower(ctx, {
    // walkable from the player's tile one tile step at a time (the spot can be two tiles off)
    canStand: (x, y) => {
      if (!grid) return false
      let cx = Math.floor(player.x), cy = Math.floor(player.y)
      const tx = Math.floor(x), ty = Math.floor(y)
      while (cx !== tx || cy !== ty) {
        const nx = cx + Math.sign(tx - cx), ny = cy + Math.sign(ty - cy)
        if (!tilePassable(grid, cx, cy, nx, ny, false)) return false
        cx = nx; cy = ny
      }
      return true
    },
  })
  const presence = createPresence(ctx, { mapId: () => map?.id ?? null, hooks: () => opts.multiplayer?.() ?? null })
  const roaming = createRoamingLayer({
    ctx, rng,
    grid: () => grid,
    reserved: (tx, ty) => !!map && (npcs.occupies(tx, ty) || !!warpAt(map, tx, ty)),
    pick: (region, x, y, present) => gameplay.roamPick(region, x, y, present),
    cue: (key, at) => gameplay.cue(key, at),
  })
  const battles = createBattleFlow({
    ctx, rng,
    place: () => (map ? { map, x: player.x, y: player.y } : null),
    setBattleActive: (on) => { battleActive = on },
    afterBattle: () => {
      graceTiles = GAME.encounters.graceSteps
      refresh()
      applyMusic(true)
    },
    npcFor: (trainerId) => npcs.list.find((n) => n.def.trainer === trainerId)?.def ?? null,
    modifiers: () => gameplay.valueMods,
    weather: () => weatherKind,
  })

  const host: ScriptHost = {
    ctx,
    async moveNpc(id, path, speed) {
      const n = npcs.get(id)
      if (n) await npcs.walk(n, path, speed)
    },
    faceNpc(id, dir) {
      const n = npcs.get(id)
      if (n) npcs.face(n, dir)
    },
    setNpcHidden(id, hidden) { npcs.setHidden(id, hidden) },
    async trainerBattle(trainerId, npc) {
      const tr = ctx.data.world.trainers[trainerId] ?? frontierTrainer(ctx.data.world, trainerId)
      if (!tr) { console.warn(`[overworld] unknown trainer "${trainerId}"`); return null }
      const outcome = await battles.trainer(tr, npc)
      return outcome?.result ?? null
    },
    async wildBattle(speciesId, level, o) {
      const cr = createCreature(speciesId, level, { rng, shiny: o.shiny ?? rollShiny(rng, ctx.data), caughtMap: map?.id }, ctx.data)
      const outcome = await battles.wild(cr, { music: o.music, scripted: o.scripted })
      return outcome.result
    },
    blackout: () => blackoutFlow(),
    warp: (m, x, y, facing) => enterMap(m, x, y, facing, true),
    playerPlace: () => ({ map: map?.id ?? ctx.save.position.map, x: player.x, y: player.y, facing: player.facing }),
    playMusic(id) {
      musicOverride = id
      ctx.audio.playBgm(id, { fadeMs: GAME.region.musicFadeMs })
    },
    onWorldChanged: () => refresh(),
    weather: () => weatherKind,
    triggerEvent: (id) => gameplay.triggerEvent(id),
    revealPlace: (ref) => gameplay.revealPlace(ref),
    shopPriceMul: (item) => gameplay.modifier('shopPrice', { category: item.category }),
  }
  const scripts = createScriptRunner(host)
  /** World events, rarity spawns, roaming legends, rumors, research (events-runtime.ts). */
  const gameplay = createGameplayRuntime({
    ctx, rng,
    place: () => (map ? { map, x: player.x, y: player.y, region: regionDef } : null),
    weather: () => weatherKind,
    setEventWeather: (kind) => { if (kind !== eventWeather) { eventWeather = kind; applyWeather() } },
    npcs: { add: (defs) => npcs.add(defs), remove: (ids) => npcs.remove(ids) },
    reserved: (tx, ty) => !!map && (npcs.occupies(tx, ty) || !!warpAt(map, tx, ty)),
    runScript: (steps) => runScript(steps, null),
    startWild: (cr, o) => wildEncounter(cr, null, o),
  })

  // ---------------------------------------------------------------- map loading

  function ensureActor(): void {
    const sheet = ctx.save.avatar
    if (actor && actorSheet === sheet) {
      actor.setName(P.showOwnName ? ctx.save.name : null)
      return
    }
    actor?.dispose()
    actor = ctx.world.createActor({ sheet, name: P.showOwnName ? ctx.save.name : undefined, kind: 'player' })
    actorSheet = sheet
  }

  function storeExplored(): void {
    storeFogPages(ctx.save, ctx.data.world)
    if (!map || !GAME.fog.mapKinds.includes(map.kind) || isInfinite(map)) return
    const bits = ctx.minimap.exploredBits()
    if (bits) ctx.save.exploredChunks[map.id] = encodeExplored(bits)
  }

  /** Ground items currently live (the whole list on finite maps, the streamed set on infinite maps). */
  const liveItems = () => stream.items

  function groundItemsChanged(): void {
    if (!map) return
    const prefix = STORY_CONTENT.meta.flags.groundItem
    ctx.world.setGroundItems(liveItems().filter((it) => !it.hidden && !flagSet(ctx.save, prefix + it.id)).map((it) => ({ id: it.id, x: it.x, y: it.y })))
  }

  /** Infinite maps: refresh live NPCs / items / places around the player; discover nearby places. */
  function streamObjects(force = false): void {
    if (!map || !isInfinite(map)) return
    if (stream.update(player.x, player.y, force)) {
      registerFrontierRefs(ctx.data.world, stream.npcs)
      npcs.sync(stream.npcs)
      groundItemsChanged()
    }
    explorer.discover(map, stream.places, player.x, player.y)
  }

  /** Minimap fog source for the current map (fog pages for the infinite overworld). */
  function bindMinimap(next: GameMap): void {
    const mm = ctx.minimap as typeof ctx.minimap & Partial<Pick<MinimapHandle, 'setFogPages'>>
    if (isInfinite(next)) {
      ctx.minimap.setMap(next, null)
      mm.setFogPages?.(GAME.fog.mapKinds.includes(next.kind) ? fogPagesFor(ctx.save, ctx.data.world) : null)
    } else {
      mm.setFogPages?.(null)
      ctx.minimap.setMap(next, decodeExplored(ctx.save.exploredChunks[next.id], next))
    }
  }

  async function enterMap(mapId: string, x: number, y: number, facing: Dir, transition = false): Promise<void> {
    const next = getMap(ctx.data.world, mapId)
    if (!next) { console.warn(`[overworld] unknown map "${mapId}"`); return }
    lock('warp')
    try {
      if (transition) await ctx.ui.fade(true, GAME.warp.fadeMs)
      storeExplored()
      npcs.clear()
      roaming.clear()
      presence.clear()
      follower.setShown(false)
      if (ctx.world.map?.id !== next.id) {
        opts.onLoadProgress?.(0, next.nameZh)
        try {
          await ctx.world.loadMap(next, { onProgress: (p) => opts.onLoadProgress?.(p, next.nameZh) })
        } finally {
          opts.onLoadProgress?.(null, next.nameZh)
        }
      }
      if (disposed) return
      map = next
      navigator.clear()
      trailKey = ''
      ctx.world.setQuestPath([])
      hop = null
      const field = collisionField(next)
      ledgeGuard.reset()
      grid = {
        map: next, field, blocked: (tx, ty) => npcs.occupies(tx, ty),
        stepGuard: (fx, fy, tx, ty) => ledgeGuard.allow(next, field, fx, fy, tx, ty),
      }
      ensureActor()
      player.x = x + 0.5
      player.y = y + 0.5
      player.facing = facing
      player.moving = false
      surf = isWaterTile(x, y)
      if (bike && !P.bike.mapKinds.includes(next.kind)) bike = false
      player.elev = ctx.world.elevationAt(player.x, player.y) + (surf ? P.surf.rideLift : 0)
      tile = playerTile()
      chunkKey = ''
      graceTiles = GAME.encounters.graceSteps
      musicOverride = null
      regionKey = null
      stream.reset(next)
      stream.update(player.x, player.y, true)
      // frontier trainers / bounties live outside world.trainers / world.quests until their NPCs are resolved
      registerFrontierRefs(ctx.data.world, stream.npcs)
      npcs.load(next, stream.npcs)
      groundItemsChanged()
      bindMinimap(next)
      revealFog()
      explorer.onTile(next, tile.x, tile.y)
      explorer.discover(next, stream.places, player.x, player.y)
      ctx.world.setZoom(P.zoomByMapKind[next.kind] ?? 1)
      refreshFollower()
      follower.reset(player.x, player.y, player.elev, player.facing)
      updateRegion(true)
      syncActor(0)
      ctx.save.position = { map: next.id, x, y, facing }
      ctx.events.emit('map:entered', { mapId: next.id, x, y })
      if (transition) await ctx.ui.fade(false, GAME.warp.fadeMs)
    } finally {
      unlock('warp')
    }
  }

  // ---------------------------------------------------------------- region / music / weather / HUD

  const regionalMap = (m: GameMap) => GAME.region.mapKinds.includes(m.kind)

  const bannerSubtitle = (r: RegionDef): string | undefined => regionSubtitle(ctx.data.world, r)

  function desiredMusic(): string {
    if (musicOverride) return musicOverride
    if (!map) return ''
    if (!regionalMap(map)) return map.music
    const r = regionDef
    if (r?.isTown && GAME.region.nightMusicForTowns && ctx.clock.timeOfDay === nightPhaseOf()) return ctx.data.audio.nightTrack
    return r?.music ?? map.music
  }

  function applyMusic(force = false): void {
    if (battleActive) return
    const id = desiredMusic()
    if (id && (force || ctx.audio.currentBgm !== id)) {
      if (ctx.audio.currentBgm !== id) ctx.audio.playBgm(id, { fadeMs: GAME.region.musicFadeMs })
    }
  }

  function applyWeather(): void {
    const fallback = GAME.region.defaultWeather
    const kind: FieldWeatherKind = weatherOverride ?? (map?.outdoor ? eventWeather ?? regionDef?.weather ?? fallback : fallback)
    weatherKind = kind
    ctx.world.setWeather({ kind, intensity: GAME.region.weatherIntensity[kind] ?? 1 })
  }

  function updateRegion(force = false): void {
    if (!map) return
    const r = regionAt(map, player.x, player.y)
    const key = r?.id ?? ''
    if (!force && key === regionKey) return
    regionKey = key
    const ri = r && !isInfinite(map) ? map.regions.indexOf(r) : -1
    const prevName = regionDef?.nameZh
    regionDef = r
    const regional = regionalMap(map)
    const name = regional ? r?.nameZh ?? map.nameZh : map.nameZh
    ctx.hud.setRegion(name)
    if (r) ctx.events.emit('region:entered', { mapId: map.id, regionIndex: ri, nameZh: r.nameZh })
    if (r?.isTown && r.townId && !ctx.save.visitedTowns.includes(r.townId)) ctx.save.visitedTowns.push(r.townId)
    if (regional && r && r.nameZh !== prevName) {
      const last = bannerAt.get(r.id) ?? -Infinity
      if (nowSec() - last > GAME.region.bannerCooldownSec) {
        bannerAt.set(r.id, nowSec())
        ctx.hud.showBanner(r.nameZh, bannerSubtitle(r))
      }
    } else if (force && !regional) ctx.hud.showBanner(map.nameZh)
    applyMusic()
    applyWeather()
  }

  function questLine(): { text: string; title: string } | null {
    const id = ctx.save.trackedQuest
    const q = id ? ctx.data.world.quests.find((x) => x.id === id) : undefined
    const st = q ? ctx.save.quests[q.id] : undefined
    if (!q || !st || st.done) return null
    return {
      text: opts.questText ? opts.questText(q, st.stage) : t('world.quest.hud', { quest: q.nameZh, stage: q.stages[Math.min(st.stage, q.stages.length - 1)]?.text ?? '' }),
      title: q.nameZh,
    }
  }

  function updateHud(dt: number): void {
    const label = ctx.clock.label()
    if (label !== clockLabel) { clockLabel = label; ctx.hud.setClock(label, ctx.clock.timeOfDay) }
    moneyT -= dt
    if (moneyT <= 0) {
      moneyT = GAME.hud.moneyCheckSec
      ctx.hud.setMoney(ctx.save.money)
      const st = ctx.save.trackedQuest ? ctx.save.quests[ctx.save.trackedQuest] : undefined
      const key = `${ctx.save.trackedQuest ?? ''}|${st?.stage ?? ''}|${st?.done ?? ''}`
      if (key !== questKey) {
        questKey = key
        const line = questLine()
        ctx.hud.setQuest(line?.text ?? null, line?.title)
      }
    }
    ambienceT -= dt
    if (ambienceT <= 0) { ambienceT = GAME.region.recheckSec; applyMusic() }
  }

  function revealFog(): void {
    if (!map || !GAME.fog.mapKinds.includes(map.kind)) return
    const chunk = ctx.data.config.world.chunk
    const key = `${Math.floor(player.x / chunk)},${Math.floor(player.y / chunk)}`
    if (key === chunkKey) return
    chunkKey = key
    if (isInfinite(map)) fogPagesFor(ctx.save, ctx.data.world).revealAround(player.x, player.y, UI_CONFIG.minimap.fog.revealRadiusChunks)
    ctx.minimap.reveal(player.x, player.y)
  }

  // ---------------------------------------------------------------- follower / lead

  function refreshFollower(): void {
    const l = lead()
    follower.sync(l, map)
    follower.setShown(!!l && !!map)
  }

  function updateLead(dt: number): void {
    const l = lead()
    const key = l ? `${l.speciesId}|${l.shiny}|${l.level}` : ''
    if (key === leadKey) { leadT = 0; return }
    leadT += dt
    if (leadT < GAME.presence.leadDebounceSec) return
    leadKey = key
    leadT = 0
    if (ctx.net.status === 'online') ctx.net.send({ t: 'lead', lead: l ? { speciesId: l.speciesId, shiny: l.shiny, level: l.level } : null })
  }

  function refresh(): void {
    npcs.refreshVisibility()
    groundItemsChanged()
    refreshFollower()
    if (actor) ensureActor()
  }

  // ---------------------------------------------------------------- player movement

  function speedFor(mode: MoveMode): number {
    const M = ctx.data.config.movement
    return mode === 'surf' ? M.surfSpeed : mode === 'bike' ? M.bikeSpeed : mode === 'run' ? M.runSpeed : M.walkSpeed
  }

  function currentMode(running: boolean): MoveMode {
    return surf ? 'surf' : bike ? 'bike' : running ? 'run' : 'walk'
  }

  function footstep(mode: MoveMode): void {
    const tt = terrainAtTile(tile.x, tile.y)
    const def = mode === 'surf' ? GAME.footsteps.surf : (tt && GAME.footsteps.terrain[tt.key]) || GAME.footsteps.default
    ctx.audio.playSfx(def.sfx, { volume: def.volume, pitch: def.pitch })
  }

  function startHop(from: { x: number; y: number }, to: { x: number; y: number }): void {
    const L = EXPLORE.ledge
    const dx = Math.sign(to.x - from.x), dy = Math.sign(to.y - from.y)
    // Land past the lower tile's near edge so the body ends fully on the lower level.
    const lx = dx ? to.x + 0.5 - dx * (0.5 - L.landingOffset) : player.x
    const ly = dy ? to.y + 0.5 - dy * (0.5 - L.landingOffset) : player.y
    // one arc from the upper ground to the lower: the base elevation slides linearly under the arc (no smoothing
    // dip at take-off); the actor only adds the landing squash, timed to this hop
    hop = { fx: player.x, fy: player.y, tx: lx, ty: ly, t: 0, dur: L.hopMs / 1000, lift: 0, e0: player.elev, e1: ctx.world.elevationAt(lx, ly) }
    player.moving = false
    actor?.hop({ ms: L.hopMs, height: 0 })
    ctx.audio.playSfx(L.sfx, { volume: L.volume, pitch: L.pitch })
  }

  /** Advances a ledge hop; returns true while hopping (normal movement is skipped). */
  function updateHop(dt: number): boolean {
    if (!hop) return false
    const h = hop
    h.t = Math.min(h.dur, h.t + dt)
    const k = h.t / h.dur
    player.x = h.fx + (h.tx - h.fx) * k
    player.y = h.fy + (h.ty - h.fy) * k
    h.lift = 4 * EXPLORE.ledge.height * k * (1 - k)
    if (h.t < h.dur) return true
    hop = null
    const L = EXPLORE.ledge
    ctx.audio.playSfx(L.landSfx, { volume: L.landVolume })
    ctx.world.spawnFx(L.landFx, player.x, player.y, ctx.world.elevationAt(player.x, player.y))
    const nt = playerTile()
    tile = nt
    void onEnterTile(nt.x, nt.y)
    return false
  }

  function updatePlayer(dt: number, free: boolean): void {
    if (!grid || !map) return
    if (updateHop(dt)) return
    bumpCooldown = Math.max(0, bumpCooldown - dt * 1000)
    const axis = free ? ctx.input.axis() : { x: 0, y: 0 }
    const mag = Math.hypot(axis.x, axis.y)
    const autoRun = ctx.save.settings.autoRun
    const running = free && (ctx.input.held('run') !== autoRun)
    const mode = currentMode(running)
    player.running = mode === 'run'
    if (mag < P.axisDeadzone) { player.moving = false; return }
    player.facing = facingFromAxis(axis.x, axis.y, player.facing, P.facingHysteresis)
    const tt = terrainAtTile(tile.x, tile.y)
    const speed = speedFor(mode) * (surf ? 1 : tt?.speed ?? 1) * Math.min(1, mag)
    const dx = (axis.x / mag) * speed * dt, dy = (axis.y / mag) * speed * dt
    const refused = ledgeGuard.refusals
    const res = moveBody(grid, player.x, player.y, dx, dy, {
      radius: P.radius, surf, cornerSlip: P.cornerSlip, cornerSlipRate: P.cornerSlipRate, substep: P.substepTiles,
    })
    const moved = Math.hypot(res.x - player.x, res.y - player.y)
    // diagonal input sliding along a wall: face the way the body actually goes (no moonwalking into the wall)
    if (res.blocked && moved > speed * dt * P.movingRatio && Math.abs(axis.x) > P.axisDeadzone && Math.abs(axis.y) > P.axisDeadzone) {
      player.facing = facingFromAxis((res.x - player.x) / moved, (res.y - player.y) / moved, player.facing, P.facingHysteresis)
    }
    player.x = res.x
    player.y = res.y
    player.moving = moved > speed * dt * P.movingRatio
    if (ledgeGuard.refusals !== refused && nowSec() - ledgeHintAt > EXPLORE.ledge.guard.hintCooldownSec) {
      ledgeHintAt = nowSec()
      ctx.ui.toast(t(EXPLORE.ledge.guard.hint))
    }
    if (res.blocked && moved < speed * dt * P.bump.stuckRatio && bumpCooldown <= 0) {
      bumpCooldown = P.bump.cooldownMs
      ctx.audio.playSfx(P.bump.sfx, { volume: P.bump.volume })
    }
    strideAcc += moved
    const stride = GAME.footsteps.stride[mode]
    if (strideAcc >= stride) { strideAcc -= stride; footstep(mode) }
    if (surf) {
      splashT -= dt
      if (splashT <= 0 && player.moving) { splashT = P.surf.splashEverySec; ctx.world.spawnFx(P.surf.fx, player.x, player.y, player.elev) }
    }
    const nt = playerTile()
    if (nt.x !== tile.x || nt.y !== tile.y) {
      const from = tile
      tile = nt
      if (surf && !isWaterTile(nt.x, nt.y)) surf = false
      if (!surf && Math.abs(nt.x - from.x) + Math.abs(nt.y - from.y) === 1 && isLedgeDrop(map, from.x, from.y, nt.x, nt.y)) {
        startHop(from, nt)
        return
      }
      void onEnterTile(nt.x, nt.y)
    }
  }

  function syncActor(dt: number): void {
    if (!actor) return
    const target = ctx.world.elevationAt(player.x, player.y) + (surf ? P.surf.rideLift : 0)
    if (hop) player.elev = hop.e0 + (hop.e1 - hop.e0) * (hop.t / hop.dur)
    else player.elev = dt > 0 ? player.elev + (target - player.elev) * (1 - Math.exp(-dt * P.elevSmoothing)) : target
    actor.setPosition(player.x, player.y, player.elev + (hop?.lift ?? 0))
    actor.setFacing(player.facing)
    actor.setMoving(player.moving && !surf, player.running || bike)
    actor.update(dt)
  }

  async function onEnterTile(tx: number, ty: number): Promise<void> {
    if (!map) return
    ctx.save.stats.steps += 1
    const tt = terrainAtTile(tx, ty)
    const fx = tt ? GAME.footsteps.terrain[tt.key]?.fx : undefined
    if (fx && !surf) ctx.world.spawnFx(fx, player.x, player.y, player.elev)
    updateRegion()
    revealFog()
    explorer.onTile(map, tx, ty)
    const warp = warpAt(map, tx, ty)
    if (warp) { await doWarp(warp); return }
    let repelEnded = false
    if (ctx.save.repelSteps > 0) {
      ctx.save.repelSteps -= 1
      repelEnded = ctx.save.repelSteps === 0
    }
    if (graceTiles > 0) graceTiles -= 1
    else if (!repelEnded) await tryEncounter(tx, ty)
    if (repelEnded) await repelWornOff()
  }

  async function doWarp(w: GameMap['warps'][number]): Promise<void> {
    const sfx = GAME.warp.sfx[w.kind]
    if (sfx) ctx.audio.playSfx(sfx)
    player.moving = false
    await enterMap(w.toMap, w.toX, w.toY, w.facing, true)
  }

  async function repelWornOff(): Promise<void> {
    lock('prompt')
    try {
      const item = ctx.data.itemList.find((it) => it.effect.kind === 'repel' && (ctx.save.bag[it.id] ?? 0) > 0)
      const anyRepel = ctx.data.itemList.find((it) => it.effect.kind === 'repel')
      await say(t('world.repel.wornOff', { item: anyRepel?.nameZh ?? '' }))
      if (item && item.effect.kind === 'repel' && GAME.encounters.repelOfferRefill) {
        const yes = await ctx.ui.confirm(t('world.repel.useAnother', { item: item.nameZh }))
        if (yes && removeItem(ctx, item.id, 1) > 0) {
          ctx.save.repelSteps = item.effect.steps
          await say(t('world.repel.used', { ...params(), item: item.nameZh }))
        }
      }
    } finally {
      unlock('prompt')
    }
  }

  // ---------------------------------------------------------------- encounters & battles

  async function tryEncounter(tx: number, ty: number): Promise<void> {
    if (!map || !regionDef || battleActive) return
    const tt = terrainAtTile(tx, ty)
    const eligible = !!tt && (tt.encounter || (surf && tt.swim && GAME.encounters.surfEncounters))
    if (!eligible) return
    const l = lead()
    if (GAME.encounters.requireConsciousParty && !l) return
    const pick = gameplay.rollGrass(regionDef, { repelActive: ctx.save.repelSteps > 0, leadLevel: l?.level ?? 0 })
    if (!pick) return
    const cr = createCreature(pick.speciesId, pick.level, { rng, shiny: pick.shiny, caughtMap: map.id }, ctx.data)
    gameplay.cue(pick.cues.spawn, { x: player.x, y: player.y })
    await wildEncounter(cr, null, pick.flee ? { flee: pick.flee } : {})
  }

  async function wildEncounter(cr: ReturnType<typeof createCreature>, roamer: Roamer | null, o: { flee?: BattleSideInit['flee'] } = {}) {
    lock('battle')
    player.moving = false
    syncActor(0)
    try {
      actor?.bubble(GAME.npc.trainer.bubble)
      ctx.world.spawnFx(GAME.encounters.transition.fx, player.x, player.y, player.elev)
      const flee = o.flee ?? roamer?.extra?.flee
      const outcome = await battles.wild(cr, flee ? { flee } : {})
      if (roamer) roaming.remove(roamer)
      if (outcome.result === 'lose' || outcome.result === 'draw') await blackoutFlow()
      return outcome
    } finally {
      unlock('battle')
    }
  }

  async function blackoutFlow(): Promise<void> {
    lock('battle')
    try {
      await ctx.ui.say([{ text: t('world.blackout.fainted', params()) }, { text: t('world.blackout.dark', params()) }])
      const last = battles.lastOutcome
      const alreadyLost = !!last && last.moneyDelta < 0
      if (!alreadyLost) {
        const loss = Math.floor(ctx.save.money * ctx.data.config.economy.blackoutMoneyLoss)
        if (loss > 0) {
          changeMoney(ctx, -loss)
          await say(t('world.blackout.money', { ...params(), money: loss }))
        }
      }
      ctx.audio.playSfx(GAME.blackout.sfx)
      await ctx.ui.fade(true, GAME.blackout.fadeMs)
      healParty(ctx)
      const r = ctx.save.respawn
      const target = getMap(ctx.data.world, r.map) ? r : { ...ctx.save.position, ...ctx.data.world.maps[ctx.data.world.startMap].spawn, map: ctx.data.world.startMap }
      bike = false
      await enterMap(target.map, target.x, target.y, target.facing, false)
      await ctx.ui.fade(false, GAME.blackout.fadeMs)
      await say(t('world.blackout.recovered', params()))
      ctx.persist('blackout')
    } finally {
      unlock('battle')
    }
  }

  // ---------------------------------------------------------------- scripts & NPCs

  async function runScript(steps: readonly ScriptStep[], npc: NpcDef | null): Promise<void> {
    lock('script')
    player.moving = false
    try {
      await scripts.run(steps, npc)
    } finally {
      unlock('script')
      refresh()
    }
  }

  async function talkTo(n: NpcRuntime): Promise<void> {
    n.busy = true
    const pt = playerTile()
    if (GAME.npc.turnToPlayer) npcs.face(n, dirTowards(n.tx, n.ty, pt.x, pt.y))
    player.facing = dirTowards(pt.x, pt.y, n.tx, n.ty)
    try {
      await runScript(n.def.script, n.def)
    } finally {
      n.busy = false
    }
  }

  async function trainerSpotted(n: NpcRuntime): Promise<void> {
    lock('script')
    n.triggered = true
    n.busy = true
    player.moving = false
    try {
      const T = GAME.npc.trainer
      ctx.audio.playSfx(T.sfx)
      n.actor?.bubble(T.bubble, T.exclaimMs)
      ctx.world.spawnFx(T.fx, n.x, n.y, ctx.world.elevationAt(n.x, n.y))
      await new Promise((r) => setTimeout(r, T.exclaimMs))
      await npcs.approach(n, playerTile(), T.approachSpeed)
      const pt = playerTile()
      player.facing = dirTowards(pt.x, pt.y, n.tx, n.ty)
      npcs.face(n, dirTowards(n.tx, n.ty, pt.x, pt.y))
      await runScript(n.def.script, n.def)
    } finally {
      n.busy = false
      unlock('script')
    }
  }

  // ---------------------------------------------------------------- interactions

  /** Props whose footprint may cover (tx, ty): anchors are top-left, so look up to propReach tiles north-west. */
  function propsNear(tx: number, ty: number) {
    if (!map) return []
    const R = EXPLORE.stream.propReach
    return objectsInRect(map, tx - R, ty - R, tx + 1, ty + 1).props
  }

  function interactiveProp(tx: number, ty: number) {
    if (!map) return null
    for (const p of propsNear(tx, ty)) {
      const def = ctx.data.props[p.prop]
      if (!def?.interactable) continue
      const r = propRect(p)
      if (tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h) return { placement: p, def }
    }
    return null
  }

  function hasReachAcrossProp(tx: number, ty: number): boolean {
    if (!map) return false
    for (const p of propsNear(tx, ty)) {
      if (!GAME.interact.reachAcrossProps.includes(p.prop)) continue
      const r = propRect(p)
      if (tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h) return true
    }
    return false
  }

  function npcInFront(): NpcRuntime | null {
    const v = DIR_VEC[player.facing]
    const fx = player.x + v.x * GAME.interact.reach, fy = player.y + v.y * GAME.interact.reach
    let best: NpcRuntime | null = null
    let bd = GAME.interact.radius
    for (const n of npcs.list) {
      if (!n.visible) continue
      const d = Math.hypot(n.x - fx, n.y - fy)
      if (d < bd) { bd = d; best = n }
    }
    if (best) return best
    const front = { x: Math.floor(fx), y: Math.floor(fy) }
    if (hasReachAcrossProp(front.x, front.y)) return npcs.at(front.x + v.x, front.y + v.y) ?? null
    return null
  }

  async function pickup(it: GroundItemDef): Promise<void> {
    const item = ctx.data.items[it.item]
    ctx.save.flags[STORY_CONTENT.meta.flags.groundItem + it.id] = true
    groundItemsChanged()
    if (!item) return
    addItem(ctx, it.item, it.qty)
    ctx.audio.playSfx(item.category === 'key' ? GAME.items.keyItemSfx : GAME.items.pickupSfx)
    const lines = [t(it.qty > 1 ? 'world.item.foundQty' : 'world.item.found', { ...params(), item: item.nameZh, qty: it.qty }), t('world.item.pocket', { ...params(), item: item.nameZh })]
    if (it.hidden) lines.unshift(t('world.item.hidden'))
    await ctx.ui.say(lines.map((text) => ({ text })))
  }

  async function statueText(tx: number, ty: number): Promise<string[]> {
    if (!map) return [t('world.interact.statue')]
    const r = regionAt(map, tx, ty)
    const town = r?.townId ? ctx.data.world.towns.find((tw) => tw.id === r.townId) : undefined
    const badge = town ? ctx.data.world.badges.find((b) => b.town === town.id) : undefined
    if (!town || !badge) return [t('world.interact.statue')]
    const leader = ctx.data.world.trainers[badge.leader]?.nameZh ?? ctx.data.characterById[badge.leader]?.nameZh ?? badge.leader
    const lines = [t('world.interact.statueGym', { town: town.nameZh, type: ctx.data.typeById[badge.type]?.nameZh ?? badge.type, leader })]
    if (ctx.save.badges.includes(badge.id)) lines.push(t('world.interact.statueWinners', params()))
    return lines
  }

  async function propInteract(prop: NonNullable<ReturnType<typeof interactiveProp>>, tx: number, ty: number): Promise<void> {
    const cfg = GAME.interact.props[prop.placement.prop]
    if (!cfg) { await say(t('world.interact.prop', { prop: prop.def.nameZh })); return }
    switch (cfg.action) {
      case 'box':
        ctx.audio.playSfx(GAME.interact.sfx)
        await say(t('world.interact.box', params()))
        await ctx.screens.box()
        refresh()
        break
      case 'statue':
        await ctx.ui.say((await statueText(tx, ty)).map((text) => ({ text })))
        break
      case 'text':
        await say(textOrKey(cfg.text ?? '', params()))
        break
      case 'script':
        await runScript(cfg.script ?? [], null)
        break
    }
  }

  async function followerInteract(): Promise<void> {
    const l = lead()
    if (!l) return
    const name = creatureName(l, ctx.data)
    ctx.world.spawnFx(GAME.follower.fx, follower.x, follower.y, ctx.world.elevationAt(follower.x, follower.y))
    ctx.audio.playCry(l.speciesId, { pitch: GAME.follower.cryPitch })
    const tired = l.hp / Math.max(1, maxHp(l, ctx.data)) < GAME.follower.tiredBelow
    await say(t(tired ? 'world.follower.tired' : 'world.follower.happy', { name }))
  }

  async function surfPrompt(): Promise<void> {
    const item = ownedKeyItem(ctx.save, 'surf', ctx.data)
    if (!item) { await say(t('world.surf.noItem')); return }
    if (!lead()) { await say(t('world.surf.noCreature')); return }
    const pick = await ctx.ui.choose(t('world.surf.prompt', { item: item.nameZh }), [t('world.surf.yes'), t('world.surf.no')], { cancelIndex: 1 })
    if (pick !== 0) return
    await say(t('world.surf.start', { ...params(), item: item.nameZh }))
    const v = DIR_VEC[player.facing]
    const from = { x: player.x, y: player.y }
    const to = { x: Math.floor(player.x + v.x * GAME.interact.reach) + 0.5, y: Math.floor(player.y + v.y * GAME.interact.reach) + 0.5 }
    surf = true
    bike = false
    actor?.hop()
    ctx.audio.playSfx(P.surf.sfx)
    await new Promise<void>((resolve) => {
      const start = performance.now()
      const tick = () => {
        const k = Math.min(1, (performance.now() - start) / P.surf.hopMs)
        player.x = from.x + (to.x - from.x) * k
        player.y = from.y + (to.y - from.y) * k
        if (k >= 1) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    ctx.world.spawnFx(P.surf.fx, player.x, player.y, player.elev)
    tile = playerTile()
  }

  async function interact(): Promise<void> {
    if (!map) return
    lock('prompt')
    try {
      const v = DIR_VEC[player.facing]
      const fx = player.x + v.x * GAME.interact.reach, fy = player.y + v.y * GAME.interact.reach
      const front = { x: Math.floor(fx), y: Math.floor(fy) }
      const pt = playerTile()
      const n = npcInFront()
      if (n) { await talkTo(n); return }
      const remote = presence.nearest(fx, fy, GAME.presence.interactRadius)
      if (remote) { await presence.interact(remote); return }
      const sign = objectsInRect(map, front.x, front.y, front.x + 1, front.y + 1).signs[0]
      if (sign) { await say(textOrKey(sign.text, params())); return }
      const prefix = STORY_CONTENT.meta.flags.groundItem
      const item = liveItems().find((it) => !flagSet(ctx.save, prefix + it.id) && ((it.x === front.x && it.y === front.y) || (it.x === pt.x && it.y === pt.y)))
      if (item) { await pickup(item); return }
      const prop = interactiveProp(front.x, front.y)
      if (prop) { await propInteract(prop, front.x, front.y); return }
      if (follower.active && Math.hypot(follower.x - fx, follower.y - fy) < GAME.follower.interactRadius) { await followerInteract(); return }
      if (!surf && isWaterTile(front.x, front.y)) await surfPrompt()
    } finally {
      unlock('prompt')
    }
  }

  function toggleBike(): void {
    const item = ownedKeyItem(ctx.save, 'bike', ctx.data)
    if (!item || !map) return
    if (surf) { ctx.ui.toast(t('world.bike.surfing', { item: item.nameZh }), 'warn'); return }
    if (!bike && !P.bike.mapKinds.includes(map.kind)) { ctx.ui.toast(t('world.bike.notHere', { item: item.nameZh }), 'warn'); return }
    bike = !bike
    ctx.audio.playSfx(bike ? P.bike.sfxOn : P.bike.sfxOff)
    ctx.ui.toast(t(bike ? 'world.bike.on' : 'world.bike.off', { ...params(), item: item.nameZh }), 'info')
  }

  // ---------------------------------------------------------------- per-frame

  function hiddenGlints(dt: number): void {
    if (!map) return
    glintT -= dt
    if (glintT > 0) return
    const G = GAME.items.hiddenGlint
    glintT = G.intervalSec
    const prefix = STORY_CONTENT.meta.flags.groundItem
    for (const it of liveItems()) {
      if (!it.hidden || flagSet(ctx.save, prefix + it.id)) continue
      const x = it.x + 0.5, y = it.y + 0.5
      if (Math.hypot(x - player.x, y - player.y) <= G.radius) ctx.world.spawnFx(G.fx, x, y, ctx.world.elevationAt(x, y))
    }
  }

  function update(dt: number): void {
    if (!map || disposed) return
    const free = isFree()
    updatePlayer(dt, free)
    streamObjects()
    stream.prefetch(player.x, player.y)
    stream.retain(player.x, player.y, dt)
    if (free) {
      const seen = npcs.sightCheck(playerTile())
      if (seen) void trainerSpotted(seen)
      else if (ctx.input.pressed('confirm')) { ctx.input.consume('confirm'); void interact() }
      else if (ctx.input.pressed('bike')) { ctx.input.consume('bike'); toggleBike() }
    }
    npcs.update(dt, { allowWander: !locks.has('script'), focus: player })
    if (grid) {
      navigator.update(dt, grid, player, ctx.save, surf || (!!ownedKeyItem(ctx.save, 'surf', ctx.data) && !!lead()), target => {
        const npc = npcs.list.find(n => n.visible && n.def.x === target.x && n.def.y === target.y)
        return npc ? { x: npc.x, y: npc.y } : null
      })
      const route = navigator.state
      const path = route && (route.status === 'ready' || route.status === 'arrived')
        ? route.path.slice(0, TUTORIAL.objective.navigation.trailTiles) : []
      const nextTrailKey = path.map(p => `${p.x},${p.y}`).join('|')
      if (trailKey !== nextTrailKey) {
        trailKey = nextTrailKey
        ctx.world.setQuestPath(path)
        markerT = 0
      }
    }
    const touched = roaming.update(dt, player, free && !!lead())
    if (touched && isFree()) void wildEncounter(touched.creature, touched)
    gameplay.update(dt, { free: isFree(), canBattle: !!lead() })
    syncActor(dt)
    follower.update(dt, player.x, player.y, player.elev, player.facing, surf)
    presence.update(dt)
    hiddenGlints(dt)
    updateLead(dt)
    ctx.world.update(dt, { x: player.x, y: player.y, elev: player.elev }, ctx.clock.minutesOfDay)
    markerT -= dt
    if (markerT <= 0) {
      markerT = GAME.markers.refreshSec
      markers = collectMarkers({ map, world: ctx.data.world, save: ctx.save, npcs: npcs.list, remotes: presence.views.values(), roamers: roaming.list, items: liveItems(), navigation: navigator.state })
      markers.push(...gameplay.markers())
    }
    ctx.minimap.update(player.x, player.y, player.facing, markers, navigator.state?.path)
    updateHud(dt)
    ctx.net.reportPosition({ map: map.id, x: player.x, y: player.y, facing: player.facing, moving: player.moving, running: player.running || bike })
  }

  const offParty = ctx.events.on('party:changed', () => refreshFollower())
  const offMoney = ctx.events.on('money:changed', ({ money }) => ctx.hud.setMoney(money))

  return {
    enterMap,
    update,
    setControlEnabled(on: boolean) { if (on) unlock('external'); else { lock('external'); player.moving = false } },
    get player() {
      return { x: player.x, y: player.y, elev: player.elev, facing: player.facing, map: map?.id ?? ctx.save.position.map }
    },
    runScript,
    blackout: () => blackoutFlow(),
    refresh,
    get battleActive() { return battleActive },
    get free() { return isFree() },
    get mode() { return currentMode(player.running) },
    get mapId() { return map?.id ?? null },
    get region() { return regionDef },
    get terrainName() { return terrainAtTile(tile.x, tile.y)?.nameZh ?? '' },
    get roamerCount() { return roaming.list.length },
    get weather() { return weatherKind },
    get questNavigation() { return navigator.state },
    setWeatherOverride(kind) { weatherOverride = kind; applyWeather() },
    async startWildBattle(speciesId, level) {
      if (!ctx.data.species[speciesId]) return
      const cr = createCreature(speciesId, level, { rng, shiny: rollShiny(rng, ctx.data), caughtMap: map?.id }, ctx.data)
      await wildEncounter(cr, null)
    },
    async startTrainerBattle(trainerId) {
      const n = npcs.list.find((x) => x.def.trainer === trainerId) ?? null
      lock('script')
      try {
        const r = await host.trainerBattle(trainerId, n?.def ?? null)
        if (r === 'lose' || r === 'draw') await blackoutFlow()
      } finally {
        unlock('script')
        refresh()
      }
    },
    playIntro: () => runScript(GAME.newGame.introScript, null),
    storeExplored,
    dispose() {
      disposed = true
      offParty()
      offMoney()
      gameplay.dispose()
      navigator.clear()
      ctx.world.setQuestPath([])
      npcs.clear()
      roaming.clear()
      presence.dispose()
      follower.dispose()
      actor?.dispose()
      actor = null
    },
  }
}
