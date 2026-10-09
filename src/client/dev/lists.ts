// Read-only pick lists for the panel's search boxes and for automation (window.__ap.v1.list): what exists in the
// game (species, items, anchors, flags, ...) and, where it matters, its current state.
import { CONTENT, t } from '../../shared/content/index.ts'
import { GAMEPLAY } from '../../shared/gameplay/data.ts'
import { eventTitle } from '../../shared/gameplay/events.ts'
import { worldAnchors } from '../../shared/world/index.ts'
import { STORY_CONTENT } from '../../shared/world/story.ts'
import { TUTORIAL, TIP_FLAG_PREFIX } from '../onboarding/config.ts'
import { tipLive, tipSeen } from '../onboarding/logic.ts'
import { GAME } from '../world/config.ts'
import type { DevHost } from './kit.ts'

export interface ListEntry { id: string; label: string; info?: Record<string, unknown> }
export const LIST_SOURCES = ['anchors', 'places', 'species', 'items', 'quests', 'flags', 'events', 'bosses', 'trainers', 'badges', 'statuses', 'weathers', 'scenarios', 'beats', 'teams', 'tips', 'roamers'] as const
export type ListSource = (typeof LIST_SOURCES)[number]

/** Every string under a key that looks like a flag reference, anywhere in the story data. */
function scanFlags(root: unknown, out: Set<string>, key = ''): void {
  if (typeof root === 'string') { if (/flag/i.test(key) && root && !/\s/.test(root)) out.add(root) } else if (Array.isArray(root)) for (const x of root) scanFlags(x, out, key)
  else if (root && typeof root === 'object') for (const [k, v] of Object.entries(root)) scanFlags(v, out, k)
}

let knownFlagsCache: string[] | null = null
export function knownFlags(): string[] {
  if (knownFlagsCache) return knownFlagsCache
  const out = new Set<string>()
  scanFlags(STORY_CONTENT.scripts, out)
  scanFlags(STORY_CONTENT.npcGroups, out)
  scanFlags(STORY_CONTENT.quests, out)
  scanFlags(STORY_CONTENT.trainerGroups, out)
  scanFlags(TUTORIAL, out)
  for (const tip of TUTORIAL.tips.list) out.add(`${TIP_FLAG_PREFIX}${tip.id}`)
  for (const l of TUTORIAL.curriculum.lessons) out.add(`${TUTORIAL.curriculum.flagPrefix}${l.id}`)
  out.add(STORY_CONTENT.meta.flags.starter)
  return (knownFlagsCache = [...out].sort())
}

function entries(host: DevHost, source: ListSource): ListEntry[] {
  const { ctx, world, overworld } = host
  switch (source) {
    case 'anchors': return Object.entries(worldAnchors(world)).map(([id, a]) => ({ id, label: id, info: { map: a.map, x: a.x, y: a.y } }))
    case 'places': return world.towns.map((p) => ({ id: p.id, label: p.nameZh, info: { kind: p.kind } }))
    case 'species': return CONTENT.speciesList.map((s) => ({ id: s.id, label: s.nameZh, info: { dexNo: s.dexNo, rarity: s.rarity } }))
    case 'items': return CONTENT.itemList.map((i) => ({ id: i.id, label: i.nameZh, info: { category: i.category, have: ctx.save.bag[i.id] ?? 0 } }))
    case 'quests': return world.quests.map((q) => ({ id: q.id, label: q.nameZh, info: { stages: q.stages.length, state: ctx.save.quests[q.id] ?? null } }))
    case 'flags': {
      const set = new Set([...knownFlags(), ...Object.keys(ctx.save.flags)])
      return [...set].sort().map((id) => ({ id, label: id, info: { value: ctx.save.flags[id] ?? null, known: knownFlags().includes(id) } }))
    }
    case 'events': return GAMEPLAY.events.map((e) => ({ id: e.id, label: eventTitle(e), info: { state: ctx.save.events?.[e.id] ?? null } }))
    case 'bosses': return Object.entries(CONTENT.bosses).map(([id, b]) => ({ id, label: t(b.title), info: { species: b.species, level: b.level } }))
    case 'trainers': return Object.values(world.trainers).map((tr) => ({ id: tr.id, label: tr.nameZh, info: { defeated: !!ctx.save.flags[STORY_CONTENT.meta.flags.trainerWon + tr.id] } }))
    case 'badges': return world.badges.map((b) => ({ id: b.id, label: b.nameZh ?? b.id, info: { have: ctx.save.badges.includes(b.id) } }))
    case 'statuses': return CONTENT.statuses.map((s) => ({ id: s.id, label: s.nameZh }))
    case 'weathers': return Object.keys(GAME.region.weatherIntensity).map((id) => ({ id, label: id }))
    case 'scenarios': return Object.keys(host.content.scenarios).sort().map((id) => ({ id, label: t(host.content.scenarios[id].titleKey) }))
    case 'beats': return Object.entries(host.content.beats).map(([id, b]) => ({ id, label: t(b.titleKey) }))
    case 'teams': return Object.entries(host.content.teams).map(([id, tm]) => ({ id, label: id, info: { level: tm.level, members: tm.members.length } }))
    case 'tips': return TUTORIAL.tips.list.map((tip) => ({ id: tip.id, label: tip.id, info: { seen: tipSeen(ctx.save, tip.id), live: tipLive(tip, ctx.save) } }))
    case 'roamers': return overworld.roamerInfo().map((r, i) => ({ id: String(i), label: `${CONTENT.species[r.speciesId]?.nameZh ?? r.speciesId} Lv${r.level}`, info: { x: Math.round(r.x), y: Math.round(r.y), mood: r.mood } }))
  }
}

/** Entries of a source whose id or label contains `query` (case-insensitive), at most `limit`. */
export function listEntries(host: DevHost, source: string, query = '', limit = 50): ListEntry[] {
  if (!(LIST_SOURCES as readonly string[]).includes(source)) return []
  const q = query.trim().toLowerCase()
  const all = entries(host, source as ListSource)
  return (q ? all.filter((e) => e.id.toLowerCase().includes(q) || e.label.toLowerCase().includes(q)) : all).slice(0, Math.max(1, limit))
}
