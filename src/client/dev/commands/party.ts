// The party: add, edit (clamped by sanitizeCreature, clipped fields reported), heal, evolve, box.
import type { Creature } from '../../../shared/types.ts'
import { CONTENT } from '../../../shared/content/index.ts'
import { createCreature, healFull, sanitizeCreature } from '../../../shared/creature.ts'
import { diff } from '../../../shared/dev/diff.ts'
import { addCreature } from '../../world/save-ops.ts'
import type { DevHost } from '../kit.ts'
import { DevError, type CommandRun } from '../registry.ts'

const FIELDS = ['level', 'exp', 'nickname', 'status', 'hp', 'shiny', 'friendship', 'heldItem', 'abilityId', 'moves', 'ivs'] as const
export const PARTY_FIELDS: readonly string[] = FIELDS

const member = (host: DevHost, index: unknown): Creature => {
  const cr = host.ctx.save.party[Math.floor(index as number)]
  if (!cr) throw new DevError('dev.err.noMember', { index: String(index) })
  return cr
}

const changed = (host: DevHost) => host.ctx.events.emit('party:changed', {})

export const partyCommands: Record<string, CommandRun> = {
  'party.add': (host, a) => {
    const id = String(a.species)
    if (!CONTENT.species[id]) throw new DevError('dev.err.unknownSpecies', { species: id })
    const { ctx } = host
    const cr = createCreature(id, (a.level as number | undefined) ?? 20, { rng: host.rng.stream('debug'), otName: ctx.save.name, otId: ctx.save.playerId, caughtMap: ctx.save.position.map })
    return { placed: addCreature(ctx, cr)?.where ?? 'full', uid: cr.uid }
  },
  /** Sets one field of a member; the creature then goes through sanitizeCreature and the fields it had to clip are listed. */
  'party.set': (host, a) => {
    const field = String(a.field)
    if (!PARTY_FIELDS.includes(field)) throw new DevError('dev.err.badArg', { arg: 'field', why: PARTY_FIELDS.join(' / ') })
    const cr = member(host, a.index)
    const raw = { ...cr } as Record<string, unknown>
    let value = a.value as unknown
    if (typeof value === 'string' && ['level', 'exp', 'hp', 'friendship'].includes(field)) value = Number(value)
    if (field === 'shiny') value = value === true || value === 'true'
    if (field === 'moves' && Array.isArray(value)) value = (value as string[]).map((id) => ({ id, pp: CONTENT.moves[id]?.pp ?? 5, ppMax: CONTENT.moves[id]?.pp ?? 5 }))
    if (value === 'null' || value === '') value = undefined
    raw[field] = value
    const clean = sanitizeCreature(raw, CONTENT)
    if (!clean) throw new DevError('dev.err.badArg', { arg: 'value', why: String(a.value) })
    const clipped = diff(raw, clean).filter((o) => o.path.split('/')[1] === field || o.op !== 'replace')
    host.ctx.save.party[Math.floor(a.index as number)] = clean
    changed(host)
    return { field, now: (clean as unknown as Record<string, unknown>)[field] ?? null, clipped: clipped.map((o) => o.path) }
  },
  'party.heal': (host) => {
    for (const c of host.ctx.save.party) healFull(c, host.ctx.data)
    changed(host)
    return { healed: host.ctx.save.party.length }
  },
  'party.remove': (host, a) => {
    member(host, a.index)
    host.ctx.save.party.splice(Math.floor(a.index as number), 1)
    changed(host)
    return { size: host.ctx.save.party.length }
  },
  'party.toBox': (host, a) => {
    const cr = member(host, a.index)
    const { ctx } = host
    const P = ctx.data.config.party
    while (ctx.save.boxes.length < P.boxCount) ctx.save.boxes.push([])
    const box = ctx.save.boxes.findIndex((b) => b.length < P.boxSize)
    if (box < 0) throw new DevError('dev.err.boxesFull')
    ctx.save.party.splice(Math.floor(a.index as number), 1)
    ctx.save.boxes[box].push(cr)
    changed(host)
    return { box }
  },
  /** Evolves a member into its next form (level is raised to the evolution level) with the evolution scene. */
  'party.evolve': async (host, a) => {
    const cr = member(host, a.index)
    const to = CONTENT.species[cr.speciesId]?.evolvesTo
    if (!to || !CONTENT.species[to.id]) throw new DevError('dev.err.noEvolution', { species: cr.speciesId })
    cr.level = Math.max(cr.level, to.level)
    await host.ctx.battle.evolve(Math.floor(a.index as number), to.id)
    changed(host)
    return { from: cr.speciesId, to: to.id }
  },
  /** Replaces the party with a preset team (content/dev/teams.json), at the preset's level unless given. */
  'party.team': (host, a) => {
    const id = String(a.team)
    const team = host.content.teams[id]
    if (!team) throw new DevError('dev.err.unknownTeam', { team: id })
    const { ctx } = host
    ctx.save.party = team.members.map((m) => {
      const cr = createCreature(m.species, (a.level as number | undefined) ?? team.level, { rng: host.rng.stream('debug'), otName: ctx.save.name, otId: ctx.save.playerId, caughtMap: ctx.save.position.map })
      if (m.nickname) cr.nickname = m.nickname
      return cr
    })
    changed(host)
    return { team: id, size: ctx.save.party.length }
  },
}
