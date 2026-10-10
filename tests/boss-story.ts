// DeepSeek story tier ("体验版", content/bosses.json deepseek.tiers.story) win-rate simulator, shared by
// tests/boss.test.ts and scripts/boss-story-sim.ts. Plays the real fight through the real engine (resolveBossDef,
// foeCompany, residualMul and all) with three scripted players:
//   naive      every turn the move with the highest estimated damage, no items, never switches on purpose;
//   competent  tools/balance/pilot.ts (matchups, set-up, switching), no items;
//   guided     the pilot plus what the briefing teaches: potion below 40% hp, a coupon to cancel a peak, leech and
//              set-up instead of wasted hits in peak, damage in the valley.
// The three starters are the player's choice; the party is starter + Ernie Bot (with the Embedding Orb the event gives)
// + Phi-3, every member rolled like a gift (grade floor B).
import type { BattleAction, BattleEvent, Creature } from '../src/shared/types.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { Rng } from '../src/shared/rng.ts'
import { createCreature, maxHp } from '../src/shared/creature.ts'
import { startBossBattle } from '../src/shared/battle/boss-battle.ts'
import { chooseAiAction } from '../src/shared/battle/ai.ts'
import { estimateDamage, isDamaging, toStages } from '../src/shared/battle/formulas.ts'
import { pilot } from '../tools/balance/pilot.ts'

export type Strategy = 'naive' | 'competent' | 'guided'
export const STARTERS = ['o1', 'claude-haiku', 'deepseek-v3'] as const
export const STORY_BAG: Readonly<Record<string, number>> = { 'cache-potion': 5, 'off-peak-coupon': 2 }
const ERNIE_MOVES = ['token-tackle', 'web-crawl', 'morning-greeting', 'embedding-orb']

/** Starter + Ernie Bot + Phi-3 at the given levels (rolled from the seed, gift-grade floor). */
export function storyParty(starter: string, levels: readonly [number, number, number], seed: number): Creature[] {
  const rng = new Rng(seed ^ 0x9e3779b1)
  const opts = { rng, shiny: false, gradeFloor: CONTENT.quality.giftGradeFloor }
  return [
    createCreature(starter, levels[0], opts, CONTENT),
    createCreature('ernie-bot', levels[1], { ...opts, moves: ERNIE_MOVES }, CONTENT),
    createCreature('phi-3', levels[2], opts, CONTENT),
  ]
}

export interface StoryRun { won: boolean; turns: number; coupons: number; potions: number; alive: number; events: BattleEvent[] }

export function fightStory(
  party: Creature[], strat: Strategy, seed: number, bag0: Readonly<Record<string, number>> = STORY_BAG, assist = false, log = false,
  guide: { coach?: boolean; skipBrief?: boolean } = {},
): StoryRun {
  const bag = { ...bag0 }
  const { engine, intro } = startBossBattle('deepseek', party, { seed, autoPlayer: true, items: bag, expGain: false, tier: 'story', assist, ...guide })
  const events: BattleEvent[] = log ? [...intro] : []
  const rng = new Rng(seed ^ 0x2545f491)
  let usedCoupon = 0
  let usedPotion = 0
  for (let guard = 0; !engine.finished && guard < 900; guard++) {
    const req = engine.request(0)
    if (req.kind === 'wait') { if (!engine.ready()) break; const w = engine.step(); if (log) events.push(...w); continue }
    let action: BattleAction | null = null
    if (req.kind === 'switch') action = pilot(engine, 0, rng)
    else {
      const st = engine.extractBossState()!
      const me = engine.party(0)[engine.activeIndex(0)]
      const mhp = maxHp(me, CONTENT)
      const fighterOf = () => ({ creature: me, level: me.level, stats: engine.fighterStats(0), stages: toStages(engine.stages(0)), critStageAdd: 0 })
      const foeCr = engine.party(1)[engine.activeIndex(1)]
      const foeF = { creature: foeCr, level: foeCr.level, stats: engine.fighterStats(1), stages: toStages(engine.stages(1)), critStageAdd: 0 }
      const attacks = () => me.moves.map((s, index) => ({ index, mv: CONTENT.moves[s.id], s }))
        .filter((x) => x.mv && x.s.pp > 0 && isDamaging(x.mv))
        .map((x) => ({ ...x, dmg: estimateDamage(fighterOf(), foeF, x.mv, engine.weather, CONTENT, engine.turn + 1).avg * (x.mv.accuracy === 0 ? 1 : x.mv.accuracy / 100) }))
        .sort((a, b) => b.dmg - a.dmg)
      const item = (id: string): BattleAction | null => {
        if (!req.canItem || (bag[id] ?? 0) <= 0) return null
        bag[id]--
        return { kind: 'item', itemId: id, partyIndex: engine.activeIndex(0) }
      }
      const peak = st.meters.tide === 0 && st.meters.grace === 0
      if (strat === 'naive') {
        const a = attacks()[0]
        action = a ? { kind: 'move', moveIndex: a.index } : pilot(engine, 0, rng)
      } else if (strat === 'competent') {
        action = pilot(engine, 0, rng)
      } else {
        const lowHp = me.hp / mhp < 0.4
        const foeVol = engine.volatiles(1)
        const base = pilot(engine, 0, rng)
        const dmgIdx = (a: BattleAction) => a.kind === 'move' && isDamaging(CONTENT.moves[me.moves[a.moveIndex].id])
        if (lowHp) { const h = item('cache-potion'); if (h) { usedPotion++; action = h } }
        if (!action && peak) { const cp = item('off-peak-coupon'); if (cp) { usedCoupon++; action = cp } }
        if (!action && base.kind === 'move' && dmgIdx(base) && peak) {
          const li = !foeVol.includes('leech') ? me.moves.findIndex((s) => {
            const m = CONTENT.moves[s.id]
            return m && s.pp > 0 && m.effects.some((e) => e.kind === 'volatile' && e.volatile === 'leech' && e.target === 'enemy')
          }) : -1
          const stg = engine.stages(0) as Record<string, number>
          const su = me.moves.findIndex((s) => {
            const m = CONTENT.moves[s.id]
            return m && s.pp > 0 && !isDamaging(m) && m.effects.some((e) => e.kind === 'stat' && e.target === 'self')
          })
          if (li >= 0) action = { kind: 'move', moveIndex: li }
          else if (su >= 0 && (stg.atk ?? 0) < 2 && (stg.spa ?? 0) < 2) action = { kind: 'move', moveIndex: su }
        }
        if (!action && !peak && base.kind === 'move' && !dmgIdx(base)) { const a = attacks()[0]; if (a) action = { kind: 'move', moveIndex: a.index } }
        if (!action) action = base
      }
    }
    if (engine.choose(0, action!) !== null) engine.choose(0, chooseAiAction(engine, 0, rng, CONTENT))
    const evs = engine.step()
    if (log) events.push(...evs)
  }
  return { won: engine.result === 'win', turns: engine.turn, coupons: usedCoupon, potions: usedPotion, alive: engine.party(0).filter((x) => x.hp > 0).length, events }
}

export interface StoryRate { rate: number; winTurns: number; coupons: number; runs: number }

/** Win rate over `n` seeds of one starter / level triple / strategy. */
export function rateStory(
  starter: string, levels: readonly [number, number, number], strat: Strategy, n: number, opts: { assist?: boolean; bag?: Readonly<Record<string, number>> } = {},
): StoryRate {
  let wins = 0
  let winTurns = 0
  let coupons = 0
  for (let i = 0; i < n; i++) {
    const seed = 1 + i * 7919
    const r = fightStory(storyParty(starter, levels, seed), strat, seed, opts.bag ?? STORY_BAG, opts.assist ?? false)
    if (r.won) { wins++; winTurns += r.turns }
    coupons += r.coupons
  }
  return { rate: wins / n, winTurns: wins ? winTurns / wins : 0, coupons: coupons / n, runs: n }
}
