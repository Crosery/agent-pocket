// Dex: virtualised grid ordered by dexNo (caught = sprite, seen = silhouette, unseen = "?"), filters from
// content/screens.json (type / rarity / country groups / company / caught state), search and completion.
// Up from the first grid row focuses the filter bar. Confirm opens the detail page (dex-detail.ts).
import type { SpeciesDef } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import type { ListItem } from '../../contracts.ts'
import { button, el, rarityBadge, typeChip } from '../widgets.ts'
import { backPressed, frame, icon, isCompact, keepTabVisible, openScreen, pressed, uiSfx, type ScreenEnv, setChildren } from './base.ts'
import { SCREENS } from './config.ts'
import { dexCompanies, dexCounts, dexState, filterDex, type DexFilter } from './logic.ts'
import { creatureImg } from './sprites.ts'
import { dexDetailScreen } from './dex-detail.ts'

type FilterId = typeof SCREENS.dex.filters[number]

const memory: { filter: DexFilter; index: number } = { filter: {}, index: 0 }

const pad3 = (n: number) => String(n).padStart(3, '0')

export function dexScreen(env: ScreenEnv): Promise<void> {
  const { ctx } = env
  const cfg = SCREENS.dex
  return openScreen<void>(env, 'aps-dex', (api) => {
    const filter: DexFilter = { ...memory.filter }
    let list: SpeciesDef[] = []
    let index = 0
    let top = 0
    let zone: 'grid' | 'filters' = 'grid'
    let filterFocus = 0

    const cols = () => (isCompact() ? cfg.compactCols : cfg.cols)
    const rows = () => (isCompact() ? cfg.compactRows : cfg.rows)

    const completion = el('div', 'aps-dex-completion')
    const f = frame(env, { title: t('screens.dex.title'), glyph: 'dex', onClose: api.guard(() => close()) })
    f.right.append(completion)

    // Filter bar
    const filterIds: (FilterId | 'search' | 'reset')[] = [...cfg.filters, 'search', 'reset']
    const filterBtns = filterIds.map((id, i) => {
      const b = button('', api.guard(() => { filterFocus = i; void activateFilter(i) }), { className: `aps-filter is-${id}` })
      return b
    })
    const filterBar = el('div', { class: 'aps-dex-filters aps-tabs-scroll', attrs: { role: 'toolbar', 'aria-label': t('screens.dex.filters') } }, filterBtns)
    keepTabVisible(filterBar, -1)

    // Grid (pool of cells re-bound on scroll)
    const grid = el('div', { class: 'aps-dex-grid', attrs: { role: 'grid', 'aria-label': t('screens.dex.title') } })
    const upInd = el('div', 'ap-scroll-ind ap-scroll-ind--up')
    const downInd = el('div', 'ap-scroll-ind ap-scroll-ind--down')
    const gridWrap = el('div', 'aps-dex-gridwrap ap-panel', [grid, upInd, downInd])
    const emptyMsg = el('div', { class: 'aps-empty aps-dex-empty', text: t('screens.dex.noMatch') })
    gridWrap.append(emptyMsg)
    const side = el('div', 'aps-dex-side ap-panel')
    f.body.append(el('div', 'aps-dex-layout', [el('div', 'aps-dex-main', [filterBar, gridWrap]), side]))
    api.root.append(f.el)

    let cells: HTMLButtonElement[] = []
    const buildPool = () => {
      grid.style.setProperty('--cols', String(cols()))
      grid.style.setProperty('--rows', String(rows()))
      cells = Array.from({ length: cols() * rows() }, (_, k) => {
        const cell = el('button', { class: 'aps-dex-cell', attrs: { type: 'button', role: 'gridcell' } })
        cell.addEventListener('mouseenter', api.guard(() => {
          const i = top * cols() + k
          if (i < list.length && (i !== index || zone !== 'grid')) { zone = 'grid'; index = i; uiSfx(env, 'move'); paint() }
        }))
        cell.addEventListener('click', api.guard(() => {
          const i = top * cols() + k
          if (i < list.length) { zone = 'grid'; index = i; paint(); void openDetail() }
        }))
        return cell
      })
      grid.replaceChildren(...cells)
    }
    grid.addEventListener('wheel', (e) => {
      e.preventDefault()
      if (api.busy || !list.length) return
      const d = Math.sign(e.deltaY) * cols()
      const next = Math.max(0, Math.min(list.length - 1, index + d))
      if (next !== index) { zone = 'grid'; index = next; uiSfx(env, 'move'); paint() }
    }, { passive: false })

    const bound = new Map<HTMLButtonElement, string>()
    const bindCell = (cell: HTMLButtonElement, sp: SpeciesDef | undefined, active: boolean) => {
      const key = sp ? `${sp.id}|${dexState(ctx.save, sp.id)}` : ''
      cell.classList.toggle('is-active', active)
      cell.classList.toggle('is-blank', !sp)
      cell.disabled = !sp
      if (bound.get(cell) === key) return
      bound.set(cell, key)
      if (!sp) { cell.replaceChildren(); cell.removeAttribute('aria-label'); return }
      const st = dexState(ctx.save, sp.id)
      cell.dataset.state = st
      cell.setAttribute('aria-label', st === 'unseen' ? t('screens.dex.unknownAria', { n: pad3(sp.dexNo) }) : sp.nameZh)
      setChildren(cell, [
        el('span', { class: 'aps-dex-no', text: pad3(sp.dexNo) }),
        st === 'unseen' ? el('span', { class: 'aps-dex-unknown', text: t('screens.dex.unknownMark') }) : creatureImg(ctx.assets, sp.id, { silhouette: st === 'seen', className: 'aps-dex-sprite' }),
        st === 'caught' ? icon('ball', { className: 'aps-dex-caught' }) : null,
      ])
    }

    const filterLabel = (id: FilterId | 'search' | 'reset'): string => {
      const v = (s: string | undefined) => s ?? t('screens.dex.all')
      switch (id) {
        case 'type': return t('screens.dex.filter.type', { v: v(filter.type ? CONTENT.typeById[filter.type]?.nameZh : undefined) })
        case 'rarity': return t('screens.dex.filter.rarity', { v: v(filter.rarity ? CONTENT.rarityById[filter.rarity]?.nameZh : undefined) })
        case 'country': {
          const g = cfg.countries.find((x) => x.id === filter.country)
          return t('screens.dex.filter.country', { v: v(g ? t(g.label) : undefined) })
        }
        case 'company': return t('screens.dex.filter.company', { v: v(filter.company) })
        case 'caught': return t('screens.dex.filter.caught', { v: v(filter.caught ? t(`screens.dex.caught.${filter.caught}`) : undefined) })
        case 'search': return filter.query ? t('screens.dex.searchValue', { q: filter.query }) : t('screens.dex.search')
        case 'reset': return t('screens.dex.reset')
      }
    }

    const refilter = (keepId?: string) => {
      list = filterDex(CONTENT.speciesList, filter, ctx.save, cfg.countries)
      const at = keepId ? list.findIndex((s) => s.id === keepId) : -1
      index = at >= 0 ? at : Math.min(index, Math.max(0, list.length - 1))
      memory.filter = { ...filter }
      filterBtns.forEach((b, i) => {
        const id = filterIds[i]
        b.textContent = filterLabel(id)
        const on = id === 'search' ? !!filter.query : id === 'reset' ? false : !!filter[id === 'caught' ? 'caught' : id]
        b.classList.toggle('is-set', on)
      })
      const c = dexCounts(ctx.save)
      completion.replaceChildren(
        el('span', { class: 'aps-dex-count', text: t('screens.dex.counts', { seen: c.seen, caught: c.caught, total: c.total }) }),
        el('span', { class: 'aps-dex-pct ap-gold', text: t('screens.dex.percent', { n: c.total ? Math.floor((c.caught / c.total) * 100) : 0 }) }),
        el('span', { class: 'aps-dex-meter', vars: { '--p': c.total ? c.caught / c.total : 0 } }),
      )
      paint()
    }

    const paint = () => {
      const c = cols()
      const r = rows()
      const row = Math.floor(index / c)
      if (row < top) top = row
      else if (row >= top + r) top = row - r + 1
      top = Math.max(0, Math.min(top, Math.max(0, Math.ceil(list.length / c) - r)))
      cells.forEach((cell, k) => {
        const i = top * c + k
        bindCell(cell, list[i], zone === 'grid' && i === index)
      })
      upInd.classList.toggle('is-on', top > 0)
      downInd.classList.toggle('is-on', (top + r) * c < list.length)
      emptyMsg.hidden = list.length > 0
      filterBtns.forEach((b, i) => b.classList.toggle('is-active', zone === 'filters' && i === filterFocus))
      if (zone === 'filters') keepTabVisible(filterBar, filterFocus)
      paintSide()
      f.setHints(zone === 'filters'
        ? [['lr', t('screens.dex.hint.filterMove')], ['confirm', t('screens.dex.hint.filterSet')], ['down', t('screens.dex.hint.toGrid')], ['cancel', t('screens.hint.back')]]
        : [['confirm', t('screens.dex.hint.open')], ['up', t('screens.dex.hint.toFilters')], ['cancel', t('screens.hint.back')]])
    }

    const paintSide = () => {
      const sp = list[index]
      if (!sp) { side.replaceChildren(el('div', { class: 'aps-empty', text: t('screens.dex.noMatch') })); return }
      const st = dexState(ctx.save, sp.id)
      if (st === 'unseen') {
        side.replaceChildren(
          el('div', 'aps-dex-pv-stage', [el('span', { class: 'aps-dex-unknown is-big', text: t('screens.dex.unknownMark') })]),
          el('div', { class: 'aps-dex-pv-no ap-gold', text: t('screens.common.dexNo', { n: pad3(sp.dexNo) }) }),
          el('div', { class: 'aps-dex-pv-name ap-model-name', text: t('screens.dex.unknownName'), title: t('screens.dex.unknownName') }),
          el('p', { class: 'ap-dim aps-dex-pv-note', text: t('screens.dex.unseenNote') }),
        )
        return
      }
      side.replaceChildren(
        el('div', 'aps-dex-pv-stage', [el('div', 'aps-sum-pedestal'), creatureImg(ctx.assets, sp.id, { silhouette: st === 'seen', className: 'aps-dex-pv-sprite' })]),
        el('div', { class: 'aps-dex-pv-no ap-gold', text: t('screens.common.dexNo', { n: pad3(sp.dexNo) }) }),
        el('div', { class: 'aps-dex-pv-name ap-model-name', text: sp.nameZh, title: sp.nameZh, attrs: { 'aria-label': sp.nameZh } }),
        el('div', { class: 'ap-dim aps-dex-pv-en ap-model-name', text: sp.nameEn, title: sp.nameEn, attrs: { 'aria-label': sp.nameEn } }),
        el('div', 'aps-chips', [...sp.types.map((ty) => typeChip(ty)), rarityBadge(sp.rarity)]),
        el('div', { class: `aps-dex-pv-state is-${st}`, text: t(`screens.dex.state.${st}`) }),
      )
    }

    const activateFilter = (i: number) => api.run(async () => {
      const id = filterIds[i]
      if (id === 'reset') {
        for (const k of Object.keys(filter) as (keyof DexFilter)[]) delete filter[k]
        uiSfx(env, 'confirm')
        refilter(list[index]?.id)
        return
      }
      if (id === 'search') {
        const q = await ctx.ui.prompt(t('screens.dex.searchPrompt'), filter.query ?? '', cfg.searchMaxLen)
        if (q !== null) { filter.query = q; refilter() }
        return
      }
      const all: ListItem = { label: t('screens.dex.all'), value: undefined }
      let opts: ListItem[] = []
      let current: string | undefined
      if (id === 'type') { opts = CONTENT.types.map((x) => ({ label: x.nameZh, value: x.id })); current = filter.type }
      else if (id === 'rarity') { opts = CONTENT.rarities.map((x) => ({ label: x.nameZh, sub: x.id, value: x.id })); current = filter.rarity }
      else if (id === 'country') { opts = cfg.countries.map((x) => ({ label: t(x.label), value: x.id })); current = filter.country }
      else if (id === 'company') { opts = dexCompanies(CONTENT.speciesList, ctx.save, cfg.companiesFromSeenOnly).map((x) => ({ label: x, value: x })); current = filter.company }
      else { opts = cfg.caughtOptions.map((x) => ({ label: t(`screens.dex.caught.${x}`), value: x })); current = filter.caught }
      const items = [all, ...opts]
      const initial = Math.max(0, items.findIndex((x) => x.value === current))
      const pick = await ctx.ui.list(t(`screens.dex.filterTitle.${id}`), items, { initial })
      if (pick < 0) return
      const value = items[pick].value as string | undefined
      if (id === 'caught') filter.caught = value as DexFilter['caught']
      else filter[id] = value
      if (value === undefined) delete filter[id]
      refilter(list[index]?.id)
    })

    const openDetail = () => api.run(async () => {
      const sp = list[index]
      if (!sp) return
      if (dexState(ctx.save, sp.id) === 'unseen') { uiSfx(env, 'error'); return }
      const browsable = list.filter((s) => dexState(ctx.save, s.id) !== 'unseen')
      const at = await dexDetailScreen(env, browsable, Math.max(0, browsable.indexOf(sp)))
      const back = browsable[at]
      if (back) { const k = list.indexOf(back); if (k >= 0) index = k }
      paint()
    })

    const close = () => {
      memory.index = index
      api.close()
    }

    buildPool()
    index = memory.index
    refilter()
    return {
      onInput(input) {
        if (backPressed(input)) {
          if (zone === 'filters') { zone = 'grid'; uiSfx(env, 'cancel'); paint(); return }
          close()
          return
        }
        if (zone === 'filters') {
          if (pressed(input, 'left', true)) { filterFocus = (filterFocus - 1 + filterIds.length) % filterIds.length; uiSfx(env, 'move'); paint() }
          else if (pressed(input, 'right', true)) { filterFocus = (filterFocus + 1) % filterIds.length; uiSfx(env, 'move'); paint() }
          else if (pressed(input, 'down', true)) { zone = 'grid'; uiSfx(env, 'move'); paint() }
          else if (pressed(input, 'up', true)) { /* top edge */ }
          else if (pressed(input, 'confirm')) void activateFilter(filterFocus)
          return
        }
        const c = cols()
        const move = (d: number) => {
          if (!list.length) return
          const next = index + d
          if (next < 0 || next >= list.length) return
          index = next
          uiSfx(env, 'move')
          paint()
        }
        if (pressed(input, 'left', true)) move(-1)
        else if (pressed(input, 'right', true)) move(1)
        else if (pressed(input, 'down', true)) {
          if (index + c < list.length) move(c)
          else if (Math.floor(index / c) < Math.floor((list.length - 1) / c)) move(list.length - 1 - index)
        } else if (pressed(input, 'up', true)) {
          if (index - c >= 0) move(-c)
          else { zone = 'filters'; uiSfx(env, 'move'); paint() }
        } else if (pressed(input, 'confirm')) void openDetail()
      },
    }
  })
}
