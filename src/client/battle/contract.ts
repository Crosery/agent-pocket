// Boss contract rules without any DOM: which balls can sign, and the signing itself (roll the card, store it, count it).
// The screen that plays it lives in capture.ts; both read content/world/instances.json, content/quality.json and
// content/battle-ui.json (contract).
import type { Creature } from '../../shared/types.ts'
import type { GameContext } from '../contracts.ts'
import { hashString, Rng } from '../../shared/rng.ts'
import { captureSeed, rollBossCard } from '../../shared/gameplay/bosscard.ts'
import { instanceOfBoss, progressOf } from '../../shared/gameplay/instances.ts'
import { BATTLE_UI } from './config.ts'
import { consumeItem, markCaught, storeCaught, type SaveCtx } from './saveops.ts'

export interface BallChoice {
  id: string
  /** Held count; 0 is the gifted default ball of a trainer who holds none. */
  owned: number
}

/** Balls the player can sign with, cheapest first (the default); the gifted ball when none is held. */
export function ballChoices(ctx: SaveCtx): BallChoice[] {
  const held = Object.entries(ctx.save.bag)
    .filter(([id, n]) => n > 0 && ctx.data.items[id]?.effect.kind === 'ball')
    .sort((a, b) => (ctx.data.items[a[0]].price ?? 0) - (ctx.data.items[b[0]].price ?? 0) || a[0].localeCompare(b[0]))
    .map(([id, owned]) => ({ id, owned }))
  return held.length ? held : [{ id: BATTLE_UI.contract.defaultBall, owned: 0 }]
}

/** Seed number of the card a save signs: the first card is fixed by the save, so reloading the room never rerolls it. */
export function contractSeed(ctx: Pick<SaveCtx, 'save'>, instanceId: string, tierId: string, first: boolean): number {
  const save = ctx.save
  save.rollSeed ??= hashString(save.playerId) >>> 0
  return captureSeed(save.rollSeed, instanceId, tierId, first ? 0 : progressOf(save, instanceId).runSeq)
}

export interface Signed { card: Creature; where: 'party' | 'box'; newEntry: boolean }

/**
 * Signs the boss card of `tierId`: rolls it, files it in the party or a box (a full house overflows the last box, the
 * first card is never lost), registers the dex entry and counts the capture. null: the tier has no capture, or it
 * was already signed and the tier does not repeat.
 */
export function signContract(
  ctx: SaveCtx & Pick<GameContext, 'overworld'>, bossId: string, tierId: string, ballId: string,
): Signed | null {
  const inst = instanceOfBoss(bossId)
  const rules = inst?.def.tiers[tierId]
  if (!inst || !rules) return null
  const prog = progressOf(ctx.save, inst.id)
  const first = (prog.captures[tierId] ?? 0) === 0
  if (!first && !rules.repeat.capture) return null
  const rng = new Rng(contractSeed(ctx, inst.id, tierId, first))
  const card = rollBossCard(rng, bossId, tierId, rules, {
    first, run: String(prog.runSeq), at: Date.now(), otName: ctx.save.name, otId: ctx.save.playerId, ballId,
    ...(ctx.overworld?.player?.map ? { caughtMap: ctx.overworld.player.map } : {}),
  }, ctx.data)
  const newEntry = markCaught(ctx, card.speciesId)
  const where = storeCaught(ctx, card)
  let filed: Signed['where'] = where?.where ?? 'box'
  if (!where) {
    // Party and boxes are full: the contract still holds, the card goes on top of the last box.
    if (!ctx.save.boxes.length) ctx.save.boxes.push([])
    ctx.save.boxes[ctx.save.boxes.length - 1].push(card)
    ctx.save.stats.caught += 1
    filed = 'box'
  }
  prog.captures[tierId] = (prog.captures[tierId] ?? 0) + 1
  if (BATTLE_UI.contract.consumeBall) consumeItem(ctx, ballId)
  return { card, where: filed, newEntry }
}
