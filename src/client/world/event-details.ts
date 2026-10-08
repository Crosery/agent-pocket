import { CONTENT, t, type Content } from '../../shared/content/index.ts'
import type { ActiveEvent } from '../../shared/gameplay/events.ts'
import type { EventEffect, ScriptStep } from '../../shared/types.ts'

export interface EventBenefit {
  label: string
  value: string
  kind: 'gain' | 'cost' | 'info'
}

/** Display the actual rules, not the flavour text's sometimes exaggerated reward claims. */
export function eventBenefits(ev: ActiveEvent, minutes: number, content: Content = CONTENT): EventBenefit[] {
  if (minutes >= ev.endsAt) return []
  const out: EventBenefit[] = []
  const names = (ids: readonly string[] | undefined, kind: 'type' | 'rarity' | 'species') =>
    (ids ?? []).map(id => kind === 'type' ? content.typeById[id]?.nameZh ?? id
      : kind === 'rarity' ? content.rarityById[id]?.nameZh ?? id : content.species[id]?.nameZh ?? id).join('、')
  const qualifiers = (effect: Extract<EventEffect, { kind: 'modifier' }>) => [
    names(effect.types, 'type'),
    ...(effect.categories ?? []).map(id => t(`hud.events.category.${id}`)),
  ].filter(Boolean).join('、')
  const scriptRewards = (steps: readonly ScriptStep[], name?: string) => {
    const rewards = new Set<string>()
    const visit = (list: readonly ScriptStep[]) => {
      for (const step of list) {
        if (step.op === 'giveItem') rewards.add(t('hud.events.itemCount', { item: content.items[step.item]?.nameZh ?? step.item, n: step.qty }))
        else if (step.op === 'giveMoney') rewards.add(t('hud.events.moneyCount', { n: step.amount, currency: t('common.money') }))
        if ('then' in step) visit(step.then)
        if ('else' in step && step.else) visit(step.else)
        if ('branches' in step) step.branches.forEach(visit)
      }
    }
    visit(steps)
    for (const value of rewards) out.push({
      label: name ? t('hud.events.npcReward', { name }) : t('hud.events.scriptReward'),
      value, kind: 'gain',
    })
  }
  for (const effect of ev.def.effects) {
    if ('minutes' in effect && effect.minutes > 0 && minutes >= Math.min(ev.endsAt, ev.startedAt + effect.minutes)) continue
    switch (effect.kind) {
      case 'modifier': {
        if (effect.multiplier === 1) break
        const subject = t(`hud.events.effect.${effect.target}`)
        const qualifier = qualifiers(effect)
        const favourable = ['shopPrice', 'fleeChance'].includes(effect.target)
          ? effect.multiplier < 1 : effect.multiplier > 1
        out.push({
          label: qualifier ? t('hud.events.qualified', { qualifier, subject }) : subject,
          value: t('hud.events.multiplier', { n: Number(effect.multiplier.toFixed(3)) }),
          kind: effect.target === 'encounterRate' ? 'info' : favourable ? 'gain' : 'cost',
        })
        break
      }
      case 'encounterBoost': {
        if (effect.multiplier === 1) break
        const qualifier = [names(effect.types, 'type'), names(effect.rarities, 'rarity'), names(effect.species, 'species')].filter(Boolean).join('、')
        out.push({
          label: t('hud.events.encounterWeight', { qualifier: qualifier || t('hud.events.allCreatures') }),
          value: t('hud.events.multiplier', { n: Number(effect.multiplier.toFixed(3)) }),
          kind: effect.multiplier > 1 ? 'gain' : 'cost',
        })
        break
      }
      case 'scatter':
        out.push({
          label: t(effect.hidden ? 'hud.events.hiddenLoot' : 'hud.events.loot'),
          value: t('hud.events.itemCount', { item: content.items[effect.item]?.nameZh ?? effect.item, n: effect.count }),
          kind: 'gain',
        })
        break
      case 'spawn': {
        const qualifier = effect.species ? names([effect.species], 'species') : [
          names(effect.pick?.types, 'type'), names(effect.pick?.rarities, 'rarity'),
        ].filter(Boolean).join('、') || t('hud.events.allCreatures')
        out.push({ label: t('hud.events.spawns'), value: t('hud.events.spawnCount', { qualifier, n: effect.count }), kind: 'gain' })
        break
      }
      case 'trainer':
        out.push({
          label: t('hud.events.trainerReward', { name: t(effect.nameZh) }),
          value: t('hud.events.baseMoney', { n: effect.reward, currency: t('common.money') }),
          kind: 'gain',
        })
        break
      case 'npc':
        out.push({ label: t('hud.events.npc'), value: t('hud.events.talkTo', { name: t(effect.npc.nameZh) }), kind: 'info' })
        scriptRewards(effect.npc.script, t(effect.npc.nameZh))
        break
      case 'script':
        scriptRewards(effect.steps)
        break
      case 'reveal':
        out.push({ label: t('hud.events.reveal'), value: t('hud.events.newPlace'), kind: 'info' })
        break
    }
  }
  return out
}
