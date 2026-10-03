// Frontier content pack: registers the content decorators (imported once by frontier/index.ts) and exposes the
// id resolvers the client / server need for objects that live outside world.trainers / world.quests:
//
//   frontierTrainer(world, id)        TrainerDef of a frontier trainer id (registered into world.trainers).
//   frontierQuest(world, id)          QuestDef of a frontier bounty id (pushed into world.quests).
//   registerFrontierRefs(world, npcs) resolves every trainer / quest referenced by these NPCs (call when a chunk or a
//                                     frontier interior is loaded).
//   restoreFrontierQuests(world, save) re-registers bounties already in SaveData.quests (call after loading a save).
//   frontierPlaceRefs(world, placeId) extra ids a frontier place counts as for EventCondition.nearPlace
//                                     ('<template>-<placeId>', incl. common.json templateAliases).
//
// Id formats: wandering trainers `ft:<cx>:<cy>:<n>`; site trainers `<siteId>:guardian` / `<siteId>:boss`;
// bounties `<hamletSiteId>:bounty-<k>` (quest), `…:bounty-<k>:outlaw` (trainer), `…:giver` / `…:partner` (NPCs);
// NPCs `<siteId>:courier|keeper|watcher|hermit|merchant|villager-<n>`, `fh:<cx>:<cy>` / `fm:<cx>:<cy>` camps,
// cache items `fi:<cx>:<cy>:c0`. Flags: content/world/frontier-content/bounties.json `flags`, `<npcId>:gift`,
// `<npcId>:taught`, `<npcId>:notes`, plus the story `trainer:<id>` won flags and gameplay `rumor:<event>` flags.
import type { NpcDef, QuestDef, SaveData, ScriptStep, TrainerDef, World } from '../../../types.ts'
import type { FrontierLookup } from '../decorate.ts'
import { registerChunkDecorator, registerInteriorDecorator } from '../decorate.ts'
import type { FrontierProvider } from '../provider.ts'
import { hamletBounties, parseBountyId } from './bounties.ts'
import { FRONTIER_PACK } from './data.ts'
import { decorateHamlets } from './hamlets.ts'
import { decorateDungeon, decorateResidents } from './interiors.ts'
import { bossBuild, decorateLandmarks, guardianBuild } from './landmarks.ts'
import { chunkTrainer, parseWandererId } from './registry.ts'
import { decorateWild } from './wild.ts'

export { FRONTIER_PACK } from './data.ts'
export { validateFrontierPack } from './validate.ts'
export { chunkTrainers } from './registry.ts'
export { hamletBounties, bountyPlans, parseBountyId } from './bounties.ts'
export { siteRoles, guardianBuild, bossBuild } from './landmarks.ts'

// Replaces the generic built-ins of the same id (same order), adds the rest after them.
registerChunkDecorator('fx-villagers', decorateHamlets, 0)
registerChunkDecorator('fxc-landmarks', decorateLandmarks, 10)
registerChunkDecorator('fxc-wild', decorateWild, 20)
registerInteriorDecorator('fx-residents', decorateResidents, 1)
registerInteriorDecorator('fxc-dungeon', decorateDungeon, 10)

/** The infinite overworld's provider of a world (null for finite worlds). */
export function frontierProvider(world: World): FrontierProvider | null {
  const own = world.maps[world.startMap]?.infinite
  if (own) return own as FrontierProvider
  for (const m of Object.values(world.maps)) if (m.infinite) return m.infinite as FrontierProvider
  return null
}

export function lookupOf(P: FrontierProvider): FrontierLookup {
  return {
    cell: P.grid.cell,
    siteAt: (sx, sy) => P.grid.siteAt(sx, sy),
    decorSite: (s) => P.decorSite(s),
    region: (id) => P.region(id),
    edgesNear: (x0, y0, x1, y1, pad) => P.roads.edgesNear(x0, y0, x1, y1, pad),
    distance: (x, y) => P.distance(x, y),
  }
}

function resolveTrainer(P: FrontierProvider, id: string): TrainerDef | null {
  const w = parseWandererId(id)
  if (w) return chunkTrainer(P.chunk(w.cx, w.cy), id)
  const s = P.siteOf(id)
  if (!s || s.part === null) return null
  const look = lookupOf(P)
  if (s.part === 'guardian') return guardianBuild(P.seed, look, s.site)?.def ?? null
  if (s.part === 'boss') return bossBuild(P.seed, s.site, P.decorSite(s.site).layout)?.def ?? null
  const m = /^bounty-\d+:outlaw$/.exec(s.part)
  if (m) return hamletBounties(P.seed, look, s.site, P.overworldId).find((b) => b.outlaw?.def.id === id)?.outlaw?.def ?? null
  return null
}

/** TrainerDef for a frontier trainer id; registered into world.trainers so battle code finds it by id. */
export function frontierTrainer(world: World, id: string): TrainerDef | null {
  const hit = world.trainers[id]
  if (hit) return hit
  const P = frontierProvider(world)
  const def = P ? resolveTrainer(P, id) : null
  if (def) world.trainers[id] = def
  return def
}

/** QuestDef for a frontier bounty id; pushed into world.quests (once) so the quest log / applyQuest find it. */
export function frontierQuest(world: World, id: string): QuestDef | null {
  const hit = world.quests.find((q) => q.id === id)
  if (hit) return hit
  const P = frontierProvider(world)
  const parsed = parseBountyId(id)
  if (!P || !parsed) return null
  const s = P.siteOf(parsed.siteId)
  if (!s || s.part !== null) return null
  const q = hamletBounties(P.seed, lookupOf(P), s.site, P.overworldId).find((b) => b.id === id)?.quest ?? null
  if (q) world.quests.push(q)
  return q
}

function walk(steps: readonly ScriptStep[], visit: (s: ScriptStep) => void): void {
  for (const s of steps) {
    visit(s)
    if (s.op === 'choice') for (const b of s.branches) walk(b, visit)
    else if ('then' in s) { walk(s.then, visit); if (s.else) walk(s.else, visit) }
  }
}

/** Resolves every frontier trainer / quest the NPCs reference (idempotent). Returns how many refs were resolved. */
export function registerFrontierRefs(world: World, npcs: readonly NpcDef[]): number {
  let n = 0
  for (const npc of npcs) {
    if (npc.trainer && frontierTrainer(world, npc.trainer)) n++
    walk(npc.script, (s) => {
      if (s.op === 'battle' && frontierTrainer(world, s.trainer)) n++
      else if (s.op === 'quest' && frontierQuest(world, s.quest)) n++
    })
  }
  return n
}

/** Re-registers frontier bounties a save has started (quest log after a reload). */
export function restoreFrontierQuests(world: World, save: Pick<SaveData, 'quests'>): number {
  let n = 0
  for (const id of Object.keys(save.quests)) if (parseBountyId(id) && frontierQuest(world, id)) n++
  return n
}

/** Extra ids a frontier place matches in EventCondition.nearPlace / revealPlace 'nearest:<template>' refs. */
export function frontierPlaceRefs(world: World, placeId: string): string[] {
  const P = frontierProvider(world)
  const s = P?.siteOf(placeId)
  if (!s || s.part !== null) return []
  const t = s.site.template
  return [t, ...(FRONTIER_PACK.common.templateAliases[t] ?? [])].map((x) => `${x}-${placeId}`)
}
