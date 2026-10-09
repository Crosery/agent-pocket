// Command window (战斗/背包/队伍/逃跑|投降) and move list with a detail window (type, category, power, accuracy,
// priority, description, effectiveness hint). Keyboard/gamepad via Input + GridNav; mouse hover/click and touch tap
// via DOM. Each open*() resolves once with the pick (-1 on cancel); disabled entries are styled but still resolve
// so the caller can explain why they cannot be used.
import type { MoveDef } from '../../shared/types.ts'
import type { AudioManager, Input } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import { append, button, createGridNav, el, panel, typeChip, type GridNav } from '../ui/widgets.ts'
import { commandIcon, typeBadge } from './badges.ts'
import { BATTLE_UI, type CommandId, type EffCategory } from './config.ts'

export interface CommandItem { id: CommandId; disabled: boolean }

export interface MoveItem {
  /** null = unknown move id (still selectable by index). */
  def: MoveDef | null
  label: string
  pp: number
  ppMax: number
  disabled: boolean
  /** Effectiveness against the foe on the field; null = not shown. */
  hint: EffCategory | 'unknown' | null
}

export interface Menus {
  readonly el: HTMLElement
  readonly open: boolean
  readonly mode: 'commands' | 'moves' | null
  openCommands(items: CommandItem[], initial: number): Promise<CommandId>
  /** Resolves the move index, or -1 when backing out. */
  openMoves(items: MoveItem[], initial: number): Promise<number>
  close(): void
  input(inp: Input): boolean
}

interface Active {
  mode: 'commands' | 'moves'
  nav: GridNav
  rows: HTMLElement[]
  pick(i: number): void
  cancel(): void
}

export function createMenus(audio: AudioManager): Menus {
  const S = BATTLE_UI.sfx
  const wrap = el('div', 'apb-menu-wrap')
  wrap.hidden = true
  let active: Active | null = null

  const paint = () => {
    if (!active) return
    active.rows.forEach((r, i) => {
      r.classList.toggle('is-active', i === active!.nav.index)
      r.setAttribute('aria-selected', String(i === active!.nav.index))
    })
  }

  const install = (content: HTMLElement[], rows: HTMLElement[], a: Omit<Active, 'rows'>) => {
    active = { ...a, rows }
    rows.forEach((r, i) => {
      r.addEventListener('mouseenter', () => {
        if (active?.rows !== rows || active.nav.index === i) return
        active.nav.index = i
        audio.playSfx(S.select)
        paint()
      })
      r.addEventListener('click', (e) => {
        e.stopPropagation()
        if (active?.rows !== rows) return
        active.nav.index = i
        paint()
        active.pick(i)
      })
    })
    wrap.replaceChildren(...content)
    wrap.hidden = false
    paint()
  }

  const close = () => {
    active = null
    wrap.hidden = true
    wrap.replaceChildren()
  }

  const row = (cls: string, children: (HTMLElement | string)[], disabled: boolean) =>
    el('div', { class: `ap-row ap-cursor-host ${cls}${disabled ? ' is-disabled' : ''}`, attrs: { role: 'option' } }, children)

  return {
    el: wrap,
    get open() { return active !== null },
    get mode() { return active?.mode ?? null },

    openCommands(items, initial) {
      return new Promise<CommandId>((resolve) => {
        const p = panel(null, { className: 'apb-win apb-menu apb-cmd' })
        p.el.style.setProperty('--cols', String(BATTLE_UI.commands.columns))
        const rows = items.map((it) => row('apb-cmd-row', [commandIcon(it.id), el('span', { class: 'ap-row-label', text: t(`battleui.cmd.${it.id}`) })], it.disabled))
        p.body.replaceWith(...rows)
        const nav = createGridNav({ count: items.length, cols: BATTLE_UI.commands.columns, initial, audio, onChange: paint })
        install([p.el], rows, {
          mode: 'commands',
          nav,
          pick: (i) => { if (!items[i].disabled) audio.playSfx(S.confirm); close(); resolve(items[i].id) },
          cancel: () => undefined,
        })
      })
    },

    openMoves(items, initial) {
      return new Promise<number>((resolve) => {
        const p = panel(null, { className: 'apb-win apb-menu apb-moves' })
        p.el.style.setProperty('--cols', String(BATTLE_UI.moves.columns))
        const rows = items.map((it) => {
          const out = it.pp <= 0
          const low = !out && it.pp * 4 <= it.ppMax
          return row('apb-move-row', [
            it.def ? typeBadge(it.def.type) : el('span'),
            el('span', { class: 'apb-move-name', text: it.label }),
            el('span', { class: `apb-move-pp${out ? ' is-out' : low ? ' is-low' : ''}`, text: t('battleui.move.pp', { pp: it.pp, max: it.ppMax }) }),
          ], it.disabled)
        })
        p.body.replaceWith(...rows)
        const back = button(t('battleui.move.back'), (e) => { e.stopPropagation(); active?.cancel() }, { className: 'apb-back' })
        const detail = panel(null, { className: 'apb-win apb-detail' })
        const showDetail = (i: number) => {
          const it = items[i]
          const m = it?.def
          if (!m) { detail.el.hidden = true; return }
          detail.el.hidden = false
          const cat = el('span', { class: 'apb-cat', text: t(`battleui.move.category.${m.category}`) })
          cat.style.setProperty('--cat', BATTLE_UI.moves.categoryColors[m.category])
          const backBtn = back
          const stat = (k: string, v: string) => el('span', {}, [t(k), el('b', { text: v })])
          const priority = m.priority
            ? el('span', { text: t('battleui.move.priority', { n: m.priority > 0 ? `+${m.priority}` : String(m.priority) }) })
            : null
          detail.body.replaceChildren()
          append(detail.body, [
            el('div', 'apb-detail-head', [typeChip(m.type), el('span', { class: 'apb-detail-name', text: m.nameZh }), backBtn]),
            el('div', 'apb-detail-stats', [
              cat,
              stat('battleui.move.power', m.power > 0 ? String(m.power) : t('battleui.move.none')),
              stat('battleui.move.accuracy', m.accuracy === 0 ? t('battleui.move.never') : String(m.accuracy)),
              priority,
            ]),
            el('p', 'apb-detail-desc', [
              it.hint ? el('span', { class: `apb-eff is-${it.hint}`, text: t(`battleui.eff.${it.hint}`) }) : null,
              m.description,
            ]),
          ])
        }
        const nav = createGridNav({
          count: items.length, cols: BATTLE_UI.moves.columns, initial, audio,
          onChange: (i) => { paint(); showDetail(i) },
        })
        const holder = el('div', 'apb-moves-wrap', [p.el, detail.el])
        detail.el.dataset.hud = ''
        install([holder], rows, {
          mode: 'moves',
          nav,
          pick: (i) => { if (!items[i].disabled) audio.playSfx(S.confirm); close(); resolve(i) },
          cancel: () => { audio.playSfx(S.cancel); close(); resolve(-1) },
        })
        rows.forEach((r, i) => r.addEventListener('mouseenter', () => showDetail(i)))
        showDetail(nav.index)
      })
    },

    close,

    input(inp) {
      const a = active
      if (!a) return false
      const r = a.nav.handle(inp)
      if (r === 'confirm') a.pick(a.nav.index)
      else if (r === 'cancel') a.cancel()
      return r !== null
    },
  }
}
