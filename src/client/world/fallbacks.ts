// Minimal stand-ins used by game.ts while the optional battle / screens modules are missing (their files are
// written by other modules): an auto-resolving battle runner on the real engine + AI, and dialogue-based
// screens. They keep the game playable end-to-end; all text via t('game.fallback.*').
import type { BattleEvent, BattleInit, Creature } from '../../shared/types.ts'
import type { BattleOutcome, BattleRunner, GameContext, Screens } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import { Rng } from '../../shared/rng.ts'
import { creatureName, evolve } from '../../shared/creature.ts'
import { BattleEngine } from '../../shared/battle/engine.ts'
import { chooseAiAction } from '../../shared/battle/ai.ts'
import { addCreature, changeMoney, markSeen } from './save-ops.ts'
import { GAME } from './config.ts'

export function createFallbackBattleRunner(ctx: GameContext): BattleRunner {
  return {
    async run(init: BattleInit, opts): Promise<BattleOutcome> {
      ctx.events.emit('battle:start', { kind: opts.kind })
      const music = opts.music ?? ctx.data.audio.battleMusic[opts.kind]
      if (music) ctx.audio.playBgm(music)
      const engine = new BattleEngine(init, ctx.data)
      const rng = new Rng(init.seed)
      const events: BattleEvent[] = [...engine.start()]
      const foe = init.sides[1]
      for (const c of foe.party) markSeen(ctx, c.speciesId)
      await ctx.ui.say([{ text: opts.trainer ? t('game.fallback.battle.trainer', { trainer: foe.name }) : t('game.fallback.battle.start', { foe: foe.name }) }])
      for (let i = 0; i < GAME.battle.fallbackMaxSteps && !engine.finished; i++) {
        if (engine.request(0).kind !== 'wait') engine.choose(0, chooseAiAction(engine, 0, rng, ctx.data))
        if (engine.ready()) events.push(...engine.step())
      }
      ctx.renderer.setTransition('none', 0)
      let moneyDelta = 0
      for (const e of events) if (e.t === 'money') moneyDelta += changeMoney(ctx, e.amount)
      const result = engine.result ?? 'draw'
      let caught: Creature | undefined
      if (result === 'caught' && engine.caught) {
        caught = engine.caught
        addCreature(ctx, caught)
      }
      const name = ctx.save.name
      const key = result === 'win' ? 'win' : result === 'lose' || result === 'forfeit' ? 'lose' : result === 'run' ? 'run' : result === 'caught' ? 'caught' : 'draw'
      const lines = [{ text: t(`game.fallback.battle.${key}`, { name, species: caught ? creatureName(caught, ctx.data) : '' }) }]
      if (moneyDelta > 0) lines.push({ text: t('game.fallback.battle.money', { money: moneyDelta, currency: t('common.money') }) })
      await ctx.ui.say(lines)
      ctx.events.emit('battle:end', { kind: opts.kind, result })
      return { result, moneyDelta, ...(caught ? { caught } : {}) }
    },
    async evolve(partyIndex: number, toSpeciesId: string): Promise<boolean> {
      const c = ctx.save.party[partyIndex]
      if (!c || !ctx.data.species[toSpeciesId]) return false
      evolve(c, toSpeciesId, ctx.data)
      ctx.events.emit('party:changed', {})
      return true
    },
  }
}

export function createFallbackScreens(ctx: GameContext): Screens {
  const unavailable = () => ctx.ui.toast(t('game.fallback.unavailable'), 'warn')
  return {
    async title(hasSave) {
      type Choice = 'continue' | 'new' | 'import' | 'settings'
      const ids: Choice[] = hasSave ? ['continue', 'new', 'import', 'settings'] : ['new', 'import', 'settings']
      const i = await ctx.ui.choose(t('game.fallback.title.prompt'), ids.map((id) => t(`game.fallback.title.${id}`)))
      return ids[Math.max(0, i)] ?? 'new'
    },
    async newGame() {
      const name = await ctx.ui.prompt(t('game.fallback.namePrompt'), '', ctx.data.config.net.nameMaxLen)
      if (name === null) return null
      const chars = ctx.data.characters.filter((c) => c.playable)
      const i = await ctx.ui.list(t('game.fallback.avatarPrompt'), chars.map((c) => ({ label: c.nameZh, icon: ctx.assets.characterImageUrl(c.id) })))
      if (i < 0) return null
      return { name, avatar: chars[i].id }
    },
    async starter(options) {
      const i = await ctx.ui.list(t('game.fallback.starterPrompt'), options.map((s) => ({ label: s.nameZh, sub: s.nameEn, icon: ctx.assets.creatureImageUrl(s.id) })))
      return options[Math.max(0, i)].id
    },
    async pauseMenu() { unavailable() },
    async party() { unavailable(); return -1 },
    async summary() { unavailable() },
    async bag() { unavailable(); return null },
    async dex() { unavailable() },
    async shop() { unavailable() },
    async box() { unavailable() },
    async worldMap() { unavailable(); return null },
    async quests() { unavailable() },
    async settings() { unavailable() },
    async online() { unavailable() },
    async learnMove() { return -1 },
  }
}
