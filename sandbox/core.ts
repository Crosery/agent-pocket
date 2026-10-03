// Visual sandbox for src/client/core: placeholder art, audio and input. Dev-only.
import { CONTENT } from '../src/shared/content/index.ts'
import type { Content } from '../src/shared/content/index.ts'
import type { InputAction } from '../src/client/contracts.ts'
import { createAssetStore } from '../src/client/core/assets.ts'
import { createAudio } from '../src/client/core/audio.ts'
import { createInput } from '../src/client/core/input.ts'
import { boundActions } from '../src/client/core/input-config.ts'
import { createPlaceholders, TUFT_SUFFIX } from '../src/client/core/placeholders.ts'
import { applyDocumentSettings } from '../src/client/core/settings.ts'
import { PH } from '../src/client/core/placeholders-data.ts'
import { MIX, SFX } from '../src/client/core/audio-data.ts'
import { getSong } from '../src/client/core/audio-sequencer.ts'
import { createSongPlayer } from '../src/client/core/audio-song.ts'
import { createSynth } from '../src/client/core/audio-synth.ts'
import { cryRecipe } from '../src/client/core/audio-cry.ts'

/** Offline render of every song / SFX / cry: reports peak & RMS so silence or clipping is caught headlessly. */
async function audioTest(): Promise<void> {
  const rate = 22050
  const measure = (buf: AudioBuffer) => {
    let peak = 0, sum = 0
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch)
      for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; sum += d[i] * d[i] }
    }
    return { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / (buf.length * buf.numberOfChannels)).toFixed(4) }
  }
  const rows: string[] = []
  for (const b of CONTENT.audio.bgm) {
    const song = getSong(b.id)!
    const dur = Math.min(10, song.barSec * song.length)
    const ctx = new OfflineAudioContext(2, Math.ceil(rate * dur), rate)
    const out = ctx.createGain()
    out.gain.value = MIX.bgmBus
    out.connect(ctx.destination)
    createSongPlayer(createSynth(ctx, MIX), song, out, 0).scheduleUntil(dur)
    const m = measure(await ctx.startRendering())
    rows.push(`bgm ${b.id} peak=${m.peak} rms=${m.rms}${m.rms < 0.01 ? ' SILENT?' : ''}${m.peak > 1 ? ' CLIP' : ''}`)
  }
  const recipes: [string, import('../src/client/core/audio-data.ts').SfxDef][] = [
    ...CONTENT.audio.sfx.map((id) => [`sfx ${id}`, SFX.sfx[id]] as [string, import('../src/client/core/audio-data.ts').SfxDef]),
    ...CONTENT.speciesList.slice(0, 6).map((s) => [`cry ${s.id}`, cryRecipe(s.id)] as [string, import('../src/client/core/audio-data.ts').SfxDef]),
  ]
  for (const [name, def] of recipes) {
    const ctx = new OfflineAudioContext(1, Math.ceil(rate * 2.5), rate)
    const end = createSynth(ctx, MIX).playRecipe(def, 0.01, ctx.destination)
    const m = measure(await ctx.startRendering())
    rows.push(`${name} len=${end.toFixed(2)}s peak=${m.peak} rms=${m.rms}${m.peak < 0.02 ? ' SILENT?' : ''}${m.peak > 1 ? ' CLIP' : ''}`)
  }
  const pre = document.createElement('pre')
  pre.id = 'audiotest'
  pre.textContent = rows.join('\n')
  app.appendChild(pre)
}

const app = document.getElementById('app')!
const params = new URLSearchParams(location.search)
const zoom = Number(params.get('zoom') ?? 1)

/** Preview-only content: the real roster plus one synthetic species per type / stage / rarity. */
function previewContent(): Content {
  const species = { ...CONTENT.species }
  const list = [...CONTENT.speciesList]
  const base = CONTENT.speciesList[0]
  if (base && params.get('variety') !== '0') {
    CONTENT.types.forEach((ty, i) => {
      const second = CONTENT.types[(i + 5) % CONTENT.types.length].id
      for (let stage = 1; stage <= 3; stage++) {
        const id = `preview-${ty.id}-${stage}`
        const rarity = CONTENT.rarities[Math.min(CONTENT.rarities.length - 1, stage + (i % 3))].id
        const s = { ...base, id, nameZh: `${ty.nameZh}·${stage}`, stage, rarity, types: stage === 2 ? [ty.id, second] : [ty.id], dexNo: 10000 + i * 3 + stage }
        species[id] = s
        list.push(s)
      }
    })
  }
  return { ...CONTENT, species, speciesList: list }
}

function section(title: string): HTMLElement {
  const h = document.createElement('h2')
  h.textContent = title
  const row = document.createElement('div')
  row.className = 'row'
  app.append(h, row)
  return row
}

function card(row: HTMLElement, el: HTMLElement, label: string): HTMLElement {
  const c = document.createElement('div')
  c.className = 'card'
  const s = document.createElement('small')
  s.textContent = label
  c.append(el, s)
  row.appendChild(c)
  return c
}

function scaled(src: HTMLCanvasElement, k: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = src.width * k
  c.height = src.height * k
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(src, 0, 0, c.width, c.height)
  return c
}

async function main() {
  if (params.get('audiotest') === '1') { await audioTest(); return }
  const touchPref = params.get('touch')
  applyDocumentSettings({ ...CONTENT.config.defaultSettings, touchControls: touchPref === 'on' || touchPref === 'off' ? touchPref : 'auto' })
  const assets = createAssetStore()
  await assets.init()
  const audio = createAudio(assets)
  ;(window as unknown as { __apAudio: unknown }).__apAudio = audio
  const content = previewContent()
  const ph = createPlaceholders(content)
  const only = params.get('only')

  if (!only || only === 'creatures') {
    const row = section(`精灵占位图 (${content.speciesList.length})`)
    for (const s of content.speciesList) {
      const c = card(row, scaled(ph.canvas('creature', s.id), zoom), `${s.nameZh} ${s.types.join('/')} S${s.stage} ${s.rarity}`)
      c.onclick = () => { audio.unlock(); audio.playCry(s.id) }
    }
  }

  if (!only || only === 'characters') {
    const row = section(`角色行走图 (${CONTENT.characters.length})`)
    const { sheetCell: cell, sheetFrames: frames, sheetRows } = CONTENT.config.sprites
    const anims: { ctx: CanvasRenderingContext2D; sheet: HTMLCanvasElement }[] = []
    for (const ch of CONTENT.characters) {
      const sheet = ph.canvas('character', ch.id)
      const anim = document.createElement('canvas')
      anim.width = cell * 4 * 2
      anim.height = cell * 2
      const ctx = anim.getContext('2d')!
      ctx.imageSmoothingEnabled = false
      anims.push({ ctx, sheet })
      const wrap = document.createElement('div')
      wrap.append(anim)
      if (params.get('sheets') === '1') wrap.append(scaled(sheet, 1))
      card(row, wrap, `${ch.nameZh} (${ch.id})`)
    }
    let t = 0
    const dirs = Object.entries(sheetRows)
    const tick = () => {
      t++
      const f = Math.floor(t / 8) % frames
      for (const a of anims) {
        a.ctx.clearRect(0, 0, a.ctx.canvas.width, a.ctx.canvas.height)
        dirs.forEach(([, r], i) => a.ctx.drawImage(a.sheet, f * cell, r * cell, cell, cell, i * cell * 2, 0, cell * 2, cell * 2))
      }
      requestAnimationFrame(tick)
    }
    tick()
  }

  if (!only || only === 'terrain') {
    const row = section('地形贴图 (3x3 平铺检查接缝)')
    const keys = [...CONTENT.terrain.map((t) => t.key), ...new Set(CONTENT.biomes.map((b) => b.cliff))]
    for (const key of keys) {
      const tile = ph.canvas('terrain', key)
      const c = document.createElement('canvas')
      c.width = tile.width * 3; c.height = tile.height * 3
      const ctx = c.getContext('2d')!
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) ctx.drawImage(tile, x * tile.width, y * tile.height)
      if (CONTENT.terrainByKey[key]?.tallGrass) {
        const tuft = ph.canvas('terrain', key + TUFT_SUFFIX)
        for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) ctx.drawImage(tuft, x * tile.width, y * tile.height)
      }
      card(row, scaled(c, 2), key)
    }
    const tuftRow = section('高草叶丛 (透明)')
    for (const t of CONTENT.terrain.filter((x) => x.tallGrass)) {
      const el = scaled(ph.canvas('terrain', t.key + TUFT_SUFFIX), 3)
      el.classList.add('grass-bg')
      card(tuftRow, el, t.key + TUFT_SUFFIX)
    }
  }

  if (!only || only === 'items') {
    const row = section('道具图标')
    const ids = CONTENT.itemList.map((i) => i.id)
    for (const id of ids) card(row, scaled(ph.canvas('item', id), 2), CONTENT.items[id].nameZh)
    // Synthetic preview of every category / key icon.
    const extra: Content['itemList'] = [
      ...['ball'].flatMap(() => ['#e8473f', '#3f6fd6', '#ffd44a', '#8b56c9'].map((color, i) => ({ id: `pv-ball-${i}`, nameZh: 'ball', category: 'ball' as const, price: 0, buyable: false, description: '', effect: { kind: 'ball' as const, catchMultiplier: 1, color }, usableInBattle: true, usableInField: false }))),
      ...Object.keys(PH.items.categoryIcons).map((cat) => ({ id: `pv-${cat}`, nameZh: cat, category: cat as never, price: 0, buyable: false, description: '', effect: { kind: 'none' as const }, usableInBattle: false, usableInField: false })),
      ...Object.keys(PH.items.keyIcons).map((k) => ({ id: `pv-key-${k}`, nameZh: k, category: 'key' as const, price: 0, buyable: false, description: '', effect: { kind: 'key' as const, key: k as never }, usableInBattle: false, usableInField: true })),
    ]
    const pv = createPlaceholders({ ...content, items: Object.fromEntries([...CONTENT.itemList, ...extra].map((i) => [i.id, i])), itemList: [...CONTENT.itemList, ...extra] })
    for (const it of extra) card(row, scaled(pv.canvas('item', it.id), 2), it.nameZh)
  }

  if (!only || only === 'audio') {
    const row = section('BGM (点击播放)')
    for (const b of CONTENT.audio.bgm) {
      const btn = document.createElement('button')
      btn.textContent = `${b.nameZh} ${b.id}`
      btn.onclick = () => { audio.unlock(); audio.playBgm(b.id) }
      row.appendChild(btn)
    }
    const stop = document.createElement('button')
    stop.textContent = '■ 停止'
    stop.onclick = () => audio.stopBgm()
    let muffled = false
    const muffle = document.createElement('button')
    muffle.textContent = '闷音切换'
    muffle.onclick = () => { muffled = !muffled; audio.setMuffled(muffled) }
    row.append(stop, muffle)
    const sfxRow = section('音效')
    for (const id of CONTENT.audio.sfx) {
      const btn = document.createElement('button')
      btn.textContent = id
      btn.onclick = () => { audio.unlock(); audio.playSfx(id) }
      sfxRow.appendChild(btn)
    }
  }

  const inputRow = section('输入')
  const info = document.createElement('div')
  info.id = 'input'
  inputRow.appendChild(info)
  const input = createInput(document.body)
  input.setTouchControlsVisible(true)
  const actions = boundActions()
  const log: string[] = []
  const frame = () => {
    const a = input.axis()
    const held = actions.filter((x: InputAction) => input.held(x))
    for (const x of actions) if (input.pressed(x, true)) log.unshift(`pressed ${x}`)
    log.length = Math.min(log.length, 6)
    info.textContent = `device=${input.lastDevice} axis=(${a.x.toFixed(2)}, ${a.y.toFixed(2)}) held=[${held.join(',')}] ${log.join(' · ')}`
    input.endFrame()
    requestAnimationFrame(frame)
  }
  frame()
}

main()
