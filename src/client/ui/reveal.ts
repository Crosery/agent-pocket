// Appraisal after a creature joins the player: a full card (grade letter, 5-step ladder, nature, ability, six IV
// star rows with the best one lit) or a one-line chip in the toast stack. The card closes on any tap / confirm /
// cancel or after content/quality.json reveal.maxMs; the chip never blocks. Everything numeric comes from content.
import type { Creature, GradeDef, StatKey } from '../../shared/types.ts'
import type { GameContext, Input, UIPanel } from '../contracts.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { creatureName, STAT_KEYS } from '../../shared/creature.ts'
import { bestStat, gradeOf, natureArrows } from '../../shared/gameplay/quality.ts'
import { SCREENS } from './screens/config.ts'
import { ivStars } from './screens/logic.ts'
import { meterIcons } from './screens/base.ts'
import { creatureImg } from './screens/sprites.ts'
import { UI_CONFIG } from './config.ts'
import { actionKeyLabel, bossMark, el, gradeChip, panel } from './widgets.ts'
import { appraisalText, gradeNick, natureName, natureStats } from './quality-text.ts'
import './reveal.css'

export interface RevealOptions {
  /** Full card (true) or the one-line chip (false). */
  full: boolean
}

export function showReveal(ctx: GameContext, cr: Creature, opts: RevealOptions): Promise<void> {
  const grade = gradeOf(cr.ivs)
  const sfx = CONTENT.quality.reveal.sfx[grade.id]
  if (sfx) ctx.audio.playSfx(sfx)
  return opts.full ? fullCard(ctx, cr, grade) : (chip(ctx, cr, grade), Promise.resolve())
}

/** "激进 推理↑ 稳健↓" with the arrows coloured; neutral natures show the name alone. */
function natureBadge(natureId: string | undefined): HTMLElement[] {
  const s = natureStats(natureId)
  return [
    el('span', { class: 'aps-rv-v', text: natureName(natureId) }),
    s ? el('span', 'aps-rv-natstats', [el('span', { class: 'is-up', text: `${s.up}↑` }), el('span', { class: 'is-down', text: `${s.down}↓` })]) : null,
  ].filter((n): n is HTMLElement => n !== null)
}

function chip(ctx: GameContext, cr: Creature, grade: GradeDef): void {
  const stack = ctx.ui.root.querySelector<HTMLElement>('.ap-toasts') ?? ctx.ui.root
  const node = el('div', { class: 'ap-toast ap-toast--success ap-toast--appraisal', attrs: { 'aria-label': appraisalText(cr) } }, [
    el('span', 'ap-toast-text', [el('span', 'aps-rv-chipline', [gradeChip(grade.id), el('span', 'aps-rv-chipnat', natureBadge(cr.nature))])]),
  ])
  stack.append(node)
  // The stack holds at most UI_CONFIG.toast.max live toasts, like the ones kit.toast adds.
  const live = [...stack.children].filter((c) => !c.classList.contains('is-leaving'))
  for (let i = 0; i < live.length - UI_CONFIG.toast.max; i++) live[i].dispatchEvent(new Event('ap-dismiss'))
  const leave = () => {
    if (node.classList.contains('is-leaving')) return
    node.classList.add('is-leaving')
    window.setTimeout(() => node.remove(), UI_CONFIG.anim.toastLeaveMs)
  }
  node.addEventListener('ap-dismiss', leave)
  window.setTimeout(leave, CONTENT.quality.reveal.chipMs)
}

function fullCard(ctx: GameContext, cr: Creature, grade: GradeDef): Promise<void> {
  const Q = CONTENT.quality
  const flags = ctx.save.flags
  const showHint = !flags[Q.flags.revealLadder]
  if (showHint) flags[Q.flags.revealLadder] = true

  const ivMax = CONTENT.config.creature.ivMax
  const best = bestStat(cr.ivs)
  const arrows = natureArrows(cr.nature)
  const ability = CONTENT.abilities[cr.abilityId]
  // A signed boss card: gold frame, the crown medal, and its signature ability set apart.
  const bossDef = cr.origin?.kind === 'boss' && cr.origin.boss ? CONTENT.bosses[cr.origin.boss] : undefined
  const signature = !!bossDef && bossDef.signature?.ability === cr.abilityId
  const touch = ctx.input.lastDevice === 'touch'

  const nowIndex = Q.grades.findIndex((x) => x.id === grade.id)
  const ladder = el('div', { class: 'aps-rv-ladder', attrs: { 'aria-hidden': 'true' } }, Q.grades.map((g, i) => {
    const step = gradeChip(g.id)
    step.classList.add('aps-rv-step')
    step.classList.toggle('is-now', i === nowIndex)
    step.classList.toggle('is-lit', i <= nowIndex)
    step.style.setProperty('--i', String(i))
    return step
  }))
  const letter = gradeChip(grade.id)
  letter.classList.add('aps-rv-letter')
  const stats = el('div', 'aps-rv-stats', STAT_KEYS.map((k: StatKey) => {
    const arrow = arrows[k]
    return el('div', { class: `aps-rv-stat${k === best ? ' is-best' : ''}` }, [
      el('span', { class: 'aps-rv-statname', text: CONTENT.statByKey[k]?.nameZh ?? k }),
      arrow ? el('span', { class: `aps-rv-arrow is-${arrow}`, text: arrow === 'up' ? '↑' : '↓' }) : null,
      meterIcons(ivStars(cr.ivs[k] ?? 0, ivMax, SCREENS.summary.ivStars), SCREENS.summary.ivStars, 'star', 'starOff'),
    ])
  }))
  const card = panel(t(bossDef ? 'screens.quality.reveal.bossTitle' : 'screens.quality.reveal.title'), { className: 'aps-rv-card' })
  card.body.append(
    el('div', 'aps-rv-top', [
      el('div', 'aps-rv-who', [
        creatureImg(ctx.assets, cr.speciesId, { shiny: cr.shiny, className: 'aps-rv-sprite' }),
        el('div', { class: 'aps-rv-name ap-model-name', text: creatureName(cr), title: creatureName(cr) }),
        el('div', 'aps-rv-lvline', [bossDef ? bossMark() : null, el('span', { class: 'aps-rv-lv', text: t('screens.common.level', { level: cr.level }) })]),
      ]),
      el('div', 'aps-rv-gradebox', [
        el('div', { class: 'aps-rv-letterbox', vars: { '--gc': grade.color } }, [letter]),
        el('div', { class: 'aps-rv-nick', text: gradeNick(grade.id) }),
        ladder,
        showHint ? el('div', { class: 'aps-rv-hint', text: t('screens.quality.reveal.ladderHint') }) : null,
      ]),
    ]),
    el('div', 'aps-rv-rows', [
      el('div', 'aps-rv-row', [el('span', { class: 'aps-rv-k', text: t('screens.quality.summary.nature') }), ...natureBadge(cr.nature)]),
      el('div', { class: `aps-rv-row${signature ? ' is-signature' : ''}` }, [
        el('span', { class: 'aps-rv-k', text: t('screens.summary.ability') }),
        el('span', { class: 'aps-rv-v', text: ability?.nameZh ?? t('screens.common.dash') }),
        signature ? el('span', { class: 'aps-rv-sig', text: t('screens.quality.reveal.signature') }) : null,
      ]),
    ]),
    stats,
    el('div', 'aps-rv-skip', [touch ? t('screens.quality.reveal.skipTouch') : t('screens.quality.reveal.skipKey', { key: actionKeyLabel('confirm', ctx.input.lastDevice) })]),
  )

  return new Promise<void>((resolve) => {
    const root = el('div', { class: 'aps-screen aps-reveal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('screens.quality.reveal.title') } }, [card.el])
    root.dataset.grade = grade.id
    root.classList.toggle('is-boss', !!bossDef)
    let closed = false
    let timer = 0
    const close = () => {
      if (closed) return
      closed = true
      window.clearTimeout(timer)
      ctx.ui.popPanel(panelApi)
      resolve()
    }
    const panelApi: UIPanel = {
      el: root,
      onInput(input: Input) {
        if (input.pressed('confirm') || input.pressed('cancel') || input.pressed('menu')) {
          input.consume('confirm'); input.consume('cancel'); input.consume('menu')
          close()
        }
        return true
      },
    }
    root.addEventListener('pointerdown', (e) => { e.preventDefault(); close() })
    ctx.ui.pushPanel(panelApi)
    timer = window.setTimeout(close, Q.reveal.maxMs)
  })
}
