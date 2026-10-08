// AI-industry easter eggs merged from docs/research/2026-10 (issue #19 research, issue #25 implementation): the buzz-
// world events, buzzq- hidden quest chains and NPC gossip use only existing items, resolve every text key, and phrase
// anything the research could not source as hearsay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CONTENT, t } from '../src/shared/content/index.ts'
import { GAMEPLAY } from '../src/shared/gameplay/data.ts'
import { STORY_CONTENT, walkSteps } from '../src/shared/world/story.ts'
import type { EventEffect, ScriptStep } from '../src/shared/types.ts'

const root = new URL('..', import.meta.url).pathname
const research = JSON.parse(readFileSync(`${root}docs/research/2026-10/easter-eggs.json`, 'utf8')) as { eggs: { id: string; kind: string; eventId: string; payload: { pool?: string } }[] }
const sources = JSON.parse(readFileSync(`${root}docs/research/2026-10/events.json`, 'utf8')) as { id: string; sourceStatus?: string }[]
const unsourced = new Set(sources.filter((s) => s.sourceStatus === 'unsourced-from-memory').map((s) => s.id))
const newItemIds = ['cold-backup', 'glue-free-pizza', 'golden-gate-pendant', 'invite-code', 'katakana-charm', 'keep4o-badge', 'map-file', 'milk-tea-card', 'odd-apostrophe', 'reset-ticket-85']

const scriptsOf = (effects: EventEffect[]): ScriptStep[] => effects.flatMap((e) => (e.kind === 'script' ? e.steps : e.kind === 'npc' ? e.npc.script : []))

test('buzz events: at least 25, every text key resolves, only existing items, hearsay for unsourced ones', () => {
  const buzz = GAMEPLAY.events.filter((e) => e.id.startsWith('buzz-'))
  assert.ok(buzz.length >= 25, `${buzz.length} buzz events`)
  for (const ev of buzz) {
    assert.ok(t(`events.ev.${ev.id}.name`) !== `events.ev.${ev.id}.name`, `${ev.id} name`)
    walkSteps(scriptsOf(ev.effects), (s) => {
      if (s.op === 'say') assert.ok(s.text in CONTENT.text, `${ev.id}: say key ${s.text}`)
      if (s.op === 'giveItem') assert.ok(CONTENT.items[s.item], `${ev.id}: item ${s.item}`)
      if (s.op === 'choice') for (const k of [s.text, ...s.options]) assert.ok(k in CONTENT.text, `${ev.id}: ${k}`)
    })
    for (const ef of ev.effects) if (ef.kind === 'scatter') assert.ok(CONTENT.items[ef.item], `${ev.id}: scatter ${ef.item}`)
  }
  assert.ok(!JSON.stringify(buzz).match(new RegExp(newItemIds.map((i) => `"${i}"`).join('|'))), 'no item without an icon')
  for (const egg of research.eggs.filter((e) => e.kind === 'worldEvent' && unsourced.has(e.eventId))) {
    const id = `buzz-${egg.id.replace(/^egg-/, '')}`
    if (CONTENT.text[`events.ev.${id}.rumor`]) assert.match(t(`events.ev.${id}.rumor`), /传闻|据说|听说/)
  }
})

test('buzzq hidden quest chains: five chains, steps exist, the final pays a plain reward instead of research', () => {
  const chains = GAMEPLAY.chains.filter((c) => c.id.startsWith('buzzq-'))
  assert.equal(chains.length, 5)
  for (const c of chains) {
    assert.ok(c.steps.length >= 3, c.id)
    for (const step of c.steps) assert.ok(GAMEPLAY.eventById[step.event], `${c.id}: ${step.event}`)
    const final = GAMEPLAY.eventById[c.steps[c.steps.length - 1].event]
    const ops: string[] = []
    walkSteps(scriptsOf(final.effects), (s) => ops.push(s.op))
    assert.ok(!ops.includes('research'), `${c.id}: research step removed`)
    assert.ok(ops.includes('giveMoney') || ops.includes('giveItem'), `${c.id}: pays a reward`)
  }
})

test('npc gossip: egg lines are text keys and the unsourced ones are hearsay', () => {
  const entries = Object.values(STORY_CONTENT.population.npcPools).flat().filter((e) => (e as { egg?: boolean }).egg) as { dialogues: string[][] }[]
  assert.ok(entries.length >= 20, `${entries.length} gossip entries`)
  for (const e of entries) for (const line of e.dialogues.flat()) assert.ok(line in CONTENT.text, `gossip key ${line}`)
  for (const egg of research.eggs.filter((x) => x.kind === 'npcLine' && unsourced.has(x.eventId))) {
    const slug = egg.id.replace(/^egg-/, '')
    const first = CONTENT.text[`events.egg.${slug}.d0l0`]
    if (first) assert.match(first, /传闻|据说/, `${slug} must read as hearsay`)
  }
})
