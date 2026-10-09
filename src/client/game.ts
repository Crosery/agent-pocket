// Integration: builds every client service into one GameContext, runs the main loop, title flow, settings,
// autosave, global keys and multiplayer wiring. Optional modules (battle client, screens, multiplayer flows)
// are discovered with import.meta.glob so the game still runs, with fallbacks, while they are missing.
import type { Creature, QuestDef, SaveData, Settings, World } from '../shared/types.ts'
import type { ClientMsg, PublicProfile } from '../shared/protocol.ts'
import type { AudioManager, BattleRunner, GameClock, GameContext, GameData, GameEvents, Minimap, Screens } from './contracts.ts'
import { CONTENT, t } from '../shared/content/index.ts'
import { toView } from '../shared/creature.ts'
import { buildWorld, buildWorldAsync, worldAnchors } from '../shared/world/index.ts'
import { getMap } from '../shared/world/worldapi.ts'
import {
  applyDocumentSettings, createAssetStore, createAudio, createClock, createEventBus, createInput, createSaveManager,
} from './core/index.ts'
import { RngHub, randomSeed } from './core/rng-hub.ts'
import { createRenderer, createWorldView } from './render/index.ts'
import { UI_CONFIG, createChatUI, createEscapeStack, createHUD, createMinimap, createUIKit, installEscapeFallback, releaseButtonFocusAfterClick } from './ui/index.ts'
import { createNetClient } from './net/index.ts'
import { createOnboarding } from './onboarding/index.ts'
import { createFallbackBattleRunner, createFallbackScreens, createOverworld, GAME, type MultiplayerHooks, type OverworldExt } from './world/index.ts'
import type { Onboarding } from './onboarding/index.ts'
import { ownedKeyItem } from './world/save-ops.ts'
import { flyLanding, resolvePlace } from './world/explore.ts'
import { createDebugOverlay } from './debug-overlay.ts'
import type { DevKit } from './dev/kit.ts'

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
    /** Progress of the world build while the overlay is up (it is built in the background behind the title). */
    world(p: number) { set(p, t('game.loading.steps.world')) },
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

/** Compile-time switch (vite.config.ts define): the dev server and `vite build --mode devtools` only. */
declare const __AP_DEVTOOLS__: boolean | undefined

/** Developer tooling for this page (?dev=1); null in the production build, which never contains src/client/dev. */
async function loadDevKit(): Promise<DevKit | null> {
  return (await import('./dev/index.ts')).createDevKit(location.search)
}

/** User Timing marks of the boot path (performance.getEntriesByType('mark') / scripts/qa-perf-boot.mjs). */
const mark = (name: string) => { try { performance.mark(`ap:${name}`) } catch { /* no User Timing */ } }

async function boot(loader: ReturnType<typeof createLoader>): Promise<void> {
  mark('boot')
  const dev = typeof __AP_DEVTOOLS__ !== 'undefined' && __AP_DEVTOOLS__ ? await loadDevKit() : null
  const slot = dev?.slot ?? 0
  const appRoot = document.getElementById('app') ?? document.body
  const canvas = document.getElementById('ap-canvas') as HTMLCanvasElement | null
  const uiRoot = document.getElementById('ap-ui') ?? appRoot
  if (!canvas) throw new Error('missing #ap-canvas')

  loader.step('content')
  const loaders = optionalModules()
  // The optional chunks start downloading now and overlap everything else the boot does; screens are needed for the title,
  // the battle, PvP and trade code only from the first fight / online play on.
  const loadScreens = loadOptional<ScreensModule>(loaders, './ui/screens/index.ts', (m) => typeof m.createScreens === 'function')
  const loadBattle = loadOptional<BattleModule>(loaders, './battle/index.ts', (m) => typeof m.createBattleRunner === 'function')
  const loadPvp = loadOptional<PvpModule>(loaders, './net/pvp-channel.ts', (m) => typeof m.challengePvp === 'function')
  const loadTrade = loadOptional<TradeModule>(loaders, './net/trade-flow.ts', (m) => typeof m.startTradeFlow === 'function')
  loader.step('assets')
  const assets = createAssetStore()
  await assets.init()
  mark('assets')

  // The world is generated after the title is up, in slices (buildWorldAsync): about 2 s of CPU on a desktop and several times
  // that on a phone. Whatever needs it waits on ensureWorld(). The developer tooling wipes and seeds slots right after the world
  // exists, so with it the world is built first.
  let world: World | null = null
  const data: GameData = { ...CONTENT, world: undefined as unknown as World }
  const needWorld = (): World => { if (!world) throw new Error('the world is not built yet'); return world }
  const adoptWorld = (w: World): World => {
    world = w
    data.world = w
    mark('world')
    dev?.afterWorld(w)
    return w
  }
  let worldTask: Promise<World> | null = null
  const startWorld = (): Promise<World> => {
    worldTask ??= buildWorldAsync(undefined, { sliceMs: GAME.loading.worldSliceMs, onProgress: (p) => loader.world(p) }).then(adoptWorld)
    worldTask.catch((err) => console.error('[game] world build failed', err))
    return worldTask
  }
  const ensureWorld = async (): Promise<World> => {
    if (world) return world
    const pending = startWorld()
    loader.step('world')
    try { return await pending } finally { loader.hide() }
  }
  if (dev) {
    loader.step('world')
    await new Promise((r) => setTimeout(r, 0))
    adoptWorld(buildWorld(dev.worldSeed ?? undefined))
  }
  const saves = createSaveManager({ world: () => world, ...(dev?.storage ? { storage: dev.storage } : {}) })
  const stored = saves.load(slot)
  let save: SaveData = stored ?? saves.newGame({ name: '', avatar: '' })
  /** Before the world starts only a save that already exists on disk may be written (settings changed on the title). */
  let titleSaveStored = !!stored
  let playing: SaveData | null = null

  const events = createEventBus<GameEvents>()
  const input = dev ? dev.wrapInput(createInput(appRoot)) : createInput(appRoot)
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
      build: { devtools: typeof __AP_DEVTOOLS__ !== 'undefined' && __AP_DEVTOOLS__ },
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
        if (titleSaveStored && !saves.write(ctx.save, slot)) ui.toast(t('game.save.failed'), 'error')
        return
      }
      if (ctx.save === playing) {
        overworld.storeExplored()
        const p = overworld.player
        ctx.save.position = { map: p.map, x: Math.floor(p.x), y: Math.floor(p.y), facing: p.facing }
      }
      if (!saves.write(ctx.save, slot)) ui.toast(t('game.save.failed'), 'error')
      lastPersistAt = performance.now()
      net.updateProfile(profile())
      events.emit('save:changed', { reason })
    },
    species: (id: string) => data.species[id],
    creatureView: (c: Creature) => toView(c, data),
  }
  const ctx = ctxObj as unknown as GameContext

  loader.step('modules')
  const screensMod = await loadScreens
  mark('modules')
  const screens = screensMod ? screensMod.createScreens(ctx) : createFallbackScreens(ctx)
  ctxObj.screens = screens
  if (!screensMod) console.warn('[game] screens module missing: using fallback screens')
  // The battle runner is built on the first fight (its chunk is usually in by then); BattleRunner is async-only, so a stand-in works.
  let battleRunner: Promise<BattleRunner> | null = null
  const battleOnDemand = (): Promise<BattleRunner> => (battleRunner ??= loadBattle.then((m) => {
    if (m) return m.createBattleRunner(ctx)
    console.warn('[game] battle module missing: battles auto-resolve')
    return createFallbackBattleRunner(ctx)
  }))
  ctxObj.battle = {
    run: async (init, opts) => (await battleOnDemand()).run(init, opts),
    evolve: async (partyIndex, to) => (await battleOnDemand()).evolve(partyIndex, to),
  }

  // What needs the generated world (built by buildWorldLayer once it exists).
  let overworld!: OverworldExt
  let onboarding!: Onboarding
  let debugOverlay!: ReturnType<typeof createDebugOverlay>
  let hooks: MultiplayerHooks = {}

  // ---- settings -----------------------------------------------------------
  const applySettings = (s: Settings) => {
    renderer.applySettings(s)
    audio.setVolumes(s.bgmVolume, s.sfxVolume)
    applyDocumentSettings(s)
    input.setTouchControlsVisible(document.documentElement.dataset.touchControls === 'on')
    input.refreshTouchLayout()
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
  let autosaveT = data.config.save.autosaveSeconds
  let modal = false
  const clockFrozen = () => !!dev?.clockFrozen()

  async function runModal(fn: () => Promise<unknown>): Promise<void> {
    modal = true
    overworld.setControlEnabled(false)
    try { await fn() } catch (err) { console.error(err) } finally {
      overworld.setControlEnabled(true)
      modal = false
    }
  }

  const canFly = () => {
    const map = overworld.mapId ? getMap(needWorld(), overworld.mapId) : null
    return !!map && GAME.fly.mapKinds.includes(map.kind) && ctx.save.badges.length >= GAME.fly.minBadges
      && !!ownedKeyItem(ctx.save, GAME.fly.keyItemKind, data)
  }

  /** Flies to a story town, hamlet, landmark or dungeon mouth of the core or the frontier (place id). */
  async function flyTo(placeId: string): Promise<void> {
    const place = resolvePlace(needWorld(), placeId)
    const land = place ? flyLanding(needWorld(), place) : null
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
    } else if (input.pressed('bag')) {
      input.consume('bag')
      void runModal(async () => { await screens.bag('field') })
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

  /** Set by tick() when it drew the overworld; frame() then reports the frame to the governor. */
  let worldRendered = false

  function frame(now: number): void {
    requestAnimationFrame(frame)
    worldRendered = false
    const real = Math.min(GAME.loop.maxDtSec, Math.max(0, (now - lastFrame) / 1000))
    lastFrame = now
    if (GAME.loop.pauseWhenHidden && document.hidden) { input.endFrame(); return }
    const dt = dev ? dev.frameDt(real) : real
    if (dt === null) { input.endFrame(); return }
    tick(dt)
    if (worldRendered) renderer.noteFrame(now)
  }

  /** One main-loop frame of dt seconds (the animation frame callback, and the developer's frame stepper). */
  function tick(dt: number): void {
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
        if (!battleUp && worldView.map) { renderer.render(worldView.renderView(), dt); worldRendered = true }
        debugOverlay.update(dt)
      }
    } catch (err) {
      console.error('[game] frame error', err)
    }
    input.endFrame()
  }
  requestAnimationFrame(frame)

  /** The overworld, onboarding, debug overlay, PvP / trade hooks and the developer tooling: everything that reads the world. */
  let layerBuilt = false
  async function buildWorldLayer(): Promise<void> {
    if (layerBuilt) return
    layerBuilt = true
    const [pvpMod, tradeMod] = await Promise.all([loadPvp, loadTrade])
    hooks = { startTradeFlow: tradeMod?.startTradeFlow, challengePvp: pvpMod?.challengePvp }
    overworld = createOverworld(ctx, {
      rng: new RngHub(dev?.rngSeed ?? randomSeed()),
      multiplayer: () => hooks,
      onLoadProgress: (p, name) => loader.map(p, name),
      ...(screensMod?.questHudText ? { questText: screensMod.questHudText } : {}),
    })
    ctxObj.overworld = overworld
    onboarding = createOnboarding(ctx, overworld, uiRoot)
    debugOverlay = createDebugOverlay(ctx, overworld, appRoot)
    for (const [name, install] of [['pvp', pvpMod?.installPvpHandlers], ['trade', tradeMod?.installTradeHandlers]] as const) {
      try { install?.(ctx) } catch (err) { console.error(`[game] ${name} handlers failed to install`, err) }
    }
    dev?.install({ ctx, overworld, world: needWorld(), onboarding, flyTo: (id) => runModal(() => flyTo(id)), tick })
  }
  if (dev) await buildWorldLayer()

  // ---- title flow ---------------------------------------------------------
  hud.setVisible(false)
  minimap.setVisible(false)
  chat.setVisible(false)
  loader.step('ready')
  loader.hide()
  mark('title')

  const applyNewGameStart = (s: SaveData) => {
    const anchor = worldAnchors(needWorld())[GAME.newGame.startAnchor]
    if (!anchor || !getMap(needWorld(), anchor.map)) return
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
    if (dev?.skipTitle) {
      const existing = saves.load(slot)
      const s = existing ?? dev.newSave(saves, needWorld())
      if (!existing) applyNewGameStart(s)
      return { save: s, isNew: false }
    }
    for (;;) {
      const hasSave = saves.hasSave(slot)
      const choice = await screens.title(hasSave)
      if (choice === 'continue') {
        await ensureWorld()
        const s = saves.load(slot)
        if (s) return { save: s, isNew: false }
      } else if (choice === 'new') {
        if (hasSave && !(await ui.confirm(t('game.title.overwrite')))) continue
        const r = await screens.newGame()
        if (!r) continue
        await ensureWorld()
        const s = saves.newGame(r)
        s.settings = { ...ctx.save.settings }
        applyNewGameStart(s)
        return { save: s, isNew: true }
      } else if (choice === 'import') {
        await ensureWorld()
        const s = await importSave()
        if (s) {
          // Settings are per device: an imported save keeps this device's current ones.
          s.settings = { ...ctx.save.settings }
          saves.write(s, slot)
          ui.toast(t('game.title.imported', { name: s.name }), 'success')
          return { save: s, isNew: false }
        }
      } else if (choice === 'settings') {
        await screens.settings()
      }
    }
  }

  if (!dev) void startWorld()
  const start = await titleFlow()
  await ensureWorld()
  await buildWorldLayer()
  const readyWorld = needWorld()
  ctx.save = start.save
  playing = start.save
  dev?.applyStart(ctx, readyWorld)
  applySettings(ctx.save.settings)
  audio.stopBgm(GAME.region.musicFadeMs)
  await ui.fade(true, GAME.warp.fadeMs)
  const pos = ctx.save.position
  const startMap = getMap(readyWorld, pos.map) ? pos : { ...readyWorld.maps[readyWorld.startMap].spawn, map: readyWorld.startMap }
  await overworld.enterMap(startMap.map, startMap.x, startMap.y, startMap.facing, false)
  inWorld = true
  mark('world-entered')
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
  await dev?.runActions(ctx, overworld, readyWorld, screens)
}
