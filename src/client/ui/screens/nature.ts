// Nature picker for the persona card: the 25 natures as a 5x5 grid (row = stat raised, column = stat lowered, the
// diagonal holds the five neutral natures). Resolves the chosen nature id, or null when the player backs out.
// The creature is not touched here; the item flow applies the choice.
import type { Creature, StatKey } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { creatureName } from '../../../shared/creature.ts'
import { createGridNav, el } from '../widgets.ts'
import { backPressed, frame, H, openScreen, pressed, uiSfx, type ScreenEnv } from './base.ts'
import { natureName, natureQuip, natureStats } from '../quality-text.ts'
import { natureAxis, natureGrid } from './logic.ts'

export function natureScreen(env: ScreenEnv, creature: Creature): Promise<string | null> {
  const { ctx } = env
  const cells = natureGrid()
  const axis = natureAxis()
  const stat = (k: StatKey) => CONTENT.statByKey[k]?.nameZh ?? k
  return openScreen<string | null>(env, 'aps-nature', (api) => {
    const f = frame(env, { title: t('screens.quality.pickNature'), onClose: api.guard(() => api.close(null)), hints: [H.select(), H.back()] })
    const nav = createGridNav({ count: cells.length, cols: axis.length, initial: Math.max(0, cells.findIndex((n) => n.id === creature.nature)), audio: ctx.audio, onChange: () => paint() })
    const detail = el('div', 'aps-nat-detail ap-panel')
    const nodes = cells.map((n, i) => {
      const b = el('button', { class: `aps-nat-cell${n.up === null ? ' is-neutral' : ''}`, attrs: { type: 'button', role: 'option', 'aria-label': natureName(n.id) } }, [natureName(n.id)])
      b.addEventListener('mouseenter', api.guard(() => { if (nav.index !== i) { nav.index = i; uiSfx(env, 'move'); paint() } }))
      b.addEventListener('click', api.guard(() => { nav.index = i; paint(); api.close(n.id) }))
      return b
    })
    const grid = el('div', { class: 'aps-nat-grid', vars: { '--cols': axis.length + 1 }, attrs: { role: 'listbox' } }, [
      el('span', { class: 'aps-nat-corner', text: '' }),
      ...axis.map((k) => el('span', { class: 'aps-nat-colhead', text: `${stat(k)}↓` })),
      ...axis.flatMap((k, r) => [el('span', { class: 'aps-nat-rowhead', text: `${stat(k)}↑` }), ...nodes.slice(r * axis.length, (r + 1) * axis.length)]),
    ])
    f.body.append(el('div', 'aps-nat-layout', [el('div', 'aps-nat-main ap-panel', [grid]), detail]))
    api.root.append(f.el)

    const paint = () => {
      nodes.forEach((b, i) => {
        b.classList.toggle('is-active', i === nav.index)
        b.classList.toggle('is-current', cells[i].id === creature.nature)
        b.setAttribute('aria-selected', String(i === nav.index))
      })
      const n = cells[nav.index]
      const s = natureStats(n.id)
      const parts: (HTMLElement | null)[] = [
        el('div', 'aps-nat-who', [creatureName(creature), n.id === creature.nature ? el('span', { class: 'aps-nat-now', text: t('screens.quality.pickCurrent') }) : null]),
        el('div', { class: 'aps-nat-name ap-gold', text: natureName(n.id) }),
        s ? el('div', 'aps-nature-arrows', [el('span', { class: 'is-up', text: `${s.up}↑` }), el('span', { class: 'is-down', text: `${s.down}↓` })]) : null,
        el('p', { class: 'aps-nat-quip ap-dim', text: natureQuip(n.id) }),
      ]
      detail.replaceChildren(...parts.filter((x): x is HTMLElement => x !== null))
    }
    paint()
    return {
      onInput(input) {
        if (backPressed(input)) { api.close(null); return }
        if (pressed(input, 'confirm')) { api.close(cells[nav.index].id); return }
        nav.handle(input)
      },
    }
  })
}
