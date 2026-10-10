// Creature instance math (stats, exp, moves, evolution, validation). Implements CreatureApi from contracts.ts.
// Every function takes an optional trailing Content; formula constants come from content/battle_rules.json.
import type { Creature, CreatureOrigin, CreatureView, GrowthRate, MoveSlot, SpeciesDef, StatKey, Stats } from './types.ts'
import type { IRng } from './contracts.ts'
import { CONTENT, type Content } from './content/index.ts'
import { RULES } from './battle/rules.ts'
import { natureMod, rollIvs, rollNature } from './gameplay/quality.ts'

export const STAT_KEYS: readonly StatKey[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']
const UID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const ID_PATTERN = /^[A-Za-z0-9_-]+$/
const REF_PATTERN = /^[A-Za-z0-9_.:/-]+$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g

function speciesOf(id: string, c: Content): SpeciesDef {
  const sp = c.species[id]
  if (!sp) throw new Error(`unknown species "${id}"`)
  return sp
}

const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.floor(v)))

export function creatureName(cr: Pick<Creature, 'nickname' | 'speciesId'>, c: Content = CONTENT): string {
  return cr.nickname?.trim() || c.species[cr.speciesId]?.nameZh || cr.speciesId
}

export function calcStats(cr: Pick<Creature, 'speciesId' | 'level' | 'ivs' | 'nature'>, c: Content = CONTENT): Stats {
  const sp = speciesOf(cr.speciesId, c)
  const f = RULES.statFormula
  const out = {} as Stats
  for (const k of STAT_KEYS) {
    const core = Math.floor(((f.baseMul * sp.baseStats[k] + (cr.ivs?.[k] ?? 0)) * cr.level) / f.levelDivisor)
    out[k] = k === 'hp' ? core + cr.level + f.hpFlat : natureMod(core + f.otherFlat, k, cr.nature, c)
  }
  return out
}

export function maxHp(cr: Creature, c: Content = CONTENT): number {
  return calcStats(cr, c).hp
}

export function expForLevel(growth: GrowthRate, level: number, c: Content = CONTENT): number {
  const g = c.config.growth[growth] ?? Object.values(c.config.growth)[0]
  return Math.floor((g?.mul ?? 1) * Math.pow(level, RULES.growthExponent))
}

/** The last `maxMoves` distinct learnset moves available at `level`, in learn order. */
export function defaultMoves(speciesId: string, level: number, c: Content = CONTENT): string[] {
  const sp = speciesOf(speciesId, c)
  const avail = sp.learnset
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.level <= level && c.moves[e.move])
    .sort((x, y) => x.e.level - y.e.level || x.i - y.i)
    .map(({ e }) => e.move)
  const picked: string[] = []
  for (let i = avail.length - 1; i >= 0 && picked.length < c.config.party.maxMoves; i--) {
    if (!picked.includes(avail[i])) picked.push(avail[i])
  }
  return picked.reverse()
}

/** Moves a creature of this species and level may legitimately know (own + pre-evolution learnsets, teachables). */
export function legalMoves(speciesId: string, level: number, c: Content = CONTENT): Set<string> {
  const out = new Set<string>()
  const seen = new Set<string>()
  let sp: SpeciesDef | undefined = c.species[speciesId]
  while (sp && !seen.has(sp.id)) {
    seen.add(sp.id)
    for (const e of sp.learnset) if (e.level <= level) out.add(e.move)
    for (const m of sp.teachable) out.add(m)
    sp = sp.evolvesFrom ? c.species[sp.evolvesFrom] : undefined
  }
  return out
}

const slotOf = (id: string, c: Content): MoveSlot => {
  const pp = c.moves[id].pp
  return { id, pp, ppMax: pp }
}

export function newUid(rng: IRng): string {
  let s = ''
  for (let i = 0; i < RULES.creature.uidLength; i++) s += UID_ALPHABET[rng.int(0, UID_ALPHABET.length - 1)]
  return s
}

export function rollShiny(rng: IRng, c: Content = CONTENT): boolean {
  return rng.chance(c.config.battle.shinyRate)
}

export function createCreature(
  speciesId: string,
  level: number,
  opts: {
    rng: IRng; shiny?: boolean; otName?: string; otId?: string; ballId?: string; caughtMap?: string; moves?: string[]
    /** Fixed nature; when given no random draw is spent on it (NPC teams, bosses). */
    nature?: string
    /** IV rules (see rollIvs). */
    gradeFloor?: string; gradeCap?: string; perfectIvs?: number; ivMin?: number
    origin?: CreatureOrigin
  },
  c: Content = CONTENT,
): Creature {
  const sp = speciesOf(speciesId, c)
  const lv = clampInt(level, RULES.creature.minLevel, c.config.party.maxLevel)
  const rng = opts.rng
  const uid = newUid(rng)
  const ivs = rollIvs(rng, { perfect: opts.perfectIvs, min: opts.ivMin, gradeFloor: opts.gradeFloor, gradeCap: opts.gradeCap }, c)
  const abilityId = sp.abilities.length > 1 && rng.chance(c.config.creature.secondAbilityChance)
    ? sp.abilities[1]
    : (sp.abilities[0] ?? '')
  const shiny = opts.shiny ?? rollShiny(rng, c)
  const nature = opts.nature && c.natureById[opts.nature] ? opts.nature : rollNature(rng, c)
  let moveIds = opts.moves
    ? [...new Set(opts.moves.filter((m) => c.moves[m]))].slice(0, c.config.party.maxMoves)
    : []
  if (moveIds.length === 0) moveIds = defaultMoves(speciesId, lv, c)
  const cr: Creature = {
    uid,
    speciesId,
    level: lv,
    exp: expForLevel(sp.growth, lv, c),
    ivs,
    moves: moveIds.map((m) => slotOf(m, c)),
    hp: 0,
    status: null,
    statusTurns: 0,
    abilityId,
    shiny,
    friendship: c.config.creature.startFriendship,
    ballId: opts.ballId ?? '',
    caughtMap: opts.caughtMap ?? '',
    otName: opts.otName ?? '',
    otId: opts.otId ?? '',
    nature,
  }
  if (opts.origin) cr.origin = { ...opts.origin }
  cr.hp = maxHp(cr, c)
  return cr
}

/** Level-ups from the exp a creature already holds, up to `levelCap` (and the global cap); learns and reports moves. */
function applyLevelUps(cr: Creature, levelCap: number, c: Content): { levels: number[]; learned: string[]; learnable: string[] } {
  const res = { levels: [] as number[], learned: [] as string[], learnable: [] as string[] }
  const sp = speciesOf(cr.speciesId, c)
  const cap = Math.min(levelCap, c.config.party.maxLevel)
  while (cr.level < cap && cr.exp >= expForLevel(sp.growth, cr.level + 1, c)) {
    const before = maxHp(cr, c)
    cr.level += 1
    res.levels.push(cr.level)
    const after = maxHp(cr, c)
    if (cr.hp > 0) cr.hp = Math.min(after, cr.hp + after - before)
    cr.friendship = Math.min(RULES.creature.friendshipMax, cr.friendship + c.config.creature.levelUpFriendship)
    for (const e of sp.learnset) {
      if (e.level !== cr.level || !c.moves[e.move]) continue
      if (cr.moves.some((m) => m.id === e.move) || res.learnable.includes(e.move)) continue
      if (cr.moves.length < c.config.party.maxMoves) {
        cr.moves.push(slotOf(e.move, c))
        res.learned.push(e.move)
      } else res.learnable.push(e.move)
    }
  }
  return res
}

/**
 * Adds exp and levels up. `opts.levelCap` stops levelling at that level (the exp keeps piling up, a boss card's
 * bank); `opts.expCap` is the most exp the creature may hold. Without `opts` this is the plain rule.
 */
export function gainExp(
  cr: Creature, amount: number, c: Content = CONTENT, opts?: { levelCap?: number; expCap?: number },
): { levels: number[]; learned: string[]; learnable: string[] } {
  const sp = speciesOf(cr.speciesId, c)
  const cap = c.config.party.maxLevel
  if (!(amount > 0) || cr.level >= cap) return { levels: [], learned: [], learnable: [] }
  let add = Math.floor(amount)
  if (opts?.expCap !== undefined) add = Math.max(0, Math.min(add, opts.expCap - cr.exp))
  cr.exp += add
  const res = applyLevelUps(cr, opts?.levelCap ?? cap, c)
  if (cr.level >= cap) cr.exp = Math.min(cr.exp, expForLevel(sp.growth, cap, c))
  return res
}

/** Levels a creature up to `levelCap` from the exp it already holds (a boss card's bank paid out by a new badge). */
export function settleLevels(cr: Creature, levelCap: number, c: Content = CONTENT): { levels: number[]; learned: string[]; learnable: string[] } {
  const res = applyLevelUps(cr, levelCap, c)
  if (cr.level >= c.config.party.maxLevel) cr.exp = Math.min(cr.exp, expForLevel(speciesOf(cr.speciesId, c).growth, c.config.party.maxLevel, c))
  return res
}

export function evolutionTarget(cr: Creature, c: Content = CONTENT): string | null {
  const evo = c.species[cr.speciesId]?.evolvesTo
  if (!evo || !c.species[evo.id] || cr.level < evo.level) return null
  return evo.id
}

export function evolve(cr: Creature, toSpeciesId: string, c: Content = CONTENT): void {
  const from = speciesOf(cr.speciesId, c)
  const to = speciesOf(toSpeciesId, c)
  const oldMax = maxHp(cr, c)
  const ratio = oldMax > 0 ? cr.hp / oldMax : 1
  const abilitySlot = Math.max(0, from.abilities.indexOf(cr.abilityId))
  cr.speciesId = to.id
  cr.abilityId = to.abilities[abilitySlot] ?? to.abilities[0] ?? cr.abilityId
  const newMax = maxHp(cr, c)
  cr.hp = cr.hp > 0 ? Math.max(1, Math.min(newMax, Math.round(newMax * ratio))) : 0
  // Stage moves: entries at the evolution level itself (or level 0 = "on evolution").
  for (const e of to.learnset) {
    if ((e.level !== 0 && e.level !== cr.level) || !c.moves[e.move]) continue
    if (cr.moves.some((m) => m.id === e.move) || cr.moves.length >= c.config.party.maxMoves) continue
    cr.moves.push(slotOf(e.move, c))
  }
}

export function healFull(cr: Creature, c: Content = CONTENT): void {
  cr.hp = maxHp(cr, c)
  cr.status = null
  cr.statusTurns = 0
  for (const m of cr.moves) m.pp = m.ppMax
}

export function toView(cr: Creature, c: Content = CONTENT): CreatureView {
  return {
    uid: cr.uid,
    speciesId: cr.speciesId,
    nickname: cr.nickname,
    level: cr.level,
    hp: cr.hp,
    maxHp: maxHp(cr, c),
    status: cr.status,
    shiny: cr.shiny,
  }
}

export function expYield(defeated: Creature, trainer: boolean, c: Content = CONTENT): number {
  const sp = speciesOf(defeated.speciesId, c)
  const b = c.config.battle
  const raw = (sp.baseExp * defeated.level) / b.expDivisor * (trainer ? b.trainerExpMultiplier : 1)
  return Math.max(1, Math.floor(raw))
}

// ---------------------------------------------------------------------------
// Untrusted input validation (trades, PvP parties, imports)
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function cleanText(v: unknown, maxLen: number): string {
  if (typeof v !== 'string') return ''
  return [...v.replace(CONTROL_CHARS, '').trim()].slice(0, maxLen).join('')
}

function cleanId(v: unknown, pattern: RegExp = ID_PATTERN): string {
  return typeof v === 'string' && v.length <= RULES.creature.idMaxLen && pattern.test(v) ? v : ''
}

const ORIGIN_KINDS: readonly CreatureOrigin['kind'][] = ['wild', 'starter', 'gift', 'boss', 'trade', 'legacy']

function sanitizeOrigin(raw: unknown, c: Content): CreatureOrigin | undefined {
  if (!isObj(raw)) return undefined
  const kind = ORIGIN_KINDS.find((k) => k === raw.kind)
  if (!kind) return undefined
  const out: CreatureOrigin = { kind }
  if (typeof raw.boss === 'string' && c.bosses[raw.boss]) out.boss = raw.boss
  const tier = cleanId(raw.tier)
  if (tier) out.tier = tier
  const run = cleanId(raw.run)
  if (run) out.run = run
  const at = num(raw.at)
  if (at !== null && at >= 0) out.at = Math.floor(at)
  return out
}

export function sanitizeCreature(raw: unknown, c: Content = CONTENT): Creature | null {
  if (!isObj(raw)) return null
  const uid = cleanId(raw.uid)
  if (!uid) return null
  const speciesId = typeof raw.speciesId === 'string' ? raw.speciesId : ''
  const sp = c.species[speciesId]
  if (!sp) return null
  const lvRaw = num(raw.level)
  if (lvRaw === null) return null
  const level = clampInt(lvRaw, RULES.creature.minLevel, c.config.party.maxLevel)

  const ivSrc = isObj(raw.ivs) ? raw.ivs : {}
  const ivs = {} as Stats
  for (const k of STAT_KEYS) ivs[k] = clampInt(num(ivSrc[k]) ?? 0, 0, c.config.creature.ivMax)

  // The signature ability / move and the exp bank are only legal on the boss's own species.
  const origin = sanitizeOrigin(raw.origin, c)
  const bossDef = origin?.kind === 'boss' && origin.boss ? c.bosses[origin.boss] : undefined
  const card = bossDef !== undefined && bossDef.species === speciesId ? bossDef : undefined
  const legal = legalMoves(speciesId, level, c)
  if (card?.signature?.move && c.moves[card.signature.move]) legal.add(card.signature.move)
  const moves: MoveSlot[] = []
  if (Array.isArray(raw.moves)) {
    for (const m of raw.moves) {
      if (moves.length >= c.config.party.maxMoves) break
      if (!isObj(m) || typeof m.id !== 'string') continue
      const def = c.moves[m.id]
      if (!def || !legal.has(m.id) || moves.some((x) => x.id === m.id)) continue
      moves.push({ id: m.id, pp: clampInt(num(m.pp) ?? def.pp, 0, def.pp), ppMax: def.pp })
    }
  }
  if (moves.length === 0) for (const id of defaultMoves(speciesId, level, c)) moves.push(slotOf(id, c))

  const lo = expForLevel(sp.growth, level, c)
  // A boss card banks exp past its badge cap (up to bankMaxLevels levels ahead of its level).
  const bank = card ? c.quality.bossCard.bankMaxLevels : 0
  const hi = level >= c.config.party.maxLevel ? lo : expForLevel(sp.growth, Math.min(c.config.party.maxLevel, level + Math.max(1, bank)), c) - (bank > 0 ? 0 : 1)
  const exp = clampInt(num(raw.exp) ?? lo, lo, Math.max(lo, hi))

  const status = typeof raw.status === 'string' && c.statusById[raw.status] ? raw.status : null
  const statusMax = status ? (c.statusById[status].durationMax ?? c.statusById[status].durationMin ?? 0) : 0
  const statusTurns = status ? clampInt(num(raw.statusTurns) ?? 0, 0, statusMax) : 0

  const abilityId = typeof raw.abilityId === 'string' && (sp.abilities.includes(raw.abilityId) || (card?.signature?.ability === raw.abilityId && !!c.abilities[raw.abilityId]))
    ? raw.abilityId
    : (sp.abilities[0] ?? '')
  const ballId = typeof raw.ballId === 'string' && c.items[raw.ballId]?.effect.kind === 'ball' ? raw.ballId : ''
  const nickname = cleanText(raw.nickname, RULES.creature.nicknameMaxLen)
  const heldItem = typeof raw.heldItem === 'string' && c.items[raw.heldItem] ? raw.heldItem : undefined
  const nature = typeof raw.nature === 'string' && c.natureById[raw.nature] ? raw.nature : c.quality.legacyNature

  const cr: Creature = {
    uid,
    speciesId,
    level,
    exp,
    ivs,
    moves,
    hp: 0,
    status,
    statusTurns,
    abilityId,
    shiny: raw.shiny === true,
    friendship: clampInt(num(raw.friendship) ?? c.config.creature.startFriendship, 0, RULES.creature.friendshipMax),
    ballId,
    caughtMap: cleanId(raw.caughtMap, REF_PATTERN),
    otName: cleanText(raw.otName, c.config.net.nameMaxLen),
    otId: cleanId(raw.otId, REF_PATTERN),
    nature,
  }
  if (nickname) cr.nickname = nickname
  if (heldItem) cr.heldItem = heldItem
  if (origin) cr.origin = origin
  const finetuned = num(raw.finetuned)
  if (finetuned !== null) cr.finetuned = clampInt(finetuned, 0, c.quality.finetune.loraMaxPerCreature)
  const max = maxHp(cr, c)
  cr.hp = clampInt(num(raw.hp) ?? max, 0, max)
  if (cr.hp === 0) {
    cr.status = null
    cr.statusTurns = 0
  }
  return cr
}
