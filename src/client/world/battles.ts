// Overworld -> battle glue: builds BattleInit for wild / trainer battles from the world, region and save,
// plays the encounter transition, runs ctx.battle and applies overworld-side results (trainer flags, badges,
// stats). Party hp/exp, bag, money and dex are mutated by the battle runner (BattleRunner contract).
import type { BattleInit, BattleModifiers, BattleSideInit, Creature, FieldWeatherKind, GameMap, NpcDef, TrainerDef } from '../../shared/types.ts'
import type { BattleKind, BattleOutcome, GameContext } from '../contracts.ts'
import type { IRng } from '../../shared/contracts.ts'
import { createCreature, maxHp } from '../../shared/creature.ts'
import { modifierValue, type EventModifiers } from '../../shared/gameplay/events.ts'
import { regionAt } from '../../shared/world/worldapi.ts'
import { STORY_CONTENT } from '../../shared/world/story.ts'
import { GAME } from './config.ts'
import { battleWeatherFor } from './encounters.ts'

export interface BattleFlowDeps {
  readonly ctx: GameContext
  rng: IRng
  /** Current map and player tile position. */
  place(): { map: GameMap; x: number; y: number } | null
  setBattleActive(on: boolean): void
  /** Restores music / follower / HUD after any battle. */
  afterBattle(): void
  /** NPC on the current map that stands for this trainer, if any. */
  npcFor(trainerId: string): NpcDef | null
  /** Active world-event modifiers at the player (exp / money / catch rate / friendship); absent = none. */
  modifiers?(): EventModifiers
  /** Current field weather incl. event overrides (defaults to the region's weather). */
  weather?(): FieldWeatherKind
}

const tween = (ms: number, fn: (k: number) => void): Promise<void> => new Promise((resolve) => {
  const start = performance.now()
  const tick = () => {
    const k = Math.min(1, (performance.now() - start) / Math.max(1, ms))
    fn(k)
    if (k >= 1) resolve()
    else requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})

export function trainerDisplayName(tr: TrainerDef): string {
  return STORY_CONTENT.meta.text.trainerNpcName.replace('{class}', tr.classZh).replace('{name}', tr.nameZh)
}

export function createBattleFlow(deps: BattleFlowDeps) {
  const { ctx, rng } = deps
  let lastOutcome: BattleOutcome | null = null

  function playerSide(): BattleSideInit {
    return { kind: 'player', name: ctx.save.name, party: ctx.save.party, sprite: ctx.save.avatar }
  }

  function arena(): Pick<BattleInit, 'biome' | 'timeOfDay' | 'weather'> {
    const p = deps.place()
    const region = p ? regionAt(p.map, p.x, p.y) ?? undefined : undefined
    const biome = region?.biome ?? ctx.data.biomes[0]?.id ?? ''
    const weather = p && p.map.outdoor ? battleWeatherFor(deps.weather?.() ?? region?.weather, ctx.data) : undefined
    return { biome, timeOfDay: ctx.clock.timeOfDay, ...(weather ? { weather } : {}) }
  }

  const typesOf = (cr: Creature) => ctx.data.species[cr.speciesId]?.types ?? []

  /** World-event multipliers for one battle (type-qualified effects resolved per party slot / foe). */
  function battleMods(foe: Creature | null): BattleModifiers | undefined {
    const m = deps.modifiers?.()
    if (!m?.modifiers.length) return undefined
    const out: BattleModifiers = {}
    const exp = ctx.save.party.map((cr) => modifierValue(m, 'exp', { types: typesOf(cr) }))
    if (exp.some((v) => v !== 1)) out.expByParty = exp
    const catchRate = foe ? modifierValue(m, 'catchRate', { types: typesOf(foe) }) : 1
    if (catchRate !== 1) out.catchRate = catchRate
    const friendship = modifierValue(m, 'friendship')
    if (friendship !== 1) out.friendship = friendship
    return Object.keys(out).length ? out : undefined
  }

  const prizeMoney = (base: number) => {
    const m = deps.modifiers?.()
    return m ? Math.round(base * modifierValue(m, 'money')) : base
  }

  /** Encounter transition (flash + screen wipe) played on the overworld before the battle scene takes over. */
  async function transition(): Promise<void> {
    const T = GAME.encounters.transition
    // DOM name tags / bubbles sit above the canvas, so they are hidden by hand while the wipe covers the world.
    ctx.hud.overlay.style.visibility = 'hidden'
    ctx.audio.playSfx(T.sfx)
    ctx.renderer.flash(T.flashColor, T.flashMs)
    await tween(T.inMs, (k) => ctx.renderer.setTransition(T.kind, k))
  }

  async function run(init: BattleInit, opts: { kind: BattleKind; trainer?: TrainerDef; music?: string }): Promise<BattleOutcome> {
    deps.setBattleActive(true)
    if (ctx.net.status === 'online') ctx.net.send({ t: 'busy', busy: true })
    let outcome: BattleOutcome
    try {
      outcome = await ctx.battle.run(init, opts)
    } catch (err) {
      console.error('[overworld] battle failed', err)
      outcome = { result: 'run', moneyDelta: 0 }
    } finally {
      deps.setBattleActive(false)
      ctx.renderer.setTransition('none', 0)
      ctx.hud.overlay.style.visibility = ''
      if (ctx.net.status === 'online') ctx.net.send({ t: 'busy', busy: false })
    }
    lastOutcome = outcome
    if (outcome.result === 'win') ctx.save.stats.battlesWon += 1
    ctx.events.emit('party:changed', {})
    deps.afterBattle()
    await new Promise((r) => setTimeout(r, GAME.battle.afterBattleSettleMs))
    return outcome
  }

  function wildKind(cr: Creature): BattleKind {
    const order = ctx.data.rarityById[ctx.data.species[cr.speciesId]?.rarity ?? '']?.order ?? 0
    return order >= GAME.encounters.legendRarityOrder ? 'legend' : 'wild'
  }

  async function wild(cr: Creature, opts: { music?: string; scripted?: boolean; flee?: BattleSideInit['flee'] } = {}): Promise<BattleOutcome> {
    await transition()
    const name = ctx.data.species[cr.speciesId]?.nameZh ?? cr.speciesId
    // A species with a boss definition (content/bosses.json) is fought with its boss rules; bosses never flee.
    const boss = ctx.data.bossBySpecies[cr.speciesId]
    const init: BattleInit = {
      seed: rng.int(1, 0x7fffffff),
      sides: [playerSide(), boss
        ? { kind: 'wild', name, party: [cr], aiLevel: 3, boss: boss.id }
        : { kind: 'wild', name, party: [cr], ...(opts.flee ? { flee: opts.flee } : {}) }],
      isWild: true,
      canRun: (opts.scripted ? GAME.encounters.scriptedCanRun : true) && (boss?.canRun ?? true),
      canCatch: true,
      expGain: true,
      ...arena(),
    }
    const mods = battleMods(cr)
    if (mods) init.mods = mods
    if (boss) cr.hp = maxHp(cr, ctx.data)
    const outcome = await run(init, { kind: wildKind(cr), ...(opts.music ? { music: opts.music } : {}) })
    // Defeating (or taming) a boss unlocks the full counterplay hint in its dex entry.
    if (boss && (outcome.result === 'win' || outcome.result === 'caught')) ctx.save.flags[GAME.flags.bossWonPrefix + boss.id] = true
    return outcome
  }

  function trainerParty(tr: TrainerDef): Creature[] {
    const out: Creature[] = []
    for (const e of tr.party) {
      if (!e.species || !ctx.data.species[e.species]) { console.warn(`[overworld] trainer ${tr.id}: unresolved party entry`); continue }
      const opts = { rng, otName: tr.nameZh, otId: tr.id, nature: ctx.data.quality.npcNature, ...(e.moves?.length ? { moves: e.moves } : {}) }
      out.push(createCreature(e.species, e.level, opts, ctx.data))
    }
    return out
  }

  /** Full trainer battle (intro/defeat lines, flags, badge). null when the trainer is unknown or has no party. */
  async function trainer(tr: TrainerDef, npc: NpcDef | null): Promise<BattleOutcome | null> {
    const party = trainerParty(tr)
    if (!party.length) return null
    // A trainer started from another NPC's script (e.g. the professor introducing the rival) speaks for itself.
    const own = npc?.trainer === tr.id ? npc : deps.npcFor(tr.id)
    const speaker = own?.nameZh ?? trainerDisplayName(tr)
    const portrait = own?.portrait ?? (ctx.data.characterById[tr.sprite]?.portrait ? tr.sprite : undefined)
    if (GAME.battle.sayIntroBefore && tr.introText.length) {
      await ctx.ui.say(tr.introText.map((text) => (portrait ? { text, speaker, portrait } : { text, speaker })))
    }
    await transition()
    const kind: BattleKind = tr.badge ? 'gym' : 'trainer'
    const music = tr.music ?? (tr.badge ? ctx.data.audio.battleMusic.gym : undefined)
    const init: BattleInit = {
      seed: rng.int(1, 0x7fffffff),
      sides: [playerSide(), {
        kind: 'trainer', name: tr.nameZh, party, trainerClass: tr.classZh, sprite: tr.sprite, aiLevel: tr.aiLevel,
        ...(tr.items ? { items: { ...tr.items } } : {}),
      }],
      isWild: false,
      canRun: false,
      canCatch: false,
      expGain: true,
      rewardMoney: prizeMoney(tr.reward),
      ...arena(),
    }
    const mods = battleMods(null)
    if (mods) init.mods = mods
    const outcome = await run(init, { kind, trainer: tr, ...(music ? { music } : {}) })
    if (outcome.result === 'win') {
      ctx.save.flags[STORY_CONTENT.meta.flags.trainerWon + tr.id] = true
      if (tr.badge && !ctx.save.badges.includes(tr.badge)) {
        ctx.save.badges.push(tr.badge)
        const badge = ctx.data.world.badges.find((b) => b.id === tr.badge)
        if (badge) ctx.save.flags[GAME.flags.badgePrefix + badge.type] = true
        ctx.events.emit('badge:earned', { badgeId: tr.badge })
      }
      if (GAME.battle.sayDefeatTextAfter && tr.defeatText.length) {
        await ctx.ui.say(tr.defeatText.map((text) => (portrait ? { text, speaker, portrait } : { text, speaker })))
      }
    }
    return outcome
  }

  return {
    wild,
    trainer,
    run,
    get lastOutcome(): BattleOutcome | null { return lastOutcome },
  }
}

export type BattleFlow = ReturnType<typeof createBattleFlow>
