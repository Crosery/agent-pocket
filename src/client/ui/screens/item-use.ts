// Using bag items outside battle: medicine (with move pick for single-move PP items), level-up, evolution items,
// skill chips, repel, escape, key items. Each flow returns true when the item was consumed.
import type { Creature, ItemDef } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { creatureName, evolutionTarget, evolve, expForLevel, gainExp, maxHp } from '../../../shared/creature.ts'
import { getMap } from '../../../shared/world/worldapi.ts'
import { actionKeyLabel } from '../widgets.ts'
import { leaveAllScreens, sfx, type ScreenEnv } from './base.ts'
import { natureScreen } from './nature.ts'
import { natureName } from '../quality-text.ts'
import { SCREENS } from './config.ts'
import { addItem, applyMedicine, medicineBlocker, needsMovePick, needsTarget, overworldExit, teachState } from './logic.ts'

const say = (env: ScreenEnv, ...lines: string[]) => env.ctx.ui.say(lines)

/** Teaches `moveId` (asking which move to forget when full). Returns true if learnt. */
export async function teachMove(env: ScreenEnv, c: Creature, moveId: string): Promise<boolean> {
  const m = CONTENT.moves[moveId]
  if (!m || c.moves.some((s) => s.id === moveId)) return false
  const name = creatureName(c)
  const slot = { id: moveId, pp: m.pp, ppMax: m.pp }
  if (c.moves.length < CONTENT.config.party.maxMoves) {
    c.moves.push(slot)
    sfx(env, 'learn')
    await say(env, t('screens.use.learned', { name, move: m.nameZh }))
    return true
  }
  const i = await env.screens.learnMove(c, moveId)
  if (i < 0 || i >= c.moves.length) {
    await say(env, t('screens.use.notLearned', { name, move: m.nameZh }))
    return false
  }
  const old = CONTENT.moves[c.moves[i].id]?.nameZh ?? c.moves[i].id
  c.moves[i] = slot
  sfx(env, 'learn')
  await say(env, t('screens.use.forgot', { name, old }), t('screens.use.learned', { name, move: m.nameZh }))
  return true
}

/** Plays the evolution through ctx.battle; makes sure the creature and the dex reflect the result. */
export async function runEvolution(env: ScreenEnv, partyIndex: number, to: string): Promise<boolean> {
  const { ctx } = env
  const c = ctx.save.party[partyIndex]
  if (!c || !CONTENT.species[to]) return false
  const ok = await ctx.battle.evolve(partyIndex, to)
  if (!ok) return false
  if (c.speciesId !== to) evolve(c, to)
  for (const list of [ctx.save.dexSeen, ctx.save.dexCaught]) {
    if (!list.includes(to)) {
      list.push(to)
      ctx.events.emit(list === ctx.save.dexCaught ? 'dex:caught' : 'dex:seen', { speciesId: to })
    }
  }
  ctx.events.emit('party:changed', {})
  return true
}

async function applyToCreature(env: ScreenEnv, item: ItemDef, partyIndex: number): Promise<boolean> {
  const { ctx } = env
  const c = ctx.save.party[partyIndex]
  if (!c) return false
  const blocker = medicineBlocker(c, item)
  if (blocker) { sfx(env, 'error'); await say(env, t(blocker, { name: creatureName(c) })); return false }
  const name = creatureName(c)
  const e = item.effect
  switch (e.kind) {
    case 'heal': case 'cure': case 'healCure': case 'revive': case 'pp': {
      let moveIndex = -1
      if (needsMovePick(item)) {
        moveIndex = await ctx.ui.list(t('screens.use.pickMove'), c.moves.map((s) => ({
          label: CONTENT.moves[s.id]?.nameZh ?? s.id,
          sub: t('screens.move.ppValue', { pp: s.pp, max: s.ppMax }),
          disabled: s.pp >= s.ppMax,
        })))
        if (moveIndex < 0) return false
      }
      const r = applyMedicine(c, item, moveIndex)
      sfx(env, 'heal')
      const lines: string[] = []
      if (r.revived) lines.push(t('screens.use.revived', { name }))
      else if (r.hp > 0) lines.push(t('screens.use.healed', { name, n: r.hp }))
      if (r.cured) lines.push(t('screens.use.cured', { name, status: CONTENT.statusById[r.cured]?.nameZh ?? r.cured }))
      if (r.pp > 0) lines.push(t('screens.use.ppRestored', { name, n: r.pp }))
      if (!lines.length) lines.push(t('screens.use.noEffect', { name }))
      await say(env, ...lines)
      ctx.events.emit('party:changed', {})
      return true
    }
    case 'levelUp': {
      const sp = CONTENT.species[c.speciesId]
      if (!sp) return false
      const res = gainExp(c, expForLevel(sp.growth, c.level + 1) - c.exp)
      if (!res.levels.length) return false
      if (c.hp > 0) c.hp = Math.min(maxHp(c), c.hp)
      sfx(env, 'levelUp')
      await say(env, t('screens.use.levelUp', { name, level: c.level }))
      for (const m of res.learned) await say(env, t('screens.use.learned', { name, move: CONTENT.moves[m]?.nameZh ?? m }))
      for (const m of res.learnable) await teachMove(env, c, m)
      const evo = evolutionTarget(c)
      if (evo) await runEvolution(env, partyIndex, evo)
      ctx.events.emit('party:changed', {})
      return true
    }
    case 'evolve': {
      const to = CONTENT.species[c.speciesId]?.evolvesTo?.id
      return to ? runEvolution(env, partyIndex, to) : false
    }
    case 'chip':
      return teachMove(env, c, e.move)
    case 'nature': {
      const pick = await natureScreen(env, c)
      if (!pick) return false
      if (pick === c.nature) { sfx(env, 'error'); await say(env, t('screens.quality.pickSame', { name, nature: natureName(pick) })); return false }
      if (!await ctx.ui.confirm(t('screens.quality.pickConfirm', { name, nature: natureName(pick) }))) return false
      c.nature = pick
      sfx(env, 'useItem')
      await say(env, t('screens.quality.pickDone', { name, nature: natureName(pick) }))
      ctx.events.emit('party:changed', {})
      return true
    }
    default:
      return false
  }
}

/** Party annotation while choosing a target for `item`. */
export function targetNote(item: ItemDef): (c: Creature) => { text: string; ok: boolean } {
  return (c) => {
    if (item.effect.kind === 'chip') {
      const s = teachState(c, item.effect.move)
      return { text: t(`screens.use.teach.${s}`), ok: s === 'ok' }
    }
    const b = medicineBlocker(c, item)
    return b ? { text: t(`${b}Short`), ok: false } : { text: t('screens.use.canUse'), ok: true }
  }
}

/** Field use from the bag. Returns true when one item was consumed. */
export async function useItemInField(env: ScreenEnv, item: ItemDef): Promise<boolean> {
  const { ctx } = env
  const e = item.effect
  if (!item.usableInField && e.kind !== 'key') {
    sfx(env, 'error')
    await say(env, t(e.kind === 'ball' || e.kind === 'battleBoost' ? 'screens.use.battleOnly' : 'screens.use.cannotUse'))
    return false
  }
  if (e.kind === 'key') {
    const a = SCREENS.bag.keyItems[e.key]
    if (a?.open === 'worldMap') await env.screens.worldMap({ fly: false })
    else if (a?.open === 'dex') await env.screens.dex()
    else if (a?.open === 'badges') await env.internal.badges()
    else if (a?.hint) await say(env, t(a.hint, { key: a.action ? actionKeyLabel(a.action, ctx.input.lastDevice) : '' }))
    return false
  }
  if (e.kind === 'repel') {
    if (ctx.save.repelSteps > 0) { sfx(env, 'error'); await say(env, t('screens.use.repelActive')); return false }
    ctx.save.repelSteps = e.steps
    consume(env, item)
    sfx(env, 'useItem')
    await say(env, t('screens.use.repel', { item: item.nameZh, steps: e.steps }))
    return true
  }
  if (e.kind === 'escape') return useEscape(env, item)
  if (!needsTarget(item)) { sfx(env, 'error'); await say(env, t('screens.use.cannotUse')); return false }
  if (!ctx.save.party.length) { sfx(env, 'error'); await say(env, t('screens.use.noParty')); return false }
  const i = await env.internal.party('select', { title: t('screens.use.pickTarget', { item: item.nameZh }), annotate: targetNote(item) })
  if (i < 0) return false
  const used = await applyToCreature(env, item, i)
  if (used && (e.kind !== 'chip' || SCREENS.bag.consumeChip)) consume(env, item)
  return used
}

/** Battle mode: medicine needs a target creature that it would affect. Returns the party index or -1. */
export async function pickBattleTarget(env: ScreenEnv, item: ItemDef): Promise<number> {
  return env.internal.party('select', {
    title: t('screens.use.pickTarget', { item: item.nameZh }),
    filter: (c) => medicineBlocker(c, item) === null,
    annotate: targetNote(item),
  })
}

function consume(env: ScreenEnv, item: ItemDef): void {
  addItem(env.ctx.save, item.id, -1)
  env.ctx.events.emit('bag:changed', {})
}

async function useEscape(env: ScreenEnv, item: ItemDef): Promise<boolean> {
  const { ctx } = env
  const p = ctx.overworld.player
  const here = getMap(ctx.data.world, p.map)
  // Caves and dungeon floors (frontier dungeons chain floor to floor): the warp chain back to the overworld.
  const exit = here && here.kind === 'cave' ? overworldExit(ctx.data.world, here.id, p.x, p.y) : null
  if (!exit) { sfx(env, 'error'); await say(env, t('screens.use.cantHere')); return false }
  consume(env, item)
  sfx(env, 'useItem')
  await say(env, t('screens.use.escape', { item: item.nameZh }))
  leaveAllScreens(env, () => { void ctx.overworld.enterMap(exit.toMap, exit.toX, exit.toY, exit.facing, true) })
  return true
}
