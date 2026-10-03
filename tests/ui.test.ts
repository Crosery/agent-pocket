import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GameMap, TerrainDef } from '../src/shared/types.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { INPUT_BINDINGS, touchPadHeight, UI_CONFIG, validateUIConfig } from '../src/client/ui/config.ts'
import { UI_GLYPHS } from '../src/client/ui/glyphs.ts'
import { computeUIScale } from '../src/client/ui/scale.ts'
import { decodeBits, encodeBits, fogGrid, hasBit, isTileExplored, normalizeBits, revealAround } from '../src/client/ui/fog.ts'
import { advanceTypewriter, createRateLimiter, createTypewriter, parseChatInput, typewriterDone } from '../src/client/ui/textflow.ts'
import { parseColor, rasterizeGlyph, rotateRows, shade } from '../src/client/ui/pixel.ts'
import { bakeMapPixels, buildingMarkers, propFootprint, regionCentroids } from '../src/client/ui/mapbake.ts'

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'ui')
const uiSources = readdirSync(UI_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')).map((f) => ({ f, src: readFileSync(join(UI_DIR, f), 'utf8') }))

// Unions from src/client/contracts.ts / types.ts, enumerated here to prove the content covers them.
const MARKER_KINDS = ['player', 'other', 'npc', 'trainer', 'center', 'shop', 'gym', 'lab', 'quest', 'item', 'wild', 'rare', 'warp', 'house', 'tower']
const TEXT_SPEEDS = ['slow', 'normal', 'fast', 'instant']
const NET_STATUSES = ['offline', 'connecting', 'online', 'error']
const CHAT_CHANNELS = ['global', 'local', 'whisper', 'system']
const TOAST_KINDS = ['info', 'success', 'warn', 'error']

test('content/ui.json is consistent with the content registry', () => {
  assert.deepEqual(validateUIConfig(UI_CONFIG, CONTENT.audio.sfx), [])
  for (const k of MARKER_KINDS) assert.ok(UI_CONFIG.minimap.markers[k], `marker style for "${k}"`)
  for (const s of TEXT_SPEEDS) assert.equal(typeof UI_CONFIG.dialogue.charsPerSecond[s as 'slow'], 'number', `textSpeed ${s}`)
  for (const k of TOAST_KINDS) {
    assert.ok(UI_CONFIG.toast.durationMs[k as 'info'] > 0, `toast duration ${k}`)
    assert.ok(UI_CONFIG.toast.sfx[k as 'info'], `toast sfx ${k}`)
  }
  for (const id of UI_GLYPHS) assert.ok(UI_CONFIG.glyphs[id], `glyph "${id}"`)
  for (const p of CONTENT.config.time.phases) assert.ok(UI_CONFIG.hud.todGlyph[p.id], `tod glyph for ${p.id}`)
  for (const p of Object.values(CONTENT.props)) {
    if (!p.minimapIcon || p.minimapIcon === 'none') continue
    assert.ok(UI_CONFIG.minimap.markers[p.minimapIcon], `marker style for minimapIcon ${p.minimapIcon}`)
    assert.ok(UI_CONFIG.minimap.bake.building.byIcon[p.minimapIcon], `building colour for ${p.minimapIcon}`)
  }
  for (const tab of UI_CONFIG.chat.tabs) assert.ok(tab === 'all' || CHAT_CHANNELS.includes(tab), `chat tab ${tab}`)
  assert.ok(['global', 'local', 'whisper'].includes(UI_CONFIG.chat.defaultChannel))
  assert.ok(touchPadHeight() > 0, 'virtual pad height derived from content/input.json')
})

test('every text key used by src/client/ui exists (literal and enumerated template keys)', () => {
  const missing: string[] = []
  const need = (k: string, where: string) => { if (!(k in CONTENT.text)) missing.push(`${where}: ${k}`) }
  for (const { f, src } of uiSources) {
    for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) need(m[1], f)
  }
  for (const k of UI_CONFIG.chat.tabs) need(`ui.chat.tab.${k}`, 'chat tabs')
  for (const c of CHAT_CHANNELS) need(`ui.chat.channel.${c}`, 'chat channels')
  for (const k of ['whisperUsage', 'noReplyTarget', 'tooLong']) need(`ui.chat.${k}`, 'chat errors')
  for (const p of CONTENT.config.time.phases) need(`hud.tod.${p.id}`, 'tod')
  for (const s of NET_STATUSES) need(`hud.net.${s}`, 'net')
  for (const k of MARKER_KINDS) need(`hud.minimap.legend.${k}`, 'legend')
  for (const codes of Object.values(INPUT_BINDINGS.keyboard)) {
    const code = codes?.[0]
    if (code && !/^(Key[A-Z]|Digit[0-9]|F[0-9]{1,2})$/.test(code)) need(`ui.keyNames.${code}`, 'key names')
  }
  for (const idxs of Object.values(INPUT_BINDINGS.gamepad.buttons)) if (idxs?.[0] !== undefined) need(`ui.padButtons.${idxs[0]}`, 'pad buttons')
  for (const b of INPUT_BINDINGS.touch.buttons) need(b.label, 'touch button labels')
  assert.deepEqual(missing, [])
})

test('UI code carries no player-facing CJK text and no hex colours (data/theme live in JSON/CSS)', () => {
  for (const { f, src } of uiSources) {
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!/[　-〿一-鿿＀-￯]/.test(code), `${f} contains CJK text`)
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(code), `${f} contains a hex colour literal`)
  }
})

test('computeUIScale keeps one UI pixel an integer number of device pixels', () => {
  const desk = computeUIScale(1280, 720, 1)
  assert.equal(desk.deviceScale, 2)
  assert.equal(desk.cssPerUnit, 2)
  assert.equal(desk.compact, false)
  const retina = computeUIScale(1440, 900, 2)
  assert.ok(Number.isInteger(retina.deviceScale))
  assert.equal(retina.cssPerUnit * 2, retina.deviceScale)
  const phone = computeUIScale(390, 844, 3)
  assert.ok(Number.isInteger(phone.deviceScale) && phone.deviceScale >= 3, 'never below 1 CSS px per unit on phones')
  assert.ok(phone.portrait && phone.compact)
  const tiny = computeUIScale(200, 150, 1)
  assert.equal(tiny.deviceScale, 1)
  for (const [w, h, d] of [[1920, 1080, 1], [844, 390, 3], [1366, 768, 1.5]] as const) {
    const s = computeUIScale(w, h, d)
    assert.ok(Number.isInteger(s.deviceScale), `${w}x${h}@${d}`)
    assert.ok(s.cssPerUnit >= UI_CONFIG.scale.minCssPerUnit - 1e-9)
  }
})

test('typewriter reveals at the configured speed with punctuation pauses', () => {
  const tw = createTypewriter('ab,cd')
  assert.equal(advanceTypewriter(tw, 0.25, 8, ',', 500), 2)
  advanceTypewriter(tw, 0.125, 8, ',', 500)
  assert.equal(tw.shown, 3)
  advanceTypewriter(tw, 0.4, 8, ',', 500)
  assert.equal(tw.shown, 3, 'paused after comma')
  advanceTypewriter(tw, 0.35, 8, ',', 500)
  assert.ok(tw.shown > 3)
  const inst = createTypewriter('你好世界')
  advanceTypewriter(inst, 0, 0, '', 0)
  assert.ok(typewriterDone(inst))
  assert.equal(createTypewriter('😀a').chars.length, 2, 'code points, not UTF-16 units')
})

test('chat input parsing: whisper/reply/channel commands, limits', () => {
  const cmds = UI_CONFIG.chat.commands
  const opts = { maxLen: 5, replyTarget: null, whisperTarget: null }
  const w = cmds.whisper[0]
  assert.deepEqual(parseChatInput(`${w} bob hi`, 'local', cmds, opts), { kind: 'send', channel: 'whisper', text: 'hi', to: 'bob' })
  assert.deepEqual(parseChatInput(`${w} bob`, 'local', cmds, opts), { kind: 'error', key: 'whisperUsage' })
  assert.deepEqual(parseChatInput(`${cmds.reply[0]} yo`, 'local', cmds, opts), { kind: 'error', key: 'noReplyTarget' })
  assert.deepEqual(parseChatInput(`${cmds.reply[0]} yo`, 'local', cmds, { ...opts, replyTarget: 'amy' }), { kind: 'send', channel: 'whisper', text: 'yo', to: 'amy' })
  assert.deepEqual(parseChatInput(cmds.global[0], 'local', cmds, opts), { kind: 'switch', channel: 'global' })
  assert.deepEqual(parseChatInput(`${cmds.local[0]} hey`, 'global', cmds, opts), { kind: 'send', channel: 'local', text: 'hey' })
  assert.deepEqual(parseChatInput('   ', 'global', cmds, opts), { kind: 'empty' })
  assert.deepEqual(parseChatInput('toolong', 'global', cmds, opts), { kind: 'error', key: 'tooLong' })
  assert.deepEqual(parseChatInput('/unknown x', 'global', cmds, { ...opts, maxLen: 50 }), { kind: 'send', channel: 'global', text: '/unknown x' })
  assert.deepEqual(parseChatInput('hi', 'whisper', cmds, { ...opts, whisperTarget: 'bob' }), { kind: 'send', channel: 'whisper', text: 'hi', to: 'bob' })
  const lim = createRateLimiter(2, 1)
  assert.equal(lim.allow(0), true)
  assert.equal(lim.allow(100), true)
  assert.equal(lim.allow(200), false)
  assert.equal(lim.allow(1001), true)
})

test('fog bitset: reveal radius, explored lookup, base64 round-trip', () => {
  const g = fogGrid(40, 20, 16)
  assert.deepEqual([g.cols, g.rows, g.bytes], [3, 2, 1])
  const bits = normalizeBits(g, null)
  assert.deepEqual(revealAround(bits, g, 0, 0, 0), [0])
  assert.ok(isTileExplored(bits, g, 15, 15))
  assert.ok(!isTileExplored(bits, g, 16, 0))
  assert.equal(revealAround(bits, g, 20, 5, 1).length, 5)
  assert.ok(hasBit(bits, 5))
  const enc = encodeBits(bits)
  assert.deepEqual(decodeBits(enc, g.bytes), bits)
  assert.equal(decodeBits(enc, g.bytes + 1), null)
  assert.equal(decodeBits('!!!!', 3), null)
  const big = Uint8Array.from({ length: 7 }, (_, i) => i * 37)
  assert.deepEqual(decodeBits(encodeBits(big), 7), big)
  assert.equal(normalizeBits(g, new Uint8Array(9)).length, g.bytes, 'wrong-size input is discarded')
})

test('pixel helpers: colours, rotation, glyph rasterisation', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 255])
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), [10, 20, 30, 128])
  assert.deepEqual(parseColor('nope'), [255, 0, 255, 255])
  assert.deepEqual(shade([100, 100, 100, 255], -0.5), [50, 50, 50, 255])
  assert.deepEqual(rotateRows(['ab', 'cd'], 1), ['ca', 'db'])
  assert.deepEqual(rotateRows(['ab', 'cd'], 4), ['ab', 'cd'])
  const bmp = rasterizeGlyph({ rows: ['x.', '.x'] }, { x: '#ff0000' })
  assert.equal(bmp.width, 2)
  assert.deepEqual([...bmp.data.slice(0, 8)], [255, 0, 0, 255, 0, 0, 0, 0])
})

function synthMap(): GameMap {
  const W = 12, H = 10
  const plain = CONTENT.terrain.find((t: TerrainDef) => t.walkable && !t.liquid)!.id
  const building = Object.values(CONTENT.props).find((p) => p.minimapIcon && p.minimapIcon !== 'none')!
  const canopy = Object.values(CONTENT.props).find((p) => !p.minimapIcon && p.footprint[0] * p.footprint[1] === 1 && p.height >= UI_CONFIG.minimap.bake.canopy.minHeight)!
  const region = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) region[i] = i % W < 6 ? 0 : 1
  return {
    id: 't', nameZh: '', kind: 'overworld', width: W, height: H,
    terrain: new Uint8Array(W * H).fill(plain), elevation: new Uint8Array(W * H), region,
    regions: [], props: [{ prop: building.key, x: 1, y: 1, rot: 0 }, { prop: canopy.key, x: 10, y: 8, rot: 0 }],
    warps: [], npcs: [], signs: [], items: [], lights: [], spawn: { x: 0, y: 0, facing: 'down' }, outdoor: true, music: '',
  }
}

test('map bake: terrain colours, building footprints, canopy shading, markers, centroids', () => {
  const map = synthMap()
  const bmp = bakeMapPixels(map, CONTENT, { ...UI_CONFIG.minimap.bake, noise: 0 })
  assert.equal(bmp.width, map.width)
  const px = (x: number, y: number) => [...bmp.data.slice((y * map.width + x) * 4, (y * map.width + x) * 4 + 3)]
  const terrainCol = parseColor(CONTENT.terrain[map.terrain[0]].minimap).slice(0, 3)
  assert.deepEqual(px(0, 0), terrainCol)
  const bdef = CONTENT.props[map.props[0].prop]
  const rect = propFootprint(map.props[0], bdef)
  const roofMid = parseColor(UI_CONFIG.minimap.bake.building.byIcon[bdef.minimapIcon!]).slice(0, 3)
  if (rect.h > 2) assert.deepEqual(px(rect.x, rect.y + 1), roofMid)
  const tree = px(10, 8)
  assert.ok(tree[0] < terrainCol[0] || tree[1] < terrainCol[1], 'canopy darkens terrain')
  const marks = buildingMarkers(map)
  assert.equal(marks.length, 1)
  assert.equal(marks[0].kind, bdef.minimapIcon)
  assert.equal(marks[0].x, rect.x + rect.w / 2)
  const rotated = propFootprint({ prop: bdef.key, x: 0, y: 0, rot: 1 }, bdef)
  assert.deepEqual([rotated.w, rotated.h], [bdef.footprint[1], bdef.footprint[0]])
  const cents = regionCentroids(map).sort((a, b) => a.index - b.index)
  assert.equal(cents.length, 2)
  assert.equal(cents[0].x, 2.5)
  assert.equal(cents[1].tiles, 60)
})
