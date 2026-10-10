// Starting fights. They return at once (the battle runs on); wait.battle('active' | 'idle') follows them.
import { CONTENT } from '../../../shared/content/index.ts'
import { createBossCreature } from '../../../shared/battle/boss-battle.ts'
import { defaultMoves, expForLevel, maxHp } from '../../../shared/creature.ts'
import { rollBossCard } from '../../../shared/gameplay/bosscard.ts'
import { GAMEPLAY } from '../../../shared/gameplay/data.ts'
import { instanceOfBoss } from '../../../shared/gameplay/instances.ts'
import { addCreature } from '../../world/save-ops.ts'
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
      fire(host.overworld.startBossBattle(id, tier, { assist: a.assist === true }), 'boss tier battle')
      return { boss: id, tier, level: def.tiers[tier].level, assist: a.assist === true }
    }
    const level = Math.max(1, Math.floor((a.level as number | undefined) ?? def.level))
    fire(host.overworld.startWildBattle(def.species, level), 'boss battle')
    return { boss: id, species: def.species, level }
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
    fire(import('../../battle/capture.ts').then(({ contractFlow }) => {
      const foe = createBossCreature(id, def.tiers![tier].level, host.rng.stream('debug'), CONTENT)
      return contractFlow(host.ctx, { bossId: id, tierId: tier, foe, chance: rules.capture.first })
    }), 'contract')
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
