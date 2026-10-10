// Quest log: tabs from content/screens.json (main / side / done), started quests with stage history, the current
// hint, rewards and tracking (SaveData.trackedQuest, mirrored to the HUD).
import type { QuestDef } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { createRowMenu, type RowMenu } from '../menu.ts'
import { el, tabs } from '../widgets.ts'
import { backPressed, frame, icon, isCompact, moneyEl, openScreen, pressed, sectionTitle, uiSfx, type ScreenEnv, setChildren } from './base.ts'
import { SCREENS } from './config.ts'
import { questEntries, type QuestEntry } from './logic.ts'

/** Text shown on the HUD for a tracked quest (current stage). */
export function questHudText(def: QuestDef, stage: number): string {
  return t('screens.quests.hud', { quest: def.nameZh, stage: stageText(def, stage) })
}

const stageText = (def: QuestDef, stage: number): string => def.stages[Math.min(stage, def.stages.length - 1)]?.text ?? ''

export function questsScreen(env: ScreenEnv): Promise<void> {
  const { ctx } = env
  const world = ctx.data.world
  return openScreen<void>(env, 'aps-quests', (api) => {
    let tab = 0
    let entries: QuestEntry[] = []
    let menu: RowMenu | null = null
    let dirty = false
    const f = frame(env, { title: t('screens.quests.title'), glyph: 'quests', onClose: api.guard(() => close()) })
    const tabBar = tabs(SCREENS.quests.tabs.map((x) => t(x.label)), { audio: ctx.audio, onChange: (i) => { tab = i; rebuild(0) } })
    const listBox = el('div', 'aps-bag-list ap-panel')
    const detail = el('div', 'aps-quest-detail ap-panel')
    f.body.append(el('div', 'aps-bag-layout', [el('div', 'aps-bag-left', [tabBar.el, listBox]), detail]))
    api.root.append(f.el)

    const close = () => {
      if (dirty) ctx.persist('quests')
      api.close()
    }
    const rebuild = (keep: number) => {
      entries = questEntries(world, ctx.save, SCREENS.quests.tabs[tab])
      const rows = isCompact() ? SCREENS.quests.compactVisibleRows : SCREENS.quests.visibleRows
      menu = createRowMenu(entries.map((e) => ({
        label: e.def.nameZh,
        sub: e.done ? t('screens.quests.doneShort') : t('screens.quests.progress', { i: e.stage + 1, n: e.def.stages.length }),
      })), {
        visibleRows: rows,
        initial: Math.min(keep, Math.max(0, entries.length - 1)),
        wrap: true,
        audio: ctx.audio,
        onChange: (i) => paint(i),
        onPick: api.guard((i: number) => toggleTrack(i)),
      })
      menu.el.querySelectorAll<HTMLElement>('.ap-row').forEach((row, i) => {
        if (entries[i]?.def.id === ctx.save.trackedQuest) row.prepend(icon('quest', { className: 'aps-track-mark' }))
      })
      listBox.replaceChildren(menu.el)
      paint(menu.index)
    }
    const paint = (i: number) => {
      const e = entries[i]
      const canTrack = !!e && !e.done
      f.setHints([['lr', t('screens.hint.tabs')], ['ud', t('screens.hint.choose')], ...(canTrack ? [['confirm', t(ctx.save.trackedQuest === e.def.id ? 'screens.quests.hint.untrack' : 'screens.quests.hint.track')] as ['confirm', string]] : []), ['cancel', t('screens.hint.back')]])
      if (!e) {
        detail.replaceChildren(el('div', { class: 'aps-empty', text: t(world.quests.length ? 'screens.quests.emptyTab' : 'screens.quests.none') }))
        return
      }
      const tracked = ctx.save.trackedQuest === e.def.id
      const stages = e.def.stages.slice(0, e.done ? e.def.stages.length : e.stage + 1).map((s, k) => {
        const done = e.done || k < e.stage
        return el('li', `aps-stage${done ? ' is-done' : ' is-current'}`, [done ? icon('check', { className: 'aps-stage-mark' }) : icon('diamond', { className: 'aps-stage-mark' }), el('span', { text: s.text })])
      })
      const cur = e.def.stages[e.stage]
      const reward = e.def.reward
      const rewardItems = Object.entries(reward?.items ?? {}).filter(([id]) => CONTENT.items[id])
      setChildren(detail, [
        el('div', 'aps-quest-head', [
          el('span', { class: `aps-tag ${e.def.kind === 'main' ? 'is-main' : ''}`, text: t(`screens.quests.kind.${e.def.kind}`) }),
          el('span', { class: 'aps-quest-name ap-gold', text: e.def.nameZh }),
          tracked ? el('span', { class: 'aps-tag is-ok', text: t('screens.quests.tracking') }) : null,
        ]),
        sectionTitle(t('screens.quests.stages')),
        el('ol', 'aps-stages', stages),
        !e.done && cur?.hint ? el('div', 'aps-quest-hint', [el('span', { class: 'ap-gold', text: t('screens.quests.hintLabel') }), cur.hint]) : null,
        reward && (reward.money || rewardItems.length) ? sectionTitle(t('screens.quests.rewards')) : null,
        reward && (reward.money || rewardItems.length) ? el('div', 'aps-rewards', [
          reward.money ? moneyEl(reward.money) : null,
          ...rewardItems.map(([id, n]) => el('span', 'aps-reward', [el('img', { class: 'aps-inline-icon', attrs: { src: ctx.assets.itemIconUrl(id), alt: '' } }), t('screens.quests.rewardItem', { item: CONTENT.items[id].nameZh, n })])),
        ]) : null,
      ])
    }
    const toggleTrack = (i: number) => {
      const e = entries[i]
      if (!e || e.done) { uiSfx(env, 'error'); return }
      if (ctx.save.trackedQuest === e.def.id) {
        delete ctx.save.trackedQuest
        ctx.hud.setQuest(null)
        uiSfx(env, 'cancel')
      } else {
        ctx.save.trackedQuest = e.def.id
        ctx.hud.setQuest(questHudText(e.def, e.stage), e.def.nameZh, stageText(e.def, e.stage))
        uiSfx(env, 'confirm')
      }
      dirty = true
      ctx.events.emit('save:changed', { reason: 'quest-track' })
      rebuild(i)
    }

    rebuild(0)
    return {
      onInput(input) {
        if (backPressed(input)) { close(); return }
        if (pressed(input, 'left', true)) { tabBar.prev(); return }
        if (pressed(input, 'right', true)) { tabBar.next(); return }
        if (menu?.handleInput(input) === 'confirm') toggleTrack(menu.index)
      },
    }
  })
}
