/// <reference types="vite/client" />
// Screens sandbox (dev only): a fake GameContext over the real CONTENT, world, core services and ui-kit, with a
// debug save. Every value shown comes from CONTENT / the generated world, so the sandbox carries no game data.
// URL params: ?screen=<name> opens a screen; &keys=<KeyboardEvent.code,...> replays keys after opening;
// &shot hides the dev bar; &fresh starts from an empty save; &touch forces the on-screen touch controls.
// Phone viewports: screens-frame.html?w=390&h=844&screen=... (same params, rendered in an iframe).
import type { Creature, GameMap, QuestDef, SaveData } from '../src/shared/types.ts'
import type {
  ActorOptions, BattleRunner, GameContext, GameData, HD2DRenderer, NetClient, OverworldController, WorldView,
} from '../src/client/contracts.ts'
import { CONTENT, t } from '../src/shared/content/index.ts'
import { Rng } from '../src/shared/rng.ts'
import { createCreature, evolve, maxHp, toView } from '../src/shared/creature.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { applyDocumentSettings, createAssetStore, createAudio, createClock, createEventBus, createInput, createSaveManager } from '../src/client/core/index.ts'
import { bakeMapImage, createChatUI, createHUD, createMinimap, createUIKit } from '../src/client/ui/index.ts'
import { createScreens, type ScreensHandle } from '../src/client/ui/screens/index.ts'
import { SCREENS } from '../src/client/ui/screens/config.ts'

const params = new URLSearchParams(location.search)
if (params.has('shot')) document.body.classList.add('shot')

const root = document.getElementById('game')!
const bg = document.getElementById('bg') as HTMLCanvasElement

const world = buildWorld()
const assets = createAssetStore()
await assets.init()
const input = createInput(root)
const audio = createAudio(assets)
const events = createEventBus<import('../src/client/contracts.ts').GameEvents>()
const saves = createSaveManager({ world, storage: null })
const ow: GameMap = world.maps[world.startMap]

// ---------------------------------------------------------------------------
// Debug save (generic picks over CONTENT; sandbox quests are synthesised from town data)
// ---------------------------------------------------------------------------

function debugSave(): SaveData {
  const avatar = CONTENT.characters.find((c) => c.playable) ?? CONTENT.characters[0]
  const s = saves.newGame({ name: avatar?.nameZh ?? '', avatar: avatar?.id ?? '' })
  if (params.has('fresh')) return s
  const rng = new Rng(7)
  const P = CONTENT.config.party
  const species = CONTENT.speciesList
  const mk = (i: number, level: number): Creature => createCreature(species[i % species.length].id, level, { rng, otName: s.name, otId: s.playerId, ballId: CONTENT.itemList.find((it) => it.effect.kind === 'ball')?.id, caughtMap: ow.id })
  s.party = Array.from({ length: Math.min(P.maxParty, Math.max(4, species.length)) }, (_, i) => mk(i, 5 + i * 7))
  if (s.party[1]) { s.party[1].hp = Math.floor(maxHp(s.party[1]) * 0.3); s.party[1].status = CONTENT.statuses[0]?.id ?? null }
  if (s.party[2]) s.party[2].shiny = true
  if (s.party[3]) s.party[3].hp = 0
  if (s.party[4]) s.party[4].nickname = CONTENT.species[s.party[4].speciesId]?.nameEn
  // Fill the first move list so learn-move has something to replace.
  const p0 = s.party[0]
  for (const m of CONTENT.moveList) {
    if (p0.moves.length >= P.maxMoves) break
    if (!p0.moves.some((x) => x.id === m.id)) p0.moves.push({ id: m.id, pp: Math.max(1, m.pp - 3), ppMax: m.pp })
  }
  s.boxes = Array.from({ length: P.boxCount }, () => [])
  for (let i = 0; i < 40; i++) s.boxes[i < 26 ? 0 : 1].push(mk(i + 3, 3 + (i % 30)))
  for (const tab of SCREENS.bag.tabs) {
    CONTENT.itemList.filter((it) => tab.categories.includes(it.category)).slice(0, 9).forEach((it, k) => { s.bag[it.id] = 1 + ((k * 7) % 12) })
  }
  s.dexSeen = species.slice(0, Math.max(1, species.length - 1)).map((x) => x.id)
  s.dexCaught = species.filter((_, i) => i % 2 === 0).map((x) => x.id)
  s.visitedTowns = world.towns.slice(0, 4).map((x) => x.id)
  s.badges = world.badges.slice(0, 3).map((b) => b.id)
  s.money = 123456
  s.playTimeSec = 3 * 3600 + 25 * 60
  if (!world.quests.length) {
    const quests: QuestDef[] = world.towns.slice(0, 5).map((tw, i) => ({
      id: `sandbox-${tw.id}`,
      nameZh: tw.nameZh,
      kind: i % 2 === 0 ? 'main' : 'side',
      stages: world.towns.slice(i, i + 3).map((x) => ({ text: x.description, hint: x.nameZh })),
      reward: { money: 1000 * (i + 1), items: Object.fromEntries(CONTENT.itemList.slice(i, i + 2).map((it) => [it.id, i + 1])) },
    }))
    world.quests.push(...quests)
  }
  world.quests.forEach((q, i) => { s.quests[q.id] = { stage: Math.min(q.stages.length - 1, i % 3), done: i === 3 } })
  s.trackedQuest = world.quests[0]?.id
  return s
}

// ---------------------------------------------------------------------------
// Fake context
// ---------------------------------------------------------------------------

const noop = () => undefined
const renderer = { applySettings: noop, resize: noop, render: noop, flash: noop, shake: noop, setTransition: noop } as unknown as HD2DRenderer
const worldView = {
  createActor: (_o: ActorOptions) => { throw new Error('sandbox') },
} as unknown as WorldView
const net = {
  status: 'online', selfId: 'sandbox', online: 42,
  connect: noop, disconnect: noop, send: noop, on: () => noop, remotePlayers: () => new Map(), reportPosition: noop, updateProfile: noop,
  leaderboard: async () => [],
} as unknown as NetClient

let save = debugSave()
if (params.has('touch')) save.settings.touchControls = 'on'
applyDocumentSettings(save.settings)
const ctxObj = {
  data: { ...CONTENT, world } as GameData,
  get save() { return save },
  set save(v: SaveData) { save = v },
  events,
  input,
  audio,
  assets,
  saves,
  clock: createClock(save),
  renderer,
  world: worldView,
  ui: null as unknown as ReturnType<typeof createUIKit>,
  hud: createHUD(root),
  minimap: createMinimap(root),
  chat: null as unknown as ReturnType<typeof createChatUI>,
  screens: null as unknown as ScreensHandle,
  battle: {
    run: async () => ({ result: 'win', moneyDelta: 0 }),
    evolve: async (i: number, to: string) => {
      const c = save.party[i]
      if (!c) return false
      const ok = await ctx.ui.confirm(t('screens.use.levelUp', { name: CONTENT.species[c.speciesId]?.nameZh ?? '', level: c.level }))
      if (ok) evolve(c, to)
      return ok
    },
  } as BattleRunner,
  net,
  overworld: {
    player: { x: ow.spawn.x, y: ow.spawn.y, elev: 0, facing: ow.spawn.facing, map: ow.id },
    enterMap: async () => undefined,
    update: noop,
    setControlEnabled: noop,
    runScript: async () => undefined,
    blackout: async () => undefined,
    refresh: noop,
  } as OverworldController,
  persist: (reason: string) => { saves.write(save); console.info('[sandbox] persist', reason) },
  species: (id: string) => CONTENT.species[id],
  creatureView: (c: Creature) => toView(c),
}
const ctx = ctxObj as unknown as GameContext & { screens: ScreensHandle }
const kit = createUIKit(root, input, audio, () => save.settings)
;(ctxObj as { ui: unknown }).ui = kit
;(ctxObj as { chat: unknown }).chat = createChatUI(root, input, noop)
kit.setPortraitResolver((id) => assets.portraitUrl(id))
ctx.hud.setMoney(save.money)
ctx.hud.setNetStatus('online', net.online)
ctx.minimap.setMap(ow, null)
for (const tw of world.towns.slice(0, 4)) ctx.minimap.reveal(tw.x, tw.y)
ctx.minimap.reveal(ow.spawn.x, ow.spawn.y)
const screens = createScreens(ctx)
ctxObj.screens = screens
events.on('settings:changed', ({ settings }) => audio.setVolumes(settings.bgmVolume, settings.sfxVolume))

// Backdrop: the baked overworld around the player, standing in for the 3D world.
const baked = bakeMapImage(ow)
function drawBackdrop(): void {
  const k = 4
  const w = Math.ceil(innerWidth / k), h = Math.ceil(innerHeight / k)
  if (bg.width !== w || bg.height !== h) { bg.width = w; bg.height = h }
  const g = bg.getContext('2d')!
  g.imageSmoothingEnabled = false
  const tile = 4
  g.drawImage(baked, ow.spawn.x - w / (2 * tile), ow.spawn.y - h / (2 * tile), w / tile, h / tile, 0, 0, w, h)
}
drawBackdrop()
addEventListener('resize', drawBackdrop)

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const newMove = CONTENT.moveList.find((m) => !save.party[0]?.moves.some((x) => x.id === m.id))?.id ?? ''
const starters = CONTENT.speciesList.filter((s) => s.starter)
const open: Record<string, () => Promise<unknown>> = {
  title: () => screens.title(true),
  newGame: () => screens.newGame(),
  starter: () => screens.starter((starters.length ? starters : CONTENT.speciesList).slice(0, 3)),
  pause: () => screens.pauseMenu(),
  party: () => screens.party('view'),
  select: () => screens.party('select', { filter: (c) => c.hp > 0 }),
  battleSwitch: () => screens.party('battleSwitch'),
  summary: () => screens.summary(save.party[0]),
  bag: () => screens.bag('field'),
  bagBattle: () => screens.bag('battle'),
  dex: () => screens.dex(),
  shop: () => screens.shop(CONTENT.itemList.filter((it) => it.buyable).slice(0, 24).map((it) => it.id)),
  box: () => screens.box(),
  map: () => screens.worldMap({ fly: false }),
  fly: () => screens.worldMap({ fly: true }),
  quests: () => screens.quests(),
  settings: () => screens.settings(),
  learn: () => screens.learnMove(save.party[0], newMove),
  badges: () => screens.badges(),
  importSave: () => screens.importSave(),
  online: () => screens.online(),
}
const run = async (name: string) => {
  const r = await open[name]()
  const shown = r === undefined ? '' : JSON.stringify(r)
  ctx.ui.toast(`${name} ${shown.slice(0, 80)}`, 'info')
}

const dev = document.getElementById('dev')!
for (const name of Object.keys(open)) {
  const b = document.createElement('button')
  b.textContent = name
  b.onclick = () => { audio.unlock(); void run(name) }
  dev.append(b)
}

let last = performance.now()
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  ctx.clock.update(dt)
  ctx.ui.update(dt)
  input.endFrame()
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

const start = params.get('screen')
if (start && open[start]) {
  void run(start)
  // Keys are held long enough for at least one game frame and spaced apart, so presses never merge into one
  // frame edge (headless virtual time runs animation frames sparsely). &wait / &hold / &gap are milliseconds.
  const keys = (params.get('keys') ?? '').split(',').filter(Boolean)
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  void (async () => {
    await sleep(Number(params.get('wait') ?? 600))
    for (const code of keys) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }))
      await sleep(Number(params.get('hold') ?? 250))
      window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }))
      await sleep(Number(params.get('gap') ?? 450))
    }
  })()
}
