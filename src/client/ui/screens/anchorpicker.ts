// Teleport-anchor picker: opened from an activated anchor. "回原点" on top, then the activated anchors grouped by
// area (a tab per area, nearest first) with distance and a detail pane. Picking asks for confirmation and
// resolves the anchor id; the game does the travelling (game.ts anchorTravelTo).
import { t } from '../../../shared/content/index.ts'
import { anchorSpotFromId } from '../../../shared/world/anchors.ts'
import { travelDestinations, type DestKind, type TravelDest } from '../../world/anchors.ts'
import { EXPLORE } from '../../world/explore-config.ts'
import { createRowMenu, type RowMenu } from '../menu.ts'
import { getUIScale } from '../scale.ts'
import { button, el, tabs } from '../widgets.ts'
import { backPressed, frame, icon, infoRow, isCompact, keepTabVisible, openScreen, pressed, sectionTitle, setChildren, type ScreenEnv } from './base.ts'
import { SCREENS } from './config.ts'
import { overworldPosition } from './logic.ts'

const WM = EXPLORE.worldMap

const glyphOf = (kind: DestKind): string => (kind === 'grand' || kind === 'home' ? WM.anchorGlyphs.grand : WM.anchorGlyphs.minor)

export function anchorPickerScreen(env: ScreenEnv, opts: { hereId?: string }): Promise<string | null> {
  const { ctx } = env
  const world = ctx.data.world
  const here = opts.hereId ? anchorSpotFromId(opts.hereId) : null
  const at = here ? { x: here.cx, y: here.cy } : overworldPosition(world, ctx.overworld.player.map, ctx.overworld.player.x, ctx.overworld.player.y) ?? world.maps[world.startMap].spawn
  const list = travelDestinations(world, ctx.save, at, opts.hereId)
  if (!list.count) {
    ctx.ui.toast(t('screens.anchor.empty'), 'warn')
    return Promise.resolve(null)
  }

  return openScreen<string | null>(env, 'aps-anchor', (api) => {
    const f = frame(env, { title: t('screens.anchor.title'), glyph: WM.anchorGlyphs.grand, onClose: api.guard(() => api.close(null)) })
    f.right.append(el('span', { class: 'aps-tag', text: t('screens.anchor.count', { count: list.count }) }))
    const left = el('div', 'aps-bag-left')
    const detail = el('div', 'aps-bag-detail ap-panel')
    f.body.append(el('div', 'aps-bag-layout', [left, detail]))
    api.root.append(f.el)

    let group = 0
    let menu: RowMenu | null = null
    let shown: TravelDest[] = []

    const pick = (dest: TravelDest | null) => {
      if (!dest || dest.here) return
      void api.run(async () => {
        if (await ctx.ui.confirm(t('screens.anchor.confirm', { name: dest.name }))) api.close(dest.id)
      })
    }

    const homeBtn = list.home
      ? button('', api.guard(() => pick(list.home)), { className: 'aps-anchor-home' })
      : null
    if (homeBtn && list.home) {
      homeBtn.append(
        icon(glyphOf('home'), { className: 'aps-anchor-home-icon' }),
        el('span', 'aps-anchor-home-text', [
          el('span', { class: 'aps-anchor-home-name ap-gold', text: t('screens.anchor.home') }),
          el('span', { class: 'ap-dim', text: t('screens.anchor.homeSub') }),
        ]),
        el('span', { class: 'aps-anchor-home-dist ap-dim', text: t('screens.anchor.distance', { distance: Math.round(list.home.dist) }) }),
      )
    }
    const tabBar = tabs(list.groups.map((g) => g.region), {
      audio: ctx.audio,
      onChange: (i) => { group = i; rebuild(0); keepTabVisible(tabBar.el, i) },
    })
    const listBox = el('div', 'aps-bag-list ap-panel')
    left.append(...(homeBtn ? [homeBtn] : []), ...(list.groups.length ? [tabBar.el, listBox] : []))

    let hintDevice = ctx.input.lastDevice
    const paintHints = () => {
      hintDevice = ctx.input.lastDevice
      if (hintDevice === 'touch') { f.setHints([]); return }
      f.setHints([
        ['ud', t('screens.hint.choose')],
        ...(list.groups.length > 1 ? [['lr', t('screens.hint.tabs')] as ['lr', string]] : []),
        ['confirm', t('screens.hint.confirm')],
        ...(list.home ? [['run', t('screens.anchor.home')] as ['run', string]] : []),
        ['cancel', t('screens.hint.back')],
      ])
    }

    const paintDetail = (dest: TravelDest | null) => {
      if (!dest) {
        setChildren(detail, [el('div', { class: 'aps-empty', text: t('screens.anchor.empty') })])
        return
      }
      setChildren(detail, [
        el('div', 'aps-item-head', [
          el('div', 'aps-item-icon', [icon(glyphOf(dest.kind))]),
          el('div', 'aps-item-title', [
            el('div', { class: 'aps-item-name ap-gold', text: dest.name }),
            el('div', 'aps-chips', [
              el('span', { class: `aps-tag${dest.kind === 'grand' || dest.kind === 'home' ? ' is-main' : ''}`, text: t(`screens.anchor.${dest.kind === 'home' ? 'grand' : dest.kind}`) }),
              dest.here ? el('span', { class: 'aps-tag is-ok', text: t('screens.anchor.here') }) : null,
            ]),
          ]),
        ]),
        sectionTitle(t('screens.anchor.detail')),
        infoRow(t('screens.anchor.region'), dest.region),
        infoRow(t('screens.anchor.away'), dest.here ? t('screens.anchor.here') : t('screens.anchor.distance', { distance: Math.round(dest.dist) })),
      ])
    }

    const rebuild = (keep: number) => {
      shown = list.groups[group]?.items ?? []
      const rows = isCompact() ? SCREENS.anchors.compactVisibleRows : SCREENS.anchors.visibleRows
      menu = createRowMenu(shown.map((d) => ({
        label: d.name,
        sub: d.here ? t('screens.anchor.here') : t('screens.anchor.distance', { distance: Math.round(d.dist) }),
        disabled: d.here,
      })), {
        visibleRows: rows,
        reservePx: (list.home ? SCREENS.anchors.padFreeReserveUnits.home : SCREENS.anchors.padFreeReserveUnits.base) * getUIScale().cssPerUnit,
        padFree: true,
        initial: Math.min(keep, Math.max(0, shown.length - 1)),
        wrap: true,
        audio: ctx.audio,
        onChange: (i) => paintDetail(shown[i] ?? null),
        onPick: api.guard((i: number) => pick(shown[i] ?? null)),
      })
      menu.el.querySelectorAll<HTMLElement>('.ap-row').forEach((row, i) => {
        row.prepend(icon(glyphOf(shown[i].kind), { className: 'aps-anchor-row-icon' }))
      })
      listBox.replaceChildren(menu.el)
      paintDetail(shown[menu.index] ?? null)
    }

    paintHints()
    if (list.groups.length) rebuild(0)
    else paintDetail(list.home)
    return {
      update() { if (ctx.input.lastDevice !== hintDevice) paintHints() },
      onInput(input) {
        if (backPressed(input)) { api.close(null); return }
        if (pressed(input, 'run') && list.home) { pick(list.home); return }
        if (list.groups.length > 1) {
          if (pressed(input, 'left', true)) { tabBar.prev(); return }
          if (pressed(input, 'right', true)) { tabBar.next(); return }
        }
        if (menu?.handleInput(input) === 'confirm') pick(shown[menu.index] ?? null)
        else if (!menu && pressed(input, 'confirm')) pick(list.home)
      },
    }
  })
}
