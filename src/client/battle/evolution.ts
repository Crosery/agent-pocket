// Evolution cutscene on a battle scene: narration, stage.evolveFx (cancel key aborts during the silhouette swap),
// evolve() from creature.ts, dex registration, then stage moves the full move list could not take.
import type { Creature } from '../../shared/types.ts'
import type { GameContext } from '../contracts.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { creatureName, evolve } from '../../shared/creature.ts'
import { actionKeyLabel } from '../ui/widgets.ts'
import { BATTLE_UI } from './config.ts'
import { learnWithScreen } from './learn.ts'
import { evolutionMoves } from './model.ts'
import { markCaught } from './saveops.ts'
import type { BattleScene } from './scene.ts'

/** Plays the cutscene and applies the evolution. Resolves false when the player cancelled it. */
export async function playEvolution(ctx: GameContext, scene: BattleScene, cr: Creature, toSpeciesId: string): Promise<boolean> {
  const to = CONTENT.species[toSpeciesId]
  if (!to || cr.speciesId === toSpeciesId) return false
  const { stage, view } = scene
  const S = BATTLE_UI.sfx
  const name = creatureName(cr)
  view.menus.close()
  view.setHudVisible(false)
  // evolveFx restores the actors that were visible before it, so the slot is hidden for the cutscene and
  // re-shown with the resulting species afterwards (otherwise the pre-evolution sprite fades back in).
  stage.setCreature(0, cr.speciesId, cr.shiny)
  stage.showCreature(0, true)
  ctx.audio.playBgm(BATTLE_UI.music.evolution, { fadeMs: BATTLE_UI.music.fadeMs })
  await view.message.show(t('battleui.evolve.start', { name }))
  await scene.wait(BATTLE_UI.evolve.startHoldMs)
  view.message.hold(t('battleui.evolve.hint', { key: actionKeyLabel('cancel', ctx.input.lastDevice) }))
  ctx.audio.playCry(cr.speciesId)
  ctx.audio.playSfx(S.evolveStart)
  view.setInterceptor((inp) => {
    if (!inp.pressed('cancel')) return false
    inp.consume('cancel')
    stage.cancelEvolve()
    return true
  })
  let ok = false
  stage.showCreature(0, false)
  try {
    ok = await stage.evolveFx(cr.speciesId, toSpeciesId, cr.shiny)
  } finally {
    view.setInterceptor(null)
    stage.setCreature(0, ok ? toSpeciesId : cr.speciesId, cr.shiny)
    stage.showCreature(0, true)
  }
  if (!ok) {
    ctx.audio.playSfx(S.evolveCancel)
    await view.message.show(t('battleui.evolve.cancelled', { name }))
    return false
  }
  const pending = evolutionMoves(cr, toSpeciesId)
  evolve(cr, toSpeciesId, ctx.data)
  ctx.audio.playCry(toSpeciesId, { pitch: BATTLE_UI.cry.evolvePitch })
  ctx.audio.playSfx(S.evolveDone)
  if (markCaught(ctx, toSpeciesId)) ctx.ui.toast(t('battleui.evolve.newDexToast', { name: to.nameZh }), 'success')
  ctx.events.emit('party:changed', {})
  const kind = to.evolvesFrom ? CONTENT.species[to.evolvesFrom]?.evolvesTo?.kind : undefined
  await view.message.show(t(kind === 'post-training' ? 'battleui.evolve.donePostTraining' : 'battleui.evolve.done', { name, to: to.nameZh }))
  for (const moveId of pending) if (!cr.moves.some((m) => m.id === moveId)) await learnWithScreen(ctx, view, cr, moveId)
  await scene.wait(BATTLE_UI.evolve.endHoldMs)
  return true
}
