// Dex research: research level / points with the level-reward claim, every species met so far and the selected
// species' research tasks (rules: src/shared/gameplay/research.ts, data: content/research.json; claiming:
// src/client/world/research.ts). Tunables: content/events/client.json research.*.
import { CONTENT, t } from '../../../shared/content/index.ts'
import { GAMEPLAY } from '../../../shared/gameplay/data.ts'
import { levelRewards, speciesResearch } from '../../../shared/gameplay/research.ts'
import { GPC } from '../../world/gameplay-config.ts'
import { claimResearchRewards, researchState, researchSummary, rewardLabel } from '../../world/research.ts'
import { createRowMenu, type RowMenu } from '../menu.ts'
import { attentionDot, el, rarityBadge } from '../widgets.ts'
import { backPressed, frame, icon, isCompact, openScreen, sectionTitle, setChildren, sfx, uiSfx, type ScreenEnv } from './base.ts'
import './gameplay.css'

type Row = { kind: 'claim' } | { kind: 'species'; id: string }

const pct = (v: number) => `${Math.round(Math.max(0, Math.min(1, v)) * 1000) / 10}%`
const fmt = (n: number) => String(Math.round(n * 10) / 10)

function bar(fill: number, className = ''): HTMLElement {
  return el('div', { class: `aps-rs-bar ${className}`.trim() }, [el('span', { class: 'aps-rs-bar-fill', vars: { '--p': pct(fill) } })])
}

const taskName = (id: string, fallback: string) => (`research.task.${id}` in CONTENT.text ? t(`research.task.${id}`) : fallback)

export function researchScreen(env: ScreenEnv): Promise<void> {
  const { ctx } = env
  return openScreen<void>(env, 'aps-research', (api) => {
    let menu: RowMenu | null = null
    let rows: Row[] = []
    let dirty = false
    const f = frame(env, { title: t('research.ui.title'), glyph: 'research', onClose: api.guard(() => close()) })
    const head = el('div', 'aps-rs-head ap-panel')
    const listBox = el('div', 'aps-rs-list ap-panel')
    const detail = el('div', 'aps-rs-detail ap-panel')
    f.body.append(el('div', 'aps-rs-layout', [el('div', 'aps-rs-left', [head, listBox]), detail]))
    api.root.append(f.el)

    const close = () => {
      if (dirty) ctx.persist('research')
      api.close()
    }

    const speciesIds = (): string[] => {
      const known = new Set([...ctx.save.dexSeen, ...Object.keys(researchState(ctx.save))])
      return CONTENT.speciesList.filter((sp) => known.has(sp.id)).map((sp) => sp.id)
    }

    const paintHead = () => {
      const s = researchSummary(ctx.save)
      const span = s.nextAt === null ? 1 : Math.max(1, s.nextAt - s.prevAt)
      const fill = s.nextAt === null ? 1 : (s.points - s.prevAt) / span
      const next = levelRewards(s.level, Math.min(s.maxLevel, s.level + 1))
      const nextText = rewardLabel(next, ctx) || t('research.ui.noReward')
      setChildren(head, [
        el('div', 'aps-rs-lvrow', [
          el('span', { class: 'aps-rs-level ap-gold', text: t('research.ui.level', { level: s.level }) }),
          el('span', { class: 'aps-rs-points', text: t('research.ui.points', { points: fmt(s.points) }) }),
        ]),
        bar(fill, 'is-level'),
        el('div', { class: 'aps-rs-next ap-dim', text: s.nextAt === null ? t('research.ui.max') : t('research.ui.next', { points: fmt(s.nextAt - s.points) }) }),
        s.canClaim
          ? el('div', 'aps-rs-claim is-ready', [attentionDot(), t('research.ui.claimable', { reward: rewardLabel(s.claimable, ctx) || t('research.ui.noReward') })])
          : el('div', { class: 'aps-rs-claim ap-dim', text: s.nextAt === null ? t('research.ui.claimedAll') : t('research.ui.nextReward', { level: s.level + 1, reward: nextText }) }),
      ])
    }

    const rebuild = (keep: number) => {
      const s = researchSummary(ctx.save)
      const state = researchState(ctx.save)
      rows = [{ kind: 'claim' } as Row, ...speciesIds().map((id) => ({ kind: 'species', id }) as Row)]
      const visible = isCompact() ? GPC.research.compactVisibleRows : GPC.research.visibleRows
      menu = createRowMenu(rows.map((r) => {
        if (r.kind === 'claim') return s.canClaim ? { label: t('research.ui.claim'), sub: '' } : { label: t('research.ui.levelRewards'), sub: t('research.ui.level', { level: s.level }) }
        const sr = speciesResearch(state, r.id)
        const sp = ctx.data.species[r.id]
        return {
          label: sp?.nameZh ?? r.id,
          sub: sr.complete ? t('research.ui.complete') : t('research.ui.speciesPoints', { points: fmt(sr.points), total: Number.isFinite(sr.completeAt) ? fmt(sr.completeAt) : '-' }),
          icon: ctx.assets.creatureImageUrl(r.id),
        }
      }), {
        visibleRows: visible,
        initial: Math.min(keep, Math.max(0, rows.length - 1)),
        wrap: true,
        audio: ctx.audio,
        onChange: (i) => paint(i),
        onPick: api.guard((i: number) => pick(i)),
      })
      menu.el.querySelectorAll<HTMLElement>('.ap-row').forEach((row, i) => {
        const r = rows[i]
        if (r?.kind === 'claim') {
          row.classList.add('aps-rs-claimrow', ...(s.canClaim ? ['is-ready'] : []))
          if (s.canClaim) row.prepend(attentionDot())
        }
        else if (r && speciesResearch(state, r.id).complete) row.prepend(icon('check', { className: 'aps-rs-done' }))
      })
      listBox.replaceChildren(...(rows.length > 1 ? [menu.el] : [menu.el, el('div', { class: 'aps-empty', text: t('research.ui.listEmpty') })]))
      paintHead()
      paint(menu.index)
    }

    const paint = (i: number) => {
      const r = rows[i]
      const canClaim = researchSummary(ctx.save).canClaim
      f.setHints([['ud', t('screens.hint.choose')], ...(r?.kind === 'claim' && canClaim ? [['confirm', t('research.ui.claim')] as ['confirm', string]] : []), ['cancel', t('screens.hint.back')]])
      if (!r) { detail.replaceChildren(el('div', { class: 'aps-empty', text: t('research.ui.kindHint') })); return }
      if (r.kind === 'claim') {
        const s = researchSummary(ctx.save)
        setChildren(detail, [
          s.canClaim ? el('div', { class: 'aps-rs-title ap-gold', text: t('research.ui.claim') }) : null,
          s.canClaim ? el('p', { class: 'aps-rs-text', text: t('research.ui.claimable', { reward: rewardLabel(s.claimable, ctx) || t('research.ui.noReward') }) }) : null,
          sectionTitle(t('research.ui.levelRewards')),
          el('ul', 'aps-rs-levels', GAMEPLAY.research.levels.map((lv, k) => {
            const level = k + 1
            const state = level <= s.claimed ? 'claimed' : level <= s.level ? 'ready' : 'locked'
            return el('li', `aps-rs-lvitem is-${state}`, [
              el('span', { class: 'aps-rs-lvname', text: t('research.ui.levelRow', { level, points: fmt(lv.points) }) }),
              el('span', { class: 'aps-rs-lvreward', text: rewardLabel(levelRewards(k, level), ctx) || t('research.ui.noReward') }),
              el('span', { class: `aps-tag${state === 'ready' ? ' is-ok' : ''}`, text: t(`research.ui.levelState.${state}`) }),
            ])
          })),
          el('p', { class: 'aps-rs-text ap-dim', text: t('research.ui.kindHint') }),
        ])
        return
      }
      const sp = ctx.data.species[r.id]
      const sr = speciesResearch(researchState(ctx.save), r.id)
      const rarity = sp?.rarity ?? ''
      const total = Number.isFinite(sr.completeAt) ? sr.completeAt : Math.max(1, sr.points)
      setChildren(detail, [
        el('div', 'aps-rs-sphead', [
          el('img', { class: 'aps-rs-portrait', attrs: { src: ctx.assets.creatureImageUrl(r.id), alt: '' } }),
          el('div', 'aps-rs-spname', [
            el('span', { class: 'aps-rs-title ap-gold ap-model-name', text: sp?.nameZh ?? r.id, title: sp?.nameZh ?? r.id }),
            el('div', 'aps-rs-tags', [
              rarity ? rarityBadge(rarity, { label: 'name' }) : null,
              el('span', { class: `aps-tag${sr.complete ? ' is-ok' : ''}`, text: t(sr.complete ? 'research.ui.complete' : 'research.ui.incomplete') }),
            ]),
          ]),
        ]),
        el('div', { class: 'aps-rs-sppoints', text: t('research.ui.speciesPoints', { points: fmt(sr.points), total: fmt(total) }) }),
        bar(sr.points / total, sr.complete ? 'is-complete' : ''),
        rarity && `research.rarity.${rarity}` in CONTENT.text ? el('p', { class: 'aps-rs-text ap-dim', text: t(`research.rarity.${rarity}`) }) : null,
        sectionTitle(t('research.ui.tasks')),
        sr.tasks.length
          ? el('ul', 'aps-rs-tasks', sr.tasks.map((task) => {
            const name = taskName(task.def.id, task.def.nameZh)
            const capAt = task.def.thresholds.reduce((m, th) => Math.max(m, th), 0)
            const done = task.next === null
            return el('li', `aps-rs-task${done ? ' is-done' : ''}`, [
              el('div', 'aps-rs-taskrow', [
                done ? icon('check', { className: 'aps-rs-taskmark' }) : icon('diamond', { className: 'aps-rs-taskmark' }),
                el('span', { class: 'aps-rs-taskname', text: done ? t('research.ui.taskDone', { task: name }) : t('research.ui.progress', { task: name, progress: task.progress, next: task.next ?? capAt }) }),
                task.points > 0 ? el('span', { class: 'aps-rs-taskpts ap-gold', text: t('research.ui.taskPoints', { points: fmt(task.points) }) }) : null,
              ]),
              el('div', 'aps-rs-pips', task.def.thresholds.map((_, k) => el('span', `aps-rs-pip${k < task.reached ? ' is-on' : ''}`))),
              bar(capAt > 0 ? task.progress / capAt : 0, 'is-task'),
            ])
          }))
          : el('div', { class: 'aps-empty', text: t('research.ui.empty') }),
        el('p', { class: 'aps-rs-text ap-dim', text: t('research.ui.kindHint') }),
      ])
    }

    const pick = (i: number) => {
      const r = rows[i]
      if (r?.kind !== 'claim') return
      const got = claimResearchRewards(ctx)
      if (!got) { uiSfx(env, 'error'); return }
      sfx(env, 'save')
      ctx.ui.toast(t('research.ui.reward', { reward: rewardLabel(got, ctx) || t('research.ui.noReward') }), 'success')
      dirty = true
      rebuild(0)
    }

    rebuild(0)
    return {
      onInput(input) {
        if (backPressed(input)) { close(); return }
        if (menu?.handleInput(input) === 'confirm') pick(menu.index)
      },
    }
  })
}
