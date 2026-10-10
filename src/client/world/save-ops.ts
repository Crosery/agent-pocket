// Save mutations shared by scripts, pickups, battles and debug: bag, money, creatures, dex, quests, flags.
// Every mutation emits the matching GameEvents so HUD / screens / autosave react.
import type { Creature, ItemDef, KeyItemKind, QuestDef, SaveData } from '../../shared/types.ts'
import type { GameContext } from '../contracts.ts'
import { CONTENT, t, type Content } from '../../shared/content/index.ts'
import { creatureName, healFull } from '../../shared/creature.ts'
import { bossCardCap, isBossCard, settleBank } from '../../shared/gameplay/bosscard.ts'
import { BATTLE_UI } from '../battle/config.ts'

export function truthy(v: boolean | number | string | undefined): boolean {
  return v !== undefined && v !== false && v !== 0 && v !== ''
}

export function flagSet(save: SaveData, flag: string): boolean {
  return truthy(save.flags[flag])
}

export function addItem(ctx: GameContext, itemId: string, qty: number): boolean {
  if (!ctx.data.items[itemId] || !(qty > 0)) return false
  ctx.save.bag[itemId] = (ctx.save.bag[itemId] ?? 0) + Math.floor(qty)
  ctx.events.emit('bag:changed', {})
  return true
}

/** Removes up to qty; returns the amount actually removed. */
export function removeItem(ctx: GameContext, itemId: string, qty: number): number {
  const have = ctx.save.bag[itemId] ?? 0
  const n = Math.max(0, Math.min(have, Math.floor(qty)))
  if (!n) return 0
  if (have - n > 0) ctx.save.bag[itemId] = have - n
  else delete ctx.save.bag[itemId]
  ctx.events.emit('bag:changed', {})
  return n
}

export function changeMoney(ctx: GameContext, delta: number): number {
  const before = ctx.save.money
  ctx.save.money = Math.max(0, Math.floor(before + delta))
  const d = ctx.save.money - before
  if (d !== 0) ctx.events.emit('money:changed', { money: ctx.save.money, delta: d })
  return d
}

export function markSeen(ctx: GameContext, speciesId: string): void {
  if (ctx.save.dexSeen.includes(speciesId)) return
  ctx.save.dexSeen.push(speciesId)
  ctx.events.emit('dex:seen', { speciesId })
}

export function markCaught(ctx: GameContext, speciesId: string): void {
  markSeen(ctx, speciesId)
  if (ctx.save.dexCaught.includes(speciesId)) return
  ctx.save.dexCaught.push(speciesId)
  ctx.events.emit('dex:caught', { speciesId })
}

export type Placement = { where: 'party' } | { where: 'box'; box: number } | null

/** Adds a creature to the party, or the first box with room. null when everything is full. */
export function addCreature(ctx: GameContext, cr: Creature): Placement {
  const P = ctx.data.config.party
  if (ctx.save.party.length < P.maxParty) {
    ctx.save.party.push(cr)
    markCaught(ctx, cr.speciesId)
    if (cr.shiny) ctx.save.stats.shiniesFound += 1
    ctx.events.emit('party:changed', {})
    return { where: 'party' }
  }
  while (ctx.save.boxes.length < P.boxCount) ctx.save.boxes.push([])
  const box = ctx.save.boxes.findIndex((b) => b.length < P.boxSize)
  if (box < 0) return null
  ctx.save.boxes[box].push(cr)
  markCaught(ctx, cr.speciesId)
  if (cr.shiny) ctx.save.stats.shiniesFound += 1
  return { where: 'box', box }
}

/**
 * Pays every boss card's exp bank under the cap the current badge count allows ("算力许可升级"): a toast per card that
 * levelled and, for party members, a pick for each move it could not fit. Returns the cards that levelled.
 */
export async function settleBossCards(ctx: GameContext): Promise<Creature[]> {
  const cap = bossCardCap(ctx.save.badges.length, ctx.data)
  const levelled: Creature[] = []
  const inParty = new Set(ctx.save.party)
  for (const cr of [...ctx.save.party, ...ctx.save.boxes.flat()]) {
    if (!isBossCard(cr)) continue
    const r = settleBank(cr, cap, ctx.data)
    if (r.to === r.from) continue
    levelled.push(cr)
    ctx.audio.playSfx(BATTLE_UI.sfx.levelUp)
    ctx.ui.toast(t('hud.license.up', { name: creatureName(cr), from: r.from, to: r.to }), 'success')
    if (!inParty.has(cr)) continue
    for (const moveId of r.learnable) {
      const move = ctx.data.moves[moveId]
      if (!move || cr.moves.some((m) => m.id === moveId)) continue
      const slot = await ctx.screens.learnMove(cr, moveId)
      if (slot < 0 || slot > cr.moves.length) continue
      const entry = { id: moveId, pp: move.pp, ppMax: move.pp }
      if (slot === cr.moves.length) cr.moves.push(entry)
      else cr.moves[slot] = entry
      ctx.ui.toast(t('hud.license.learned', { name: creatureName(cr) }), 'success')
    }
  }
  if (levelled.length) {
    ctx.events.emit('party:changed', {})
    ctx.persist('license')
  }
  return levelled
}

export function healParty(ctx: GameContext): void {
  for (const c of ctx.save.party) healFull(c, ctx.data)
  ctx.events.emit('party:changed', {})
}

/** First item definition implementing a key-item capability (looked up by effect, never by id). */
export function keyItemOf(kind: KeyItemKind | string, c: Content = CONTENT): ItemDef | null {
  return c.itemList.find((it) => it.effect.kind === 'key' && it.effect.key === kind) ?? null
}

/** The owned item implementing a key-item capability, or null. */
export function ownedKeyItem(save: SaveData, kind: KeyItemKind | string, c: Content = CONTENT): ItemDef | null {
  return c.itemList.find((it) => it.effect.kind === 'key' && it.effect.key === kind && (save.bag[it.id] ?? 0) > 0) ?? null
}

export interface QuestChange { def: QuestDef; started: boolean; advanced: boolean; finished: boolean }

/** Applies a quest step: never moves a quest backwards; finishing grants QuestDef.reward once. */
export function applyQuest(ctx: GameContext, questId: string, stage: number, done: boolean): QuestChange | null {
  const def = ctx.data.world.quests.find((q) => q.id === questId)
  if (!def) return null
  const maxStage = Math.max(0, def.stages.length - 1)
  const prev = ctx.save.quests[questId]
  const nextStage = Math.min(maxStage, Math.max(prev?.stage ?? 0, Math.floor(stage)))
  const wasDone = prev?.done ?? false
  const nowDone = wasDone || done
  const started = !prev
  const advanced = !!prev && nextStage > prev.stage
  const finished = nowDone && !wasDone
  if (!started && !advanced && !finished) return { def, started, advanced, finished }
  ctx.save.quests[questId] = { stage: nextStage, done: nowDone }
  if (!ctx.save.trackedQuest || (ctx.save.trackedQuest === questId && nowDone)) {
    ctx.save.trackedQuest = nowDone ? openQuestId(ctx) ?? undefined : questId
  }
  if (finished && def.reward) {
    if (def.reward.money) changeMoney(ctx, def.reward.money)
    for (const [id, qty] of Object.entries(def.reward.items ?? {})) addItem(ctx, id, qty)
  }
  ctx.events.emit('quest:updated', { questId, stage: nextStage, done: nowDone })
  return { def, started, advanced, finished }
}

function openQuestId(ctx: GameContext): string | null {
  const open = ctx.data.world.quests.filter((q) => ctx.save.quests[q.id] && !ctx.save.quests[q.id].done)
  return (open.find((q) => q.kind === 'main') ?? open[0])?.id ?? null
}

/** Display text for a quest reward ("A×2、500 Token 币"). */
export function rewardText(def: QuestDef): string {
  const parts: string[] = []
  for (const [id, qty] of Object.entries(def.reward?.items ?? {})) {
    const item = CONTENT.items[id]
    if (item) parts.push(t('world.script.rewardItem', { item: item.nameZh, qty }))
  }
  if (def.reward?.money) parts.push(t('world.script.rewardMoney', { money: def.reward.money, currency: t('common.money') }))
  return parts.join(t('world.script.rewardJoin'))
}
