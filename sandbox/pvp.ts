/// <reference types="vite/client" />
// Multiplayer sandbox (dev only): the real hub / trade window / PvP channel for one player, against a scripted
// bot connected through a second NetClient. Needs the game server behind the Vite /ws proxy.
// URL params: ?demo=hub|hub-board|hub-profile|trade|pvp|incoming-trade|incoming-pvp &shot (hide dev bar) &auto (auto-play battles)
import type { BattleEvent, BattleInit, BattleRequest, Creature, SaveData, World } from '../src/shared/types.ts'
import type {
  AssetStore, AudioManager, BattleChannel, BattleOutcome, GameContext, GameData, GameEvents, Screens, UIPanel,
} from '../src/client/contracts.ts'
import type { ClientMsg, PublicProfile } from '../src/shared/protocol.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { createCreature, toView } from '../src/shared/creature.ts'
import { Rng } from '../src/shared/rng.ts'
import { createEventBus } from '../src/client/core/events.ts'
import { createInput } from '../src/client/core/input.ts'
import { createAssetStore } from '../src/client/core/assets.ts'
import { createNetClient } from '../src/client/net/index.ts'
import { createUIKit, el, panel, button } from '../src/client/ui/index.ts'
import { challengePvp, installPvpHandlers } from '../src/client/net/pvp-channel.ts'
import { installTradeHandlers, startTradeFlow } from '../src/client/net/trade-flow.ts'
import { openOnline } from '../src/client/ui/screens/online.ts'

const params = new URLSearchParams(location.search)
if (params.has('shot')) document.body.classList.add('shot')
const auto = params.has('auto')
const logEl = document.getElementById('log')!
const lines: string[] = []
const log = (s: string) => { lines.push(s); if (lines.length > 14) lines.shift(); logEl.textContent = lines.join('\n') }

const silentAudio: AudioManager = {
  unlock: () => undefined, playBgm: () => undefined, stopBgm: () => undefined, currentBgm: null,
  playSfx: () => undefined, playCry: () => undefined, setVolumes: () => undefined, setMuffled: () => undefined,
}

// Real world when the generator is available (map names in the roster); otherwise names fall back to the unknown label.
const world: World = await import('../src/shared/world/index.ts')
  .then((m) => m.buildWorld())
  .catch(() => ({ seed: 0, maps: {}, trainers: {}, towns: [], quests: [], badges: [], startMap: '' }) as World)
const startMap = world.startMap || 'sandbox'
const spawn = world.maps[startMap]?.spawn ?? { x: 5, y: 5, facing: 'down' as const }

// ---------------------------------------------------------------------------
// Player save + services
// ---------------------------------------------------------------------------

const rng = new Rng(Date.now() >>> 0)
const species = CONTENT.speciesList
const mk = (i: number, level: number, ot: string): Creature => createCreature(species[i % species.length].id, level, { rng, otName: ot, shiny: i === 1 })
const playable = CONTENT.characters.filter((c) => c.playable)

function makeSave(name: string, avatar: string, partySize: number): SaveData {
  return {
    version: CONTENT.config.save.version, playerId: crypto.randomUUID(), name, avatar, createdAt: Date.now(), playTimeSec: 3 * 3600 + 25 * 60,
    money: 0, badges: [], party: Array.from({ length: partySize }, (_, i) => mk(i, 12 + i * 3, name)),
    boxes: Array.from({ length: CONTENT.config.party.boxCount }, () => []), bag: {}, dexSeen: species.slice(0, 3).map((s) => s.id),
    dexCaught: species.slice(0, 2).map((s) => s.id), position: { map: startMap, ...spawn }, respawn: { map: startMap, ...spawn },
    flags: {}, quests: {}, visitedTowns: [], exploredChunks: {}, repelSteps: 0, clockMinutes: 0,
    stats: { battlesWon: 0, caught: 2, steps: 0, pvpWins: 1, pvpLosses: 2, trades: 0, shiniesFound: 0 },
    settings: { ...CONTENT.config.defaultSettings },
  }
}

const profileOf = (s: SaveData): PublicProfile => ({
  id: '', name: s.name, avatar: s.avatar, badges: s.badges, dexCaught: s.dexCaught.length, party: s.party.map((c) => toView(c)),
  pvpWins: s.stats.pvpWins, pvpLosses: s.stats.pvpLosses, playTimeSec: s.playTimeSec,
})
const helloFor = (s: SaveData, x: number) => (): Extract<ClientMsg, { t: 'hello' }> => ({
  t: 'hello', v: CONTENT.config.net.protocolVersion, playerId: s.playerId, name: s.name, avatar: s.avatar, map: startMap, x, y: spawn.y,
  facing: 'down', lead: s.party[0] ? { speciesId: s.party[0].speciesId, shiny: s.party[0].shiny, level: s.party[0].level } : null, profile: profileOf(s),
})

const save = makeSave(params.get('name') ?? '小智', playable[0]?.id ?? '', 3)
const events = createEventBus<GameEvents>()
const root = document.getElementById('game')!
const input = createInput(root)
const assets: AssetStore = createAssetStore()
await assets.init()
const ui = createUIKit(root, input, silentAudio, () => save.settings)
const net = createNetClient(events, helloFor(save, spawn.x))
events.on('toast', (e) => ui.toast(e.text, e.kind))
events.on('net:status', (e) => log(`status: ${e.status}`))
net.on('error', (m) => log(`error: ${m.code}`))

// ---------------------------------------------------------------------------
// Minimal battle presenter driving any BattleChannel (log + action buttons)
// ---------------------------------------------------------------------------

function runBattle(init: BattleInit, channel: BattleChannel): Promise<BattleOutcome> {
  return new Promise((resolve) => {
    const win = panel(`${init.sides[0].name} vs ${init.sides[1].name} · ${init.biome}/${init.timeOfDay} · Lv≤${init.levelCap}`)
    const logBox = el('div', { style: { height: 'calc(var(--u) * 150)' } })
    logBox.style.overflow = 'auto'
    logBox.style.fontSize = '0.9em'
    const actions = el('div', 'ap-btn-row')
    win.body.append(logBox, actions)
    win.el.style.width = 'min(96vw, calc(var(--u) * 360))'
    const view: UIPanel = { el: el('div', 'ap-modal-center', [win.el]), onInput: () => true }
    ui.pushPanel(view)
    const party = init.sides[0].party
    let active = 0
    let result: BattleOutcome['result'] = 'draw'
    let autoTry = 0
    const show = (evs: BattleEvent[]) => {
      for (const e of evs) {
        if (e.t === 'switch' && e.side === 0) active = e.partyIndex
        if (e.t === 'damage' || e.t === 'heal') { const cr = e.side === 0 ? party[active] : null; if (cr) cr.hp = e.hp }
        if (e.t === 'end') result = e.result
        const text = e.t === 'msg' ? e.text : e.t === 'damage' ? `  [${e.side}] -${e.amount} (${e.hp}/${e.maxHp})` : null
        if (text) logBox.append(el('div', { text }))
      }
      logBox.scrollTop = logBox.scrollHeight
    }
    const step = async (r: { events: BattleEvent[]; request: BattleRequest }): Promise<void> => {
      show(r.events)
      actions.replaceChildren()
      if (r.request.kind === 'wait') {
        ui.popPanel(view)
        channel.dispose()
        resolve({ result, moneyDelta: 0 })
        return
      }
      const choices: { label: string; act: () => Promise<void> }[] = r.request.kind === 'switch'
        ? party.map((c, i) => ({ label: `${CONTENT.species[c.speciesId]?.nameZh ?? c.speciesId} ${c.hp}`, act: async () => step(await channel.submit({ kind: 'switch', partyIndex: i })) }))
        : (party[active]?.moves ?? []).map((m, i) => ({ label: CONTENT.moves[m.id]?.nameZh ?? m.id, act: async () => step(await channel.submit({ kind: 'move', moveIndex: i })) }))
      choices.push({ label: 'forfeit', act: async () => step(await channel.submit({ kind: 'forfeit' })) })
      for (const c of choices) actions.append(button(c.label, () => { actions.replaceChildren(el('span', { class: 'ap-dim', text: '…' })); void c.act() }))
      if (auto) {
        // A lone message back means the server refused the action (no PP, fainted target...): try the next choice.
        autoTry = r.events.length === 1 && r.events[0].t === 'msg' ? autoTry + 1 : 0
        const btns = [...actions.querySelectorAll('button')] as HTMLButtonElement[]
        const options = choices.length - 1
        const pick = r.request.kind === 'switch'
          ? Math.max(0, party.findIndex((c, i) => i !== active && c.hp > 0))
          : options > 0 ? autoTry % options : 0
        window.setTimeout(() => btns[pick]?.click(), 400)
      }
    }
    void channel.start().then(step)
  })
}

const partySelect: Screens['party'] = async (_mode, opts) => {
  const items = save.party.map((c) => ({
    label: `${CONTENT.species[c.speciesId]?.nameZh ?? c.speciesId}  Lv.${c.level}`, sub: `${c.hp}`, icon: assets.creatureImageUrl(c.speciesId),
    disabled: opts?.filter ? !opts.filter(c) : false,
  }))
  return ui.list(opts?.title ?? '', items)
}

const ctx = {
  data: { ...CONTENT, world } as GameData,
  save,
  events,
  input,
  audio: silentAudio,
  assets,
  saves: null as never,
  clock: null as never,
  renderer: null as never,
  world: null as never,
  ui,
  hud: null as never,
  minimap: null as never,
  chat: null as never,
  screens: { party: partySelect } as unknown as Screens,
  battle: {
    run: (init: BattleInit, o: { channel?: BattleChannel }) => {
      events.emit('battle:start', { kind: 'pvp' })
      return runBattle(init, o.channel!).then((r) => { events.emit('battle:end', { kind: 'pvp', result: r.result }); return r })
    },
    evolve: async () => true,
  },
  net,
  overworld: { refresh: () => undefined } as never,
  persist: (reason: string) => { log(`persist(${reason}) party=${save.party.map((c) => c.speciesId).join(',')} trades=${save.stats.trades} pvp=${save.stats.pvpWins}/${save.stats.pvpLosses}`); net.updateProfile(profileOf(save)) },
  species: (id: string) => CONTENT.species[id],
  creatureView: (c: Creature) => toView(c),
} as unknown as GameContext

installPvpHandlers(ctx)
installTradeHandlers(ctx)

// ---------------------------------------------------------------------------
// Bot opponent: second connection that accepts everything and plays automatically
// ---------------------------------------------------------------------------

const botSave = makeSave(params.get('bot') ?? '机器人小美', playable[1]?.id ?? playable[0]?.id ?? '', 2)
const botEvents = createEventBus<GameEvents>()
const bot = createNetClient(botEvents, helloFor(botSave, spawn.x + 1))
let botTrade: string | null = null
let botMoveTry = 0
bot.on('pvp.challenged', (m) => { log(`bot: challenged by ${m.name}`); window.setTimeout(() => bot.send({ t: 'pvp.respond', from: m.from, accept: true }), 900) })
bot.on('pvp.start', (m) => bot.send({ t: 'pvp.party', battleId: m.battleId, party: botSave.party }))
bot.on('pvp.events', (m) => {
  if (m.request.kind === 'wait') return
  const rejected = m.events.length === 1 && m.events[0].t === 'msg'
  botMoveTry = rejected ? botMoveTry + 1 : 0
  const action = m.request.kind === 'switch' ? { kind: 'switch' as const, partyIndex: botMoveTry } : { kind: 'move' as const, moveIndex: botMoveTry % 4 }
  window.setTimeout(() => bot.send({ t: 'pvp.action', battleId: m.battleId, action }), 700)
})
bot.on('trade.requested', (m) => { log(`bot: trade request from ${m.name}`); window.setTimeout(() => bot.send({ t: 'trade.respond', from: m.from, accept: true }), 900) })
bot.on('trade.start', (m) => {
  botTrade = m.tradeId
  window.setTimeout(() => bot.send({ t: 'trade.offer', tradeId: m.tradeId, creature: botSave.party[1] }), 1200)
})
bot.on('trade.offer', (m) => {
  if (m.side === 'other' && m.creature && botTrade) window.setTimeout(() => bot.send({ t: 'trade.confirm', tradeId: botTrade! }), 1500)
})
bot.on('trade.complete', (m) => { log(`bot: traded away ${m.given}`); botTrade = null })
bot.on('trade.cancelled', () => { botTrade = null })

net.connect()
bot.connect()
const online = () => new Promise<void>((r) => { const tick = () => (net.status === 'online' && bot.status === 'online' ? r() : setTimeout(tick, 50)); tick() })

// ---------------------------------------------------------------------------
// Dev bar + demos
// ---------------------------------------------------------------------------

const demos: Record<string, () => Promise<void>> = {
  hub: () => openOnline(ctx),
  'hub-board': async () => { const p = openOnline(ctx); window.setTimeout(() => (document.querySelectorAll('.mp-hub .ap-tab')[1] as HTMLElement)?.click(), 200); await p },
  'hub-profile': async () => { const p = openOnline(ctx); window.setTimeout(() => (document.querySelectorAll('.mp-hub .ap-tab')[2] as HTMLElement)?.click(), 200); await p },
  trade: () => startTradeFlow(ctx, bot.selfId!, botSave.name),
  pvp: () => challengePvp(ctx, bot.selfId!, botSave.name),
  'incoming-trade': async () => { bot.send({ t: 'trade.request', to: net.selfId! }) },
  'incoming-pvp': async () => { bot.send({ t: 'pvp.challenge', to: net.selfId! }) },
}
const dev = document.getElementById('dev')!
for (const [name, fn] of Object.entries(demos)) {
  const b = document.createElement('button')
  b.textContent = name
  b.addEventListener('click', () => { void fn() })
  dev.append(b)
}

let last = performance.now()
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  ui.update(dt)
  input.endFrame()
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

await online()
log(`online: me=${net.selfId?.slice(0, 8)} bot=${bot.selfId?.slice(0, 8)}`)
const requested = params.get('demo')
if (requested && demos[requested]) window.setTimeout(() => { void demos[requested]() }, Number(params.get('at') ?? 600))
