// 属性克制表: three views of the one chart in content/types.json.
//   单个属性  pick a type (←→ / tap): what it beats, what resists it, what it is weak to, what it is immune to
//   完整表格  13 x 13 grid, attacker rows x defender columns; the cursor's row and column light up, a caption names the pair
//   克制闭环  the memory loops (content/tutorial.json typeChart.loops) as arrow rings, with the reason of every arrow
// ↑ from the top of a view focuses the view tabs (←→ switches view, ↓ returns); Z opens a grid row's type; X backs out.
import { CONTENT, t } from '../../../shared/content/index.ts'
import type { Input, TypeChartOptions } from '../../contracts.ts'
import { TUTORIAL, type LoopDef } from '../../onboarding/config.ts'
import { onUIScaleChange } from '../scale.ts'
import { button, createGridNav, el, panel, tabs, type GridNav } from '../widgets.ts'
import { backPressed, frame, isCompact, openScreen, pressed, setChildren, uiSfx, type Hint, type ScreenEnv } from './base.ts'
import { SCREENS, type TypeChartView } from './config.ts'
import { attackGroups, defendGroups, exampleOf, formatMul, loopEdges, mulOf, rowOfMul, type MatchupGroup } from './typechart-logic.ts'
import { loopRing, typeIcon, typeTag, withNodes } from './typechart-parts.ts'
import './typechart.css'

interface ChartView {
  readonly el: HTMLElement
  /** The view just became visible (or its layout changed): repaint what depends on size. */
  show(): void
  /** Handles direction / confirm input; returns 'tabs' when the player pressed up past the first row. */
  input(input: Input): 'tabs' | null
  hints(): Hint[]
}

/** What the screen was last showing, so reopening it from the pause menu does not start over. */
const memory: { view: TypeChartView; type: string | null } = { view: SCREENS.typeChart.views[0], type: null }

const typeIds = (): string[] => CONTENT.types.map((x) => x.id)
const nameOf = (id: string): string => CONTENT.typeById[id]?.nameZh ?? id

export function typeChartScreen(env: ScreenEnv, opts?: TypeChartOptions): Promise<void> {
  const { ctx } = env
  const cfg = SCREENS.typeChart
  const ids = typeIds()
  return openScreen<void>(env, 'aps-typechart', (api) => {
    const startType = opts?.type && ids.includes(opts.type) ? opts.type : memory.type && ids.includes(memory.type) ? memory.type : ids[0]
    let current = startType
    const setType = (id: string) => { current = id; memory.type = id }

    const f = frame(env, { title: t('screens.typeChart.title'), glyph: 'typeChart', onClose: api.guard(() => api.close()) })
    const views: Record<TypeChartView, ChartView> = {
      type: typeView(env, () => current, setType),
      grid: gridView(env, () => current, setType, (id) => { setType(id); switchTo('type') }),
      loops: loopsView(env),
    }
    const viewIds = cfg.views
    const startView = viewIds.includes(opts?.view ?? memory.view) ? opts?.view ?? memory.view : viewIds[0]
    let zone: 'tabs' | 'body' = 'body'
    let active: TypeChartView = startView
    const tabBar = tabs(viewIds.map((v) => t(`screens.typeChart.view.${v}`)), {
      initial: viewIds.indexOf(startView), audio: ctx.audio, className: 'aps-tc-tabs',
      onChange: (i) => switchTo(viewIds[i]),
    })
    const stage = el('div', 'aps-tc-stage', viewIds.map((v) => views[v].el))
    f.body.append(tabBar.el, stage)
    api.root.append(f.el)
    tabBar.el.addEventListener('pointerdown', () => setZone('tabs'))
    stage.addEventListener('pointerdown', () => setZone('body'))

    let hintDevice = ctx.input.lastDevice
    const paintHints = () => {
      hintDevice = ctx.input.lastDevice
      if (hintDevice === 'touch') { f.setHints([]); return }
      const toTabs: Hint[] = [['lr', t('screens.hint.tabs')], ['down', t('screens.typeChart.hint.toContent')], ['cancel', t('screens.hint.back')]]
      f.setHints(zone === 'tabs' ? toTabs : [...views[active].hints(), ['cancel', t('screens.hint.back')]])
    }
    const setZone = (z: 'tabs' | 'body') => {
      zone = z
      tabBar.el.classList.toggle('is-focus', z === 'tabs')
      paintHints()
    }
    function switchTo(v: TypeChartView): void {
      active = v
      memory.view = v
      for (const id of viewIds) views[id].el.hidden = id !== v
      if (tabBar.index !== viewIds.indexOf(v)) tabBar.set(viewIds.indexOf(v), true)
      views[v].show()
      paintHints()
    }
    switchTo(startView)

    const offScale = onUIScaleChange(() => views[active].show())
    return {
      onInput(input) {
        if (backPressed(input)) { api.close(); return }
        if (zone === 'tabs') {
          if (pressed(input, 'left', true)) tabBar.prev()
          else if (pressed(input, 'right', true)) tabBar.next()
          else if (pressed(input, 'down', true) || pressed(input, 'confirm')) setZone('body')
          return
        }
        if (views[active].input(input) === 'tabs') { uiSfx(env, 'move'); setZone('tabs') }
      },
      // Hints follow the device the player is using right now (a tap after keys hides the key caps).
      update() { if (ctx.input.lastDevice !== hintDevice) paintHints() },
      dispose() { offScale() },
    }
  })
}

// ---------------------------------------------------------------------------
// Per-type view
// ---------------------------------------------------------------------------

function typeView(env: ScreenEnv, getType: () => string, setType: (id: string) => void): ChartView {
  const { ctx } = env
  const cfg = SCREENS.typeChart
  const ids = typeIds()
  const root = el('div', 'aps-tc-typeview')
  const pickerBox = el('div', { class: 'aps-tc-picker', attrs: { role: 'listbox', 'aria-label': t('screens.typeChart.hint.pick') }, vars: { '--tile-h': cfg.picker.tileH } })
  const detail = el('div', { class: 'aps-tc-detail', attrs: { 'aria-live': 'polite' } })
  root.append(pickerBox, detail)

  const tiles = ids.map((id, i) => {
    const def = CONTENT.typeById[id]
    const tile = button('', () => pick(i), { className: 'aps-tc-tile' })
    tile.setAttribute('role', 'option')
    tile.style.setProperty('--tc', def.color)
    tile.append(typeIcon(ctx.assets, id, cfg.picker.icon), el('span', { class: 'aps-tc-tile-name', text: def.nameZh }))
    return tile
  })
  pickerBox.append(...tiles)

  const cols = () => (isCompact() ? cfg.picker.compactCols : cfg.picker.cols)
  let nav: GridNav = makeNav()
  function makeNav(): GridNav {
    return createGridNav({ count: ids.length, cols: cols(), wrap: true, initial: Math.max(0, ids.indexOf(getType())), audio: ctx.audio, onChange: (i) => { setType(ids[i]); paint() } })
  }
  function pick(i: number): void {
    if (i !== nav.index) { nav.set(i); uiSfx(env, 'move') }
    setType(ids[i])
    paint()
  }

  const group = (g: MatchupGroup, side: 'attack' | 'defend'): HTMLElement => {
    const label = t(`screens.typeChart.${side}.${g.row.id}`, { mul: formatMul(g.row.mul) })
    const chips = g.types.length
      ? el('span', 'aps-tc-chips', g.types.map((id) => typeTag(ctx.assets, id)))
      : el('span', { class: 'aps-tc-none ap-dim', text: t('screens.typeChart.none') })
    return el('div', { class: `aps-tc-row is-${g.row.tone}${g.types.length ? '' : ' is-empty'}`, vars: { '--tone-bg': cfg.tones[g.row.tone].bg, '--tone-fg': cfg.tones[g.row.tone].fg } }, [
      el('span', { class: 'aps-tc-row-label', text: label }), chips,
    ])
  }
  const side = (kind: 'attack' | 'defend', groups: MatchupGroup[]) => {
    const p = panel(t(`screens.typeChart.${kind}.title`), { className: `aps-tc-side is-${kind}` })
    p.body.append(...groups.map((g) => group(g, kind)))
    return p.el
  }

  function paint(): void {
    const id = getType()
    tiles.forEach((tile, i) => {
      tile.classList.toggle('is-active', ids[i] === id)
      tile.setAttribute('aria-selected', String(ids[i] === id))
    })
    const def = CONTENT.typeById[id]
    const ex = exampleOf(id)
    const example = ex
      ? el('div', 'aps-tc-example', [
        el('span', { class: 'aps-tc-example-k ap-gold', text: t('screens.typeChart.exampleLabel') }),
        el('span', 'aps-tc-example-v', withNodes(t('screens.typeChart.example', { mul: formatMul(ex.mul) }), { atk: typeTag(ctx.assets, id), def: typeTag(ctx.assets, ex.def) })),
      ])
      : null
    detail.replaceChildren(
      el('div', 'aps-tc-head', [
        typeIcon(ctx.assets, id, 32),
        el('span', { class: 'aps-tc-name', text: def.nameZh, vars: { '--tc': def.color } }),
        example,
      ]),
      el('div', 'aps-tc-sides', [side('attack', attackGroups(id)), side('defend', defendGroups(id))]),
    )
    detail.scrollTop = 0
  }

  return {
    el: root,
    show() {
      if (nav.cols !== cols()) nav = makeNav()
      nav.set(Math.max(0, ids.indexOf(getType())))
      pickerBox.style.setProperty('--cols', String(cols()))
      paint()
    },
    input(input) {
      if (pressed(input, 'left', true)) { nav.move(-1, 0); return null }
      if (pressed(input, 'right', true)) { nav.move(1, 0); return null }
      if (pressed(input, 'up', true)) {
        if (detail.scrollTop > 0) { detail.scrollBy({ top: -detail.clientHeight * 0.6 }); return null }
        return Math.floor(nav.index / nav.cols) === 0 ? 'tabs' : (nav.move(0, -1), null)
      }
      if (pressed(input, 'down', true)) {
        if (Math.floor(nav.index / nav.cols) < Math.ceil(ids.length / nav.cols) - 1) nav.move(0, 1)
        else detail.scrollBy({ top: detail.clientHeight * 0.6 })
      }
      return null
    },
    hints: () => [['lr', t('screens.typeChart.hint.pick')], ['up', t('screens.typeChart.hint.toTabs')]],
  }
}

// ---------------------------------------------------------------------------
// Full grid view
// ---------------------------------------------------------------------------

function gridView(env: ScreenEnv, getType: () => string, setType: (id: string) => void, openType: (id: string) => void): ChartView {
  const { ctx } = env
  const cfg = SCREENS.typeChart
  const ids = typeIds()
  const n = ids.length
  const g = cfg.grid
  const root = el('div', { class: 'aps-tc-gridview', vars: { '--cw-u': g.cellW, '--ch-u': g.cellH, '--hw': g.headW, '--hh': g.headH, '--side': g.sideW, '--n': n } })
  // Corner, column headers, row headers and cells are four boxes: the headers follow the cells' scroll (they never sit
  // under anything, and nothing scrolls beneath them).
  const colStrip = el('div', 'aps-tc-cols')
  const rowStrip = el('div', 'aps-tc-rows')
  const cellsEl = el('div', { class: 'aps-tc-cells', attrs: { role: 'grid', 'aria-label': t('screens.typeChart.view.grid') } })
  cellsEl.addEventListener('scroll', () => { colStrip.scrollLeft = cellsEl.scrollLeft; rowStrip.scrollTop = cellsEl.scrollTop }, { passive: true })
  const sidePane = el('div', 'aps-tc-gridside')
  root.append(el('div', 'aps-tc-gridpanel ap-panel', [el('div', 'aps-tc-grid', [el('div', { class: 'aps-tc-corner', text: t('screens.typeChart.corner') }), colStrip, rowStrip, cellsEl])]), sidePane)

  const verdictText = (mul: number): string => {
    const row = rowOfMul(mul)
    return t(`screens.typeChart.verdict.${row ? row.id : 'neutral'}`, { mul: formatMul(mul) })
  }
  const rowHeads: HTMLElement[] = []
  const colHeads: HTMLElement[] = []
  const cells: HTMLButtonElement[][] = []

  ids.forEach((id) => {
    const h = el('div', { class: 'aps-tc-colhead', attrs: { title: nameOf(id) } }, [typeIcon(ctx.assets, id, g.icon)])
    colHeads.push(h)
    colStrip.append(h)
  })
  ids.forEach((atk, r) => {
    const h = el('div', 'aps-tc-rowhead', [typeIcon(ctx.assets, atk, g.icon), el('span', { class: 'aps-tc-rowname', text: nameOf(atk) })])
    rowHeads.push(h)
    rowStrip.append(h)
    cells.push(ids.map((def, c) => {
      const mul = mulOf(atk, def)
      const row = rowOfMul(mul)
      const cell = el('button', {
        class: `aps-tc-cell${row ? ` is-${row.tone}` : ''}`, text: row ? t(`screens.typeChart.cell.${row.id}`) : '',
        attrs: { type: 'button', role: 'gridcell', tabindex: '-1', 'aria-label': t('screens.typeChart.cellLabel', { pair: t('screens.typeChart.pair', { atk: nameOf(atk), def: nameOf(def) }), verdict: verdictText(mul) }) },
        vars: row ? { '--tone-bg': cfg.tones[row.tone].bg, '--tone-fg': cfg.tones[row.tone].fg } : undefined,
      })
      cell.addEventListener('click', () => put(r, c, true))
      cell.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && (cursor.r !== r || cursor.c !== c)) put(r, c, false) })
      cellsEl.append(cell)
      return cell
    }))
  })

  // Side pane: the pair under the cursor, then the legend.
  const caption = panel(null, { className: 'aps-tc-caption' })
  const legend = panel(t('screens.typeChart.legend.title'), { className: 'aps-tc-legend' })
  legend.body.append(
    ...cfg.matchups.attack.map((r) => el('div', 'aps-tc-legend-row', [
      el('span', { class: `aps-tc-swatch is-${r.tone}`, text: t(`screens.typeChart.cell.${r.id}`), vars: { '--tone-bg': cfg.tones[r.tone].bg, '--tone-fg': cfg.tones[r.tone].fg } }),
      el('span', { text: t(`screens.typeChart.legend.${r.id}`) }),
    ])),
    el('div', 'aps-tc-legend-row', [el('span', { class: 'aps-tc-swatch is-blank', text: '' }), el('span', { text: t('screens.typeChart.legend.neutral') })]),
    el('div', { class: 'aps-tc-axis ap-dim', text: t('screens.typeChart.axis') }),
  )
  sidePane.append(caption.el, legend.el)

  const cursor = { r: 0, c: 0 }
  const openBtn = button('', () => openType(ids[cursor.r]), { className: 'aps-tc-open' })

  function paint(scroll: boolean): void {
    const { r, c } = cursor
    const atk = ids[r], def = ids[c]
    const mul = mulOf(atk, def)
    const row = rowOfMul(mul)
    for (let i = 0; i < n; i++) {
      rowHeads[i].classList.toggle('is-on', i === r)
      colHeads[i].classList.toggle('is-on', i === c)
      for (let j = 0; j < n; j++) {
        const cell = cells[i][j]
        cell.classList.toggle('is-row', i === r)
        cell.classList.toggle('is-col', j === c)
        cell.classList.toggle('is-cursor', i === r && j === c)
      }
    }
    const reasonKey = `screens.typeChart.reason.${atk}.${def}`
    const reason = mul > 1 && reasonKey in CONTENT.text ? el('p', { class: 'aps-tc-reason', text: t(reasonKey) }) : null
    openBtn.textContent = t('screens.typeChart.openType', { name: nameOf(atk) })
    setChildren(caption.body, [
      el('div', 'aps-tc-pair', withNodes(t('screens.typeChart.pair', { atk: '{atk}', def: '{def}' }), { atk: typeTag(ctx.assets, atk), def: typeTag(ctx.assets, def) })),
      el('div', { class: 'aps-tc-verdict', text: verdictText(mul), vars: row ? { '--tone-bg': cfg.tones[row.tone].bg, '--tone-fg': cfg.tones[row.tone].fg } : undefined }),
      reason,
      openBtn,
    ])
    if (scroll) cells[r][c].scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  function put(r: number, c: number, sfx: boolean): void {
    if (sfx && (cursor.r !== r || cursor.c !== c)) uiSfx(env, 'move')
    cursor.r = Math.min(n - 1, Math.max(0, r))
    cursor.c = Math.min(n - 1, Math.max(0, c))
    setType(ids[cursor.r])
    paint(sfx)
  }

  return {
    el: root,
    show() {
      const r = Math.max(0, ids.indexOf(getType()))
      const ex = exampleOf(ids[r])
      cursor.r = r
      cursor.c = ex ? Math.max(0, ids.indexOf(ex.def)) : 0
      paint(false)
      requestAnimationFrame(() => {
        cellsEl.scrollTop = 0
        cellsEl.scrollLeft = 0
        cells[cursor.r][cursor.c].scrollIntoView({ block: 'nearest', inline: 'nearest' })
      })
    },
    input(input) {
      const move = (dr: number, dc: number) => {
        const r = cursor.r + dr, c = cursor.c + dc
        if (r < 0 || c < 0 || r >= n || c >= n) return
        put(r, c, true)
      }
      if (pressed(input, 'left', true)) move(0, -1)
      else if (pressed(input, 'right', true)) move(0, 1)
      else if (pressed(input, 'down', true)) move(1, 0)
      else if (pressed(input, 'up', true)) { if (cursor.r === 0) return 'tabs'; move(-1, 0) }
      else if (pressed(input, 'confirm')) { uiSfx(env, 'confirm'); openType(ids[cursor.r]) }
      return null
    },
    hints: () => [['lr', t('screens.typeChart.hint.move')], ['confirm', t('screens.typeChart.hint.open')], ['up', t('screens.typeChart.hint.toTabs')]],
  }
}

// ---------------------------------------------------------------------------
// Loops view
// ---------------------------------------------------------------------------

function loopsView(env: ScreenEnv): ChartView {
  const { ctx } = env
  const loops = TUTORIAL.typeChart.loops
  const root = el('div', 'aps-tc-loopview')
  const picker = el('div', { class: 'aps-tc-loop-picker', attrs: { role: 'listbox' }, vars: { '--loops': loops.length } })
  const detail = el('div', 'aps-tc-loop-detail')
  root.append(picker, el('div', 'aps-tc-looppanel ap-panel', [detail]))
  let index = 0
  const titleOf = (l: LoopDef) => t(`screens.typeChart.loops.${l.id}.title`)
  const tabsEl = loops.map((l, i) => {
    const b = button(titleOf(l), () => select(i, true), { className: 'aps-tc-loop-tab' })
    b.setAttribute('role', 'option')
    return b
  })
  picker.append(...tabsEl)

  function paint(): void {
    const loop = loops[index]
    tabsEl.forEach((b, i) => { b.classList.toggle('is-active', i === index); b.setAttribute('aria-selected', String(i === index)) })
    const edges = loopEdges(loop).map(([a, b]) => {
      const key = `screens.typeChart.reason.${a}.${b}`
      return el('li', 'aps-tc-edge', [
        el('span', 'aps-tc-edge-pair', [typeTag(ctx.assets, a), el('span', { class: 'aps-tc-edge-arrow', text: '→' }), typeTag(ctx.assets, b)]),
        key in CONTENT.text ? el('span', { class: 'aps-tc-why', text: t(key) }) : null,
      ])
    })
    detail.replaceChildren(
      el('div', 'aps-tc-loop-ring', [loopRing(ctx.assets, loop)]),
      el('div', 'aps-tc-loop-text', [
        el('div', 'aps-tc-loop-title', [
          el('span', { class: 'ap-gold', text: titleOf(loop) }),
          loop.starter ? el('span', { class: 'aps-tag is-main', text: t(`screens.typeChart.loops.${loop.id}.tag`) }) : null,
        ]),
        el('ul', 'aps-tc-edges', edges),
        el('p', { class: 'aps-tc-loop-hint ap-dim', text: t('screens.typeChart.loopHint') }),
      ]),
    )
  }
  function select(i: number, sfx: boolean): void {
    const next = ((i % loops.length) + loops.length) % loops.length
    if (next === index) return
    index = next
    if (sfx) uiSfx(env, 'move')
    paint()
  }

  return {
    el: root,
    show() { paint() },
    input(input) {
      if (pressed(input, 'left', true)) select(index - 1, true)
      else if (pressed(input, 'right', true)) select(index + 1, true)
      else if (pressed(input, 'up', true)) { if (detail.scrollTop > 0) detail.scrollBy({ top: -detail.clientHeight * 0.6 }); else return 'tabs' }
      else if (pressed(input, 'down', true)) detail.scrollBy({ top: detail.clientHeight * 0.6 })
      return null
    },
    hints: () => [['lr', t('screens.typeChart.hint.loop')], ['up', t('screens.typeChart.hint.toTabs')]],
  }
}
