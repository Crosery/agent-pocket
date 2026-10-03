// Intel log (pause menu): world-event news (start announcements kept as SaveData.flags news entries), rumors heard,
// active events + the real-date festival calendar, MYTHIC chain clues and the roaming legends' status.
// Rules: src/shared/gameplay/{events,spawns}.ts; tunables: content/events/client.json intel.*.
import type { WorldEventDef } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { GAMEPLAY } from '../../../shared/gameplay/data.ts'
import {
  activeEvents, dayOf, eventDescription, eventParams, eventTitle, festivalCalendar, realDateOf, rumorFlag,
} from '../../../shared/gameplay/events.ts'
import { chainsProgress } from '../../../shared/gameplay/spawns.ts'
import { GPC } from '../../world/gameplay-config.ts'
import { createRowMenu, type RowMenu } from '../menu.ts'
import { el, tabs } from '../widgets.ts'
import { backPressed, frame, icon, isCompact, openScreen, pressed, sectionTitle, setChildren, type ScreenEnv } from './base.ts'
import './gameplay.css'

type Child = HTMLElement | string | null

interface Entry {
  label: string
  sub: string
  /** Row accent (data-tag) for styling. */
  tag?: string
  detail(): Child[]
}

const TABS = ['news', 'rumors', 'events', 'clues', 'legends'] as const
type Tab = typeof TABS[number]

const MINUTES_PER_DAY = 24 * 60

function whenText(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes))
  const mod = m % MINUTES_PER_DAY
  const time = `${String(Math.floor(mod / 60)).padStart(2, '0')}:${String(mod % 60).padStart(2, '0')}`
  return t('events.ui.when', { day: dayOf(m) + 1, time })
}

const textOf = (key: string, params: Record<string, string | number> = {}) => (key in CONTENT.text ? t(key, params) : key)

function flagEntries(flags: Readonly<Record<string, unknown>>, prefix: string): { id: string; at: number }[] {
  const out: { id: string; at: number }[] = []
  for (const [k, v] of Object.entries(flags)) if (k.startsWith(prefix) && typeof v === 'number') out.push({ id: k.slice(prefix.length), at: v })
  return out.sort((a, b) => b.at - a.at)
}

function tag(text: string, ok = false): HTMLElement {
  return el('span', { class: `aps-tag${ok ? ' is-ok' : ''}`, text })
}

export function intelScreen(env: ScreenEnv): Promise<void> {
  const { ctx } = env
  const I = GPC.intel
  return openScreen<void>(env, 'aps-intel', (api) => {
    let tab = 0
    let entries: Entry[] = []
    let menu: RowMenu | null = null
    const f = frame(env, { title: t('events.ui.intelTitle'), glyph: 'intel', onClose: api.guard(() => api.close()) })
    const tabBar = tabs(TABS.map((k) => t(`events.ui.tab.${k}`)), { audio: ctx.audio, onChange: (i) => { tab = i; rebuild(0) } })
    const listBox = el('div', 'aps-bag-list ap-panel')
    const detail = el('div', 'aps-intel-detail ap-panel')
    f.body.append(el('div', 'aps-bag-layout aps-intel-layout', [el('div', 'aps-bag-left', [tabBar.el, listBox]), detail]))
    api.root.append(f.el)

    const minutes = () => ctx.save.clockMinutes
    const state = () => ctx.save.events ?? {}
    const isActive = (id: string) => activeEvents(state(), minutes()).some((a) => a.id === id)
    const eventStatus = (def: WorldEventDef): HTMLElement => (isActive(def.id) ? tag(t('events.ui.statusActive'), true) : tag(t('events.ui.statusEnded')))
    const eventDetail = (def: WorldEventDef, extra: Child[] = []): Child[] => [
      el('div', 'aps-intel-head', [el('span', { class: 'aps-intel-title ap-gold', text: eventTitle(def) }), eventStatus(def), tag(t(`events.ui.scope.${def.scope}`))]),
      ...extra,
      el('p', { class: 'aps-intel-text', text: eventDescription(def) }),
    ]

    const news = (): Entry[] => flagEntries(ctx.save.flags, GPC.flags.news).slice(0, I.maxNews).flatMap(({ id, at }) => {
      const def = GAMEPLAY.eventById[id]
      if (!def) return []
      return [{ label: eventTitle(def), sub: whenText(at), tag: def.tag ?? '', detail: () => eventDetail(def, [el('div', { class: 'aps-intel-when ap-dim', text: t('events.ui.startedAt', { when: whenText(at) }) })]) }]
    })

    const rumors = (): Entry[] => flagEntries(ctx.save.flags, rumorFlag('')).slice(0, I.maxRumors).flatMap(({ id, at }) => {
      const def = GAMEPLAY.eventById[id]
      if (!def?.rumor) return []
      const text = textOf(def.rumor, eventParams(def))
      const confirmed = (state()[id]?.count ?? 0) > 0
      return [{
        label: text, sub: whenText(at), tag: 'rumor',
        detail: () => [
          el('div', 'aps-intel-head', [el('span', { class: 'aps-intel-title ap-gold', text: t('events.ui.tab.rumors') }), tag(t(confirmed ? 'events.ui.statusConfirmed' : 'events.ui.statusUnconfirmed'), confirmed)]),
          el('div', { class: 'aps-intel-when ap-dim', text: t('events.ui.heardAt', { when: whenText(at) }) }),
          el('p', { class: 'aps-intel-text aps-intel-quote', text }),
          confirmed ? el('p', { class: 'aps-intel-text', text: eventTitle(def) }) : null,
        ],
      }]
    })

    const events = (): Entry[] => {
      const out: Entry[] = []
      for (const ev of activeEvents(state(), minutes())) {
        if (ev.def.hidden || ev.def.trigger === 'legend') continue
        const left = Math.max(1, Math.ceil(ev.endsAt - minutes()))
        out.push({ label: eventTitle(ev.def), sub: t('events.ui.endsIn', { minutes: left }), tag: ev.def.tag ?? '', detail: () => eventDetail(ev.def, [el('div', { class: 'aps-intel-when ap-dim', text: t('events.ui.endsIn', { minutes: left }) })]) })
      }
      for (const c of festivalCalendar(realDateOf(new Date()), I.calendarDays)) {
        const def = GAMEPLAY.eventById[c.event]
        if (!def || isActive(def.id)) continue
        const sub = c.inDays === 0 ? t('events.ui.statusToday') : t('events.ui.inDays', { days: c.inDays })
        out.push({
          label: eventTitle(def), sub, tag: def.tag ?? '',
          detail: () => [
            el('div', 'aps-intel-head', [el('span', { class: 'aps-intel-title ap-gold', text: eventTitle(def) }), tag(t(c.inDays === 0 ? 'events.ui.statusToday' : 'events.ui.statusUpcoming'))]),
            sectionTitle(t('events.ui.calendarTitle')),
            el('div', { class: 'aps-intel-when', text: c.inDays === 0 ? t('events.ui.calendarToday', { name: eventTitle(def) }) : t('events.ui.calendarSoon', { name: eventTitle(def), days: c.inDays }) }),
            el('p', { class: 'aps-intel-text', text: eventDescription(def) }),
          ],
        })
      }
      return out
    }

    const clues = (): Entry[] => chainsProgress(ctx.save.flags).map((p) => {
      const name = t(`events.chain.${p.chain.id}.name`)
      return {
        label: name, sub: t('events.ui.stepCount', { solved: p.solved, total: p.total }), tag: 'chain',
        detail: () => [
          el('div', 'aps-intel-head', [el('span', { class: 'aps-intel-title ap-gold', text: name }), tag(t(p.done ? 'events.ui.statusSolved' : 'events.ui.statusSolving'), p.done)]),
          sectionTitle(t('events.ui.chainIntro')),
          el('p', { class: 'aps-intel-text', text: textOf(`events.chain.${p.chain.id}.intro`) }),
          sectionTitle(t('events.ui.chainClues')),
          el('ol', 'aps-stages', p.chain.steps.slice(0, Math.min(p.total, p.solved + (p.done ? 0 : 1))).map((step, k) => {
            const solved = k < p.solved
            return el('li', `aps-stage${solved ? ' is-done' : ' is-current'}`, [icon(solved ? 'check' : 'diamond', { className: 'aps-stage-mark' }), el('span', { text: textOf(step.clue) })])
          })),
        ],
      }
    })

    const legends = (): Entry[] => GAMEPLAY.legends.map((lg) => {
      const sp = ctx.data.species[lg.species]
      const st = ctx.save.legends?.[lg.species]
      const known = ctx.save.dexSeen.includes(lg.species) || (st?.seen ?? 0) > 0
      const heard = ctx.save.flags[rumorFlag(`legend-${lg.species}`)] !== undefined
      const title = t(`events.legend.${lg.species}.title`)
      const status = st?.caught ? 'events.ui.legendCaughtTag'
        : st?.defeatedDay !== undefined ? 'events.ui.legendDefeatedTag'
          : (st?.restUntil ?? 0) > minutes() ? 'events.ui.legendRestingTag' : 'events.ui.legendRoamingTag'
      const name = known ? sp?.nameZh ?? lg.species : t('events.ui.legendUnknown')
      return {
        label: known ? name : title, sub: t(status), tag: 'legend',
        detail: () => [
          el('div', 'aps-intel-head', [el('span', { class: 'aps-intel-title ap-gold', text: title }), tag(t(status), !!st?.caught)]),
          known ? el('img', { class: 'aps-intel-portrait', attrs: { src: ctx.assets.creatureImageUrl(lg.species), alt: '' } }) : null,
          el('div', { class: 'aps-intel-when', text: name }),
          st?.seen ? el('div', { class: 'aps-intel-when ap-dim', text: t('events.ui.legendSeen', { n: st.seen }) }) : null,
          st?.hops ? el('div', { class: 'aps-intel-when ap-dim', text: t('events.ui.legendHops', { n: st.hops }) }) : null,
          st?.hp !== undefined && !st.caught ? el('div', { class: 'aps-intel-when ap-dim', text: t('events.ui.legendHp', { hp: st.hp }) }) : null,
          el('p', { class: 'aps-intel-text aps-intel-quote', text: heard || known ? textOf(`events.legend.${lg.species}.rumor`) : t('events.ui.legendRumorUnheard') }),
          el('p', { class: 'aps-intel-text ap-dim', text: t('events.ui.legendHint') }),
        ],
      }
    })

    const EMPTY: Record<Tab, string> = {
      news: 'events.ui.newsEmpty', rumors: 'events.ui.rumorsEmpty', events: 'events.ui.eventsEmpty', clues: 'events.ui.cluesEmpty', legends: 'events.ui.legendsEmpty',
    }
    const build: Record<Tab, () => Entry[]> = { news, rumors, events, clues, legends }

    const rebuild = (keep: number) => {
      const k = TABS[tab]
      entries = build[k]()
      const visible = isCompact() ? I.compactVisibleRows : I.visibleRows
      menu = createRowMenu(entries.map((e) => ({ label: e.label, sub: e.sub })), {
        visibleRows: visible,
        initial: Math.min(keep, Math.max(0, entries.length - 1)),
        wrap: true,
        audio: ctx.audio,
        onChange: (i) => paint(i),
        onPick: (i: number) => paint(i),
      })
      menu.el.querySelectorAll<HTMLElement>('.ap-row').forEach((row, i) => {
        const tg = entries[i]?.tag
        if (!tg) return
        row.dataset.tag = tg
        const color = GPC.hud.tagColors[tg]
        if (color) row.style.setProperty('--evc', color)
      })
      listBox.replaceChildren(entries.length ? menu.el : el('div', { class: 'aps-empty', text: t(EMPTY[k]) }))
      paint(menu.index)
    }

    const paint = (i: number) => {
      f.setHints([['lr', t('screens.hint.tabs')], ['ud', t('screens.hint.choose')], ['cancel', t('screens.hint.back')]])
      const e = entries[i]
      if (!e) { detail.replaceChildren(el('div', { class: 'aps-empty', text: t(EMPTY[TABS[tab]]) })); return }
      setChildren(detail, e.detail())
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
