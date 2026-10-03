// Frontier bounties: every hamlet posts 2-3 small requests in the story bounty format (content/world/story/bounties.json
// kinds / personas / texts / reward table), adapted to the infinite map: deliveries to a neighbouring hamlet's
// courier, outlaws camping beside the hamlet's roads, finding a traveller at a nearby landmark, catching local
// types, and daily (repeatable) supply runs. Everything is a pure function of (seed, hamlet site), so the giver's
// chunk, the destination's chunk and the id resolvers all agree without any generation order.
import type { NpcDef, QuestDef, ScriptStep } from '../../../types.ts'
import { CONTENT } from '../../../content/index.ts'
import { fmt } from '../../grid.ts'
import type { Rng } from '../../random.ts'
import { compiledFrontier } from '../config.ts'
import type { FrontierLookup } from '../decorate.ts'
import type { RoadEdge } from '../roads.ts'
import type { FrontierSite } from '../sites.ts'
import { bountyReward, FRONTIER_PACK } from './data.ts'
import type { BountyKindSpec, FrontierBountyKind, Lines, StoryBountyKind, TrainerClass } from './schema.ts'
import { classTrainer, trainerNpc, trainerScript, trainerWonFlag, type TrainerBuild } from './teams.ts'
import { bearing, farness, memo, pickLines, ringPoint, say, sayAll, siteRngOf, text, type Params, type Pt } from './util.ts'

export interface BountyPlan {
  /** Quest id `<hamletSiteId>:bounty-<k>`. */
  id: string
  k: number
  kind: FrontierBountyKind
  daily: boolean
  /** deliver: hamlet; visit: landmark. */
  dest: FrontierSite | null
  /** hunt: outlaw road tile; visit: partner point near the landmark. */
  anchor: Pt | null
  /** hunt: the road's far end (null = causeway gate). */
  roadTo: FrontierSite | null
}

export interface Bounty extends BountyPlan {
  site: FrontierSite
  story: StoryBountyKind
  spec: BountyKindSpec
  nameZh: string
  giver: { sprite: string; name: string; lines: Lines }
  params: Params
  quest: QuestDef | null
  flags: { given: string; done: string; found: string; daily: string }
  parcel?: string
  outlaw?: TrainerBuild
  partner?: { sprite: string; name: string }
  type?: string
  count?: number
  item?: string
  qty?: number
  money: number
}

const KINDS: readonly FrontierBountyKind[] = ['deliver', 'hunt', 'catch', 'fetch', 'visit']

let OFF_ROAD: Set<number> | null = null
/** Road tile terrains with no roadside land (outlaw camps skip them). */
const offRoad = (): Set<number> => {
  if (OFF_ROAD) return OFF_ROAD
  const cf = compiledFrontier()
  return (OFF_ROAD = new Set([cf.bridge, cf.causeway, cf.stairs]))
}

export const bountyId = (siteId: string, k: number): string => `${siteId}:bounty-${k}`

/** Bounty quest id -> hamlet site id + index, or null. */
export function parseBountyId(id: string): { siteId: string; k: number } | null {
  const m = /^(fx:.+):bounty-(\d+)$/.exec(id)
  return m ? { siteId: m[1], k: Number(m[2]) } : null
}

function storyKind(spec: BountyKindSpec): StoryBountyKind | null {
  return FRONTIER_PACK.story.kinds?.[spec.story] ?? null
}

/** Sites of the given types/kinds within `cells` site cells of `site`, nearest first (ties by id). */
export function sitesAround(look: FrontierLookup, site: FrontierSite, cells: number, ok: (s: FrontierSite) => boolean): FrontierSite[] {
  const out: FrontierSite[] = []
  for (let sy = site.sy - cells; sy <= site.sy + cells; sy++) {
    for (let sx = site.sx - cells; sx <= site.sx + cells; sx++) {
      if (sx === site.sx && sy === site.sy) continue
      const s = look.siteAt(sx, sy)
      if (s && ok(s)) out.push(s)
    }
  }
  const d = (s: FrontierSite) => (s.x - site.x) * (s.x - site.x) + (s.y - site.y) * (s.y - site.y)
  return out.sort((a, b) => d(a) - d(b) || (a.id < b.id ? -1 : 1))
}

/** Road edges ending at a site (drawn path tiles walk away from it). */
export function roadsOf(look: FrontierLookup, site: FrontierSite): { edge: RoadEdge; fromStart: boolean }[] {
  const r = Math.ceil(site.radius) + 1
  const out: { edge: RoadEdge; fromStart: boolean }[] = []
  for (const e of look.edgesNear(site.x - r, site.y - r, site.x + r + 1, site.y + r + 1, 0)) {
    if (e.a?.id === site.id) out.push({ edge: e, fromStart: true })
    else if (e.b.id === site.id) out.push({ edge: e, fromStart: false })
  }
  return out.sort((a, b) => (a.edge.id < b.edge.id ? -1 : 1))
}

/** Cheap plan (kinds, destinations, anchors) — no layouts of other sites are built. */
export function bountyPlans(seed: number, look: FrontierLookup, site: FrontierSite): BountyPlan[] {
  if (site.type !== 'hamlet') return []
  return memo(seed, `bplan:${site.id}`, () => {
    const B = FRONTIER_PACK.bounties
    const rng = siteRngOf(seed, site.id, 'bounties')
    const n = rng.int(B.perHamlet[0], B.perHamlet[1])
    const left = KINDS.filter((k) => B.kinds[k] && site.dist >= (B.kinds[k].minDistance ?? 0) && storyKind(B.kinds[k]))
    const out: BountyPlan[] = []
    for (let k = 0; k < n && left.length; k++) {
      const kind = rng.weighted(left, (x) => B.kinds[x].weight)
      left.splice(left.indexOf(kind), 1)
      const spec = B.kinds[kind]
      const plan: BountyPlan = { id: bountyId(site.id, out.length), k: out.length, kind, daily: !!spec.daily, dest: null, anchor: null, roadTo: null }
      if (kind === 'deliver' || kind === 'visit') {
        const kinds = spec.destKinds ?? []
        const cands = sitesAround(look, site, B.neighbourCells, (s) => kinds.includes(s.kind.id) && (kind === 'deliver' ? s.type === 'hamlet' : s.type !== 'hamlet'))
        if (!cands.length) { k--; continue }
        plan.dest = cands[rng.int(0, Math.min(cands.length, 3) - 1)]
        if (kind === 'visit') plan.anchor = ringPoint({ x: plan.dest.x, y: plan.dest.y }, rng)
      } else if (kind === 'hunt') {
        const roads = roadsOf(look, site).filter((r) => r.edge.xs.length > (spec.road?.[1] ?? 0) + 2)
        if (!roads.length) { k--; continue }
        const { edge, fromStart } = rng.pick(roads)
        const n0 = edge.xs.length
        // First drawn tile walking away from the hamlet, then `road` tiles further along.
        let first = 0
        for (let j = 0; j < n0; j++) { const i = fromStart ? j : n0 - 1 - j; if (edge.drawn[i]) { first = j; break } }
        // Nearest drawn land tile to the rolled step (forward first): never a bridge / causeway / stair over water.
        const want = Math.min(n0 - 1, first + rng.int(spec.road?.[0] ?? 0, spec.road?.[1] ?? 0))
        const land = (j: number) => { const i = fromStart ? j : n0 - 1 - j; return edge.drawn[i] === 1 && !offRoad().has(edge.terrain[i]) }
        let step = -1
        for (let j = want; j < n0 && step < 0; j++) if (land(j)) step = j
        for (let j = want - 1; j > first && step < 0; j--) if (land(j)) step = j
        if (step < 0) { k--; continue }
        const i = fromStart ? step : n0 - 1 - step
        plan.anchor = { x: edge.xs[i], y: edge.ys[i] }
        plan.roadTo = fromStart ? edge.b : edge.a
      }
      out.push(plan)
    }
    return out
  })
}

function persona(list: StoryBountyKind['giver'], rng: Rng): { sprite: string; name: string; lines: Lines } {
  const p = list && list.length ? rng.pick(list) : null
  return { sprite: p?.sprite ?? '', name: p ? rng.pick(p.names) : '', lines: p?.lines?.length ? rng.pick(p.lines) : [] }
}

function rewardOf(level: number, mul: number, rng: Rng): { money: number; items?: Record<string, number> } {
  const R = bountyReward()
  if (!R) return { money: 0 }
  const money = Math.max(R.round, Math.round((R.moneyPerLevel * level * mul) / R.round) * R.round)
  const band = R.items.find((b) => level <= b.maxLevel) ?? R.items[R.items.length - 1]
  const pool = (band?.pool ?? []).filter((e) => Object.keys(e).every((id) => CONTENT.items[id]))
  return pool.length ? { money, items: { ...rng.pick(pool) } } : { money }
}

/** Outlaw persona of the story 'defeat' kind as a trainer class. */
function outlawClass(rng: Rng): TrainerClass | null {
  const list = FRONTIER_PACK.story.kinds?.[FRONTIER_PACK.bounties.outlawStory]?.trainer ?? []
  if (!list.length) return null
  const p = rng.pick(list)
  return { id: 'outlaw', classZh: p.classZh, sprites: [p.sprite], names: p.names, biomes: 'any', types: p.types, weight: 1, intro: p.introText, defeat: p.defeatText, after: p.after }
}

/** Display name of a hamlet's courier (pure; used by deliveries addressed to that hamlet). */
export function courierPersona(seed: number, site: FrontierSite): { sprite: string; name: string } {
  const C = FRONTIER_PACK.bounties.courier
  const rng = siteRngOf(seed, site.id, 'courier')
  return { sprite: rng.pick(C.sprites), name: rng.pick(C.names) }
}

/** Full bounties of a hamlet (names, personas, texts, rewards, quest defs, outlaw trainers). */
export function hamletBounties(seed: number, look: FrontierLookup, site: FrontierSite, overworldId: string): Bounty[] {
  if (site.type !== 'hamlet') return []
  return memo(seed, `bfull:${overworldId}:${site.id}`, () => {
    const B = FRONTIER_PACK.bounties
    const ds = look.decorSite(site)
    const home = ds.layout.center
    const level = ds.layout.levelRange[1]
    const out: Bounty[] = []
    for (const plan of bountyPlans(seed, look, site)) {
      const spec = B.kinds[plan.kind]
      const story = storyKind(spec)!
      const rng = siteRngOf(seed, plan.id, 'detail')
      const giver = persona(story.giver, rng)
      const flags = {
        given: fmt(B.flags.given, { quest: plan.id }), done: fmt(B.flags.done, { quest: plan.id }),
        found: fmt(B.flags.found, { quest: plan.id }), daily: fmt(B.flags.daily, { quest: plan.id }),
      }
      const params: Params = { place: ds.layout.nameZh, giverSite: ds.layout.nameZh, giverName: giver.name }
      let target: Pt | null = null
      const b: Bounty = { ...plan, site, story, spec, nameZh: '', giver, params, quest: null, flags, money: 0 }
      if (plan.kind === 'deliver' && plan.dest) {
        const dd = look.decorSite(plan.dest)
        const parcels = (story.parcels ?? []).filter((id) => CONTENT.items[id])
        if (!parcels.length) continue
        b.parcel = rng.pick(parcels)
        target = dd.layout.center
        Object.assign(params, { parcel: b.parcel, destName: dd.layout.nameZh, partnerName: courierPersona(seed, plan.dest).name })
      } else if (plan.kind === 'visit' && plan.dest && plan.anchor) {
        const dd = look.decorSite(plan.dest)
        const p = persona(story.partner, rng)
        b.partner = { sprite: p.sprite, name: p.name }
        target = plan.anchor
        Object.assign(params, { destName: dd.layout.nameZh, partnerName: p.name })
      } else if (plan.kind === 'hunt' && plan.anchor) {
        const cls = outlawClass(rng)
        if (!cls) continue
        const region = ds.region
        const destName = plan.roadTo ? fmt(spec.destName ?? '{name}', { name: look.decorSite(plan.roadTo).layout.nameZh }) : spec.gateName ?? ''
        b.outlaw = classTrainer(`${plan.id}:outlaw`, cls, {
          biome: region?.biome ?? CONTENT.biomes[site.biome]?.id ?? '', levelRange: ds.layout.levelRange, dist: site.dist, types: cls.types,
          levelBonus: story.levelBonus ?? 0, sizeBonus: 0, rarity: FRONTIER_PACK.trainers.party.rarity, size: spec.partySize,
        }, rng, { place: ds.layout.nameZh })
        target = plan.anchor
        Object.assign(params, { destName, trainerClass: b.outlaw.def.classZh, trainerName: b.outlaw.def.nameZh })
      } else if (plan.kind === 'catch') {
        const counts = new Map<string, number>()
        for (const slot of ds.region?.encounters ?? []) for (const ty of CONTENT.species[slot.species]?.types ?? []) counts.set(ty, (counts.get(ty) ?? 0) + slot.weight)
        const types = [...counts.entries()].sort((a, b2) => (a[0] < b2[0] ? -1 : 1))
        if (!types.length) continue
        b.type = rng.weighted(types, (e) => e[1])[0]
        b.count = rng.int(story.catchCount?.[0] ?? 1, story.catchCount?.[1] ?? 1)
        Object.assign(params, { type: b.type, count: b.count })
      } else if (plan.kind === 'fetch') {
        const f = story.fetch
        const band = f?.bands.find((x) => level <= x.maxLevel) ?? f?.bands[f.bands.length - 1]
        const items = (band?.items ?? []).filter((id) => CONTENT.items[id])
        if (!f || !items.length) continue
        b.item = rng.pick(items)
        b.qty = rng.int(f.qty[0], f.qty[1])
        Object.assign(params, { item: b.item, qty: b.qty })
      } else continue
      if (target) Object.assign(params, { destDir: bearing(home, target), destDist: farness(home, target) })
      b.nameZh = text(story.names.length ? rng.pick(story.names) : '', params)
      b.giver.lines = b.giver.lines.map((l) => text(l, params))
      const reward = rewardOf(level, spec.rewardMul ?? story.rewardMul ?? 1, rng)
      b.money = reward.money
      if (!plan.daily) {
        b.quest = {
          id: plan.id, nameZh: b.nameZh, kind: 'side',
          stages: story.stages.map((st) => {
            const at = st.target === 'partner' ? target : st.target === 'giver' ? home : null
            return at ? { text: text(st.text, params), target: { map: overworldId, x: at.x, y: at.y } } : { text: text(st.text, params) }
          }),
          reward,
        }
      }
      out.push(b)
    }
    return out
  })
}

const pickText = (b: Bounty, key: string, rng: Rng): string => {
  const pool = b.story.texts[key] ?? []
  return pool.length ? text(rng.pick(pool), b.params) : ''
}

/** The giver NPC's script (state machine over the bounty's flags). */
export function giverScript(b: Bounty, seed: number): ScriptStep[] {
  const B = FRONTIER_PACK.bounties
  const rng = siteRngOf(seed, b.id, 'script')
  const line = (key: string): ScriptStep[] => { const s = pickText(b, key, rng); return s ? [{ op: 'say', text: s }] : [] }
  const pitch: ScriptStep[] = b.giver.lines.map((l) => ({ op: 'say', text: l }) as ScriptStep)
  const stage0 = b.quest?.stages[0]?.text
  const accept = (yes: ScriptStep[]): ScriptStep => ({
    op: 'choice', text: text(B.accept.question, b.params), options: B.accept.options.slice(), branches: [yes, line('decline')],
  })
  const startQuest: ScriptStep[] = [{ op: 'setFlag', flag: b.flags.given }, { op: 'quest', quest: b.id, stage: 0 }, ...(stage0 ? [{ op: 'say', text: stage0 } as ScriptStep] : [])]
  const done = (stage: number): ScriptStep[] => [...line('giverThanks'), { op: 'setFlag', flag: b.flags.done }, { op: 'quest', quest: b.id, stage, done: true }]
  switch (b.kind) {
    case 'deliver':
      return [{
        op: 'ifFlag', flag: b.flags.done, then: line('doneLine'),
        else: [{ op: 'ifFlag', flag: b.flags.given, then: line('reminder'), else: [...pitch, accept([{ op: 'giveItem', item: b.parcel!, qty: 1 }, ...startQuest])] }],
      }]
    case 'visit':
      return [{
        op: 'ifFlag', flag: b.flags.done, then: line('doneLine'),
        else: [{
          op: 'ifFlag', flag: b.flags.found, then: done(1),
          else: [{ op: 'ifFlag', flag: b.flags.given, then: line('reminder'), else: [...pitch, accept(startQuest)] }],
        }],
      }]
    case 'hunt':
      return [{
        op: 'ifFlag', flag: b.flags.done, then: line('doneLine'),
        else: [{
          op: 'ifFlag', flag: b.flags.given,
          then: [{ op: 'ifFlag', flag: trainerWonFlag(b.outlaw!.def.id), then: done(1), else: line('reminder') }],
          else: [...pitch, accept(startQuest)],
        }],
      }]
    case 'catch':
      return [{
        op: 'ifFlag', flag: b.flags.done, then: line('doneLine'),
        else: [{
          op: 'ifFlag', flag: b.flags.given,
          then: [{ op: 'ifCaught', type: b.type!, atLeast: b.count!, then: done(0), else: line('reminder') }],
          else: [...pitch, accept(startQuest)],
        }],
      }]
    case 'fetch': {
      const D = B.daily
      return [{
        op: 'ifFlag', flag: b.flags.daily, then: sayAll(pickLines(D.doneToday, rng), b.params),
        else: [...pitch, {
          op: 'ifItem', item: b.item!, atLeast: b.qty!,
          then: [{
            op: 'choice', text: text(D.handIn, b.params), options: D.options.slice(), branches: [
              [{ op: 'takeItem', item: b.item!, qty: b.qty! }, { op: 'setFlag', flag: b.flags.daily }, { op: 'giveMoney', amount: b.money }, ...line('giverThanks')],
              line('decline'),
            ],
          }],
          else: [...sayAll(pickLines(D.notEnough, rng), b.params), ...line('reminder')],
        }],
      }]
    }
  }
}

/** Steps a hamlet courier runs for deliveries addressed to it (each ends the script once handled). */
export function courierInbound(b: Bounty, seed: number): ScriptStep {
  const rng = siteRngOf(seed, b.id, 'courier')
  const p = b.params
  const thanks = pickText(b, 'partnerThanks', rng)
  return {
    op: 'ifFlag', flag: b.flags.given, else: [],
    then: [{
      op: 'ifFlag', flag: b.flags.done, then: [],
      else: [{
        op: 'ifItem', item: b.parcel!, else: [],
        then: [
          say(FRONTIER_PACK.bounties.courier.inboundHint, p),
          { op: 'takeItem', item: b.parcel!, qty: 1 },
          ...(thanks ? [{ op: 'say', text: thanks } as ScriptStep] : []),
          { op: 'setFlag', flag: b.flags.done },
          { op: 'quest', quest: b.id, stage: 0, done: true },
          { op: 'end' },
        ],
      }],
    }],
  }
}

/** The traveller a 'visit' bounty sends the player to (shown only while the bounty is open). */
export function visitPartnerNpc(b: Bounty, seed: number, x: number, y: number): NpcDef {
  const rng = siteRngOf(seed, b.id, 'partner')
  const found = pickText(b, 'partnerFound', rng)
  const wait = pickText(b, 'partnerWait', rng)
  return {
    id: `${b.id}:partner`, x, y, facing: 'down', sprite: b.partner!.sprite, nameZh: b.partner!.name, role: 'villager',
    hiddenUnlessFlag: b.flags.given, hiddenIfFlag: b.flags.done,
    script: [{
      op: 'ifFlag', flag: b.flags.found, then: wait ? [{ op: 'say', text: wait }] : [],
      else: [...(found ? [{ op: 'say', text: found } as ScriptStep] : []), { op: 'setFlag', flag: b.flags.found }, { op: 'quest', quest: b.id, stage: 1 }],
    }],
  }
}

/** The outlaw of a 'hunt' bounty (appears once the bounty is accepted; advances the quest when beaten). */
export function outlawNpc(b: Bounty, x: number, y: number, facing: NpcDef['facing']): NpcDef {
  const o = b.outlaw!
  const npc = trainerNpc(o.def, x, y, facing, trainerScript(o.def.id, String(o.params.after ?? ''), [
    { op: 'ifFlag', flag: trainerWonFlag(o.def.id), then: [{ op: 'quest', quest: b.id, stage: 1 }] },
  ]), b.spec.sightRange ?? 0)
  npc.hiddenUnlessFlag = b.flags.given
  return npc
}
