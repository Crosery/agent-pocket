// Pure game-screen logic (no DOM): dex filters, shop prices, item effects in the field, box moves, map
// navigation, quest lists. Everything reads data from CONTENT / SaveData; failures return text keys.
import type { Creature, Dir, GameMap, ItemDef, NatureDef, QuestDef, SaveData, SpeciesDef, StatKey, StatusId, TypeId, Warp, World } from '../../../shared/types.ts'
import { CONTENT, typeEffectiveness, type Content } from '../../../shared/content/index.ts'
import { STAT_KEYS, expForLevel, legalMoves, maxHp } from '../../../shared/creature.ts'
import { gradeOf, gradeRank } from '../../../shared/gameplay/quality.ts'
import { getMap } from '../../../shared/world/worldapi.ts'
import type { ScreensConfig, SettingsField } from './config.ts'

// ---------------------------------------------------------------------------
// Economy
// ---------------------------------------------------------------------------

export function sellPrice(item: ItemDef, c: Content = CONTENT): number {
  return Math.max(0, Math.floor(item.price * c.config.economy.sellRatio))
}

/** Buy price under a world-event multiplier (Screens.shop priceMul); never below 1. */
export function shopBuyPrice(item: ItemDef, mul = 1): number {
  return mul === 1 ? item.price : Math.max(1, Math.round(item.price * mul))
}

/** The English name when it adds something (75 of 190 species are named identically in both languages). */
export const extraEnglishName = (sp: Pick<SpeciesDef, 'nameZh' | 'nameEn'>): string | null => (sp.nameEn && sp.nameEn !== sp.nameZh ? sp.nameEn : null)

export const canSell = (item: ItemDef): boolean => item.category !== 'key' && item.price > 0

/** Largest quantity purchasable with `money` (0 when unaffordable). */
export function maxAffordable(price: number, money: number, cap: number): number {
  if (price <= 0) return Math.max(0, cap)
  return Math.max(0, Math.min(cap, Math.floor(money / price)))
}

export function addItem(save: SaveData, itemId: string, qty: number): void {
  const next = (save.bag[itemId] ?? 0) + Math.floor(qty)
  if (next > 0) save.bag[itemId] = next
  else delete save.bag[itemId]
}

// ---------------------------------------------------------------------------
// Bag
// ---------------------------------------------------------------------------

export interface BagEntry { item: ItemDef; qty: number }

/** Bag contents shown under a tab, in content order. Battle mode keeps only items usable in battle. */
export function bagEntries(save: SaveData, tab: ScreensConfig['bag']['tabs'][number], mode: 'field' | 'battle', c: Content = CONTENT): BagEntry[] {
  const out: BagEntry[] = []
  for (const item of c.itemList) {
    const qty = save.bag[item.id] ?? 0
    if (qty <= 0 || !tab.categories.includes(item.category)) continue
    if (mode === 'battle' && !item.usableInBattle) continue
    out.push({ item, qty })
  }
  return out
}

// ---------------------------------------------------------------------------
// Creatures
// ---------------------------------------------------------------------------

export const isConscious = (cr: Creature): boolean => cr.hp > 0

export function ivStars(iv: number, ivMax: number, count: number): number {
  if (ivMax <= 0 || count <= 0) return 0
  return Math.max(0, Math.min(count, Math.round((iv / ivMax) * count)))
}

export interface ExpProgress { level: number; into: number; need: number; toNext: number; ratio: number; max: boolean }

export function expProgress(cr: Creature, c: Content = CONTENT): ExpProgress {
  const sp = c.species[cr.speciesId]
  const growth = sp?.growth ?? Object.keys(c.config.growth)[0]
  const max = cr.level >= c.config.party.maxLevel
  const base = expForLevel(growth, cr.level, c)
  const next = expForLevel(growth, Math.min(c.config.party.maxLevel, cr.level + 1), c)
  const need = Math.max(1, next - base)
  const into = Math.max(0, Math.min(need, cr.exp - base))
  return { level: cr.level, into, need, toNext: max ? 0 : Math.max(0, next - cr.exp), ratio: max ? 1 : into / need, max }
}

export interface MatchupGroup { mul: number; types: TypeId[] }

/** Defensive multipliers of a type combination, grouped (multiplier 1 omitted), weakest first. */
export function defensiveProfile(types: readonly TypeId[], c: Content = CONTENT): MatchupGroup[] {
  const groups = new Map<number, TypeId[]>()
  for (const atk of c.types) {
    const m = typeEffectiveness(atk.id, types, c)
    if (m === 1) continue
    groups.set(m, [...(groups.get(m) ?? []), atk.id])
  }
  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([mul, ts]) => ({ mul, types: ts }))
}

export type TeachState = 'ok' | 'known' | 'unable'

/** Whether a creature can learn `moveId` from a chip: own teachables, any learnset level, or legal pre-evolution moves. */
export function teachState(cr: Creature, moveId: string, c: Content = CONTENT): TeachState {
  if (cr.moves.some((m) => m.id === moveId)) return 'known'
  const sp = c.species[cr.speciesId]
  if (!sp || !c.moves[moveId]) return 'unable'
  const learnable = sp.teachable.includes(moveId) || sp.learnset.some((l) => l.move === moveId) ||
    legalMoves(cr.speciesId, c.config.party.maxLevel, c).has(moveId)
  return learnable ? 'ok' : 'unable'
}

/** Linear evolution family of a species (root first), following evolvesFrom / evolvesTo. */
export function evolutionChain(speciesId: string, c: Content = CONTENT): SpeciesDef[] {
  let root = c.species[speciesId]
  if (!root) return []
  const seen = new Set<string>([root.id])
  while (root.evolvesFrom && c.species[root.evolvesFrom] && !seen.has(root.evolvesFrom)) {
    root = c.species[root.evolvesFrom]
    seen.add(root.id)
  }
  const chain: SpeciesDef[] = [root]
  const visited = new Set<string>([root.id])
  let cur: SpeciesDef | undefined = root
  while (cur?.evolvesTo && c.species[cur.evolvesTo.id] && !visited.has(cur.evolvesTo.id)) {
    cur = c.species[cur.evolvesTo.id]
    visited.add(cur.id)
    chain.push(cur)
  }
  return chain
}

/** Stats shown on summary/dex pages: the StatKeys of a Stats record, in CONTENT.stats order. */
export function statKeys(c: Content = CONTENT): StatKey[] {
  const keys: StatKey[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']
  return c.stats.map((s) => s.key).filter((k): k is StatKey => (keys as string[]).includes(k))
}

// ---------------------------------------------------------------------------
// Item effects in the field (medicine / level-up / evolve / chip). Failures are text keys.
// ---------------------------------------------------------------------------

export interface MedicineResult { hp: number; cured: StatusId | null; revived: boolean; pp: number }

/** null when the item would have an effect on this creature, else the reason (text key). */
export function medicineBlocker(cr: Creature, item: ItemDef, c: Content = CONTENT): string | null {
  const e = item.effect
  const max = maxHp(cr, c)
  const fainted = cr.hp <= 0
  switch (e.kind) {
    case 'heal':
      if (fainted) return 'screens.use.fainted'
      return cr.hp >= max ? 'screens.use.hpFull' : null
    case 'cure':
      if (fainted) return 'screens.use.fainted'
      return cr.status && (e.status === 'all' || e.status === cr.status) ? null : 'screens.use.noEffect'
    case 'healCure':
      if (fainted) return 'screens.use.fainted'
      return cr.hp < max || cr.status ? null : 'screens.use.noEffect'
    case 'revive':
      return fainted ? null : 'screens.use.notFainted'
    case 'pp':
      return cr.moves.some((m) => m.pp < m.ppMax) ? null : 'screens.use.ppFull'
    case 'levelUp':
      return cr.level >= c.config.party.maxLevel ? 'screens.use.maxLevel' : null
    case 'evolve':
      return c.species[cr.speciesId]?.evolvesTo && c.species[c.species[cr.speciesId].evolvesTo!.id] ? null : 'screens.use.cannotEvolve'
    case 'chip': {
      const s = teachState(cr, e.move, c)
      return s === 'ok' ? null : s === 'known' ? 'screens.use.known' : 'screens.use.cannotLearn'
    }
    case 'nature':
      return null
    default:
      return 'screens.use.noEffect'
  }
}

/** Effects that need a target creature when used from the bag. */
export const needsTarget = (item: ItemDef): boolean =>
  ['heal', 'cure', 'healCure', 'revive', 'pp', 'levelUp', 'evolve', 'chip', 'nature'].includes(item.effect.kind)

/** Single-move PP items need the player to pick a move. */
export const needsMovePick = (item: ItemDef): boolean => item.effect.kind === 'pp' && !item.effect.all

/** Applies a medicine (heal/cure/healCure/revive/pp). Mutates the creature. */
export function applyMedicine(cr: Creature, item: ItemDef, moveIndex = -1, c: Content = CONTENT): MedicineResult {
  const e = item.effect
  const max = maxHp(cr, c)
  const res: MedicineResult = { hp: 0, cured: null, revived: false, pp: 0 }
  const heal = (amount: number) => {
    const before = cr.hp
    cr.hp = Math.min(max, cr.hp + Math.max(0, Math.floor(amount)))
    res.hp = cr.hp - before
  }
  const cure = () => {
    if (cr.status) { res.cured = cr.status; cr.status = null; cr.statusTurns = 0 }
  }
  switch (e.kind) {
    case 'heal': heal(e.amount === 'full' ? max : e.amount); break
    case 'cure': if (cr.status && (e.status === 'all' || e.status === cr.status)) cure(); break
    case 'healCure': heal(max); cure(); break
    case 'revive':
      if (cr.hp <= 0) {
        cr.hp = Math.max(1, Math.floor(max * e.fraction))
        cure()
        res.revived = true
        res.hp = cr.hp
      }
      break
    case 'pp': {
      const slots = e.all ? cr.moves : cr.moves.filter((_, i) => i === moveIndex)
      for (const m of slots) {
        const before = m.pp
        m.pp = e.amount === 'full' ? m.ppMax : Math.min(m.ppMax, m.pp + e.amount)
        res.pp += m.pp - before
      }
      break
    }
    default: break
  }
  return res
}

// ---------------------------------------------------------------------------
// Dex
// ---------------------------------------------------------------------------

export type DexState = 'caught' | 'seen' | 'unseen'

export function dexState(save: SaveData, speciesId: string): DexState {
  if (save.dexCaught.includes(speciesId)) return 'caught'
  return save.dexSeen.includes(speciesId) ? 'seen' : 'unseen'
}

export function dexCounts(save: SaveData, c: Content = CONTENT): { seen: number; caught: number; total: number } {
  const caught = new Set(save.dexCaught.filter((id) => c.species[id]))
  const seen = new Set([...save.dexSeen.filter((id) => c.species[id]), ...caught])
  return { seen: seen.size, caught: caught.size, total: c.speciesList.length }
}

export interface DexFilter {
  type?: string
  rarity?: string
  country?: string
  company?: string
  caught?: DexState
  query?: string
}

export function countryMatches(code: string, group: ScreensConfig['dex']['countries'][number]): boolean {
  if (group.codes && !group.codes.includes(code)) return false
  if (group.exclude && group.exclude.includes(code)) return false
  return true
}

/**
 * Species visible under the filters. Attribute filters (type/rarity/country/company) and the text query only
 * match species the player has seen, so filtering never reveals unseen entries.
 */
export function filterDex(list: readonly SpeciesDef[], f: DexFilter, save: SaveData, countries: ScreensConfig['dex']['countries']): SpeciesDef[] {
  const q = f.query?.trim().toLowerCase() ?? ''
  const attr = !!(f.type || f.rarity || f.country || f.company || q)
  const group = f.country ? countries.find((g) => g.id === f.country) : undefined
  return list.filter((sp) => {
    const st = dexState(save, sp.id)
    if (f.caught && st !== f.caught) return false
    if (!attr) return true
    if (st === 'unseen') return false
    if (f.type && !sp.types.includes(f.type)) return false
    if (f.rarity && sp.rarity !== f.rarity) return false
    if (group && !countryMatches(sp.country, group)) return false
    if (f.company && sp.company !== f.company) return false
    if (q) {
      const hay = [sp.nameZh, sp.nameEn, sp.company, String(sp.dexNo)].join('\n').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

/** Distinct companies, most species first (ties by name). */
export function dexCompanies(list: readonly SpeciesDef[], save: SaveData, seenOnly: boolean): string[] {
  const count = new Map<string, number>()
  for (const sp of list) {
    if (seenOnly && dexState(save, sp.id) === 'unseen') continue
    count.set(sp.company, (count.get(sp.company) ?? 0) + 1)
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k)
}

// ---------------------------------------------------------------------------
// Box / party storage. Party and boxes are dense lists; an "empty slot" means "append here".
// ---------------------------------------------------------------------------

export interface Slot { area: 'party' | 'box'; box: number; index: number }

export function slotList(save: SaveData, s: Slot): Creature[] {
  if (s.area === 'party') return save.party
  while (save.boxes.length <= s.box) save.boxes.push([])
  return save.boxes[s.box]
}

export function creatureAt(save: SaveData, s: Slot): Creature | undefined {
  return slotList(save, s)[s.index]
}

const partyOk = (party: Creature[]) => party.length > 0 && party.some(isConscious)

/**
 * Moves the creature at `from` onto `to`: occupied target swaps, empty target appends to that list.
 * Returns null on success or a text key explaining why the move is not allowed (state unchanged).
 */
export function moveCreature(save: SaveData, from: Slot, to: Slot, c: Content = CONTENT): string | null {
  const src = slotList(save, from)
  const dst = slotList(save, to)
  const a = src[from.index]
  if (!a) return 'screens.box.err.empty'
  if (src === dst && from.index === to.index) return null
  const b = dst[to.index]
  const party = save.party.slice()
  const boxes = save.boxes.map((x) => x.slice())
  const list = (s: Slot) => (s.area === 'party' ? party : boxes[s.box])
  const ls = list(from)
  const ld = list(to)
  if (b) {
    ls[from.index] = b
    ld[to.index] = a
  } else {
    const cap = to.area === 'party' ? c.config.party.maxParty : c.config.party.boxSize
    if (ls !== ld && ld.length >= cap) return to.area === 'party' ? 'screens.box.err.partyFull' : 'screens.box.err.boxFull'
    ls.splice(from.index, 1)
    ld.push(a)
  }
  if (!partyOk(party)) return party.length === 0 ? 'screens.box.err.lastMember' : 'screens.box.err.needConscious'
  save.party = party
  save.boxes = boxes
  return null
}

export function releaseCreature(save: SaveData, at: Slot): string | null {
  const src = slotList(save, at)
  if (!src[at.index]) return 'screens.box.err.empty'
  if (at.area === 'party') {
    const rest = save.party.filter((_, i) => i !== at.index)
    if (!partyOk(rest)) return rest.length === 0 ? 'screens.box.err.lastMember' : 'screens.box.err.needConscious'
  }
  src.splice(at.index, 1)
  return null
}

// ---------------------------------------------------------------------------
// World map
// ---------------------------------------------------------------------------

export interface MapPoint { id: string; x: number; y: number }

const DIR_VEC: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }

/** Nearest point lying within 60 degrees of the direction from `from` (distance penalised by angle). */
export function pickInDirection(points: readonly MapPoint[], from: MapPoint, dir: Dir): MapPoint | null {
  const [vx, vy] = DIR_VEC[dir]
  let best: MapPoint | null = null
  let bestScore = Infinity
  for (const p of points) {
    if (p.id === from.id) continue
    const dx = p.x - from.x
    const dy = p.y - from.y
    const d = Math.hypot(dx, dy)
    if (d === 0) continue
    const cos = (dx * vx + dy * vy) / d
    if (cos < 0.5) continue
    const score = d * (2 - cos)
    if (score < bestScore) { bestScore = score; best = p }
  }
  return best
}

/**
 * The warp that finally leads from a place on any map back to the overworld: breadth-first over the warp graph
 * (interiors, caves, multi-floor dungeons incl. lazily generated frontier floors); among several exits on the
 * last map the one nearest to the arrival point wins. Null on the overworld or when no way out exists.
 */
export function overworldExit(world: World, mapId: string, x: number, y: number): Warp | null {
  const ow = world.startMap
  if (mapId === ow || !getMap(world, mapId)) return null
  const arrival = new Map<string, { x: number; y: number }>([[mapId, { x, y }]])
  const queue = [mapId]
  while (queue.length) {
    const id = queue.shift()!
    const here = getMap(world, id)
    if (!here) continue
    const at = arrival.get(id)!
    const outs = here.warps.filter((w) => w.toMap === ow)
    if (outs.length) return outs.slice().sort((a, b) => Math.hypot(a.x - at.x, a.y - at.y) - Math.hypot(b.x - at.x, b.y - at.y))[0]
    for (const w of here.warps) {
      if (arrival.has(w.toMap) || !getMap(world, w.toMap)) continue
      arrival.set(w.toMap, { x: w.toX, y: w.toY })
      queue.push(w.toMap)
    }
  }
  return null
}

/** Position on the overworld for a place on any map: follows exit warps (interiors / caves) back outside. */
export function overworldPosition(world: World, mapId: string, x: number, y: number): { x: number; y: number } | null {
  if (mapId === world.startMap) return getMap(world, mapId) ? { x, y } : null
  const exit = overworldExit(world, mapId, x, y)
  return exit ? { x: exit.toX, y: exit.toY } : null
}

// ---------------------------------------------------------------------------
// Quests
// ---------------------------------------------------------------------------

export interface QuestEntry { def: QuestDef; stage: number; done: boolean }

export function questEntries(world: World, save: SaveData, tab: ScreensConfig['quests']['tabs'][number]): QuestEntry[] {
  const out: QuestEntry[] = []
  for (const def of world.quests) {
    const p = save.quests[def.id]
    if (!p || !tab.kinds.includes(def.kind) || p.done !== tab.done) continue
    out.push({ def, stage: Math.max(0, Math.min(def.stages.length - 1, p.stage)), done: p.done })
  }
  return out
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function playTimeParts(sec: number): { h: number; m: string } {
  const s = Math.max(0, Math.floor(sec))
  return { h: Math.floor(s / 3600), m: String(Math.floor((s % 3600) / 60)).padStart(2, '0') }
}

/** Next value of a settings field when stepping by `dir` (-1/+1); choices wrap, sliders clamp. */
export function stepSetting(f: SettingsField, value: unknown, dir: number): unknown {
  if (f.kind === 'toggle') return !value
  if (f.kind === 'choice') {
    const opts = f.options ?? []
    if (!opts.length) return value
    const i = opts.indexOf(value as string | number)
    return opts[((i < 0 ? 0 : i + dir) % opts.length + opts.length) % opts.length]
  }
  const min = f.min ?? 0
  const max = f.max ?? 1
  const step = f.step ?? 0.1
  const v = typeof value === 'number' ? value : min
  const next = Math.round((v + dir * step) / step) * step
  return Math.min(max, Math.max(min, Number(next.toFixed(6))))
}

const ivTotal = (c: Creature): number => STAT_KEYS.reduce((s, k) => s + (c.ivs[k] ?? 0), 0)

/** Display order of a box: indices into `items`, filtered and sorted per the toolbar (stable, so ties keep their slots). */
export function boxView(items: readonly Creature[], opts: { sortByGrade: boolean; onlyTop: boolean }): number[] {
  const min = gradeRank(CONTENT.quality.box.filterMinGrade)
  let idx = items.map((_, i) => i)
  if (opts.onlyTop) idx = idx.filter((i) => gradeRank(gradeOf(items[i].ivs).id) >= min)
  if (opts.sortByGrade) idx.sort((a, b) => ivTotal(items[b]) - ivTotal(items[a]) || a - b)
  return idx
}

/** Stats a nature can raise or lower, in the order the content lists them. */
export function natureAxis(): StatKey[] {
  const out: StatKey[] = []
  for (const n of CONTENT.quality.natures) if (n.up && !out.includes(n.up)) out.push(n.up)
  return out
}

/** Grid cells row-major: [raised][lowered]; the diagonal takes the neutral natures in content order. */
export function natureGrid(): NatureDef[] {
  const axis = natureAxis()
  const neutral = CONTENT.quality.natures.filter((n) => n.up === null)
  const out: NatureDef[] = []
  axis.forEach((up, r) => axis.forEach((down, c) => {
    const n = r === c ? neutral[r] : CONTENT.quality.natures.find((x) => x.up === up && x.down === down)
    if (n) out.push(n)
  }))
  return out
}
