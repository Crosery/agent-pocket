// ScriptRunner: executes data-only ScriptStep lists (dialogue, flags, branching, rewards, battles, warps,
// NPC choreography). Every op of the ScriptStep contract is implemented; behaviour comes from the step data,
// content tables and content/game.json — never from ids in code.
import type { BattleResult, Creature, Dir, FieldWeatherKind, ItemDef, NpcDef, ScriptStep } from '../../shared/types.ts'
import type { DialogueLine, GameContext } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import type { IRng } from '../../shared/contracts.ts'
import { Rng } from '../../shared/rng.ts'
import { randomSeed } from '../core/rng-hub.ts'
import { createCreature, creatureName, rollShiny } from '../../shared/creature.ts'
import { revealIsFull } from '../../shared/gameplay/quality.ts'
import { STORY_CONTENT } from '../../shared/world/story.ts'
import { dayOf, expandFlag, realDateOf } from '../../shared/gameplay/events.ts'
import { GAME, textOrKey } from './config.ts'
import { addCreature, addItem, applyQuest, changeMoney, flagSet, healParty, markSeen, removeItem, rewardText } from './save-ops.ts'
import { presentArrival } from './rarity-spawns.ts'
import { scriptResearch } from './research.ts'
import { TUTORIAL } from '../onboarding/config.ts'

export type ScriptOutcome = 'done' | 'end' | 'abort'

/** World services the runner drives (implemented by the overworld controller). */
export interface ScriptHost {
  readonly ctx: GameContext
  /** Stream for script rolls (gifted creatures); random when absent. */
  readonly rng?: IRng
  moveNpc(id: string, path: Dir[], speed: number): Promise<void>
  faceNpc(id: string, dir: Dir): void
  setNpcHidden(id: string, hidden: boolean): void
  /** Trainer battle incl. intro/defeat text and rewards; null when the trainer does not exist. */
  trainerBattle(trainerId: string, npc: NpcDef | null): Promise<BattleResult | null>
  wildBattle(speciesId: string, level: number, opts: { music?: string; shiny?: boolean; scripted: boolean }): Promise<BattleResult | null>
  /** Boss instance fight of one tier (rewards and the post-win contract included); null when the boss or tier does not exist. */
  bossBattle?(bossId: string, tier: string, opts: { captureAfterWin?: boolean }): Promise<BattleResult | null>
  /** Teleport to the respawn point after a loss (heals). */
  blackout(): Promise<void>
  warp(map: string, x: number, y: number, facing: Dir): Promise<void>
  playerPlace(): { map: string; x: number; y: number; facing: Dir }
  playMusic(id: string): void
  /** Party / follower / NPC visibility changed. */
  onWorldChanged(): void
  /** Current field weather ('ifWeather'; absent = every branch test fails). */
  weather?(): FieldWeatherKind
  /** Starts a world event by id ('triggerEvent'); false when gated / unknown / already active. */
  triggerEvent?(id: string): Promise<boolean>
  /** Reveals a place on the world map ('revealPlace'; place id, template or 'nearest:<template>'). */
  revealPlace?(ref: string): Promise<unknown>
  /** Buy-price multiplier of an item from active world events ('shop'; absent = list price). */
  shopPriceMul?(item: ItemDef): number
  /** Appraisal card (full) or chip for a creature that just joined the player; absent = nothing is shown. */
  reveal?(cr: Creature, opts: { full: boolean }): Promise<void>
}

const ballId = (ctx: GameContext): string | undefined => ctx.data.itemList.find((it) => it.effect.kind === 'ball')?.id

export function createScriptRunner(host: ScriptHost) {
  const { ctx } = host
  const rng = host.rng ?? new Rng(randomSeed())
  const params = () => ({ name: ctx.save.name, currency: t('common.money') })

  const line = (text: string, speaker?: string, portrait?: string): DialogueLine => {
    const out: DialogueLine = { text: textOrKey(text, params()) }
    if (speaker) out.speaker = textOrKey(speaker, params())
    if (portrait) out.portrait = portrait
    return out
  }
  const narrate = (text: string) => ctx.ui.say([{ text }])
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)))
  const isLoss = (r: BattleResult | null) => r === 'lose' || r === 'draw'
  /** Flags may carry {year} / {day} placeholders (yearly / daily one-shots). */
  const flagName = (f: string) => (f.includes('{') ? expandFlag(f, { year: realDateOf(new Date()).year, day: dayOf(ctx.save.clockMinutes) }) : f)

  async function giveCreature(speciesId: string, level: number, shiny: boolean | undefined): Promise<void> {
    if (!ctx.data.species[speciesId]) { console.warn(`[script] unknown species "${speciesId}"`); return }
    const place = host.playerPlace()
    const isNew = !ctx.save.dexCaught.includes(speciesId)
    const cr = createCreature(speciesId, level, {
      rng, shiny: shiny ?? rollShiny(rng, ctx.data), otName: ctx.save.name, otId: ctx.save.playerId, ballId: ballId(ctx), caughtMap: place.map,
      gradeFloor: ctx.data.quality.giftGradeFloor, origin: { kind: 'gift' },
    }, ctx.data)
    const species = creatureName(cr, ctx.data)
    ctx.audio.playSfx(GAME.items.keyItemSfx)
    await narrate(t('world.script.giveCreature', { ...params(), species }))
    const where = addCreature(ctx, cr)
    if (!where) await narrate(t('world.script.boxFull', { species }))
    else if (where.where === 'box') await narrate(t('world.script.toBox', { species, box: t('world.script.boxName', { n: where.box + 1 }) }))
    if (where) await host.reveal?.(cr, { full: revealIsFull(cr, { newSpecies: isNew, firstCatch: false }, ctx.data) })
    host.onWorldChanged()
  }

  async function questStep(questId: string, stage: number, done: boolean): Promise<void> {
    const change = applyQuest(ctx, questId, stage, done)
    if (!change) { console.warn(`[script] unknown quest "${questId}"`); return }
    const quest = change.def.nameZh
    if (change.started) ctx.ui.toast(t('world.script.questStart', { quest }), 'info')
    else if (change.advanced && !change.finished) ctx.ui.toast(t('world.script.questStage', { quest }), 'info')
    if (change.finished) {
      ctx.audio.playSfx(GAME.script.questSfx)
      ctx.ui.toast(t('world.script.questDone', { quest }), 'success')
      const reward = rewardText(change.def)
      if (reward) await narrate(t('world.script.questReward', { reward }))
    } else if (change.started || change.advanced) ctx.audio.playSfx(GAME.script.questSfx)
  }

  async function exec(steps: readonly ScriptStep[], npc: NpcDef | null, depth: number): Promise<ScriptOutcome> {
    if (depth > GAME.script.maxDepth) { console.warn('[script] max depth exceeded'); return 'end' }
    for (const s of steps) {
      const r = await step(s, npc, depth)
      if (r !== 'done') return r
    }
    return 'done'
  }

  async function step(s: ScriptStep, npc: NpcDef | null, depth: number): Promise<ScriptOutcome> {
    switch (s.op) {
      case 'say':
        await ctx.ui.say([line(s.text, s.speaker, s.portrait)])
        return 'done'
      case 'choice': {
        const options = s.options.map((o) => textOrKey(o, params()))
        const i = await ctx.ui.choose(line(s.text, npc?.nameZh, npc?.portrait), options, { cancelIndex: options.length - 1 })
        const branch = s.branches[i] ?? s.branches[s.branches.length - 1] ?? []
        return exec(branch, npc, depth + 1)
      }
      case 'setFlag':
        ctx.save.flags[flagName(s.flag)] = s.value ?? true
        return 'done'
      case 'ifFlag': {
        const flag = flagName(s.flag)
        const v = ctx.save.flags[flag]
        const ok = s.equals === undefined ? flagSet(ctx.save, flag) : v === s.equals
        return exec(ok ? s.then : s.else ?? [], npc, depth + 1)
      }
      case 'ifBadges':
        return exec(ctx.save.badges.length >= s.atLeast ? s.then : s.else ?? [], npc, depth + 1)
      case 'ifItem':
        return exec((ctx.save.bag[s.item] ?? 0) >= (s.atLeast ?? 1) ? s.then : s.else ?? [], npc, depth + 1)
      case 'ifCaught': {
        const n = ctx.save.dexCaught.filter((id) => {
          const sp = ctx.data.species[id]
          if (!sp) return false
          if (s.species && id !== s.species) return false
          if (s.type && !sp.types.includes(s.type)) return false
          return true
        }).length
        return exec(n >= (s.atLeast ?? 1) ? s.then : s.else ?? [], npc, depth + 1)
      }
      case 'giveItem': {
        const item = ctx.data.items[s.item]
        if (!item || !addItem(ctx, s.item, s.qty)) { console.warn(`[script] unknown item "${s.item}"`); return 'done' }
        const key = item.category === 'key'
        ctx.audio.playSfx(key ? GAME.items.keyItemSfx : GAME.items.pickupSfx)
        const text = key ? 'world.script.keyItem' : s.qty > 1 ? 'world.script.giveItemQty' : 'world.script.giveItem'
        await narrate(t(text, { ...params(), item: item.nameZh, qty: s.qty }))
        return 'done'
      }
      case 'takeItem': {
        const n = removeItem(ctx, s.item, s.qty)
        const item = ctx.data.items[s.item]
        if (n > 0 && item) await narrate(t('world.script.takeItem', { ...params(), item: item.nameZh, qty: n }))
        return 'done'
      }
      case 'giveMoney':
        changeMoney(ctx, s.amount)
        ctx.audio.playSfx(GAME.script.moneySfx)
        await narrate(t('world.script.giveMoney', { ...params(), money: s.amount }))
        return 'done'
      case 'takeMoney':
        if (ctx.save.money < s.amount) {
          await ctx.ui.say([line(s.failText ?? t('world.script.noMoney', params()), npc?.nameZh, npc?.portrait)])
          return 'end'
        }
        changeMoney(ctx, -s.amount)
        ctx.audio.playSfx(GAME.script.moneySfx)
        await narrate(t('world.script.takeMoney', { ...params(), money: s.amount }))
        return 'done'
      case 'giveCreature':
        if (!s.species) { console.warn('[script] giveCreature without a resolved species'); return 'done' }
        await giveCreature(s.species, s.level, s.shiny)
        return 'done'
      case 'chooseStarter': {
        const options = ctx.data.speciesList.filter((sp) => sp.starter)
        if (!options.length) { console.warn('[script] no starter species in content'); return 'done' }
        const id = await ctx.screens.starter(options)
        const chosen = ctx.data.species[id] ? id : options[0].id
        const cr = createCreature(chosen, ctx.data.config.creature.starterLevel, {
          rng, otName: ctx.save.name, otId: ctx.save.playerId, ballId: ballId(ctx), caughtMap: host.playerPlace().map,
          gradeFloor: ctx.data.quality.giftGradeFloor, origin: { kind: 'starter' },
        }, ctx.data)
        addCreature(ctx, cr)
        ctx.save.flags[STORY_CONTENT.meta.flags.starter] = chosen
        ctx.audio.playCry(chosen)
        await narrate(t('world.script.starter', { ...params(), species: creatureName(cr, ctx.data) }))
        await host.reveal?.(cr, { full: true })
        host.onWorldChanged()
        return 'done'
      }
      case 'battle': {
        const r = await host.trainerBattle(s.trainer, npc)
        if (s.lossFlag && r !== null) ctx.save.flags[flagName(s.lossFlag)] = isLoss(r)
        if (isLoss(r) && GAME.battle.lossAbortsScript && !s.lossContinues) { await host.blackout(); return 'abort' }
        return 'done'
      }
      case 'bossBattle': {
        const r = (await host.bossBattle?.(s.boss, s.tier, { captureAfterWin: s.captureAfterWin })) ?? null
        if (s.lossFlag && r !== null) ctx.save.flags[flagName(s.lossFlag)] = isLoss(r)
        if (isLoss(r) && GAME.battle.lossAbortsScript && !s.lossContinues) { await host.blackout(); return 'abort' }
        return 'done'
      }
      case 'wildBattle': {
        if (!s.species) { console.warn('[script] wildBattle without a resolved species'); return 'done' }
        markSeen(ctx, s.species)
        await presentArrival(ctx, s.species, host.playerPlace())
        const r = await host.wildBattle(s.species, s.level, { music: s.music, scripted: true })
        if (isLoss(r) && GAME.battle.lossAbortsScript) { await host.blackout(); return 'abort' }
        return 'done'
      }
      case 'heal':
        healParty(ctx)
        ctx.audio.playSfx(GAME.script.healSfx)
        await wait(GAME.script.healWaitMs)
        host.onWorldChanged()
        return 'done'
      case 'shop':
        {
          const ids = s.items.filter((id) => ctx.data.items[id])
          const priceMul: Record<string, number> = {}
          if (host.shopPriceMul) for (const id of ids) { const m = host.shopPriceMul(ctx.data.items[id]); if (m !== 1) priceMul[id] = m }
          await ctx.screens.shop(ids, Object.keys(priceMul).length ? { priceMul } : undefined)
        }
        return 'done'
      case 'exchange':
        await ctx.screens.exchange(s.desk)
        return 'done'
      case 'teach': {
        const flag = `${TUTORIAL.curriculum.flagPrefix}${s.lesson}`
        if (!ctx.save.flags[flag]) {
          ctx.save.flags[flag] = true
          ctx.audio.playSfx(GAME.script.questSfx)
          ctx.ui.toast(t('tutorial.taught', { lesson: t(`tutorial.manual.${s.lesson}.title`) }), 'info')
        }
        return 'done'
      }
      case 'openTypeChart':
        await ctx.screens.typeChart({ view: s.view, type: s.type })
        return 'done'
      case 'openBox':
        await ctx.screens.box()
        host.onWorldChanged()
        return 'done'
      case 'quest':
        await questStep(s.quest, s.stage, s.done ?? false)
        return 'done'
      case 'warp':
        await host.warp(s.map, s.x, s.y, s.facing)
        return 'done'
      case 'moveNpc':
        await host.moveNpc(s.npc, s.path, GAME.script.moveNpcSpeed)
        return 'done'
      case 'faceNpc':
        host.faceNpc(s.npc, s.dir)
        return 'done'
      case 'hideNpc':
        host.setNpcHidden(s.npc, true)
        return 'done'
      case 'showNpc':
        host.setNpcHidden(s.npc, false)
        return 'done'
      case 'sfx':
        ctx.audio.playSfx(s.id)
        return 'done'
      case 'bgm':
        host.playMusic(s.id)
        return 'done'
      case 'wait':
        await wait(s.ms)
        return 'done'
      case 'fade':
        await ctx.ui.fade(s.out, GAME.script.fadeMs)
        return 'done'
      case 'unlockTown': {
        const town = ctx.data.world.towns.find((tw) => tw.id === s.town)
        if (!town) { console.warn(`[script] unknown town "${s.town}"`); return 'done' }
        if (!ctx.save.visitedTowns.includes(town.id)) {
          ctx.save.visitedTowns.push(town.id)
          ctx.audio.playSfx(GAME.script.unlockSfx)
          ctx.ui.toast(t('world.script.unlockTown', { town: town.nameZh }), 'success')
        }
        return 'done'
      }
      case 'setRespawn': {
        const p = host.playerPlace()
        ctx.save.respawn = { map: p.map, x: Math.floor(p.x), y: Math.floor(p.y), facing: p.facing }
        return 'done'
      }
      case 'random':
        return exec(rng.chance(s.chance) ? s.then : s.else ?? [], npc, depth + 1)
      case 'ifTime':
        return exec(s.times.includes(ctx.clock.timeOfDay) ? s.then : s.else ?? [], npc, depth + 1)
      case 'ifWeather': {
        const w = host.weather?.()
        return exec(w && s.weather.includes(w) ? s.then : s.else ?? [], npc, depth + 1)
      }
      case 'ifDex':
        return exec(ctx.save.dexCaught.length >= s.caughtAtLeast ? s.then : s.else ?? [], npc, depth + 1)
      case 'triggerEvent':
        if (!host.triggerEvent) console.warn(`[script] triggerEvent "${s.event}" without an event runtime`)
        else await host.triggerEvent(s.event)
        return 'done'
      case 'revealPlace':
        if (!host.revealPlace) console.warn(`[script] revealPlace "${s.place}" without an event runtime`)
        else await host.revealPlace(s.place)
        return 'done'
      case 'research':
        if (!ctx.data.species[s.species]) { console.warn(`[script] unknown species "${s.species}"`); return 'done' }
        scriptResearch(ctx, s.species, s.task, s.amount)
        return 'done'
      case 'end':
        return 'end'
    }
  }

  return {
    /** Runs steps to completion; 'abort' when a battle loss ended the script with a blackout. */
    run(steps: readonly ScriptStep[], npc: NpcDef | null): Promise<ScriptOutcome> {
      return exec(steps, npc, 0)
    },
  }
}

export type ScriptRunner = ReturnType<typeof createScriptRunner>
