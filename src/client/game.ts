// Integration: builds every client service into one GameContext, runs the main loop, title flow, settings,
// autosave, global keys and multiplayer wiring. Optional modules (battle client, screens, multiplayer flows)
// are discovered with import.meta.glob so the game still runs, with fallbacks, while they are missing.
import type { Creature, QuestDef, SaveData, Settings } from '../shared/types.ts'
import type { ClientMsg, PublicProfile } from '../shared/protocol.ts'
import type { AudioManager, BattleRunner, GameClock, GameContext, GameData, GameEvents, Minimap, Screens } from './contracts.ts'
import { CONTENT, t } from '../shared/content/index.ts'
import { toView } from '../shared/creature.ts'
import { buildWorld, worldAnchors } from '../shared/world/index.ts'
import { getMap } from '../shared/world/worldapi.ts'
import {
  applyDocumentSettings, createAssetStore, createAudio, createClock, createEventBus, createInput, createSaveManager,
} from './core/index.ts'
import { createRenderer, createWorldView } from './render/index.ts'
import { UI_CONFIG, createChatUI, createEscapeStack, createHUD, createMinimap, createUIKit, installEscapeFallback, releaseButtonFocusAfterClick } from './ui/index.ts'
import { createNetClient } from './net/index.ts'
import { createOnboarding } from './onboarding/index.ts'
import { validateTutorial } from './onboarding/config.ts'
import { createFallbackBattleRunner, createFallbackScreens, createOverworld, GAME, validateGameContent, type MultiplayerHooks, type OverworldExt } from './world/index.ts'
import { ownedKeyItem } from './world/save-ops.ts'
import { flyLanding, resolvePlace } from './world/explore.ts'
import { applyDebugStart, createDebugOverlay, debugSave, installDebugHooks, installDevLog, readDebugParams, runDebugActions, type DebugParams } from './debug.ts'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type Loader = () => Promise<unknown>

/** <html> class the battle scene (src/client/battle/scene.ts) sets while it renders the canvas. */
const BATTLE_SCREEN_CLASS = 'ap-battle-on'
/** <html> class set while a modal UI owns input (index.html disables the touch stick zone under it). */
const UI_BLOCKING_CLASS = 'ap-ui-blocking'

interface ScreensModule { createScreens(ctx: GameContext): Screens & { importSave?(): Promise<SaveData | null> }; questHudText?(def: QuestDef, stage: number): string }
interface BattleModule { createBattleRunner(ctx: GameContext): BattleRunner }
interface PvpModule { challengePvp(ctx: GameContext, id: string, name: string): Promise<void>; installPvpHandlers(ctx: GameContext): () => void }
interface TradeModule { startTradeFlow(ctx: GameContext, id: string, name: string): Promise<void>; installTradeHandlers(ctx: GameContext): () => void }

/** Vite rewrites this into lazy loaders for the files that exist; missing files simply have no entry. */
function optionalModules(): Record<string, Loader> {
  try {
    // @ts-ignore -- import.meta.glob is a Vite compile-time feature (not in the node/tsc lib types)
    return import.meta.glob(['./battle/index.ts', './ui/screens/index.ts', './net/pvp-channel.ts', './net/trade-flow.ts']) as Record<string, Loader>
  } catch {
    return {}
  }
}

async function loadOptional<T>(loaders: Record<string, Loader>, path: string, check: (m: Partial<T>) => boolean): Promise<T | null> {
  const load = loaders[path]
  if (!load) return null
  try {
    const mod = (await load()) as Partial<T>
    return check(mod) ? (mod as T) : null
  } catch (err) {
    console.warn(`[game] optional module ${path} failed to load`, err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Loading screen (markup in index.html)
// ---------------------------------------------------------------------------

function createLoader() {
  const root = document.getElementById('ap-loading')
  const bar = root?.querySelector<HTMLElement>('.ap-loading__fill') ?? null
  const label = root?.querySelector<HTMLElement>('.ap-loading__label') ?? null
  const title = root?.querySelector<HTMLElement>('.ap-loading__title') ?? null
  const sub = root?.querySelector<HTMLElement>('.ap-loading__sub') ?? null
  if (title) title.textContent = t('game.loading.title')
  if (sub) sub.textContent = t('game.loading.subtitle')
  document.title = t('game.appTitle')
  let showTimer = 0
  const set = (p: number, text: string) => {
    if (bar) bar.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`
    if (label) label.textContent = text
  }
  const show = () => { if (root) { root.hidden = false; root.classList.remove('is-done') } }
  const hide = () => {
    window.clearTimeout(showTimer)
    showTimer = 0
    if (!root || root.hidden) return
    root.classList.add('is-done')
    window.setTimeout(() => { if (root.classList.contains('is-done')) root.hidden = true }, GAME.loading.fadeOutMs)
  }
  return {
    step(id: string) {
      const steps = GAME.loading.steps
      const i = Math.max(0, steps.indexOf(id))
      show()
      set((i + 1) / steps.length, t(`game.loading.steps.${id}`))
    },
    /** Map-load progress; the overlay only appears when a load takes longer than loading.showAfterMs. */
    map(p: number | null, mapName: string) {
      if (p === null) { hide(); return }
      set(p, t('game.loading.steps.map', { map: mapName }))
      if (root?.hidden && !showTimer) showTimer = window.setTimeout(() => { showTimer = 0; show() }, GAME.loading.showAfterMs)
    },
    hide,
    error(message: string) {
      show()
      root?.classList.add('is-error')
      set(1, message)
      const retry = root?.querySelector<HTMLButtonElement>('.ap-loading__retry')
      if (retry) { retry.hidden = false; retry.textContent = t('game.loading.retry'); retry.onclick = () => location.reload() }
    },
  }
}

// ---------------------------------------------------------------------------
// Clock that survives save replacement (GameContext.clock is readonly; the clock binds to one SaveData)
// ---------------------------------------------------------------------------

function createClockHolder(save: SaveData) {
  let inner = createClock(save)
  const clock: GameClock = {
    get minutes() { return inner.minutes },
    set minutes(v: number) { inner.minutes = v },
    get minutesOfDay() { return inner.minutesOfDay },
    get timeOfDay() { return inner.timeOfDay },
    update(dt: number) { inner.update(dt) },
    label() { return inner.label() },
  }
  return { clock, rebind(s: SaveData) { inner = createClock(s) } }
}

export async function startGame(): Promise<void> {
  const loader = createLoader()
  try {
    await boot(loader)
  } catch (err) {
    console.error(err)
    loader.error(t('game.loading.error', { error: err instanceof Error ? err.message : String(err) }))
  }
}

async function boot(loader: ReturnType<typeof createLoader>): Promise<void> {
  const dbg: DebugParams = readDebugParams(location.search)
  if (dbg.dev) {
    installDevLog()
    for (const e of validateGameContent()) console.warn(`[game] ${e}`)
  }
  const appRoot = document.getElementById('app') ?? document.body
  const canvas = document.getElementById('ap-canvas') as HTMLCanvasElement | null
  const uiRoot = document.getElementById('ap-ui') ?? appRoot
  if (!canvas) throw new Error('missing #ap-canvas')

  loader.step('content')
  const loaders = optionalModules()
  loader.step('assets')
  const assets = createAssetStore()
  await assets.init()
  loader.step('world')
  await new Promise((r) => setTimeout(r, 0))
  const world = buildWorld()
  const data: GameData = { ...CONTENT, world }
  if (dbg.dev) for (const e of validateTutorial(world, worldAnchors(world))) console.warn(`[onboarding] ${e}`)
  const saves = createSaveManager({ world })
  if (dbg.dev && dbg.reset) localStorage.removeItem(`${CONTENT.config.save.storagePrefix}${dbg.slot}`)
  const stored = saves.load(dbg.slot)
  let save: SaveData = stored ?? saves.newGame({ name: '', avatar: '' })
  /** Before the world starts only a save that already exists on disk may be written (settings changed on the title). */
  let titleSaveStored = !!stored
  let playing: SaveData | null = null

  const events = createEventBus<GameEvents>()
  const input = createInput(appRoot)
  const audio: AudioManager = createAudio(assets)
  const clockHolder = createClockHolder(save)

  loader.step('renderer')
  let renderer: ReturnType<typeof createRenderer>
  try {
    renderer = createRenderer(canvas, save.settings)
  } catch (err) {
    console.error(err)
    throw new Error(t('game.loading.webgl'))
  }
  const resize = () => renderer.resize(window.innerWidth, window.innerHeight)
  resize()
  window.addEventListener('resize', resize)
  window.visualViewport?.addEventListener('resize', resize)

  loader.step('ui')
  const hud = createHUD(uiRoot)
  const worldView = createWorldView(renderer, assets, hud.overlay)
  const ui = createUIKit(uiRoot, input, audio, () => ctx.save.settings)
  ui.setPortraitResolver((id) => assets.portraitUrl(id))
  const minimap = createMinimap(uiRoot)
  const chat = createChatUI(uiRoot, input, (channel, text, to) => {
    if (net.status !== 'online') { ui.toast(t('game.net.offlineChat'), 'warn'); return }
    const msg: ClientMsg = to ? { t: 'chat', channel, text, to } : { t: 'chat', channel, text }
    net.send(msg)
  })
  // Focus hand-over: Esc always closes the topmost overlay, a click on the game view returns to the game,
  // and HUD buttons let go of focus after a pointer click (see ui/focus-guard.ts).
  const escapes = createEscapeStack(UI_CONFIG.focus.escapeOrder)
  escapes.register({ id: 'chat', isOpen: () => chat.isOpen, dismiss: () => chat.close() })
  installEscapeFallback(escapes)
  releaseButtonFocusAfterClick(uiRoot, UI_CONFIG.focus.releaseClickScopes)
  canvas.addEventListener('pointerdown', () => chat.close())

  const profile = (): PublicProfile => ({
    id: net.selfId ?? '',
    name: ctx.save.name,
    avatar: ctx.save.avatar,
    badges: [...ctx.save.badges],
    dexCaught: ctx.save.dexCaught.length,
    party: ctx.save.party.map((c) => toView(c, data)),
    pvpWins: ctx.save.stats.pvpWins,
    pvpLosses: ctx.save.stats.pvpLosses,
    playTimeSec: Math.floor(ctx.save.playTimeSec),
  })
  const leadOf = (party: Creature[]) => {
    const l = party.find((c) => c.hp > 0) ?? null
    return l ? { speciesId: l.speciesId, shiny: l.shiny, level: l.level } : null
  }
  const net = createNetClient(events, () => {
    const p = overworld.player
    return {
      t: 'hello', v: data.config.net.protocolVersion, playerId: ctx.save.playerId, name: ctx.save.name, avatar: ctx.save.avatar,
      map: p.map, x: p.x, y: p.y, facing: p.facing, lead: leadOf(ctx.save.party), profile: profile(),
    }
  })

  // ---- context ------------------------------------------------------------
  let inWorld = false
  let lastPersistAt = 0
  let lastFrame = performance.now()
  const ctxObj: Partial<Mutable<GameContext>> & { save: SaveData } = {
    data,
    get save() { return save },
    set save(v: SaveData) { save = v; clockHolder.rebind(v) },
    events, input, audio, assets, saves,
    clock: clockHolder.clock,
    renderer, world: worldView, ui, hud, minimap, chat, net,
    persist(reason: string) {
      if (!inWorld) {
        if (titleSaveStored && !saves.write(ctx.save, dbg.slot)) ui.toast(t('game.save.failed'), 'error')
        return
      }
      if (ctx.save === playing) {
        overworld.storeExplored()
        const p = overworld.player
        ctx.save.position = { map: p.map, x: Math.floor(p.x), y: Math.floor(p.y), facing: p.facing }
      }
      if (!saves.write(ctx.save, dbg.slot)) ui.toast(t('game.save.failed'), 'error')
      lastPersistAt = performance.now()
      net.updateProfile(profile())
      events.emit('save:changed', { reason })
    },
    species: (id: string) => data.species[id],
    creatureView: (c: Creature) => toView(c, data),
  }
  const ctx = ctxObj as unknown as GameContext

  loader.step('modules')
  const [screensMod, battleMod, pvpMod, tradeMod] = await Promise.all([
    loadOptional<ScreensModule>(loaders, './ui/screens/index.ts', (m) => typeof m.createScreens === 'function'),
    loadOptional<BattleModule>(loaders, './battle/index.ts', (m) => typeof m.createBattleRunner === 'function'),
    loadOptional<PvpModule>(loaders, './net/pvp-channel.ts', (m) => typeof m.challengePvp === 'function'),
    loadOptional<TradeModule>(loaders, './net/trade-flow.ts', (m) => typeof m.startTradeFlow === 'function'),
  ])
  const screens = screensMod ? screensMod.createScreens(ctx) : createFallbackScreens(ctx)
  ctxObj.screens = screens
  ctxObj.battle = battleMod ? battleMod.createBattleRunner(ctx) : createFallbackBattleRunner(ctx)
  const hooks: MultiplayerHooks = { startTradeFlow: tradeMod?.startTradeFlow, challengePvp: pvpMod?.challengePvp }
  const overworld: OverworldExt = createOverworld(ctx, {
    multiplayer: () => hooks,
    onLoadProgress: (p, name) => loader.map(p, name),
    ...(screensMod?.questHudText ? { questText: screensMod.questHudText } : {}),
  })
  ctxObj.overworld = overworld
  const onboarding = createOnboarding(ctx, overworld, uiRoot)
  if (!screensMod) console.warn('[game] screens module missing: using fallback screens')
  if (!battleMod) console.warn('[game] battle module missing: battles auto-resolve')

  // ---- settings -----------------------------------------------------------
  const applySettings = (s: Settings) => {
    renderer.applySettings(s)
    audio.setVolumes(s.bgmVolume, s.sfxVolume)
    applyDocumentSettings(s)
    input.setTouchControlsVisible(document.documentElement.dataset.touchControls === 'on')
    minimap.setVisible(inWorld && s.showMinimap)
    resize()
  }
  applySettings(save.settings)
  events.on('settings:changed', ({ settings }) => applySettings(settings))

  // ---- events & net wiring ------------------------------------------------
  events.on('toast', ({ text, kind }) => ui.toast(text, kind))
  events.on('net:status', ({ status }) => hud.setNetStatus(status, net.online))
  net.on('online', (m) => hud.setNetStatus(net.status, m.count))
  net.on('welcome', (m) => {
    hud.setNetStatus(net.status, m.online)
    if (m.motd) chat.addMessage({ name: '', channel: 'system', text: m.motd, at: Date.now() })
  })
  net.on('chat', (m) => {
    chat.addMessage({ name: m.name, channel: m.channel, text: m.text, at: m.at, self: m.from === net.selfId })
    events.emit('chat:message', { from: m.from, name: m.name, channel: m.channel, text: m.text, at: m.at })
  })
  net.on('system', (m) => chat.addMessage({ name: '', channel: 'system', text: m.text, at: Date.now() }))
  for (const [name, install] of [['pvp', pvpMod?.installPvpHandlers], ['trade', tradeMod?.installTradeHandlers]] as const) {
    try { install?.(ctx) } catch (err) { console.error(`[game] ${name} handlers failed to install`, err) }
  }

  for (const e of GAME.autosave.events) {
    events.on(e as keyof GameEvents, () => {
      if (inWorld && performance.now() - lastPersistAt > GAME.autosave.minIntervalSec * 1000) ctx.persist(`auto:${e}`)
    })
  }
  window.addEventListener('pagehide', () => ctx.persist('pagehide'))
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (GAME.autosave.onHidden) ctx.persist('hidden') }
    else lastFrame = performance.now()
  })

  const unlockAudio = () => {
    audio.unlock()
    for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) window.removeEventListener(ev, unlockAudio, true)
  }
  for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) window.addEventListener(ev, unlockAudio, true)

  // ---- main loop ----------------------------------------------------------
  const debugOverlay = createDebugOverlay(ctx, overworld, appRoot)
  let autosaveT = data.config.save.autosaveSeconds
  let modal = false
  const clockFrozen = () => dbg.dev && dbg.time !== null && GAME.debug.freezeClockWithTime

  async function runModal(fn: () => Promise<unknown>): Promise<void> {
    modal = true
    overworld.setControlEnabled(false)
    try { await fn() } catch (err) { console.error(err) } finally {
      overworld.setControlEnabled(true)
      modal = false
    }
  }

  const canFly = () => {
    const map = overworld.mapId ? getMap(world, overworld.mapId) : null
    return !!map && GAME.fly.mapKinds.includes(map.kind) && ctx.save.badges.length >= GAME.fly.minBadges
      && !!ownedKeyItem(ctx.save, GAME.fly.keyItemKind, data)
  }

  /** Flies to a story town, hamlet, landmark or dungeon mouth of the core or the frontier (place id). */
  async function flyTo(placeId: string): Promise<void> {
    const place = resolvePlace(world, placeId)
    const land = place ? flyLanding(world, place) : null
    if (!place || !land) { ui.toast(t('world.fly.blocked'), 'warn'); return }
    audio.playSfx(GAME.fly.sfx)
    await overworld.enterMap(land.map.id, land.x, land.y, 'down', true)
    ui.toast(t('world.fly.arrive', { name: ctx.save.name, town: place.nameZh }), 'info')
  }

  function globalKeys(): void {
    if (input.pressed('debug')) { input.consume('debug'); debugOverlay.toggle() }
    if (modal || !overworld.free) return
    if (input.pressed('menu')) { input.consume('menu'); onboarding.notifyMenuOpened(); void runModal(() => screens.pauseMenu()) }
    else if (input.pressed('map')) {
      input.consume('map')
      const fly = canFly()
      void runModal(async () => {
        const town = await screens.worldMap({ fly })
        if (town && fly) await flyTo(town)
      })
    } else if (input.pressed('minimap')) {
      input.consume('minimap')
      const mm = minimap as Minimap & { expanded?: boolean }
      minimap.setExpanded(!mm.expanded)
    } else if (input.pressed('quickSave')) {
      input.consume('quickSave')
      ctx.persist('quick')
      ui.toast(t('game.save.quick'), 'success')
    }
  }

  const html = document.documentElement
  /** A battle / evolution scene owns the canvas: ours (overworld flow) or one opened directly (PvP, field evolution). */
  const battleScreenUp = () => overworld.battleActive || html.classList.contains(BATTLE_SCREEN_CLASS)

  function frame(now: number): void {
    requestAnimationFrame(frame)
    const dt = Math.min(GAME.loop.maxDtSec, Math.max(0, (now - lastFrame) / 1000))
    lastFrame = now
    if (GAME.loop.pauseWhenHidden && document.hidden) { input.endFrame(); return }
    try {
      ui.update(dt)
      const blocking = ui.isBlocking()
      html.classList.toggle(UI_BLOCKING_CLASS, blocking)
      chat.update(dt, inWorld && !modal && !blocking)
      if (inWorld) {
        ctx.save.playTimeSec += dt
        if (!clockFrozen()) ctx.clock.update(dt)
        globalKeys()
        const battleUp = battleScreenUp()
        if (!battleUp) overworld.update(dt)
        onboarding.update(dt)
        autosaveT -= dt
        if (autosaveT <= 0) { autosaveT = data.config.save.autosaveSeconds; ctx.persist('auto') }
        if (!battleUp && worldView.map) renderer.render(worldView.renderView(), dt)
        debugOverlay.update(dt)
      }
    } catch (err) {
      console.error('[game] frame error', err)
    }
    input.endFrame()
  }
  requestAnimationFrame(frame)
  if (dbg.dev) (window as unknown as { __AP: GameContext }).__AP = ctx
  if (dbg.dev) (window as unknown as { __apOnboarding: typeof onboarding }).__apOnboarding = onboarding
  if (dbg.dev) installDebugHooks(ctx, overworld, world, { flyTo: (id) => runModal(() => flyTo(id)) })

  // ---- title flow ---------------------------------------------------------
  hud.setVisible(false)
  minimap.setVisible(false)
  chat.setVisible(false)
  loader.step('ready')
  loader.hide()

  const applyNewGameStart = (s: SaveData) => {
    const anchor = worldAnchors(world)[GAME.newGame.startAnchor]
    if (!anchor || !getMap(world, anchor.map)) return
    const place = { map: anchor.map, x: anchor.x, y: anchor.y, facing: GAME.newGame.facing }
    s.position = { ...place }
    if (GAME.newGame.respawnAtStart) s.respawn = { ...place }
  }

  const importSave = async (): Promise<SaveData | null> => {
    const viaScreens = (screens as Screens & { importSave?: () => Promise<SaveData | null> }).importSave
    if (viaScreens) return viaScreens()
    const code = await ui.prompt(t('game.fallback.title.import'), '', GAME.title.importCodeMaxLen)
    if (code === null) return null
    const s = saves.importCode(code)
    if (!s) ui.toast(t('game.title.importFailed'), 'error')
    return s
  }

  async function titleFlow(): Promise<{ save: SaveData; isNew: boolean }> {
    if (dbg.dev && dbg.skipTitle) {
      const existing = saves.load(dbg.slot)
      const s = existing ?? debugSave(saves, world, dbg)
      if (!existing) applyNewGameStart(s)
      return { save: s, isNew: false }
    }
    for (;;) {
      const hasSave = saves.hasSave(dbg.slot)
      const choice = await screens.title(hasSave)
      if (choice === 'continue') {
        const s = saves.load(dbg.slot)
        if (s) return { save: s, isNew: false }
      } else if (choice === 'new') {
        if (hasSave && !(await ui.confirm(t('game.title.overwrite')))) continue
        const r = await screens.newGame()
        if (!r) continue
        const s = saves.newGame(r)
        s.settings = { ...ctx.save.settings }
        applyNewGameStart(s)
        return { save: s, isNew: true }
      } else if (choice === 'import') {
        const s = await importSave()
        if (s) {
          // Settings are per device: an imported save keeps this device's current ones.
          s.settings = { ...ctx.save.settings }
          saves.write(s, dbg.slot)
          ui.toast(t('game.title.imported', { name: s.name }), 'success')
          return { save: s, isNew: false }
        }
      } else if (choice === 'settings') {
        await screens.settings()
      }
    }
  }

  const start = await titleFlow()
  ctx.save = start.save
  playing = start.save
  if (dbg.dev) applyDebugStart(ctx, world, dbg)
  applySettings(ctx.save.settings)
  audio.stopBgm(GAME.region.musicFadeMs)
  await ui.fade(true, GAME.warp.fadeMs)
  const pos = ctx.save.position
  const startMap = getMap(world, pos.map) ? pos : { ...world.maps[world.startMap].spawn, map: world.startMap }
  await overworld.enterMap(startMap.map, startMap.x, startMap.y, startMap.facing, false)
  inWorld = true
  hud.setVisible(true)
  onboarding.setVisible(true)
  minimap.setVisible(ctx.save.settings.showMinimap)
  chat.setVisible(true)
  hud.setMoney(ctx.save.money)
  hud.setNetStatus(net.status, net.online)
  ctx.persist(start.isNew ? 'newgame' : 'continue')
  net.connect()
  await ui.fade(false, GAME.warp.fadeMs)
  if (start.isNew) await overworld.playIntro()
  if (dbg.dev) await runDebugActions(ctx, overworld, world, dbg, screens)
}
