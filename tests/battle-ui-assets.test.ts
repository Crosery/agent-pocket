// Battle UI art and layout content (issue #32): every file the HUD points at exists and every number is usable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTENT } from '../src/shared/content/index.ts'
import { BATTLE_UI } from '../src/client/battle/config.ts'
import { fitLabel } from '../src/client/battle/model.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = (p: string) => join(ROOT, 'public', p)

test('every icon the HUD references exists', () => {
  const names = [...Object.values(BATTLE_UI.icons.commands), ...BATTLE_UI.icons.effects, ...Object.values(BATTLE_UI.icons.meterTones)]
  for (const n of names) assert.ok(existsSync(pub(`${BATTLE_UI.icons.base}icon-${n}.png`)), `icon-${n}.png`)
  for (const t of CONTENT.types) assert.ok(t.icon && existsSync(pub(`${BATTLE_UI.icons.typeBase}${t.icon}.png`)), `type icon of ${t.id}`)
})

test('every status condition and volatile effect has an icon', () => {
  for (const s of CONTENT.statuses) assert.ok(BATTLE_UI.icons.effects.includes(s.id), `status ${s.id}`)
  for (const v of CONTENT.volatiles) assert.ok(BATTLE_UI.icons.effects.includes(v.id), `volatile ${v.id}`)
})

test('every command has an icon', () => {
  for (const id of [...BATTLE_UI.commands.normal, ...BATTLE_UI.commands.pvp]) assert.ok(BATTLE_UI.icons.commands[id], id)
})

test('battle.css only uses frame art that exists', () => {
  const css = readFileSync(join(ROOT, 'src/client/battle/battle.css'), 'utf8')
  const urls = [...css.matchAll(/url\('(\/assets\/[^']+)'\)/g)].map((m) => m[1])
  assert.ok(urls.length >= 4)
  for (const u of urls) assert.ok(existsSync(pub(u)), u)
})

test('layout numbers are positive and the compact widths are narrower', () => {
  const L = BATTLE_UI.layout
  for (const [k, v] of Object.entries(L)) assert.ok(typeof v === 'number' && v > 0, k)
  assert.ok(L.compactFoeWidth <= L.foeWidth && L.compactOwnWidth <= L.ownWidth && L.compactCmdWidth <= L.cmdWidth)
})

test('boss meter labels shorten by display width', () => {
  const W = BATTLE_UI.hud.meterLabelWidth
  assert.ok(W >= 2 && BATTLE_UI.hud.meterPipCells >= 2)
  assert.equal(fitLabel('苹果订阅', W), '苹果')
  assert.equal(fitLabel('住宅 IP', W), '住宅')
  assert.equal(fitLabel('juice', W), 'juice')
  assert.equal(fitLabel('supercalifragilistic', W).length, W)
})
