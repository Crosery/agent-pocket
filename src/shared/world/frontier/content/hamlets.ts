// Hamlet population (replaces the built-in 'fx-villagers' decorator): bounty givers next to a bounty board, the
// courier who receives deliveries from neighbouring hamlets and points the way, and villagers with archetype
// dialogue, gossip (rumors), sages (MYTHIC chain clues), tips and gifts. Anchors are a pure function of the site
// (layout spots first, then ring points); the chunk that contains an anchor places that NPC, so a hamlet split
// across chunks never duplicates or loses anyone.
import type { NpcDef, ScriptStep } from '../../../types.ts'
import { CONTENT } from '../../../content/index.ts'
import type { ChunkDecorContext, DecorSite, FrontierLookup } from '../decorate.ts'
import type { FrontierSite } from '../sites.ts'
import { bountyPlans, courierInbound, courierPersona, giverScript, hamletBounties, sitesAround, type Bounty } from './bounties.ts'
import { FRONTIER_PACK } from './data.ts'
import { archetypesFor, villagerScript, type Locale } from './people.ts'
import { bearing, biomeName, farness, findSpot, fitsProp, memo, pickLines, ringPoint, sayAll, siteRngOf, spotOk, text, type Params, type Pt } from './util.ts'

/** Place refs (templates + aliases) of the POI sites around a site (rumor / clue weighting). */
export function nearRefs(seed: number, look: FrontierLookup, site: FrontierSite): string[] {
  return memo(seed, `refs:${site.id}`, () => {
    const A = FRONTIER_PACK.common.templateAliases
    const out = new Set<string>()
    for (const s of [site, ...sitesAround(look, site, 1, (x) => x.type === 'poi')]) {
      if (s.type !== 'poi') continue
      out.add(s.template)
      for (const a of A[s.template] ?? []) out.add(a)
    }
    return [...out].sort()
  })
}

export function localeOf(seed: number, look: FrontierLookup, ds: DecorSite): Locale {
  return { biome: ds.region?.biome ?? CONTENT.biomes[ds.site.biome]?.id ?? '', dist: ds.site.dist, nearRefs: nearRefs(seed, look, ds.site) }
}

export function siteParams(ds: DecorSite): Params {
  const biome = ds.region?.biome ?? CONTENT.biomes[ds.site.biome]?.id
  return { place: ds.layout.nameZh, region: ds.region?.nameZh ?? '', biome: biomeName(biome), distance: Math.round(ds.site.dist), level: ds.layout.levelRange[0] }
}

type Role =
  | { kind: 'giver'; at: Pt; b: Bounty }
  | { kind: 'courier'; at: Pt }
  | { kind: 'villager'; at: Pt; k: number }

function roles(ctx: ChunkDecorContext, ds: DecorSite, bounties: readonly Bounty[]): Role[] {
  const L = ds.layout
  const rng = siteRngOf(ctx.seed, ds.site.id, 'hamlet-anchors')
  let si = 0
  const next = (): Pt => (si < L.spots.length ? L.spots[si++] : ringPoint(L.center, rng))
  const out: Role[] = []
  for (const b of bounties) out.push({ kind: 'giver', at: next(), b })
  out.push({ kind: 'courier', at: next() })
  const V = FRONTIER_PACK.villagers
  const n = rng.int(V.perHamlet[0], V.perHamlet[1])
  for (let k = 0; k < n; k++) out.push({ kind: 'villager', at: next(), k })
  return out
}

function courierScript(ctx: ChunkDecorContext, ds: DecorSite, rng: ReturnType<typeof siteRngOf>, params: Params): ScriptStep[] {
  const B = FRONTIER_PACK.bounties
  const look = ctx.lookup
  const site = ds.site
  const steps: ScriptStep[] = []
  for (const g of sitesAround(look, site, B.neighbourCells, (s) => s.type === 'hamlet')) {
    if (!bountyPlans(ctx.seed, look, g).some((p) => p.kind === 'deliver' && p.dest?.id === site.id)) continue
    for (const b of hamletBounties(ctx.seed, look, g, ctx.overworldId)) if (b.kind === 'deliver' && b.dest?.id === site.id) steps.push(courierInbound(b, ctx.seed))
  }
  steps.push(...sayAll(pickLines(B.courier.idle, rng), params))
  const home = ds.layout.center
  for (const n of sitesAround(look, site, B.neighbourCells, (s) => s.type === 'hamlet').slice(0, 2)) {
    const c = look.decorSite(n).layout.center
    steps.push({ op: 'say', text: text(B.courier.neighbour, { ...params, dir: bearing(home, c), dist: farness(home, c), name: look.decorSite(n).layout.nameZh }) })
  }
  return steps
}

function boardText(ds: DecorSite, bounties: readonly Bounty[]): string {
  const B = FRONTIER_PACK.bounties.board
  const entries = bounties.map((b) => text(b.daily ? B.daily : B.entry, { ...b.params, name: b.nameZh, giver: b.giver.name }))
  return text(B.format, { place: ds.layout.nameZh, entries: entries.join('\n') })
}

function placeBoard(ctx: ChunkDecorContext, ds: DecorSite, near: Pt, bounties: readonly Bounty[]): void {
  const B = FRONTIER_PACK.bounties.board
  const keepClear = ds.layout.doors.map((d) => d.front)
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, -1], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1]]) {
    const x = near.x + dx, y = near.y + dy
    if (!fitsProp(ctx, x, y, 1, 1) || !spotOk(ctx, x, y, { neighbours: 2, keepClear, spacing: 0 })) continue
    ctx.chunk.props.push({ prop: B.prop, x, y, rot: 0 })
    ctx.chunk.signs.push({ x, y, text: boardText(ds, bounties), kind: 'board' })
    ctx.occupy(x, y)
    return
  }
}

export function decorateHamlets(ctx: ChunkDecorContext): void {
  for (const ds of ctx.sites) if (ds.site.type === 'hamlet') decorateHamlet(ctx, ds)
}

function decorateHamlet(ctx: ChunkDecorContext, ds: DecorSite): void {
  const site = ds.site
  const P = FRONTIER_PACK.common.place
  const bounties = hamletBounties(ctx.seed, ctx.lookup, site, ctx.overworldId)
  const list = roles(ctx, ds, bounties)
  if (!list.some((r) => ctx.inChunk(r.at.x, r.at.y))) return
  const loc = localeOf(ctx.seed, ctx.lookup, ds)
  const params = siteParams(ds)
  const keepClear = ds.layout.doors.map((d) => d.front)
  const V = FRONTIER_PACK.villagers
  const archetypes = archetypesFor(loc)
  for (const r of list) {
    if (!ctx.inChunk(r.at.x, r.at.y)) continue
    const at = findSpot(ctx, r.at.x, r.at.y, P.search, { level: site.level, keepClear, away: ctx.chunk.npcs })
    if (!at) continue
    let npc: NpcDef
    if (r.kind === 'giver') {
      npc = { id: `${r.b.id}:giver`, x: at.x, y: at.y, facing: 'down', sprite: r.b.giver.sprite, nameZh: r.b.giver.name, role: 'questGiver', script: giverScript(r.b, ctx.seed) }
    } else if (r.kind === 'courier') {
      const rng = siteRngOf(ctx.seed, site.id, 'courier-lines')
      const cp = courierPersona(ctx.seed, site)
      npc = { id: `${site.id}:courier`, x: at.x, y: at.y, facing: 'down', sprite: cp.sprite, nameZh: cp.name, role: 'villager', script: courierScript(ctx, ds, rng, { ...params, name: cp.name }) }
    } else {
      const rng = siteRngOf(ctx.seed, site.id, `villager-${r.k}`)
      if (!archetypes.length) continue
      const arch = rng.weighted(archetypes, (a) => a.weight)
      const id = `${site.id}:villager-${r.k + 1}`
      const v = villagerScript(id, arch, loc, rng, params)
      npc = { id, x: at.x, y: at.y, facing: 'down', sprite: v.sprite, nameZh: v.name, role: 'villager', script: v.script, wander: V.wander }
    }
    ctx.chunk.npcs.push(npc)
    ctx.occupy(at.x, at.y)
    if (r.kind === 'giver' && r.b.k === 0) placeBoard(ctx, ds, at, bounties)
  }
}
