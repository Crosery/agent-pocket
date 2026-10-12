// Player decisions: command window -> move list / bag / party / run / forfeit, and forced switches. Validates what
// the engine cannot know (storage space for captures) and explains unavailable choices in the message window.
import type { BattleAction, BattleInit, BattleRequest, Creature } from '../../shared/types.ts'
import type { BattleKind, GameContext, ListItem } from '../contracts.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { creatureName } from '../../shared/creature.ts'
import { BATTLE_UI, type CommandId } from './config.ts'
import type { MoveItem } from './menus.ts'
import { catchPlacement } from '../../shared/gameplay/save-ops.ts'
import { coachCommandPulse, moveEffectiveness, type BattleModel } from './model.ts'
import type { BattleScene } from './scene.ts'

type ActionRequest = Extract<BattleRequest, { kind: 'action' }>

export interface DecideEnv {
  readonly ctx: GameContext
  readonly scene: BattleScene
  readonly model: BattleModel
  readonly init: BattleInit
  readonly kind: BattleKind
  readonly ownParty: Creature[]
  /** Species the player has seen before / battled (effectiveness hints). */
  readonly known: Set<string>
}

export interface Decider {
  chooseAction(req: ActionRequest): Promise<BattleAction | null>
  chooseReplacement(): Promise<BattleAction | null>
  cancel(): void
}

export function createDecider(env: DecideEnv): Decider {
  const { ctx, scene, model } = env
  const { view } = scene
  const S = BATTLE_UI.sfx
  const pvp = env.kind === 'pvp'
  let lastCommand = 0
  let lastMove = 0
  let cancelCurrent: (() => void) | null = null

  const active = (): Creature | undefined => env.ownParty[model.sides[0].active]
  const refuse = async (text: string) => {
    ctx.audio.playSfx(S.error)
    await view.message.show(text)
  }

  function startTimer(): () => void {
    if (!pvp) return () => undefined
    const deadline = performance.now() + ctx.data.config.net.pvpTurnSeconds * 1000
    scene.onFrame(() => view.setTimer((deadline - performance.now()) / 1000))
    return () => { scene.onFrame(null); view.setTimer(null) }
  }

  const isTypeLesson = () =>
    env.init.sides[1].name === '陪练智灵' || Boolean(ctx.save.flags['ob:typeLesson'] && !ctx.save.flags['ds:stamp:types'])

  const hasStatBuff = () =>
    Object.values(model.sides[0].stages).some((v) => (v ?? 0) > 0) ||
    Object.values(model.sides[1].stages).some((v) => (v ?? 0) < 0) ||
    model.sides[0].volatiles.length > 0

  const isCaptureTutorial = () => {
    if (!env.init.isWild || !env.init.canCatch) return false
    const hasBall = Object.entries(ctx.save.bag).some(([id, n]) => n > 0 && CONTENT.items[id]?.effect.kind === 'ball')
    if (!hasBall) return false
    const foe = model.sides[1].view
    return foe?.speciesId === 'ernie-bot' || (ctx.save.stats.caught === 0 && !ctx.save.flags['ds:ernie'])
  }

  function moveItems(cr: Creature): MoveItem[] {
    const foe = model.sides[1].view
    const foeTypes = foe ? CONTENT.species[foe.speciesId]?.types ?? [] : []
    const typeLesson = isTypeLesson()
    const seen = typeLesson || !BATTLE_UI.moves.hintRequiresSeen || (foe !== null && env.known.has(foe.speciesId))
    const blocker = model.sides[0].volatiles.find((v) => CONTENT.volatileById[v]?.blocksStatusMoves)
    const buffed = hasStatBuff()

    const atkItems = cr.moves
      .map((slot) => ({ slot, def: CONTENT.moves[slot.id] ?? null }))
      .filter(({ def }) => def && def.category !== 'status')
    const hasSuper = atkItems.some(({ def }) => foe && moveEffectiveness(def!, foeTypes) === 'super')
    const allWeak = atkItems.length > 0 && atkItems.every(({ def }) => {
      const eff = moveEffectiveness(def!, foeTypes)
      return eff === 'weak' || eff === 'immune'
    })
    const neutralAtkSlots = atkItems
      .filter(({ def }) => {
        const eff = moveEffectiveness(def!, foeTypes)
        return eff === 'normal' || eff === null
      })
      .sort((a, b) => (b.def?.power ?? 0) - (a.def?.power ?? 0))
    const bestNeutralId = neutralAtkSlots[0]?.slot.id

    return cr.moves.map((slot) => {
      const def = CONTENT.moves[slot.id] ?? null
      const eff = def && foe ? moveEffectiveness(def, foeTypes) : null
      const hint = eff === null ? null : seen ? eff : 'unknown'
      const isSuper = typeLesson && hint === 'super'
      const isStatusPulse = typeLesson && !hasSuper && !allWeak && !buffed && def?.category === 'status'
      const isNeutralPulse = typeLesson && !hasSuper && !allWeak && slot.id === bestNeutralId
      return {
        def,
        label: def?.nameZh ?? slot.id,
        pp: slot.pp,
        ppMax: slot.ppMax,
        disabled: slot.pp <= 0 || !def || (blocker !== undefined && def.category === 'status'),
        hint,
        pulse: isSuper || isStatusPulse || isNeutralPulse,
      }
    })
  }

  /** Index of a party member to send in, or -1 when cancelled. */
  async function pickMember(forced: boolean): Promise<number> {
    const cur = model.sides[0].active
    const title = t(forced ? 'battleui.prompt.forcedSwitch' : 'battleui.prompt.switchTitle')
    view.setBarVisible(false)
    try {
      if (env.ownParty === ctx.save.party) {
        const current = env.ownParty[cur]
        return await ctx.screens.party('battleSwitch', { title, filter: (c) => c !== current && c.hp > 0 })
      }
      const items: ListItem[] = env.ownParty.map((c, i) => {
        const v = model.sides[0].active === i ? model.sides[0].view : null
        const hp = v ? v.hp : c.hp
        const fainted = model.sides[0].slots[i]?.state === 'fainted' || hp <= 0
        return {
          label: creatureName(c),
          sub: i === cur ? t('battleui.party.active') : fainted ? t('battleui.party.fainted') : t('battleui.party.level', { level: v?.level ?? c.level }),
          icon: ctx.assets.creatureImageUrl(c.speciesId),
          disabled: i === cur || fainted,
        }
      })
      const first = items.findIndex((it) => !it.disabled)
      return await ctx.ui.list(title, items, { initial: Math.max(0, first) })
    } finally {
      view.setBarVisible(true)
    }
  }

  async function fight(cr: Creature): Promise<BattleAction | null> {
    const items = moveItems(cr)
    if (!items.some((m) => !m.disabled)) return { kind: 'move', moveIndex: 0 }
    view.message.hold(t('battleui.prompt.move'))
    // The type chart opens over the battle (it pauses, see battle-ui.json pause.selectors); closing it lands back on the list.
    const openChart = (at: number) => {
      const type = items[at]?.def?.type
      view.setBarVisible(false)
      void ctx.screens.typeChart({ view: BATTLE_UI.moves.chart.view, ...(type ? { type } : {}) }).finally(() => view.setBarVisible(true))
    }
    const typeLesson = isTypeLesson()
    let initMoveIdx = Math.min(lastMove, items.length - 1)
    if (typeLesson) {
      const superIdx = items.findIndex((m) => m.hint === 'super' && !m.disabled)
      const atkMoves = items
        .map((m, idx) => ({ m, idx }))
        .filter(({ m }) => m.def?.category !== 'status' && !m.disabled)
      const allWeak = atkMoves.length > 0 && atkMoves.every(({ m }) => m.hint === 'weak' || m.hint === 'immune')
      const neutralMoves = atkMoves.filter(({ m }) => m.hint === 'normal' || m.hint === 'unknown')
      neutralMoves.sort((a, b) => (b.m.def?.power ?? 0) - (a.m.def?.power ?? 0))
      const bestNeutralIdx = neutralMoves[0]?.idx ?? -1

      if (superIdx >= 0) initMoveIdx = superIdx
      else if (allWeak && atkMoves[0]) initMoveIdx = atkMoves[0].idx
      else if (bestNeutralIdx >= 0) initMoveIdx = bestNeutralIdx
    }
    const i = await view.menus.openMoves(items, initMoveIdx, openChart, { chartPulse: typeLesson })
    if (i < 0) return null
    lastMove = i
    const it = items[i]
    if (it.disabled) {
      const blocker = model.sides[0].volatiles.find((v) => CONTENT.volatileById[v]?.blocksStatusMoves)
      await refuse(it.pp <= 0 || !blocker
        ? t('battle.err.noPp')
        : t('battle.err.blocked', { name: creatureName(cr), volatile: CONTENT.volatileById[blocker]?.nameZh ?? blocker }))
      return null
    }
    return { kind: 'move', moveIndex: i }
  }

  async function bag(req: ActionRequest): Promise<BattleAction | null> {
    if (!req.canItem) { await refuse(t('battle.err.cantItem')); return null }
    view.setBarVisible(false)
    const pick = await ctx.screens.bag('battle').finally(() => view.setBarVisible(true))
    if (!pick) return null
    const item = CONTENT.items[pick.itemId]
    if (!item) return null
    if (item.effect.kind === 'ball') {
      if (!env.init.isWild || !env.init.canCatch) { await refuse(env.init.sides[1].boss && env.init.bossTier ? t('battle.err.cantCatchBoss') : t('battleui.bag.cantCatch')); return null }
      if (!catchPlacement(ctx.save, ctx.data)) { await refuse(t('battleui.bag.noSpace')); return null }
    } else if (!item.usableInBattle) {
      await refuse(t('battleui.bag.cantUse'))
      return null
    }
    return pick.partyIndex !== undefined ? { kind: 'item', itemId: item.id, partyIndex: pick.partyIndex } : { kind: 'item', itemId: item.id }
  }

  async function command(id: CommandId, req: ActionRequest, cr: Creature): Promise<BattleAction | null> {
    switch (id) {
      case 'fight':
        return fight(cr)
      case 'bag':
        return bag(req)
      case 'party': {
        if (!req.canSwitch) { await refuse(t('battle.err.cantSwitch')); return null }
        const i = await pickMember(false)
        return i >= 0 ? { kind: 'switch', partyIndex: i } : null
      }
      case 'run':
        if (!req.canRun) { await refuse(t('battle.err.cantRun')); return null }
        return { kind: 'run' }
      case 'forfeit':
        view.setBarVisible(false)
        try {
          return (await ctx.ui.confirm(t('battleui.forfeit.confirm'))) ? { kind: 'forfeit' } : null
        } finally {
          view.setBarVisible(true)
        }
    }
  }

  const enabled = (id: CommandId, req: ActionRequest): boolean =>
    id === 'bag' ? req.canItem : id === 'party' ? req.canSwitch : id === 'run' ? req.canRun : true

  return {
    async chooseAction(req) {
      const stop = startTimer()
      let cancelled = false
      let resolveCancel: ((v: null) => void) | null = null
      const cancelPromise = new Promise<null>((r) => { resolveCancel = r })
      cancelCurrent = () => {
        cancelled = true
        view.menus.close()
        resolveCancel?.(null)
      }
      try {
        // The coach speaks when the command menu opens (one line per turn) and steps aside once a command is picked.
        const line = model.coach.shift()
        const loop = async (): Promise<BattleAction | null> => {
          for (;;) {
            if (cancelled || model.end) return null
            const cr = active()
            if (!cr) return { kind: 'move', moveIndex: 0 }
            view.message.hold(t('battleui.prompt.command', { name: model.sides[0].view ? creatureName(model.sides[0].view) : creatureName(cr) }))
            const ids = pvp ? BATTLE_UI.commands.pvp : BATTLE_UI.commands.normal

            let activeCoach = line ? { text: line.text, speaker: line.speaker, portraitUrl: line.portrait ? ctx.assets.portraitUrl(line.portrait) : null } : null
            const needsCouponGuide = Boolean(
              (env.init.coach || model.boss) &&
              (ctx.save.bag['off-peak-coupon'] ?? 0) > 0 &&
              (model.boss?.meters['tide'] ?? 0) <= 0 &&
              !ctx.save.flags['ds:done']
            )
            let pulse = coachCommandPulse(model, env.init.coach, ctx.save.bag, ctx.data)
            if (!activeCoach && isTypeLesson()) {
              const foe = model.sides[1].view
              const foeName = foe ? creatureName(foe) : '对手'
              const foeTypes = (foe ? CONTENT.species[foe.speciesId]?.types ?? [] : [])
                .map((ty) => CONTENT.typeById[ty]?.nameZh ?? ty)
                .join(' / ')
              const moves = moveItems(cr)
              const superMove = moves.find((m) => m.hint === 'super' && !m.disabled)
              const atkMoves = moves.filter((m) => m.def?.category !== 'status' && !m.disabled)
              const allWeak = atkMoves.length > 0 && atkMoves.every((m) => m.hint === 'weak' || m.hint === 'immune')
              const neutralMoves = atkMoves.filter((m) => m.hint === 'normal' || m.hint === 'unknown')
              neutralMoves.sort((a, b) => (b.def?.power ?? 0) - (a.def?.power ?? 0))
              const bestNeutral = neutralMoves[0]
              const statusMove = moves.find((m) => m.def?.category === 'status' && !m.disabled)
              const buffed = hasStatBuff()

              if (superMove) {
                activeCoach = {
                  speaker: '阿灵',
                  portraitUrl: ctx.assets.portraitUrl('trainer_scientist'),
                  text: `【第一课·属性克制】${foeName}是【${foeTypes}】！你的属性正好克制它，点击高亮「战斗」选标有【克制】的「${superMove.label}」，能打出 2 倍效果拔群！`,
                }
                pulse = 'fight'
              } else if (allWeak) {
                activeCoach = {
                  speaker: '阿灵',
                  portraitUrl: ctx.assets.portraitUrl('trainer_scientist'),
                  text: `【第三课·属性抵抗】注意！${foeName}是【${foeTypes}】，抵抗你的招式（只有 0.5 倍微弱伤害，会刮痧）！遇到逆属性强攻很吃亏，实战中点【队伍】换队友！`,
                }
                pulse = 'fight'
              } else {
                activeCoach = {
                  speaker: '阿灵',
                  portraitUrl: ctx.assets.portraitUrl('trainer_scientist'),
                  text: (!buffed && statusMove)
                    ? `【第二课·常规与增益】${foeName}是【${foeTypes}】，双方无克制（1 倍标准伤害）。除了用「${bestNeutral?.label ?? '攻击招式'}」出招，也可以用增益招式「${statusMove.label}」强化自身！`
                    : `【第二课·全力进攻】${foeName}是【${foeTypes}】，双方无克制（1 倍标准伤害）。选择威力最高的「${bestNeutral?.label ?? '攻击招式'}」全力进攻！`,
                }
                pulse = 'fight'
              }
            } else if (!activeCoach && isCaptureTutorial()) {
              const foe = model.sides[1].view
              const foeName = foe ? creatureName(foe) : '野生智灵'
              activeCoach = {
                speaker: '收服引导',
                portraitUrl: ctx.assets.portraitUrl('creature:deepseek-r1'),
                text: `${foeName}已经迫不及待加入队伍了！无需攻击，直接点击高亮的「背包」投出提示词球即可 100% 成功收服！`,
              }
              pulse = 'bag'
              const bagIdx = ids.indexOf('bag')
              if (bagIdx >= 0) lastCommand = bagIdx
            } else if (needsCouponGuide) {
              if (!activeCoach) {
                activeCoach = {
                  speaker: '小 R',
                  portraitUrl: ctx.assets.portraitUrl('creature:deepseek-r1'),
                  text: `现在是高峰期！点击高亮的「背包」使用【谷时半价券】，直接将她打入谷时半价！`,
                }
              }
              pulse = 'bag'
              const bagIdx = ids.indexOf('bag')
              if (bagIdx >= 0) lastCommand = bagIdx
            }

            view.setCoach(activeCoach)
            const id = await view.menus.openCommands(ids.map((x) => ({ id: x, disabled: !enabled(x, req), pulse: x === pulse })), Math.min(lastCommand, ids.length - 1))
            view.setCoach(null)
            if (cancelled || model.end) return null
            lastCommand = ids.indexOf(id)
            const action = await command(id, req, cr)
            if (cancelled || model.end) return null
            if (action) return action
          }
        }
        return await Promise.race([loop(), cancelPromise])
      } finally {
        cancelCurrent = null
        stop()
        view.setCoach(null)
      }
    },
    async chooseReplacement() {
      const stop = startTimer()
      let cancelled = false
      let resolveCancel: ((v: null) => void) | null = null
      const cancelPromise = new Promise<null>((r) => { resolveCancel = r })
      cancelCurrent = () => {
        cancelled = true
        view.menus.close()
        resolveCancel?.(null)
      }
      try {
        const loop = async (): Promise<BattleAction | null> => {
          for (;;) {
            if (cancelled || model.end) return null
            view.message.hold(t('battleui.prompt.forcedSwitch'))
            const i = await pickMember(true)
            if (cancelled || model.end) return null
            if (i >= 0) return { kind: 'switch', partyIndex: i }
          }
        }
        return await Promise.race([loop(), cancelPromise])
      } finally {
        cancelCurrent = null
        stop()
      }
    },
    cancel() {
      cancelCurrent?.()
    },
  }
}
