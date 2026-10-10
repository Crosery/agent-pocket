// Starting fights. They return at once (the battle runs on); wait.battle('active' | 'idle') follows them.
import type { ScriptStep } from '../../../shared/types.ts'
import { CONTENT } from '../../../shared/content/index.ts'
import { createBossCreature } from '../../../shared/battle/boss-battle.ts'
import { defaultMoves, expForLevel, maxHp } from '../../../shared/creature.ts'
import { rollBossCard } from '../../../shared/gameplay/bosscard.ts'
import { GAMEPLAY } from '../../../shared/gameplay/data.ts'
import { instanceOfBoss, progressOf, shouldOfferAssist } from '../../../shared/gameplay/instances.ts'
import { walkSteps } from '../../../shared/world/story.ts'
import { contractFlow } from '../../battle/capture.ts'
import { addCreature } from '../../world/save-ops.ts'
import { getCoopChannel, openDungeonModal } from '../../net/coop-channel.ts'
import { GAME } from '../../world/config.ts'
import type { DevHost } from '../kit.ts'
import { DevError, type CommandRun } from '../registry.ts'
const guard = (host: DevHost): void => { if (host.overworld.battleActive) throw new DevError('dev.err.battleBusy') }
const fire = (p: Promise<unknown>, what: string): void => { p.catch((err) => console.error(`[dev] ${what} failed`, err)) }

export const battleCommands: Record<string, CommandRun> = {
  'battle.wild': (host, a) => {
    const id = String(a.species)
    if (!CONTENT.species[id]) throw new DevError('dev.err.unknownSpecies', { species: id })
    guard(host)
    const level = Math.max(1, Math.floor((a.level as number | undefined) ?? 20))
    fire(host.overworld.startWildBattle(id, level), 'wild battle')
    return { species: id, level }
  },
  'battle.trainer': (host, a) => {
    const id = String(a.trainer)
    if (!host.world.trainers[id]) throw new DevError('dev.err.unknownTrainer', { trainer: id })
    guard(host)
    fire(host.overworld.startTrainerBattle(id), 'trainer battle')
    return { trainer: id }
  },
  /** A boss fight with the current party at the boss's level (or `level`). */
  'battle.boss': (host, a) => {
    const id = String(a.boss)
    const def = CONTENT.bosses[id]
    if (!def) throw new DevError('dev.err.unknownBoss', { boss: id })
    guard(host)
    const tier = a.tier === undefined ? undefined : String(a.tier)
    if (tier !== undefined) {
      if (!def.tiers?.[tier]) throw new DevError('dev.err.unknownBossTier', { boss: id, tier })
      fire(host.overworld.startBossBattle(id, tier, { assist: a.assist === true, coach: a.coach === true }), 'boss tier battle')
      return { boss: id, tier, level: def.tiers[tier].level, assist: a.assist === true, ...(a.coach === true ? { coach: true } : {}) }
    }
    const level = Math.max(1, Math.floor((a.level as number | undefined) ?? def.level))
    fire(host.overworld.startWildBattle(def.species, level), 'boss battle')
    return { boss: id, species: def.species, level }
  },
  /** Forces a boss instance result without playing the fight; on 'lose', updates instance losses/flags and runs the post-loss script. */
  'battle.forceResult': (host, a) => {
    const result = String(a.result ?? 'lose')
    if (result !== 'win' && result !== 'lose') throw new DevError('dev.err.badArg', { arg: 'result', why: 'win | lose' })
    const bossId = String(a.boss ?? 'deepseek')
    const tierId = String(a.tier ?? 'story')
    const inst = instanceOfBoss(bossId)
    if (!inst || !inst.def.tiers[tierId]) throw new DevError('dev.err.unknownBossTier', { boss: bossId, tier: tierId })
    const { ctx } = host
    const prog = progressOf(ctx.save, inst.id)
    const ID = GAMEPLAY.instanceDefaults
    if (result === 'win') {
      prog.clears[tierId] = (prog.clears[tierId] ?? 0) + 1
      prog.losses[tierId] = 0
      ctx.save.flags[ID.assistOfferFlag] = false
      ctx.save.flags[GAME.flags.bossWonPrefix + bossId] = true
      return { boss: bossId, tier: tierId, result: 'win', clears: prog.clears[tierId] }
    }
    prog.losses[tierId] = (prog.losses[tierId] ?? 0) + 1
    const hint = String(a.hint ?? 'peakDamage')
    if (ID.lossHintFlag) ctx.save.flags[ID.lossHintFlag] = hint
    ctx.save.flags[ID.assistOfferFlag] = shouldOfferAssist(ID, prog.losses[tierId], {
      turns: 3, foeHpLeft: 0.9, enraged: false, baitTagsUsed: [], healItemsUsed: 0,
      damageByMeterState: { tide: { 0: 10 } }, faintedByMeterState: { tide: { 0: 3 } },
    })
    ctx.save.flags['ds:met'] = true
    ctx.save.flags['ds:lost'] = true
    for (const cr of ctx.save.party) cr.hp = maxHp(cr, CONTENT)
    const v4 = host.world.maps['origin-lab-b2']?.npcs.find((n) => n.id === 'ds-v4')
    const lossBranches: ScriptStep[][] = []
    if (v4) walkSteps(v4.script, (s) => { if (s.op === 'ifFlag' && s.flag === 'ds:lost') lossBranches.push(s.then) })
    const lossBranch = lossBranches[0]
    const r1 = host.world.maps['origin-lab-b1']?.npcs.find((n) => n.id === 'ds-r1') ?? null
    if (lossBranch && typeof host.overworld.runScript === 'function') {
      fire(host.overworld.runScript(lossBranch.slice(4, -1), r1), 'loss script')
    }
    return { boss: bossId, tier: tierId, result: 'lose', losses: prog.losses[tierId], assistOffer: !!ctx.save.flags[ID.assistOfferFlag], hint }
  },
  /** The contract screen right away, without the fight (the first clear's card is rolled, filed and appraised). */
  'capture.force': (host, a) => {
    const id = String(a.boss ?? 'deepseek')
    const tier = String(a.tier ?? 'story')
    const def = CONTENT.bosses[id]
    if (!def) throw new DevError('dev.err.unknownBoss', { boss: id })
    const rules = instanceOfBoss(id)?.def.tiers[tier]
    if (!def.tiers?.[tier] || !rules) throw new DevError('dev.err.unknownBossTier', { boss: id, tier })
    if (a.result !== undefined && a.result !== 'success') throw new DevError('dev.err.badArg', { arg: 'result', why: 'success' })
    guard(host)
    const foe = createBossCreature(id, def.tiers![tier].level, host.rng.stream('debug'), CONTENT)
    fire(contractFlow(host.ctx, { bossId: id, tierId: tier, foe, chance: rules.capture.first, skipBefore: true }), 'contract')
    return { boss: id, tier, result: 'success' }
  },
  /** Forgets a boss instance's progress (clears, captures, run counter) so its first clear can be played again. */
  'instance.reset': (host, a) => {
    const id = String(a.id)
    const inst = CONTENT.bosses[id] ? instanceOfBoss(id) : null
    const found = inst ?? (GAMEPLAY.instances[id] ? { id, def: GAMEPLAY.instances[id] } : null)
    if (!found) throw new DevError('dev.err.unknownInstance', { id })
    delete host.ctx.save.instances?.[found.id]
    delete host.ctx.save.flags[GAME.flags.bossWonPrefix + found.def.boss]
     return { id: found.id }
   },
  'dungeon.open': (host, a) => {
    const id = String(a.id ?? 'deepseek-tide')
    openDungeonModal(host.ctx, id)
    return { opened: id }
  },
  'party.create': (host) => {
    const channel = getCoopChannel()
    if (channel) channel.createParty()
    return { result: 'ok' }
  },
  /** A signed boss card at `level` with `bank` levels of exp banked (party or the first box when full). */
  'bosscard.give': (host, a) => {
    const id = String(a.boss ?? 'deepseek')
    const def = CONTENT.bosses[id]
    const inst = instanceOfBoss(id)
    if (!def || !inst) throw new DevError('dev.err.unknownBoss', { boss: id })
    const { ctx } = host
    const tier = Object.keys(inst.def.tiers)[0]
    const level = Math.max(1, Math.floor((a.level as number | undefined) ?? 1))
    const bank = Math.max(0, Math.floor((a.bank as number | undefined) ?? 0))
    const card = rollBossCard(host.rng.stream('debug'), id, tier, inst.def.tiers[tier], { first: true, otName: ctx.save.name, otId: ctx.save.playerId }, CONTENT)
    card.level = level
    const slot = (m: string) => ({ id: m, pp: CONTENT.moves[m].pp, ppMax: CONTENT.moves[m].pp })
    card.moves = defaultMoves(def.species, level, CONTENT).map(slot)
    if (def.signature?.move && !card.moves.some((m) => m.id === def.signature!.move)) card.moves[card.moves.length - 1] = slot(def.signature.move)
    card.exp = expForLevel(CONTENT.species[def.species].growth, Math.min(CONTENT.config.party.maxLevel, level + bank), CONTENT)
    card.hp = maxHp(card, CONTENT)
    if (a.lead === true) {
      ctx.save.party.unshift(card)
      ctx.events.emit('party:changed', {})
      return { placed: 'lead', uid: card.uid, level, bank }
    }
    return { placed: addCreature(ctx, card)?.where ?? 'full', uid: card.uid, level, bank }
  },
}
