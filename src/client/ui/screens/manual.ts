// 教学手册: the curriculum (content/tutorial.json curriculum) as a browsable manual, one tab per group. Pages are
// t('tutorial.manual.<id>.title|body'); a lesson shows as learnt once an NPC taught it or one of its tips appeared.
import { CONTENT, t } from '../../../shared/content/index.ts'
import { TUTORIAL, type LessonDef } from '../../onboarding/config.ts'
import { lessonLearned } from '../../onboarding/logic.ts'
import { richText } from '../../onboarding/view.ts'
import { createRowMenu, type RowMenu } from '../menu.ts'
import { el, tabs } from '../widgets.ts'
import { backPressed, frame, isCompact, openScreen, pressed, setChildren, type ScreenEnv } from './base.ts'
import { SCREENS } from './config.ts'

/** The manual page body for the device in hand: a `bodyTouch` variant when there is one. */
const manualBodyKey = (id: string, device: string): string =>
  device === 'touch' && `tutorial.manual.${id}.bodyTouch` in CONTENT.text ? `tutorial.manual.${id}.bodyTouch` : `tutorial.manual.${id}.body`

export function manualScreen(env: ScreenEnv): Promise<void> {
  const { ctx } = env
  const groups = TUTORIAL.curriculum.groups
  return openScreen<void>(env, 'aps-manual', (api) => {
    let tab = 0
    let rows: LessonDef[] = []
    let menu: RowMenu | null = null
    const learnt = (l: LessonDef) => lessonLearned(l, ctx.save)
    const f = frame(env, { title: t('screens.manual.title'), glyph: 'quests', onClose: api.guard(() => api.close()) })
    const count = el('span', 'ap-gold')
    f.right.append(count)
    const tabBar = tabs(groups.map((g) => t(`tutorial.group.${g.id}`)), { audio: ctx.audio, onChange: (i) => { tab = i; rebuild(0) } })
    const listBox = el('div', 'aps-bag-list ap-panel')
    const detail = el('div', 'aps-bag-detail aps-manual-page ap-panel')
    f.body.append(el('div', 'aps-bag-layout', [el('div', 'aps-bag-left', [tabBar.el, listBox]), detail]))
    f.setHints([['lr', t('screens.hint.tabs')], ['ud', t('screens.hint.choose')], ['cancel', t('screens.hint.back')]])
    api.root.append(f.el)

    const paint = (i: number) => {
      const l = rows[i]
      if (!l) { detail.replaceChildren(el('div', { class: 'aps-empty', text: t('screens.manual.empty') })); return }
      setChildren(detail, [
        el('div', { class: 'aps-item-name ap-gold', text: t(`tutorial.manual.${l.id}.title`) }),
        el('div', { class: 'ap-dim', text: t(learnt(l) ? 'screens.manual.learnt' : 'screens.manual.unlearnt') }),
        el('p', { class: 'aps-manual-body' }, richText(t(manualBodyKey(l.id, ctx.input.lastDevice)), ctx.input.lastDevice)),
      ])
    }
    const rebuild = (keep: number) => {
      const gid = groups[tab]?.id
      rows = TUTORIAL.curriculum.lessons.filter((l) => l.group === gid)
      menu = createRowMenu(rows.map((l) => ({ label: t(`tutorial.manual.${l.id}.title`), sub: learnt(l) ? t('screens.manual.mark') : '' })), {
        visibleRows: isCompact() ? SCREENS.shop.compactVisibleRows : SCREENS.shop.visibleRows,
        initial: Math.min(keep, Math.max(0, rows.length - 1)),
        wrap: true,
        audio: ctx.audio,
        onChange: (i) => paint(i),
        onPick: () => undefined,
      })
      listBox.replaceChildren(menu.el)
      const all = TUTORIAL.curriculum.lessons
      count.textContent = t('screens.manual.count', { n: all.filter(learnt).length, total: all.length })
      paint(menu.index)
    }

    rebuild(0)
    return {
      onInput(input) {
        if (backPressed(input)) { api.close(); return }
        if (pressed(input, 'left', true)) { tabBar.prev(); return }
        if (pressed(input, 'right', true)) { tabBar.next(); return }
        menu?.handleInput(input)
      },
    }
  })
}
