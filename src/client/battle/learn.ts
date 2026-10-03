// Move learning with a full move list (after a level-up or an evolution): asks the learn-move screen which move to
// forget and narrates the result in the battle message window.
import type { Creature } from '../../shared/types.ts'
import type { GameContext } from '../contracts.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { creatureName } from '../../shared/creature.ts'
import { BATTLE_UI } from './config.ts'
import type { BattleView } from './view.ts'

export async function learnWithScreen(ctx: GameContext, view: BattleView, cr: Creature, moveId: string): Promise<boolean> {
  const move = CONTENT.moves[moveId]
  if (!move || cr.moves.some((m) => m.id === moveId)) return false
  const name = creatureName(cr)
  if (cr.moves.length < CONTENT.config.party.maxMoves) {
    cr.moves.push({ id: moveId, pp: move.pp, ppMax: move.pp })
    ctx.events.emit('party:changed', {})
    ctx.audio.playSfx(BATTLE_UI.sfx.learn)
    await view.message.show(t('battleui.learn.learned', { name, move: move.nameZh }))
    return true
  }
  view.setBarVisible(false)
  const slot = await ctx.screens.learnMove(cr, moveId)
  view.setBarVisible(true)
  if (slot < 0 || slot >= cr.moves.length) {
    await view.message.show(t('battleui.learn.skipped', { name, move: move.nameZh }))
    return false
  }
  const old = CONTENT.moves[cr.moves[slot].id]?.nameZh ?? cr.moves[slot].id
  cr.moves[slot] = { id: moveId, pp: move.pp, ppMax: move.pp }
  ctx.events.emit('party:changed', {})
  await view.message.show(t('battleui.learn.forgot', { name, old }))
  ctx.audio.playSfx(BATTLE_UI.sfx.learn)
  await view.message.show(t('battleui.learn.learned', { name, move: move.nameZh }))
  return true
}
