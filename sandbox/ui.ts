/// <reference types="vite/client" />
// UI kit sandbox (dev only): exercises every component of src/client/ui.
// Demo text is pulled from CONTENT tables so the sandbox itself carries no game data.
// URL params: ?demo=<name>&at=<ms>&shot (hide dev bar) &speed=<textSpeed>
import type { Dir, GameMap, PropPlacement, RegionDef, Settings, TerrainDef } from '../src/shared/types.ts'
import type { AssetStore, AudioManager, Input, InputAction, MinimapMarker, UIPanel } from '../src/client/contracts.ts'
import { CONTENT, t } from '../src/shared/content/index.ts'
import {
  bakeMapImage, createChatUI, createGridNav, createHUD, createMinimap, createUIKit, creatureIcon, el, expBar,
  formatNumber, hpBar, keyHint, nameTag, panel, rarityBadge, speechBubble, statRadar, statusChip, tabs, typeChip, UI_CONFIG,
} from '../src/client/ui/index.ts'

const params = new URLSearchParams(location.search)
if (params.has('shot')) document.body.classList.add('shot')

type Loader = Record<string, () => Promise<unknown>>
const optional = {
  input: import.meta.glob('../src/client/core/input.ts') as Loader,
  audio: import.meta.glob('../src/client/core/audio.ts') as Loader,
  world: import.meta.glob('../src/shared/world/index.ts') as Loader,
}
async function load<T>(g: Loader): Promise<T | null> {
  const f = Object.values(g)[0]
  if (!f) return null
  try { return (await f()) as T } catch (e) { console.warn('[sandbox] optional module failed', e); return null }
}

// ---------------------------------------------------------------------------
// Fallback fakes (used only when src/client/core is absent)
// ---------------------------------------------------------------------------

function fakeInput(): Input {
  const keys: Record<string, InputAction> = {
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    KeyZ: 'confirm', Space: 'confirm', Enter: 'confirm', KeyX: 'cancel', Backspace: 'cancel', Escape: 'menu', KeyT: 'chat', KeyM: 'map', KeyN: 'minimap',
  }
  const held = new Set<InputAction>(), edge = new Set<InputAction>(), up = new Set<InputAction>(), used = new Set<InputAction>()
  let text = false
  addEventListener('keydown', (e) => { const a = keys[e.code]; if (!a || text) return; if (!held.has(a) || e.repeat) edge.add(a); held.add(a) })
  addEventListener('keyup', (e) => { const a = keys[e.code]; if (!a) return; held.delete(a); up.add(a) })
  return {
    axis: () => ({ x: (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0), y: (held.has('down') ? 1 : 0) - (held.has('up') ? 1 : 0) }),
    held: (a) => !text && held.has(a),
    pressed: (a) => !text && edge.has(a) && !used.has(a),
    released: (a) => up.has(a),
    consume: (a) => { used.add(a) },
    endFrame: () => { edge.clear(); up.clear(); used.clear() },
    setTextInputActive: (v) => { text = v },
    lastDevice: 'keyboard',
    setTouchControlsVisible: () => undefined,
  }
}

const silentAudio: AudioManager = {
  unlock: () => undefined, playBgm: () => undefined, stopBgm: () => undefined, currentBgm: null,
  playSfx: () => undefined, playCry: () => undefined, setVolumes: () => undefined, setMuffled: () => undefined,
}

/** Minimal asset store: no files, so core audio uses its procedural synth. */
const noAssets = new Proxy({}, {
  get: (_t, k) => (k === 'manifest' ? { creatures: [], characters: [], portraits: [], textures: [], models: [], items: [], bgm: [], ui: [] } : () => null),
}) as AssetStore

// ---------------------------------------------------------------------------
// Demo map (property-driven picks over CONTENT; replaced by buildWorld() when available)
// ---------------------------------------------------------------------------

function noise2(x: number, y: number, seed: number): number {
  const h = (ix: number, iy: number) => {
    let n = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0
    n = Math.imul(n ^ (n >>> 13), 1274126177)
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295
  }
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy
  const s = (v: number) => v * v * (3 - 2 * v)
  const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1)
  return a + (b - a) * s(fx) + (c - a) * s(fy) + (a - b - c + d) * s(fx) * s(fy)
}
const fbm = (x: number, y: number, seed: number) => noise2(x, y, seed) * 0.6 + noise2(x * 2.1, y * 2.1, seed + 7) * 0.3 + noise2(x * 4.3, y * 4.3, seed + 13) * 0.1

function makeDemoMap(): GameMap {
  const W = 168, H = 136
  const T = CONTENT.terrain
  const first = (f: (t: TerrainDef) => boolean, fallback = 0) => T.find(f)?.id ?? fallback
  const plain = first((t) => t.walkable && !t.liquid && !t.encounter && !t.stairs && t.speed === 1)
  const tall = first((t) => t.tallGrass, plain)
  const deep = first((t) => t.swim, plain)
  const shore = first((t) => !!t.liquid && t.walkable, plain)
  const road = first((t) => t.walkable && !t.liquid && t.speed > 1, plain)
  const slow = first((t) => t.walkable && !t.liquid && !t.encounter && t.speed < 0.95 && t.speed > 0.89, plain)
  const flowers = T.filter((t) => t.walkable && !t.liquid && !t.encounter && t.speed === 1)[1]?.id ?? plain
  const terrain = new Uint8Array(W * H), elevation = new Uint8Array(W * H), region = new Uint8Array(W * H)
  const cx = W / 2, cy = H / 2
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    const n = fbm(x / 22, y / 22, 3)
    const town = Math.hypot((x - cx) / 1.3, y - cy) < 16
    let id = plain
    if (!town && n < 0.3) id = deep
    else if (!town && n < 0.34) id = shore
    else if (!town && n < 0.38) id = slow
    else if (!town && fbm(x / 9, y / 9, 11) > 0.62) id = tall
    else if (!town && fbm(x / 6, y / 6, 21) > 0.72) id = flowers
    if (Math.abs(y - cy) < 1.5 || Math.abs(x - cx) < 1.5) id = id === deep ? shore : road
    terrain[i] = id
    const e = fbm(x / 30, y / 30, 5)
    elevation[i] = !town && n >= 0.38 ? (e > 0.66 ? 2 : e > 0.55 ? 1 : 0) : 0
    region[i] = town ? 1 : x < cx ? 0 : 2
  }
  const props: PropPlacement[] = []
  const propList = Object.values(CONTENT.props)
  const trees = propList.filter((p) => !p.minimapIcon && p.footprint[0] === 1 && p.footprint[1] === 1 && p.height >= UI_CONFIG.minimap.bake.canopy.minHeight)
  for (let y = 2; y < H - 2; y += 2) for (let x = 2; x < W - 2; x += 2) {
    const i = y * W + x
    if (terrain[i] !== plain || region[i] === 1 || !trees.length) continue
    if (fbm(x / 7, y / 7, 41) > 0.6) props.push({ prop: trees[(x + y) % trees.length].key, x, y, rot: 0 })
  }
  const buildings = propList.filter((p) => p.minimapIcon && p.minimapIcon !== 'none')
  const seen = new Set<string>()
  let bx = Math.round(cx - 22)
  for (const b of buildings) {
    if (seen.has(b.minimapIcon!)) continue
    seen.add(b.minimapIcon!)
    const by = Math.round(cy - 4 - b.footprint[1])
    props.push({ prop: b.key, x: bx, y: by, rot: 0 })
    bx += b.footprint[0] + 2
  }
  const regions: RegionDef[] = [0, 1, 2].map((k) => {
    const b = CONTENT.biomes[k % CONTENT.biomes.length]
    return { id: `demo-${k}`, nameZh: b.nameZh, biome: b.id, music: '', encounters: [], encounterRate: 0, roamingDensity: 0, isTown: k === 1 }
  })
  return {
    id: 'demo', nameZh: regions[1].nameZh, kind: 'overworld', width: W, height: H, terrain, elevation, region, regions, props,
    warps: [], npcs: [], signs: [], items: [], lights: [], spawn: { x: Math.round(cx), y: Math.round(cy), facing: 'down' }, outdoor: true, music: '',
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const root = document.getElementById('game')!
const bg = document.getElementById('bg') as HTMLCanvasElement
const coreInput = await load<{ createInput(root: HTMLElement): Input }>(optional.input)
const coreAudio = await load<{ createAudio(assets: AssetStore): AudioManager }>(optional.audio)
const worldMod = await load<{ buildWorld(): { maps: Record<string, GameMap>; startMap: string } }>(optional.world)

const input = coreInput ? coreInput.createInput(root) : fakeInput()
const audio = coreAudio ? coreAudio.createAudio(noAssets) : silentAudio
addEventListener('pointerdown', () => audio.unlock(), { once: true })
addEventListener('keydown', () => audio.unlock(), { once: true })
const speed = params.get('speed') as Settings['textSpeed'] | null
const settings: Settings = { ...CONTENT.config.defaultSettings, ...(speed ? { textSpeed: speed } : {}) }

let map: GameMap
try { map = worldMod ? (() => { const w = worldMod.buildWorld(); return w.maps[w.startMap] })() : makeDemoMap() } catch (e) { console.warn(e); map = makeDemoMap() }

const ui = createUIKit(root, input, audio, () => settings)
const hud = createHUD(root)
const minimap = createMinimap(root)
const self = CONTENT.characters.find((c) => c.playable) ?? CONTENT.characters[0]
const others = CONTENT.characters.filter((c) => c !== self)
const chat = createChatUI(root, input, (channel, text, to) => {
  chat.addMessage({ name: self?.nameZh ?? '', channel, text, at: Date.now(), self: true })
  if (channel === 'whisper' && to) setTimeout(() => chat.addMessage({ name: to, channel: 'whisper', text: CONTENT.moveList[3]?.description ?? text, at: Date.now() }), 900)
})

// Portrait resolver: crop the first frame of a character sheet (stand-in for /assets/portraits).
const portraitCache = new Map<string, string>()
async function preparePortrait(id: string): Promise<void> {
  const img = new Image()
  img.src = `/assets/characters/${id}.png`
  try { await img.decode() } catch { return }
  const cell = CONTENT.config.sprites.sheetCell
  const cv = document.createElement('canvas')
  cv.width = cell; cv.height = cell
  cv.getContext('2d')!.drawImage(img, 0, 0, cell, cell, 0, 0, cell, cell)
  portraitCache.set(id, cv.toDataURL())
}
const portraitIds = CONTENT.characters.filter((c) => c.portrait || !c.playable).slice(0, 4).map((c) => c.id)
await Promise.all(portraitIds.map(preparePortrait))
ui.setPortraitResolver((id) => portraitCache.get(id) ?? null)

// HUD state
const regionAt = (x: number, y: number) => map.regions[map.region[Math.floor(y) * map.width + Math.floor(x)]]?.nameZh ?? ''
hud.setMoney(CONTENT.config.economy.startMoney)
hud.setNetStatus('online', 12)
hud.setQuest(CONTENT.itemList[1]?.description ?? null)
minimap.setMap(map, null)

// Player & markers
const player = { x: map.spawn.x, y: map.spawn.y, facing: map.spawn.facing as Dir }
const rnd = (k: number) => (Math.sin(k * 91.7) * 43758.5453) % 1
const markers: MinimapMarker[] = []
const kinds: MinimapMarker['kind'][] = ['npc', 'npc', 'trainer', 'item', 'wild', 'wild', 'rare', 'other', 'warp']
kinds.forEach((kind, i) => markers.push({ kind, x: player.x + Math.round(Math.abs(rnd(i + 1)) * 36 - 18), y: player.y + Math.round(Math.abs(rnd(i + 9)) * 30 - 15) }))
markers.push({ kind: 'quest', x: map.width - 6, y: 6 })
for (let i = 0; i < map.width; i += 8) for (let j = 0; j < map.height; j += 8) if (Math.hypot(i - player.x, j - player.y) < 40) minimap.reveal(i, j)

// Overlay name tags (positioned as world/ would)
const tagSelf = nameTag(self?.nameZh ?? '')
const bubble = speechBubble(CONTENT.typeById[CONTENT.types[0].id].nameZh)
hud.overlay.append(tagSelf)

// Backdrop: the baked map, zoomed, as a stand-in for the 3D world.
const baked = bakeMapImage(map)
function drawBackdrop(): void {
  const k = 4
  const w = Math.ceil(innerWidth / k), h = Math.ceil(innerHeight / k)
  if (bg.width !== w || bg.height !== h) { bg.width = w; bg.height = h }
  const ctx = bg.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  const tile = 4
  ctx.drawImage(baked, player.x - w / (2 * tile), player.y - h / (2 * tile), w / tile, h / tile, 0, 0, w, h)
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, 'rgba(10,16,40,0.55)'); g.addColorStop(0.45, 'rgba(10,16,40,0.05)'); g.addColorStop(1, 'rgba(5,8,20,0.5)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  tagSelf.style.left = `${innerWidth / 2}px`
  tagSelf.style.top = `${innerHeight / 2 - 30}px`
  bubble.style.left = `${innerWidth / 2 + 90}px`
  bubble.style.top = `${innerHeight / 2 - 50}px`
}

// ---------------------------------------------------------------------------
// Demos
// ---------------------------------------------------------------------------

const say = (i: number) => CONTENT.moveList[i % CONTENT.moveList.length]?.description ?? ''
const itemDesc = (i: number) => CONTENT.itemList[i % CONTENT.itemList.length]?.description ?? ''
const npc = (i: number) => others[i % others.length]

const sandboxCss = document.createElement('style')
sandboxCss.textContent = `
.sbx-row { display: flex; flex-wrap: wrap; align-items: center; gap: calc(var(--u) * 4); margin-bottom: calc(var(--u) * 6); }
.sbx-cols { display: flex; align-items: flex-start; gap: calc(var(--u) * 6); }
.sbx-col { display: flex; flex-direction: column; gap: calc(var(--u) * 5); }
.sbx-sel { outline: var(--u) solid #fff; outline-offset: var(--u); }
.sbx-screen { display: flex; align-items: center; justify-content: center; height: 100%; background: rgba(4, 6, 14, 0.5); }`
document.head.append(sandboxCss)

function widgetsPanel(): UIPanel {
  const sp = CONTENT.speciesList[0]
  const card = panel(sp?.nameZh ?? '', { className: 'ap-anim-in' })
  const hp = hpBar({ numbers: true, label: CONTENT.statByKey.hp?.nameZh })
  const exp = expBar({ width: 96 })
  const radar = statRadar(sp?.baseStats ?? { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, 100)
  const sheet = portraitCache.values().next().value
  const strip = tabs(CONTENT.stats.slice(0, 3).map((s) => s.nameZh), { audio })
  const chips = CONTENT.types.map((ty) => typeChip(ty.id))
  const nav = createGridNav({ count: chips.length, cols: 7, audio, onChange: (i, prev) => { chips[prev].classList.remove('sbx-sel'); chips[i].classList.add('sbx-sel') } })
  chips[0].classList.add('sbx-sel')
  card.body.append(
    el('div', 'sbx-cols', [
      el('div', 'sbx-col', [
        el('div', 'sbx-row', [creatureIcon(sheet ?? '', true, 48), el('div', 'sbx-col', [
          el('div', 'sbx-row', [rarityBadge(sp?.rarity ?? CONTENT.rarities[0].id), ...(sp?.types ?? []).map(typeChip)]),
          el('div', { class: 'ap-dim', text: t('common.level', { level: 24 }) }),
        ])]),
        hp.el,
        el('div', 'sbx-row', [el('span', { class: 'ap-gold', text: 'EXP' }), exp.el]),
        el('div', { text: `${t('common.money')} ${formatNumber(123456)}` }),
        strip.el,
      ]),
      radar.el,
    ]),
    el('div', 'sbx-row', CONTENT.rarities.map((r) => rarityBadge(r.id))),
    el('div', 'sbx-row', CONTENT.statuses.map((s) => statusChip(s.id))),
    el('div', 'sbx-row', chips),
    el('div', 'sbx-row', [keyHint('confirm', { label: t('ui.hint.confirm') }), keyHint('cancel', { label: t('ui.hint.cancel') }), keyHint('menu')]),
  )
  card.el.style.maxWidth = 'calc(var(--u) * 330)'
  hp.set(30, 30)
  exp.set(40, 100)
  setTimeout(() => hp.set(16, 30, true), 600)
  setTimeout(() => hp.set(4, 30, true), 2200)
  setTimeout(() => exp.set(90, 100, true), 900)
  const wrap = el('div', 'sbx-screen', [card.el])
  const p: UIPanel = {
    el: wrap,
    onInput(inp) {
      if (inp.pressed('cancel') || inp.pressed('menu')) { inp.consume('cancel'); inp.consume('menu'); ui.popPanel(p); return true }
      nav.handle(inp)
      return true
    },
  }
  return p
}

const demos: Record<string, () => unknown> = {
  dialogue: () => ui.say([
    { text: say(0), speaker: npc(0)?.nameZh, portrait: npc(0)?.id },
    { text: `${say(1)}\n${say(2)}`, speaker: npc(1)?.nameZh, portrait: 'no-such-portrait' },
    say(3),
  ]),
  choice: async () => {
    const opts = CONTENT.types.slice(0, 4).map((x) => x.nameZh)
    const i = await ui.choose({ text: say(4), speaker: npc(2)?.nameZh, portrait: npc(2)?.id }, opts, { cancelIndex: opts.length - 1 })
    ui.toast(opts[i] ?? String(i), 'success')
  },
  confirm: async () => ui.toast(String(await ui.confirm(say(5))), 'info'),
  prompt: async () => {
    const v = await ui.prompt(itemDesc(2), self?.nameZh ?? '', CONTENT.config.net.nameMaxLen)
    ui.toast(v ?? t('ui.prompt.cancel'), v ? 'success' : 'warn')
  },
  list: async () => {
    const items = CONTENT.itemList.slice(0, 24).map((it, i) => ({ label: it.nameZh, sub: `${formatNumber(it.price)}`, disabled: i % 7 === 3 }))
    const i = await ui.list(t('common.money'), items, {
      detail: (k) => el('div', {}, [
        el('div', { class: 'ap-gold', text: CONTENT.itemList[k].nameZh }),
        el('div', { text: CONTENT.itemList[k].description }),
      ]),
    })
    if (i >= 0) ui.toast(items[i].label, 'success')
  },
  toasts: () => {
    ui.toast(itemDesc(0), 'info')
    setTimeout(() => ui.toast(CONTENT.itemList[3]?.nameZh ?? '', 'success'), 200)
    setTimeout(() => ui.toast(CONTENT.itemList[5]?.nameZh ?? '', 'warn'), 400)
    setTimeout(() => ui.toast(t('ui.chat.tooFast'), 'error'), 600)
  },
  banner: () => hud.showBanner(regionAt(player.x, player.y) || map.nameZh, CONTENT.biomes[3]?.nameZh),
  fade: async () => { await ui.fade(true); await ui.fade(false) },
  widgets: () => ui.pushPanel(widgetsPanel()),
  map: () => minimap.setExpanded(!minimap.expanded),
  chat: () => {
    const now = Date.now()
    const chans = ['global', 'local', 'system', 'whisper'] as const
    for (let i = 0; i < 7; i++) chat.addMessage({ name: npc(i)?.nameZh ?? '', channel: chans[i % chans.length], text: say(10 + i), at: now - (7 - i) * 61000 })
    chat.focus()
  },
  bubble: () => { hud.overlay.append(bubble); setTimeout(() => bubble.remove(), 2500) },
  all: () => {
    const now = Date.now()
    const chans = ['global', 'local', 'system', 'global', 'whisper'] as const
    for (let i = 0; i < 5; i++) chat.addMessage({ name: npc(i + 3)?.nameZh ?? '', channel: chans[i], text: say(20 + i), at: now - (5 - i) * 47000 })
    hud.overlay.append(bubble)
    demos.banner()
    ui.toast(CONTENT.itemList[6]?.nameZh ?? '', 'success')
    void demos.dialogue()
  },
}

Object.assign(window, { __sbx: { ui, hud, minimap, chat, input } })

const dev = document.getElementById('dev')!
for (const name of Object.keys(demos)) {
  const b = document.createElement('button')
  b.textContent = name
  b.addEventListener('click', () => { void demos[name]() })
  dev.append(b)
}
for (const s of ['slow', 'normal', 'fast', 'instant'] as const) {
  const b = document.createElement('button')
  b.textContent = `speed:${s}`
  b.addEventListener('click', () => { settings.textSpeed = s })
  dev.append(b)
}

const requested = params.get('demo')
if (requested && demos[requested]) setTimeout(() => { void demos[requested]() }, Number(params.get('at') ?? 300))

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

let last = performance.now()
let clockMin = CONTENT.config.time.startMinutes
let autoWalk = 0
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  ui.update(dt)
  chat.update(dt, !ui.isBlocking())
  if (!ui.isBlocking() && !chat.isOpen) {
    if (input.pressed('map')) { input.consume('map'); minimap.setExpanded(!minimap.expanded) }
    if (input.pressed('menu')) { input.consume('menu'); ui.pushPanel(widgetsPanel()) }
    const a = input.axis()
    let vx = a.x, vy = a.y
    if (!vx && !vy) { autoWalk += dt; vx = Math.cos(autoWalk * 0.35) * 0.6; vy = Math.sin(autoWalk * 0.5) * 0.6 }
    player.x = Math.max(0, Math.min(map.width - 1, player.x + vx * dt * CONTENT.config.movement.walkSpeed))
    player.y = Math.max(0, Math.min(map.height - 1, player.y + vy * dt * CONTENT.config.movement.walkSpeed))
    if (Math.abs(vx) > Math.abs(vy)) player.facing = vx > 0 ? 'right' : 'left'
    else if (vy) player.facing = vy > 0 ? 'down' : 'up'
    minimap.reveal(player.x, player.y)
  }
  clockMin += dt * (1440 / CONTENT.config.time.dayRealSeconds) * 60
  const phase = CONTENT.config.time.phases.find((p) => { const m = clockMin % 1440; return p.from <= p.to ? m >= p.from && m < p.to : m >= p.from || m < p.to })
  const m = Math.floor(clockMin % 1440)
  hud.setClock(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, phase?.id ?? 'day')
  hud.setRegion(regionAt(player.x, player.y))
  minimap.update(player.x, player.y, player.facing, markers)
  drawBackdrop()
  input.endFrame()
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
