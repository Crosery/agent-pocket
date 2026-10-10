// Player decisions: command window -> move list / bag / party / run / forfeit, and forced switches. Validates what
// the engine cannot know (storage space for captures) and explains unavailable choices in the message window.
import type { BattleAction, BattleInit, BattleRequest, Creature } from '../../shared/types.ts'
import type { BattleKind, GameContext, ListItem } from '../contracts.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { creatureName } from '../../shared/creature.ts'
import { BATTLE_UI, type CommandId } from './config.ts'
import type { MoveItem } from './menus.ts'
import { catchPlacement, moveEffectiveness, type BattleModel } from './model.ts'
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
  chooseAction(req: ActionRequest): Promise<BattleAction>
  chooseReplacement(): Promise<BattleAction>
}

export function createDecider(env: DecideEnv): Decider {
  const { ctx, scene, model } = env
  const { view } = scene
  const S = BATTLE_UI.sfx
  const pvp = env.kind === 'pvp'
  let lastCommand = 0
  let lastMove = 0

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

  function moveItems(cr: Creature): MoveItem[] {
    const foe = model.sides[1].view
    const foeTypes = foe ? CONTENT.species[foe.speciesId]?.types ?? [] : []
    const seen = !BATTLE_UI.moves.hintRequiresSeen || (foe !== null && env.known.has(foe.speciesId))
    const blocker = model.sides[0].volatiles.find((v) => CONTENT.volatileById[v]?.blocksStatusMoves)
    return cr.moves.map((slot) => {
      const def = CONTENT.moves[slot.id] ?? null
      const eff = def && foe ? moveEffectiveness(def, foeTypes) : null
      return {
        def,
        label: def?.nameZh ?? slot.id,
        pp: slot.pp,
        ppMax: slot.ppMax,
        disabled: slot.pp <= 0 || !def || (blocker !== undefined && def.category === 'status'),
        hint: eff === null ? null : seen ? eff : 'unknown',
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
    const i = await view.menus.openMoves(items, Math.min(lastMove, items.length - 1), openChart)
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
      try {
        for (;;) {
          const cr = active()
          if (!cr) return { kind: 'move', moveIndex: 0 }
          view.message.hold(t('battleui.prompt.command', { name: model.sides[0].view ? creatureName(model.sides[0].view) : creatureName(cr) }))
          const ids = pvp ? BATTLE_UI.commands.pvp : BATTLE_UI.commands.normal
          const id = await view.menus.openCommands(ids.map((x) => ({ id: x, disabled: !enabled(x, req) })), Math.min(lastCommand, ids.length - 1))
          lastCommand = ids.indexOf(id)
          const action = await command(id, req, cr)
          if (action) return action
        }
      } finally {
        stop()
      }
    },
    async chooseReplacement() {
      const stop = startTimer()
      try {
        for (;;) {
          view.message.hold(t('battleui.prompt.forcedSwitch'))
          const i = await pickMember(true)
          if (i >= 0) return { kind: 'switch', partyIndex: i }
        }
      } finally {
        stop()
      }
    },
  }
}
