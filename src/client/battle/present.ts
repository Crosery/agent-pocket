// Plays BattleEvents in order on the battle stage and view: messages, attacks, hits with HP drain, faints,
// send-outs/recalls, status/stat/heal effects, weather, captures, exp bars across levels with the stat window,
// move learning, and the save side effects that belong to individual events (bag, money, dex seen).
import type { BattleEvent, BattleInit, Creature, CreatureView, SideIndex } from '../../shared/types.ts'
import type { BattleKind, GameContext } from '../contracts.ts'
import type { BattleEngine } from '../../shared/battle/engine.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { calcStats, creatureName } from '../../shared/creature.ts'
import { gradeOf } from '../../shared/gameplay/quality.ts'
import { BATTLE_UI } from './config.ts'
import { applyEvent, bossOpeningHud, bossPanelInfo, effCategory, expRatio, expSegments, levelUpStats, type BattleModel, type ExpSegment } from './model.ts'
import type { BattleScene } from './scene.ts'
import { addBagItem, changeMoney, consumeItem, markSeen } from './saveops.ts'
import { learnWithScreen } from './learn.ts'

export interface PresenterEnv {
  readonly ctx: GameContext
  readonly scene: BattleScene
  readonly model: BattleModel
  readonly init: BattleInit
  readonly kind: BattleKind
  /** In-process engine (local battles); null for remote channels. */
  readonly engine: BattleEngine | null
  /** Own party as the battle sees it (the save party locally, clones in PvP). */
  readonly ownParty: Creature[]
  /** Bag / money changes go to ctx.save (false for PvP). */
  readonly writesSave: boolean
  /** Species whose send-out the intro already showed (wild / legend foe). */
  introduced: { side: SideIndex; uid: string } | null
  /** Species the player has battled (effectiveness hints). */
  readonly known: Set<string>
}

export interface Presenter {
  play(events: readonly BattleEvent[]): Promise<void>
}

export function ballColorOf(cr: Pick<Creature, 'ballId'> | undefined): string | undefined {
  const e = cr?.ballId ? CONTENT.items[cr.ballId]?.effect : undefined
  return e?.kind === 'ball' ? e.color : undefined
}

export function createPresenter(env: PresenterEnv): Presenter {
  const { ctx, scene, model } = env
  const { stage, view } = scene
  const S = BATTLE_UI.sfx
  const sfx = (id: string) => ctx.audio.playSfx(id)
  const mirror = env.engine === null
  /** Runs after the next message has been shown (engine emits the event before its message). */
  let after: (() => Promise<void>)[] = []
  let prevKey = ''
  let exp: { partyIndex: number; segments: ExpSegment[]; next: number } | null = null

  const nameOf = (v: Pick<CreatureView, 'nickname' | 'speciesId'>) => creatureName(v)
  const growthOf = (i: number) => CONTENT.species[env.ownParty[i]?.speciesId ?? '']?.growth ?? ''
  const ownActive = () => model.sides[0].active
  const ownShown = (partyIndex: number) => ownActive() === partyIndex && model.sides[0].onField

  const syncSlots = (side: SideIndex) => {
    const s = model.sides[side]
    const show = s.kind !== 'wild'
    view.status[side].setSlots(show ? s.slots : null, show ? Math.max(s.slots.length, side === 0 ? CONTENT.config.party.maxParty : s.slots.length) : 0)
  }

  const mirrorOwn = (side: SideIndex) => {
    if (!mirror || side !== 0) return
    const cr = env.ownParty[ownActive()]
    const v = model.sides[0].view
    if (cr && v) { cr.hp = v.hp; cr.status = v.status }
  }

  async function animateExp(seg: ExpSegment, reset: boolean): Promise<void> {
    const panel = view.status[0]
    if (reset) await panel.setExp(seg.from, false)
    await panel.setExp(seg.to, true)
  }

  /** Quality letter on the wild foe's name plate, shown once the species is in the player's caught dex. */
  function foeGrade(side: number, partyIndex: number, speciesId: string): string | undefined {
    const sd = env.init.sides[side]
    if (side !== 1 || sd.kind !== 'wild' || !ctx.save.dexCaught.includes(speciesId)) return undefined
    const cr = sd.party[partyIndex]
    return cr ? gradeOf(cr.ivs, ctx.data).id : undefined
  }

  async function onSwitch(e: Extract<BattleEvent, { t: 'switch' }>): Promise<void> {
    const s = model.sides[e.side]
    const panel = view.status[e.side]
    const intro = env.introduced?.side === e.side && env.introduced.uid === e.creature.uid
    if (s.onField && !intro) {
      await scene.settle(stage.recall(e.side))
      panel.setAway(true)
    }
    applyEvent(model, e)
    panel.setCreature(e.creature, env.init.sides[e.side].party[e.partyIndex]?.abilityId, foeGrade(e.side, e.partyIndex, e.creature.speciesId))
    syncSlots(e.side)
    if (e.side === 1) {
      markSeen(ctx, e.creature.speciesId)
      const bossId = env.init.sides[1].boss
      const opening = bossId && !model.boss ? bossOpeningHud(bossId) : null
      if (opening) { model.boss = opening; view.setBoss(bossPanelInfo(opening)) }
    } else {
      const p = model.progress[e.partyIndex]
      void panel.setExp(p ? expRatio(growthOf(e.partyIndex), p.level, p.exp) : 0, false)
    }
    if (intro) {
      env.introduced = null
    } else {
      const src = e.side === 0 ? env.ownParty[e.partyIndex] : env.init.sides[1].party[e.partyIndex]
      stage.setCreature(e.side, e.creature.speciesId, e.creature.shiny)
      await scene.settle(stage.sendOut(e.side, ballColorOf(src)))
    }
    if (BATTLE_UI.cry.onSendOut) ctx.audio.playCry(e.creature.speciesId)
    panel.setAway(false)
  }

  /** Boss form change: the sprite swaps in place with a stat-burst, the window renames, a banner shows the new form. */
  async function onForm(e: Extract<BattleEvent, { t: 'form' }>): Promise<void> {
    const sp = CONTENT.species
    const before = model.sides[e.side].view
    applyEvent(model, e)
    const s = model.sides[e.side]
    const panel = view.status[e.side]
    panel.setCreature(e.creature, env.init.sides[e.side].party[s.active]?.abilityId, foeGrade(e.side, s.active, e.creature.speciesId))
    panel.setVolatiles(s.volatiles)
    panel.setStages(s.stages)
    syncSlots(e.side)
    if (e.side === 1) markSeen(ctx, e.creature.speciesId)
    stage.setCreature(e.side, e.creature.speciesId, e.creature.shiny)
    view.banner(e.side, t('battleui.boss.formBanner', { from: before ? nameOf(before) : '', to: nameOf(e.creature) }))
    sfx(S.ability)
    const power = (id: string) => Object.values(sp[id]?.baseStats ?? {}).reduce((a, b) => a + b, 0)
    await scene.settle(stage.statFx(e.side, power(e.creature.speciesId) >= power(e.fromSpeciesId)))
    if (BATTLE_UI.cry.onSendOut) ctx.audio.playCry(e.creature.speciesId)
  }

  async function onLevelUp(e: Extract<BattleEvent, { t: 'levelUp' }>): Promise<void> {
    const cr = env.ownParty[e.partyIndex]
    sfx(S.levelUp)
    if (!cr) return
    const shown = ownShown(e.partyIndex)
    if (shown) {
      const cap = env.init.levelCap
      const lv = (n: number) => (cap !== undefined && cap > 0 ? Math.min(n, cap) : n)
      const v = model.sides[0].view
      view.status[0].setLevel(lv(e.level))
      if (v) {
        v.level = lv(e.level)
        const before = calcStats({ speciesId: cr.speciesId, ivs: cr.ivs, nature: cr.nature, level: lv(e.level - 1) }).hp
        const max = calcStats({ speciesId: cr.speciesId, ivs: cr.ivs, nature: cr.nature, level: lv(e.level) }).hp
        if (v.hp > 0) v.hp = Math.min(max, v.hp + max - before)
        v.maxHp = max
        void view.status[0].setHp(v.hp, v.maxHp, true)
      }
      void scene.settle(stage.levelUpFx(0))
    }
    after.push(async () => {
      const title = t('battleui.levelUp.title', { name: creatureName(cr), level: e.level })
      await view.levelUp(title, levelUpStats(cr, e.level - 1, e.level))
      if (exp && exp.partyIndex === e.partyIndex && exp.next < exp.segments.length) {
        const seg = exp.segments[exp.next++]
        if (shown) await animateExp(seg, true)
      }
    })
  }

  async function onLearnable(partyIndex: number, moveId: string): Promise<void> {
    const cr = env.ownParty[partyIndex]
    if (cr) await learnWithScreen(ctx, view, cr, moveId)
  }

  async function handle(e: BattleEvent): Promise<void> {
    switch (e.t) {
      case 'msg': {
        await view.message.show(e.text)
        const queued = after
        after = []
        for (const fn of queued) await fn()
        return
      }
      case 'turn':
        return
      case 'move': {
        const def = CONTENT.moves[e.moveId]
        if (mirror && e.side === 0) {
          const slot = env.ownParty[ownActive()]?.moves.find((m) => m.id === e.moveId)
          if (slot && slot.pp > 0) slot.pp -= 1
        }
        if (e.side === 0 && model.sides[1].view) env.known.add(model.sides[1].view.speciesId)
        await scene.settle(stage.attack(e.side, e.anim, e.type, def?.category ?? 'physical'))
        return
      }
      case 'damage': {
        applyEvent(model, e)
        mirrorOwn(e.side)
        syncSlots(e.side)
        if (e.amount <= 0) return
        sfx(e.crit ? S.crit : S.hit[effCategory(e.effectiveness)])
        await scene.settle(Promise.all([stage.hit(e.side, e.effectiveness, e.crit), view.status[e.side].setHp(e.hp, e.maxHp, true)]))
        return
      }
      case 'heal': {
        applyEvent(model, e)
        mirrorOwn(e.side)
        sfx(S.heal)
        await scene.settle(Promise.all([stage.healFx(e.side), view.status[e.side].setHp(e.hp, e.maxHp, true)]))
        return
      }
      case 'miss':
        sfx(S.miss)
        await scene.settle(stage.miss(e.side))
        return
      case 'status': {
        applyEvent(model, e)
        mirrorOwn(e.side)
        view.status[e.side].setStatus(e.status)
        syncSlots(e.side)
        if (e.status) {
          sfx(S.status)
          await scene.settle(stage.statusFx(e.side, e.status))
        }
        return
      }
      case 'volatile':
        applyEvent(model, e)
        view.status[e.side].setVolatiles(model.sides[e.side].volatiles)
        return
      case 'stat': {
        applyEvent(model, e)
        view.status[e.side].setStages(model.sides[e.side].stages)
        const key = `stat:${e.side}:${e.delta > 0}`
        if (prevKey === key) return
        sfx(e.delta > 0 ? S.statUp : S.statDown)
        await scene.settle(stage.statFx(e.side, e.delta > 0))
        return
      }
      case 'faint': {
        const v = model.sides[e.side].view
        applyEvent(model, e)
        mirrorOwn(e.side)
        syncSlots(e.side)
        if (v && BATTLE_UI.cry.onFaint) ctx.audio.playCry(v.speciesId, { pitch: BATTLE_UI.cry.faintPitch })
        sfx(S.faint)
        await scene.settle(stage.faint(e.side))
        view.status[e.side].setAway(true)
        await scene.wait(BATTLE_UI.timing.faintSettleMs)
        return
      }
      case 'switch':
        await onSwitch(e)
        return
      case 'weather':
        applyEvent(model, e)
        stage.weatherFx(e.weather)
        view.setWeather(e.weather)
        return
      case 'ability': {
        const v = model.sides[e.side].view
        const ability = CONTENT.abilities[e.abilityId]?.nameZh ?? e.abilityId
        sfx(S.ability)
        view.banner(e.side, t('battleui.ability.banner', { name: v ? nameOf(v) : '', ability }))
        return
      }
      case 'item':
        sfx(S.item)
        if (e.side === 0 && env.writesSave) consumeItem(ctx, e.itemId)
        return
      case 'catch': {
        const item = CONTENT.items[e.ballId]
        const color = item?.effect.kind === 'ball' ? item.effect.color : ''
        sfx(S.throwBall)
        await scene.settle(stage.throwBall(color, e.shakes, e.success))
        sfx(e.success ? S.catch : S.catchFail)
        applyEvent(model, e)
        if (e.success) view.status[1].setAway(true)
        return
      }
      case 'exp': {
        const from = { ...(model.progress[e.partyIndex] ?? { level: e.level, exp: e.exp }) }
        applyEvent(model, e)
        const segments = expSegments(growthOf(e.partyIndex), from, { level: e.level, exp: e.exp })
        exp = { partyIndex: e.partyIndex, segments, next: 1 }
        if (ownShown(e.partyIndex) && segments[0]) await animateExp(segments[0], false)
        return
      }
      case 'levelUp':
        await onLevelUp(e)
        return
      case 'learnMove':
        after.push(async () => sfx(S.learn))
        return
      case 'moveLearnable':
        after.push(() => onLearnable(e.partyIndex, e.moveId))
        return
      case 'evolveReady':
        applyEvent(model, e)
        return
      case 'money':
        applyEvent(model, e)
        if (env.writesSave) changeMoney(ctx, e.amount)
        sfx(S.money)
        return
      case 'flee':
        // Wild flee (BattleSideInit.flee): the engine's own message follows; 'fled' plays the foe leaving the field.
        if (e.stage === 'warn') { sfx(S.status); return }
        sfx(S.run)
        await scene.settle(stage.recall(e.side))
        view.status[e.side].setAway(true)
        return
      case 'boss': {
        const before = model.boss
        applyEvent(model, e)
        view.setBoss(bossPanelInfo(e.hud))
        if (before && e.hud.phase > before.phase) {
          sfx(S.ability)
          view.status[e.side].pulseBoss()
          view.banner(e.side, t('battleui.boss.phase', { n: e.hud.phase }))
        }
        return
      }
      case 'form':
        await onForm(e)
        return
      case 'telegraph':
        sfx(S.status)
        view.status[e.side].pulseBoss()
        return
      case 'loot':
        if (env.writesSave) addBagItem(ctx, e.itemId, e.qty)
        sfx(S.item)
        return
      case 'end':
        applyEvent(model, e)
        if (e.result === 'run') sfx(S.run)
        return
    }
  }

  return {
    async play(events) {
      for (const e of events) {
        await handle(e)
        if (e.t !== 'msg') prevKey = e.t === 'stat' ? `stat:${e.side}:${e.delta > 0}` : e.t
      }
      const queued = after
      after = []
      for (const fn of queued) await fn()
    },
  }
}
