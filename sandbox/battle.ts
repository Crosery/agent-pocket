/// <reference types="vite/client" />
// Battle client sandbox (dev only): the real renderer, battle stage, ui-kit, screens and battle runner over a fake
// GameContext with a seeded random party. Every creature, trainer, item and biome comes from CONTENT / the generated
// world — the sandbox holds no game data.
// URL params: start=wild|trainer|legend|evolve|pvp (auto-start) · lag=<ms> (pvp: simulated server latency) · seed=<n> · plv=<party level> · flv=<foe level>
//             foehp=<0..1 foe hp fraction> · nearlevel=1 (party one exp short of a level) · psize=<party size> · shiny=1 (wild) · biome=<id> · tod=<dawn|day|dusk|night>
//             w=<weather id> · keys=<KeyboardEvent.code,...> replayed after `delay` ms with `gap` ms between keys · shot
// Keyboard: arrows/WASD move, Z/Space/Enter confirm, X/Backspace cancel — a full battle is playable keyboard-only.
import type { BattleInit, Creature, GameMap, SaveData, TimeOfDay, TrainerDef, World } from '../src/shared/types.ts'
import type { BattleChannel, GameContext, GameData, GameEvents, NetClient, OverworldController } from '../src/client/contracts.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { Rng } from '../src/shared/rng.ts'
import { createCreature, evolutionTarget, expForLevel, maxHp, toView } from '../src/shared/creature.ts'
import { createAssetStore, createAudio, createClock, createEventBus, createInput, createSaveManager } from '../src/client/core/index.ts'
import { createRenderer } from '../src/client/render/index.ts'
import { createChatUI, createHUD, createMinimap, createUIKit } from '../src/client/ui/index.ts'
import { createScreens } from '../src/client/ui/screens/index.ts'
import { BattleEngine } from '../src/shared/battle/engine.ts'
import { createBattleRunner, createLocalChannel, validateBattleUi } from '../src/client/battle/index.ts'

const params = new URLSearchParams(location.search)
if (params.has('shot')) document.body.classList.add('shot')
const errorsEl = document.getElementById('errors')!
const logEl = document.getElementById('log')!
const lines: string[] = []
const log = (s: string) => { lines.push(s); if (lines.length > 12) lines.shift(); logEl.textContent = lines.join('\n') }
window.addEventListener('error', (e) => { errorsEl.textContent += `error: ${e.message}\n` })
window.addEventListener('unhandledrejection', (e) => { errorsEl.textContent += `rejection: ${String(e.reason?.stack ?? e.reason)}\n` })
for (const e of validateBattleUi(CONTENT)) errorsEl.textContent += `${e}\n`

const num = (k: string, d: number) => { const v = Number(params.get(k)); return params.has(k) && Number.isFinite(v) ? v : d }
const seed = num('seed', Date.now() % 100000)
const rng = new Rng(seed)
const P = CONTENT.config.party

const app = document.getElementById('app')!
const canvas = document.getElementById('ap-canvas') as HTMLCanvasElement
const uiRoot = document.getElementById('ap-ui')!

// The world generator is optional here: when it fails (module being edited) battles still run on CONTENT alone.
const world: World = await import('../src/shared/world/index.ts').then((m) => m.buildWorld()).catch((err: unknown) => {
  errorsEl.textContent += `buildWorld failed (sandbox continues without the world): ${String(err)}\n`
  return { seed: 0, maps: {}, trainers: {}, towns: [], quests: [], badges: [], startMap: '' }
})
const regionAt = (map: GameMap, x: number, y: number) => map.region[Math.min(map.height - 1, Math.max(0, y)) * map.width + Math.min(map.width - 1, Math.max(0, x))] ?? 0
const assets = createAssetStore()
await assets.init()
const input = createInput(app)
const audio = createAudio(assets)
const events = createEventBus<GameEvents>()
const saves = createSaveManager({ world, storage: null })

// ---------------------------------------------------------------------------
// Save: seeded random party + one of every battle-usable item category
// ---------------------------------------------------------------------------

const balls = CONTENT.itemList.filter((it) => it.effect.kind === 'ball')
const pickSpecies = () => CONTENT.speciesList[rng.int(0, CONTENT.speciesList.length - 1)]
const mkCreature = (speciesId: string, level: number, save: SaveData): Creature => createCreature(speciesId, level, {
  rng, otName: save.name, otId: save.playerId, ballId: balls.length ? rng.pick(balls).id : undefined, caughtMap: world.startMap,
})

function makeSave(): SaveData {
  const avatar = CONTENT.characters.find((c) => c.playable) ?? CONTENT.characters[0]
  const s = saves.newGame({ name: avatar?.nameZh ?? '', avatar: avatar?.id ?? '' })
  const size = Math.max(1, Math.min(P.maxParty, num('psize', 4)))
  s.party = Array.from({ length: size }, () => mkCreature(pickSpecies().id, num('plv', 18), s))
  // nearlevel=1: every member one exp point short of its next level (level-up demo).
  if (params.get('nearlevel') === '1') for (const c of s.party) c.exp = expForLevel(CONTENT.species[c.speciesId].growth, c.level + 1) - 1
  for (const it of CONTENT.itemList) if (it.usableInBattle) s.bag[it.id] = 5
  s.dexSeen = []
  s.dexCaught = s.party.map((c) => c.speciesId)
  s.money = 5000
  return s
}

// ---------------------------------------------------------------------------
// Fake context
// ---------------------------------------------------------------------------

const settings = { ...CONTENT.config.defaultSettings }
const renderer = createRenderer(canvas, settings)
const resize = () => renderer.resize(innerWidth, innerHeight)
addEventListener('resize', resize)
resize()

const ow: GameMap | undefined = world.maps[world.startMap]
const biomeParam = params.get('biome')
const spot = (() => {
  if (!ow) return { x: 0, y: 0 }
  if (!biomeParam) return ow.spawn
  for (let y = 0; y < ow.height; y += 4) for (let x = 0; x < ow.width; x += 4) {
    if (ow.regions[regionAt(ow, x, y)]?.biome === biomeParam) return { x, y }
  }
  return ow.spawn
})()

const noop = () => undefined
const net = {
  status: 'offline', selfId: null, online: 0, connect: noop, disconnect: noop, send: noop, on: () => noop,
  remotePlayers: () => new Map(), reportPosition: noop, updateProfile: noop, leaderboard: async () => [],
} as unknown as NetClient

let save = makeSave()
const ui = createUIKit(uiRoot, input, audio, () => save.settings)
ui.setPortraitResolver((id) => assets.portraitUrl(id))
const overworld = {
  player: { x: spot.x, y: spot.y, elev: 0, facing: 'down', map: ow?.id ?? '' },
  enterMap: async () => undefined, update: noop, setControlEnabled: noop, runScript: async () => undefined,
  blackout: async () => undefined, refresh: noop,
} as unknown as OverworldController
const ctxObj = {
  data: { ...CONTENT, world } as GameData,
  get save() { return save },
  set save(v: SaveData) { save = v },
  events, input, audio, assets, saves,
  clock: createClock(save),
  renderer,
  world: null,
  ui,
  hud: createHUD(uiRoot),
  minimap: createMinimap(uiRoot),
  chat: createChatUI(uiRoot, input, noop),
  screens: null,
  battle: null,
  net,
  overworld,
  persist: (reason: string) => log(`persist ${reason}`),
  species: (id: string) => CONTENT.species[id],
  creatureView: (c: Creature) => toView(c),
}
const ctx = ctxObj as unknown as GameContext
;(ctxObj as { screens: unknown }).screens = createScreens(ctx)
const runner = createBattleRunner(ctx)
;(ctxObj as { battle: unknown }).battle = runner
ctx.hud.setVisible(true)
ctx.hud.setMoney(save.money)
if (ow) ctx.minimap.setMap(ow, null)
ctx.minimap.setVisible(true)
ctx.chat.setVisible(true)
for (const k of ['dex:seen', 'dex:caught', 'money:changed', 'bag:changed', 'battle:start', 'battle:end'] as const) {
  events.on(k, (p) => log(`${k} ${JSON.stringify(p)}`))
}
events.on('toast', ({ text, kind }) => ui.toast(text, kind))

// ---------------------------------------------------------------------------
// Battles
// ---------------------------------------------------------------------------

const tods = CONTENT.config.time.phases.map((p) => p.id)
const arena = (): Pick<BattleInit, 'biome' | 'timeOfDay' | 'weather'> => {
  const biome = biomeParam && CONTENT.biomeById[biomeParam] ? biomeParam : rng.pick(CONTENT.biomes).id
  const todParam = params.get('tod') as TimeOfDay | null
  const timeOfDay = todParam && tods.includes(todParam) ? todParam : rng.pick(tods)
  const w = params.get('w')
  return { biome, timeOfDay, ...(w && CONTENT.weatherById[w] ? { weather: w } : {}) }
}

function damageFoe(cr: Creature): Creature {
  if (params.has('foehp')) cr.hp = Math.max(1, Math.floor(maxHp(cr) * Math.min(1, Math.max(0, num('foehp', 1)))))
  return cr
}

/** Without a world: a trainer made of a non-playable character sheet and random species. */
function syntheticTrainer(): TrainerDef {
  const npc = CONTENT.characters.filter((c) => !c.playable)
  const ch = npc.length ? rng.pick(npc) : CONTENT.characters[0]
  return {
    id: `sandbox-${ch?.id ?? ''}`, nameZh: ch?.nameZh ?? '', classZh: '', sprite: ch?.id ?? '', reward: num('flv', 16) * 100,
    party: Array.from({ length: 3 }, () => ({ species: pickSpecies().id, level: num('flv', 16) })),
    introText: [], defeatText: [], aiLevel: 2,
  }
}

let busy = false
async function play(kind: 'wild' | 'trainer' | 'legend'): Promise<void> {
  if (busy) return
  busy = true
  try {
    for (const c of save.party) if (c.hp <= 0) c.hp = maxHp(c)
    let init: BattleInit
    let trainer: TrainerDef | undefined
    if (kind === 'trainer') {
      const list = Object.values(world.trainers).filter((tr) => tr.party.some((e) => e.species && CONTENT.species[e.species]))
      trainer = list.length ? list[rng.int(0, list.length - 1)] : syntheticTrainer()
      const party = (trainer?.party ?? [{ species: pickSpecies().id, level: num('flv', 16) }])
        .filter((e) => e.species && CONTENT.species[e.species])
        .map((e) => damageFoe(createCreature(e.species!, params.has('flv') ? num('flv', e.level) : e.level, { rng, otName: trainer?.nameZh ?? '', otId: trainer?.id ?? '' })))
      init = {
        seed: rng.int(1, 0x7fffffff),
        sides: [
          { kind: 'player', name: save.name, party: save.party, sprite: save.avatar },
          { kind: 'trainer', name: trainer?.nameZh ?? '', party, ...(trainer?.classZh ? { trainerClass: trainer.classZh } : {}), sprite: trainer?.sprite, aiLevel: trainer?.aiLevel ?? 1, ...(trainer?.items ? { items: { ...trainer.items } } : {}) },
        ],
        isWild: false, canRun: false, canCatch: false, expGain: true, rewardMoney: trainer?.reward ?? 0, ...arena(),
      }
    } else {
      const pool = kind === 'legend'
        ? CONTENT.speciesList.filter((s) => (CONTENT.rarityById[s.rarity]?.order ?? 0) >= CONTENT.rarities.length - 2)
        : CONTENT.speciesList
      const sp = (pool.length ? pool : CONTENT.speciesList)[rng.int(0, (pool.length || CONTENT.speciesList.length) - 1)]
      const cr = damageFoe(createCreature(sp.id, num('flv', 14), { rng, shiny: params.get('shiny') === '1', caughtMap: ow?.id ?? '' }))
      init = {
        seed: rng.int(1, 0x7fffffff),
        sides: [{ kind: 'player', name: save.name, party: save.party, sprite: save.avatar }, { kind: 'wild', name: sp.nameZh, party: [cr] }],
        isWild: true, canRun: true, canCatch: true, expGain: true, ...arena(),
      }
    }
    const out = await runner.run(init, { kind, ...(trainer ? { trainer } : {}) })
    log(`outcome ${out.result} money ${out.moneyDelta}${out.caught ? ` caught ${out.caught.speciesId}` : ''} party ${save.party.length}`)
    ctx.hud.setMoney(save.money)
  } catch (err) {
    errorsEl.textContent += `battle failed: ${String((err as Error)?.stack ?? err)}\n`
  } finally {
    busy = false
  }
}

/**
 * PvP through the remote-channel path: the runner gets kind 'pvp' + a BattleChannel and a cloned party (as
 * net/pvp-channel.ts does). The "server" is a local engine over its own copies with an AI opponent, behind a delay.
 */
async function playPvp(): Promise<void> {
  if (busy) return
  busy = true
  try {
    const before = JSON.stringify({ party: save.party, bag: save.bag, money: save.money })
    const mine = save.party.slice(0, P.maxParty).map((c) => ({ ...structuredClone(c), hp: maxHp(c), status: null }))
    const npc = CONTENT.characters.filter((c) => !c.playable)
    const ch = npc.length ? rng.pick(npc) : CONTENT.characters[0]
    const foes = Array.from({ length: Math.max(1, Math.min(P.maxParty, num('psize', 3))) }, () => createCreature(pickSpecies().id, num('flv', 16), { rng }))
    const base: BattleInit = {
      seed: rng.int(1, 0x7fffffff),
      sides: [
        { kind: 'player', name: save.name, party: mine, sprite: save.avatar },
        { kind: 'remote', name: ch?.nameZh ?? '', party: foes, sprite: ch?.id },
      ],
      isWild: false, canRun: false, canCatch: false, expGain: false, ...arena(),
    }
    const server = new BattleEngine({
      ...base,
      sides: [{ ...base.sides[0], party: structuredClone(mine) }, { ...base.sides[1], kind: 'trainer', aiLevel: 2, party: structuredClone(foes) }],
    })
    const inner = createLocalChannel(server)
    const lag = () => new Promise<void>((r) => setTimeout(r, num('lag', 500)))
    const channel: BattleChannel = {
      start: async () => { await lag(); return inner.start() },
      submit: async (a) => { await lag(); return inner.submit(a) },
      dispose: () => inner.dispose(),
    }
    const out = await runner.run(base, { kind: 'pvp', channel })
    channel.dispose()
    const after = JSON.stringify({ party: save.party, bag: save.bag, money: save.money })
    log(`pvp outcome ${out.result} money ${out.moneyDelta} save ${before === after ? 'untouched' : 'CHANGED'}`)
  } catch (err) {
    errorsEl.textContent += `pvp failed: ${String((err as Error)?.stack ?? err)}\n`
  } finally {
    busy = false
  }
}

async function evolveDemo(): Promise<void> {
  if (busy) return
  busy = true
  try {
    let i = save.party.findIndex((c) => CONTENT.species[c.speciesId]?.evolvesTo)
    if (i < 0) {
      const sp = CONTENT.speciesList.find((s) => s.evolvesTo)
      if (!sp) return
      save.party[0] = mkCreature(sp.id, num('plv', 18), save)
      i = 0
    }
    const c = save.party[i]
    const evo = CONTENT.species[c.speciesId].evolvesTo!
    if (c.level < evo.level) { c.level = evo.level; c.exp = expForLevel(CONTENT.species[c.speciesId].growth, c.level) }
    const to = evolutionTarget(c) ?? evo.id
    const ok = await runner.evolve(i, to)
    log(`evolve ${ok} -> ${save.party[i].speciesId}`)
  } finally {
    busy = false
  }
}

const dev = document.getElementById('dev')!
const actions: Record<string, () => Promise<void> | void> = {
  wild: () => play('wild'),
  trainer: () => play('trainer'),
  legend: () => play('legend'),
  pvp: () => playPvp(),
  evolve: () => evolveDemo(),
  newParty: () => { save = makeSave(); log('new party') },
}
for (const [name, fn] of Object.entries(actions)) {
  const b = document.createElement('button')
  b.textContent = name
  b.onclick = () => { audio.unlock(); b.blur(); void fn() }
  dev.append(b)
}

let last = performance.now()
function frame(now: number): void {
  requestAnimationFrame(frame)
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  ctx.clock.update(dt)
  ui.update(dt)
  input.endFrame()
}
requestAnimationFrame(frame)
;(window as unknown as { __ap: unknown }).__ap = { ctx, runner, play, playPvp, evolveDemo }

const start = params.get('start')
if (start && actions[start]) void actions[start]()
const keys = (params.get('keys') ?? '').split(',').filter(Boolean)
const gap = num('gap', 350)
keys.forEach((code, i) => {
  setTimeout(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }))
    setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true })), 60)
  }, num('delay', 3000) + i * gap)
})
