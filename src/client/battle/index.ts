// Battle client (BattleRunner): plays a full battle on the HD-2D battle stage with the Octopath-style battle UI.
// Local battles run the shared engine through createLocalChannel; PvP passes a remote BattleChannel. The runner
// mutates ctx.save for local battles (party state via the engine, bag, money, dex, captures, evolutions); PvP only
// reads its cloned party. All tunables: content/battle-ui.json; all text: t('battleui.*') / engine messages.
import type { BattleAction, BattleInit, BattleResult, Creature, WeatherId } from '../../shared/types.ts'
import type { BattleOutcome, BattleRunner, GameContext } from '../contracts.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { creatureName, evolve } from '../../shared/creature.ts'
import { BattleEngine } from '../../shared/battle/engine.ts'
import { getMap, regionAt } from '../../shared/world/worldapi.ts'
import { RULES } from '../../shared/battle/rules.ts'
import { BATTLE_UI } from './config.ts'
import { createLocalChannel, type LocalChannel } from './channel.ts'
import { createDecider } from './decide.ts'
import { playEvolution } from './evolution.ts'
import { createBattleModel, finalResult } from './model.ts'
import { createPresenter, type PresenterEnv } from './present.ts'
import { markCaught, storeCaught } from './saveops.ts'
import { openScene, type BattleScene, type CoverMode } from './scene.ts'

export { createLocalChannel, isLocalChannel, type LocalChannel } from './channel.ts'
export { BATTLE_UI, validateBattleUi, type BattleUiConfig } from './config.ts'

/** Schema sentinel for clear weather (types.ts: WeatherId 'none'). */
const CLEAR: WeatherId = 'none'

interface Place { biome: string; indoor: boolean }

function currentPlace(ctx: GameContext): Place {
  const fallback = ctx.data.biomes[0]?.id ?? ''
  const p = ctx.overworld?.player
  const map = p && ctx.data.world ? getMap(ctx.data.world, p.map) : null
  if (!map || !p) return { biome: fallback, indoor: false }
  // WorldApi: works on the infinite overworld too (finite maps clamp to their edge as before).
  const region = regionAt(map, p.x, p.y)
  return { biome: region?.biome ?? fallback, indoor: BATTLE_UI.stage.indoorMapKinds.includes(map.kind) }
}

const characterOrNull = (ctx: GameContext, id: string | undefined): string | null => (id && ctx.data.characterById[id] ? id : null)

/** The overworld already covered the screen with its encounter transition when it flags an active battle. */
const coveredByCaller = (ctx: GameContext): boolean => (ctx.overworld as { battleActive?: boolean } | undefined)?.battleActive === true

export function createBattleRunner(ctx: GameContext): BattleRunner {
  /** Stores the capture first (synchronously, so a failing prompt can never lose it), then narrates. */
  async function catchFlow(scene: BattleScene, cr: Creature): Promise<void> {
    const { view } = scene
    const name = CONTENT.species[cr.speciesId]?.nameZh ?? cr.speciesId
    const newEntry = markCaught(ctx, cr.speciesId)
    const where = storeCaught(ctx, cr)
    if (newEntry) {
      ctx.ui.toast(t('battleui.catch.newDexToast', { name }), 'success')
      await view.message.show(t('battleui.catch.newDex', { name }))
    }
    if (cr.shiny) ctx.ui.toast(t('battleui.catch.shinyToast', { name }), 'success')
    if (BATTLE_UI.catch.nicknamePrompt) {
      view.setBarVisible(false)
      try {
        if (await ctx.ui.confirm(t('battleui.catch.nicknameAsk', { name }))) {
          const max = RULES.creature.nicknameMaxLen
          const nick = await ctx.ui.prompt(t('battleui.catch.nicknamePrompt', { name }), Array.from(name).length <= max ? name : '', max)
          const v = nick?.trim()
          if (v && v !== name) cr.nickname = v
        }
      } finally {
        view.setBarVisible(true)
      }
    }
    if (cr.nickname) ctx.events.emit('party:changed', {})
    const shown = creatureName(cr)
    if (where?.where === 'party') await view.message.show(t('battleui.catch.toParty', { name: shown }))
    else if (where?.where === 'box') await view.message.show(t('battleui.catch.toBox', { name: shown, box: where.box + 1 }))
  }

  return {
    async run(init: BattleInit, opts): Promise<BattleOutcome> {
      const kind = opts.kind
      const remote = opts.channel !== undefined
      const ownParty = init.sides[0].party
      const model = createBattleModel(init, CLEAR)
      const known = new Set<string>(ctx.save.dexSeen)
      let engine: BattleEngine | null = null
      let local: LocalChannel | null = null
      let scene: BattleScene | null = null
      let caught: Creature | undefined
      let stored = false
      ctx.events.emit('battle:start', { kind })

      try {
        engine = remote ? null : new BattleEngine(init, ctx.data)
        local = engine ? createLocalChannel(engine) : null
        const channel = opts.channel ?? local
        if (!channel) throw new Error('battle channel missing')
        const cover: CoverMode = coveredByCaller(ctx) ? 'covered' : 'transition'
        scene = await openScene(ctx, {
          biome: init.biome, timeOfDay: init.timeOfDay, indoor: !remote && currentPlace(ctx).indoor, cover,
        })
        const { stage, view } = scene
        const music = opts.music ?? ctx.data.audio.battleMusic[kind]
        if (music) ctx.audio.playBgm(music, { fadeMs: BATTLE_UI.music.fadeMs })
        stage.setTrainer(0, characterOrNull(ctx, init.sides[0].sprite ?? ctx.save.avatar))
        stage.setTrainer(1, init.sides[1].kind === 'wild' ? null : characterOrNull(ctx, opts.trainer?.sprite ?? init.sides[1].sprite))

        const env: PresenterEnv = { ctx, scene, model, init, kind, engine, ownParty, writesSave: !remote, introduced: null, known }
        const presenter = createPresenter(env)
        const decider = createDecider({ ctx, scene, model, init, kind, ownParty, known })

        let batch = await channel.start()
        ctx.events.emit('battle:events', { kind, events: batch.events })
        if (init.sides[1].kind === 'wild') {
          const first = batch.events.find((e) => e.t === 'switch' && e.side === 1)
          if (first?.t === 'switch') {
            stage.setCreature(1, first.creature.speciesId, first.creature.shiny)
            env.introduced = { side: 1, uid: first.creature.uid }
          }
        }
        await scene.settle(stage.ready)
        await Promise.all([scene.reveal(), scene.settle(stage.intro(BATTLE_UI.introByKind[kind]))])
        await scene.wait(BATTLE_UI.timing.afterIntroMs)
        await presenter.play(batch.events)

        const foeLabel = init.sides[1].trainerClass ? t('battle.trainerLabel', { class: init.sides[1].trainerClass, name: init.sides[1].name }) : init.sides[1].name
        while (!model.end) {
          const req = batch.request
          let action: BattleAction
          if (req.kind === 'action') action = await decider.chooseAction(req)
          else if (req.kind === 'switch') action = await decider.chooseReplacement()
          else break
          view.menus.close()
          if (remote) view.message.hold(t('battleui.prompt.waiting', { name: foeLabel }))
          else view.message.clear()
          batch = await channel.submit(action)
          ctx.events.emit('battle:events', { kind, events: batch.events })
          await presenter.play(batch.events)
        }

        const result = model.end?.result
        view.menus.close()
        if (result === 'win' && BATTLE_UI.music.victoryKinds.includes(kind)) ctx.audio.playBgm(BATTLE_UI.music.victory, { fadeMs: BATTLE_UI.music.fadeMs })
        await scene.wait(BATTLE_UI.timing.endHoldMs)
        if (result === 'caught' && engine?.caught) {
          caught = engine.caught
          stored = true
          await catchFlow(scene, caught)
        }
        for (const [i, to] of model.evolutions) {
          const cr = ownParty[i]
          if (cr && cr.hp > 0) await playEvolution(ctx, scene, cr, to)
        }
      } catch (err) {
        console.error('[battle] battle aborted', err)
        ctx.ui.toast(t('battleui.error.aborted'), 'error')
      } finally {
        local?.dispose()
        if (scene) await scene.close().catch((err: unknown) => console.error('[battle] scene close failed', err))
        else ctx.renderer.setTransition('none', 0)
      }

      const result: BattleResult = finalResult(model.end?.result, engine?.result, remote)
      if (result === 'caught' && !stored && engine?.caught) {
        caught = engine.caught
        markCaught(ctx, caught.speciesId)
        storeCaught(ctx, caught)
      }
      if (!remote) ctx.persist('battle')
      ctx.events.emit('battle:end', { kind, result })
      const moneyDelta = remote ? 0 : model.money
      return caught ? { result, moneyDelta, caught } : { result, moneyDelta }
    },

    async evolve(partyIndex: number, toSpeciesId: string): Promise<boolean> {
      const cr = ctx.save.party[partyIndex]
      if (!cr || !ctx.data.species[toSpeciesId] || cr.speciesId === toSpeciesId) return false
      const place = currentPlace(ctx)
      const before = ctx.audio.currentBgm
      let scene: BattleScene
      try {
        scene = await openScene(ctx, { biome: place.biome, timeOfDay: ctx.clock.timeOfDay, indoor: place.indoor, cover: 'fade' })
      } catch (err) {
        // No scene (e.g. renderer failure): the evolution still happens, just without the cutscene.
        console.error('[battle] evolution scene failed', err)
        evolve(cr, toSpeciesId, ctx.data)
        markCaught(ctx, toSpeciesId)
        ctx.events.emit('party:changed', {})
        ctx.persist('evolve')
        return true
      }
      let ok = false
      try {
        scene.view.setHudVisible(false)
        await scene.settle(scene.stage.ready)
        await scene.reveal()
        ok = await playEvolution(ctx, scene, cr, toSpeciesId)
      } catch (err) {
        console.error('[battle] evolution aborted', err)
        ok = cr.speciesId === toSpeciesId
      } finally {
        await scene.close().catch((err: unknown) => console.error('[battle] scene close failed', err))
        if (before) ctx.audio.playBgm(before, { fadeMs: BATTLE_UI.music.fadeMs })
      }
      if (ok) ctx.persist('evolve')
      return ok
    },
  }
}

