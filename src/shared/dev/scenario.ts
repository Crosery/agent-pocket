// Scenario applier (ADR 0002 §4.4): pure. A scenario (plus its `extends` chain and beat) and a fresh new-game save
// go in; the prepared save and the commands to run afterwards come out. Browser and Node tests share this.
import type { Creature, DevBeat, DevCommandCall, DevExpectation, DevPartyEntry, DevPlace, DevScenario, DevTeam, SaveData, World } from '../types.ts'
import type { IRng } from '../contracts.ts'
import { CONTENT, type Content } from '../content/index.ts'
import { createCreature } from '../creature.ts'
import { STORY_CONTENT } from '../world/story.ts'
import { worldAnchors } from '../world/index.ts'
import { getMap } from '../world/worldapi.ts'
import { getPointer, matches } from './diff.ts'

export interface ScenarioDeps {
  world: World
  scenarios: Record<string, DevScenario>
  beats: Record<string, DevBeat>
  teams: Record<string, DevTeam>
  /** A fresh new-game save (name and avatar chosen); the scenario is applied on top of a copy. */
  base: SaveData
  rng: IRng
  content?: Content
}

export interface ScenarioResult {
  id: string
  scenario: DevScenario
  save: SaveData
  /** Derived commands (clock freeze, weather) followed by the scenario's `then`. */
  commands: DevCommandCall[]
  expect: DevExpectation[]
  problems: string[]
}

/** The scenario with its extends chain folded in (root first). Throws on unknown ids and cycles. */
export function flattenScenario(id: string, scenarios: Record<string, DevScenario>): DevScenario {
  const chain: DevScenario[] = []
  const seen = new Set<string>()
  for (let cur: string | undefined = id; cur; ) {
    if (seen.has(cur)) throw new Error(`scenario "${id}": extends cycle at "${cur}"`)
    seen.add(cur)
    const sc: DevScenario | undefined = scenarios[cur]
    if (!sc) throw new Error(`unknown scenario "${cur}"`)
    chain.unshift(sc)
    cur = sc.extends
  }
  const out: DevScenario = { id, titleKey: chain[chain.length - 1].titleKey }
  for (const sc of chain) {
    const { extends: _x, then, expect, bag, flags, quests, ...rest } = sc
    Object.assign(out, rest)
    if (bag) out.bag = { ...out.bag, ...bag }
    if (flags) out.flags = { ...out.flags, ...flags }
    if (quests) out.quests = { ...out.quests, ...quests }
    if (then) out.then = [...(out.then ?? []), ...then]
    if (expect) out.expect = [...(out.expect ?? []), ...expect]
  }
  out.id = id
  return out
}

/** Tile of a place: anchor ids come from worldAnchors, explicit tiles pass through; null when unknown. */
export function resolveDevPlace(world: World, place: DevPlace, anchors: Record<string, { map: string; x: number; y: number }> = worldAnchors(world)): { map: string; x: number; y: number } | null {
  if (typeof place !== 'string') return getMap(world, place.map) ? place : null
  return anchors[place] ?? null
}

function buildMember(entry: DevPartyEntry & { species: string }, level: number, rng: IRng, save: SaveData, c: Content, problems: string[]): Creature | null {
  if (!c.species[entry.species]) { problems.push(`unknown species "${entry.species}"`); return null }
  const ball = c.itemList.find((it) => it.effect.kind === 'ball')?.id
  const cr = createCreature(entry.species, level, { rng, otName: save.name, otId: save.playerId, ...(ball ? { ballId: ball } : {}), caughtMap: save.position.map, ...(entry.shiny !== undefined ? { shiny: entry.shiny } : {}) }, c)
  if (entry.nickname) cr.nickname = entry.nickname
  if (entry.status) {
    const def = c.statusById[entry.status]
    if (!def) problems.push(`unknown status "${entry.status}"`)
    cr.status = entry.status
    cr.statusTurns = def?.durationMax ?? def?.durationMin ?? 0
  }
  if (entry.hp !== undefined && entry.hp >= 0 && entry.hp < 1) cr.hp = Math.max(entry.hp > 0 ? 1 : 0, Math.floor(cr.hp * entry.hp))
  return cr
}

/** Applies the beat and the scenario fields to a copy of `deps.base`. */
export function applyScenario(id: string, deps: ScenarioDeps): ScenarioResult {
  const c = deps.content ?? CONTENT
  const problems: string[] = []
  const sc = flattenScenario(id, deps.scenarios)
  const beat = sc.beat ? deps.beats[sc.beat] : undefined
  if (sc.beat && !beat) problems.push(`unknown beat "${sc.beat}"`)
  const save: SaveData = structuredClone(deps.base)
  const rng = deps.rng

  if (beat) {
    save.badges = [...new Set([...save.badges, ...(beat.badges ?? [])])]
    for (const tr of beat.trainers ?? []) save.flags[STORY_CONTENT.meta.flags.trainerWon + tr] = true
    Object.assign(save.quests, beat.quests)
    Object.assign(save.flags, beat.flags)
  }
  if (sc.badges) save.badges = [...new Set(sc.badges)]
  if (sc.money !== undefined) save.money = Math.max(0, Math.floor(sc.money))
  if (sc.bagAll !== undefined) for (const it of c.itemList) save.bag[it.id] = Math.max(1, Math.floor(sc.bagAll))
  for (const [item, qty] of Object.entries(sc.bag ?? {})) {
    if (!c.items[item]) problems.push(`unknown item "${item}"`)
    else if (qty > 0) save.bag[item] = Math.floor(qty)
    else delete save.bag[item]
  }
  Object.assign(save.flags, sc.flags)
  Object.assign(save.quests, sc.quests)

  const place = sc.place ?? beat?.place
  if (place) {
    const at = resolveDevPlace(deps.world, place)
    if (at) {
      save.position = { map: at.map, x: Math.floor(at.x), y: Math.floor(at.y), facing: 'down' }
      save.respawn = { ...save.position }
    } else problems.push(`unresolved place ${JSON.stringify(place)}`)
  }

  if (sc.party) {
    const party: Creature[] = []
    for (const entry of sc.party) {
      if (entry.team) {
        const team = deps.teams[entry.team]
        if (!team) { problems.push(`unknown team "${entry.team}"`); continue }
        for (const m of team.members) {
          const cr = buildMember({ ...m, species: m.species }, entry.level ?? team.level, rng, save, c, problems)
          if (cr) party.push(cr)
        }
      } else if (entry.species) {
        const cr = buildMember({ ...entry, species: entry.species }, entry.level ?? c.config.creature.starterLevel, rng, save, c, problems)
        if (cr) party.push(cr)
      } else problems.push('party entry needs a team or a species')
    }
    save.party = party.slice(0, c.config.party.maxParty)
    const ids = new Set([...save.dexCaught, ...save.party.map((m) => m.speciesId)])
    save.dexCaught = [...ids]
    save.dexSeen = [...new Set([...save.dexSeen, ...ids])]
    if (save.party[0]) save.flags[STORY_CONTENT.meta.flags.starter] = save.party[0].speciesId
  }
  if (sc.clock) save.clockMinutes = Math.max(0, sc.clock.minutes)

  const commands: DevCommandCall[] = []
  if (sc.clock?.frozen) commands.push({ cmd: 'clock.freeze', args: { on: true } })
  if (sc.weather !== undefined) commands.push({ cmd: 'weather.set', args: sc.weather === null ? {} : { kind: sc.weather } })
  commands.push(...(sc.then ?? []))
  return { id, scenario: sc, save, commands, expect: sc.expect ?? [], problems }
}

export interface ExpectResult { path: string; ok: boolean; actual: unknown; expected: unknown }

/** Evaluates expectations against a state document ({ save, runtime, world }). */
export function checkExpectations(doc: unknown, expect: readonly DevExpectation[]): ExpectResult[] {
  return expect.map((e) => {
    const { path, ...matcher } = e
    const { found, value } = getPointer(doc, path)
    return { path, ok: matches(found, value, matcher), actual: found ? value : undefined, expected: matcher }
  })
}
