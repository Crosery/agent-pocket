// Pause menu: player card (avatar, name, money, play time, dex, badges, location) + menu entries from
// content/screens.json. Also hosts the badge case (opened from the key item or the card's badge row).
import type { BadgeDef } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { getMap, regionAt } from '../../../shared/world/worldapi.ts'
import { parseColor, shade } from '../pixel.ts'
import { createGridNav, el, keyHint, typeChip } from '../widgets.ts'
import { onUIScaleChange } from '../scale.ts'
import { backPressed, frame, H, icon, infoRow, isCompact, moneyEl, openScreen, pressed, sfx, uiSfx, type ScreenEnv } from './base.ts'
import { SCREENS } from './config.ts'
import { dexCounts, playTimeParts } from './logic.ts'
import { intelScreen } from './intel.ts'
import { researchScreen } from './research.ts'
import { portraitEl } from './sprites.ts'

const css = (c: [number, number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`

/** Diamond glyph tinted with the badge's type colour (dim when not earned). */
function badgeIcon(b: BadgeDef, earned: boolean, className?: string): HTMLElement {
  const base = parseColor(CONTENT.typeById[b.type]?.color ?? SCREENS.worldMap.unvisitedPalette.g)
  const pal = earned
    ? { h: css(shade(base, SCREENS.badges.tintLight)), g: css(base), d: css(shade(base, SCREENS.badges.tintDark)) }
    : SCREENS.worldMap.unvisitedPalette
  return icon(SCREENS.worldMap.townGlyph, { palette: pal, className })
}

function playerCard(env: ScreenEnv): HTMLElement {
  const { ctx } = env
  const s = ctx.save
  const world = ctx.data.world
  const dc = dexCounts(s)
  const pt = playTimeParts(s.playTimeSec)
  const map = getMap(world, ctx.overworld.player.map)
  const region = map ? regionAt(map, ctx.overworld.player.x, ctx.overworld.player.y) : null
  const place = map ? (region && region.nameZh !== map.nameZh && map.kind === 'overworld' ? t('screens.pause.place', { map: map.nameZh, region: region.nameZh }) : map.nameZh) : t('screens.common.dash')
  const earned = new Set(s.badges)
  return el('section', { class: 'aps-pause-card ap-panel', attrs: { 'aria-label': t('screens.pause.card') } }, [
    el('div', 'aps-pc-top', [
      el('div', 'aps-pc-avatar', [portraitEl(ctx.assets, s.avatar, 'aps-pc-portrait')]),
      el('div', 'aps-pc-id', [
        el('div', { class: 'aps-pc-name', text: s.name }),
        el('div', { class: 'aps-pc-class ap-dim', text: CONTENT.characterById[s.avatar]?.nameZh ?? '' }),
        el('div', { class: 'aps-pc-place', text: place }),
      ]),
    ]),
    el('div', 'aps-pc-rows', [
      infoRow(t('screens.pause.money'), moneyEl(s.money)),
      infoRow(t('screens.pause.playTime'), t('screens.common.playTime', pt)),
      infoRow(t('screens.pause.dex'), t('screens.pause.dexValue', { caught: dc.caught, seen: dc.seen })),
      infoRow(t('screens.pause.badges'), t('screens.pause.badgeValue', { n: s.badges.length, total: world.badges.length })),
    ]),
    world.badges.length ? el('div', 'aps-pc-badges', world.badges.map((b) => badgeIcon(b, earned.has(b.id), 'aps-pc-badge'))) : null,
  ])
}

export function pauseScreen(env: ScreenEnv): Promise<void> {
  const { ctx } = env
  const entries = SCREENS.pause.entries
  ctx.audio.setMuffled(true)
  return openScreen<void>(env, 'aps-pause', (api) => {
    const f = frame(env, { title: t('screens.pause.heading'), onClose: api.guard(() => api.close()), hints: ctx.input.lastDevice === 'touch' ? [] : [H.select(), H.back()] })
    const clock = el('div', 'aps-pause-clock')
    f.right.append(clock)
    const cardSlot = el('div', 'aps-pause-cardslot')
    const detailTitle = el('div', 'aps-pause-detail-title')
    const detailText = el('p', 'aps-pause-detail-text')
    const detailHint = el('div', 'aps-pause-detail-hint', [keyHint('confirm', { label: t('screens.hint.select'), device: ctx.input.lastDevice })])
    const detail = el('section', { class: 'aps-pause-detail', attrs: { 'aria-live': 'polite' } }, [detailTitle, detailText, detailHint])
    const enabled = (i: number) => entries[i].requires !== 'party' || ctx.save.party.length > 0
    const rowsEl = entries.map((e, i) => {
      const r = el('button', { class: 'aps-pause-row ap-row ap-cursor-host', attrs: { type: 'button' } }, [
        e.glyph ? icon(e.glyph, { className: 'aps-pause-icon' }) : null,
        el('span', { class: 'ap-row-label', text: t(e.label) }),
      ])
      r.addEventListener('mouseenter', api.guard(() => { if (nav.index !== i) { nav.index = i; uiSfx(env, 'move'); paint() } }))
      r.addEventListener('focus', api.guard(() => { nav.index = i; paint() }))
      r.addEventListener('click', api.guard(() => { nav.index = i; paint(); void activate(i) }))
      return r
    })
    const menu = el('nav', { class: 'aps-pause-menu ap-panel', attrs: { 'aria-label': t('screens.pause.heading') } }, rowsEl)
    f.body.append(el('div', 'aps-pause-layout', [cardSlot, menu]))
    api.root.append(f.el)

    const makeNav = (initial = 0) => createGridNav({ count: entries.length, cols: isCompact() ? 2 : 1, initial, audio: ctx.audio, onChange: () => paint() })
    let nav = makeNav()
    const paint = () => {
      rowsEl.forEach((r, i) => {
        r.classList.toggle('is-active', i === nav.index)
        r.classList.toggle('is-disabled', !enabled(i))
        r.setAttribute('aria-disabled', String(!enabled(i)))
        if (i === nav.index) r.setAttribute('aria-current', 'true')
        else r.removeAttribute('aria-current')
      })
      const e = entries[nav.index]
      detailTitle.replaceChildren(...(e.glyph ? [icon(e.glyph)] : []), t(e.label))
      detailText.textContent = enabled(nav.index) ? t(`screens.pause.description.${e.action}`) : t('screens.pause.noParty')
      detailHint.hidden = !enabled(nav.index) || ctx.input.lastDevice === 'touch'
    }
    const refresh = () => {
      cardSlot.replaceChildren(playerCard(env), detail)
      clock.textContent = t('screens.pause.clock', { time: ctx.clock.label(), tod: t(`hud.tod.${ctx.clock.timeOfDay}`) })
      paint()
    }

    const activate = (i: number) => api.run(async () => {
      const e = entries[i]
      if (!enabled(i)) { sfx(env, 'error'); ctx.ui.toast(t('screens.pause.noParty'), 'warn'); return }
      switch (e.action) {
        case 'dex': await env.screens.dex(); break
        case 'party': await env.screens.party('view'); break
        case 'bag': await env.screens.bag('field'); break
        case 'map': await env.screens.worldMap({ fly: false }); break
        case 'quests': await env.screens.quests(); break
        case 'research': await researchScreen(env); break
        case 'intel': await intelScreen(env); break
        case 'manual': await env.screens.manual(); break
        case 'online': ctx.events.emit('screen:opened', { screen: 'online' }); await env.screens.online(); break
        case 'settings': await env.screens.settings(); break
        case 'save':
          if (await ctx.ui.confirm(t('screens.pause.saveConfirm'))) {
            ctx.persist('manual')
            sfx(env, 'save')
            ctx.ui.toast(t('screens.pause.saved'), 'success')
          }
          break
        case 'title':
          if (await ctx.ui.confirm(t('screens.pause.titleConfirm'))) {
            api.close()
            const ev = new CustomEvent(SCREENS.pause.titleEvent, { cancelable: true })
            if (window.dispatchEvent(ev)) location.reload()
            return
          }
          break
      }
      refresh()
    })

    refresh()
    const offScale = onUIScaleChange(() => {
      const cols = isCompact() ? 2 : 1
      if (nav.cols !== cols) nav = makeNav(nav.index)
    })
    return {
      onInput(input) {
        if (backPressed(input)) { api.close(); return }
        if (pressed(input, 'confirm')) {
          const focused = document.activeElement
          if (focused instanceof HTMLButtonElement && api.root.contains(focused) && focused.matches('.aps-close')) focused.click()
          else void activate(nav.index)
          return
        }
        if (nav.handle(input) === 'move') rowsEl[nav.index]?.focus({ preventScroll: true })
      },
      update() {
        clock.textContent = t('screens.pause.clock', { time: ctx.clock.label(), tod: t(`hud.tod.${ctx.clock.timeOfDay}`) })
      },
      dispose() { offScale(); ctx.audio.setMuffled(false) },
    }
  }, () => undefined)
}

export function badgeCaseScreen(env: ScreenEnv): Promise<void> {
  const { ctx } = env
  const world = ctx.data.world
  return openScreen<void>(env, 'aps-badges', (api) => {
    const f = frame(env, { title: t('screens.badges.title'), onClose: api.guard(() => api.close()), hints: [['lr', t('screens.hint.choose')], H.back()] })
    const earned = new Set(ctx.save.badges)
    const cards = world.badges.map((b) => {
      const got = earned.has(b.id)
      const town = world.towns.find((x) => x.id === b.town)
      return el('div', `aps-badge-card aps-card${got ? ' is-earned' : ''}`, [
        badgeIcon(b, got, 'aps-badge-big'),
        el('div', { class: 'aps-badge-name', text: got ? b.nameZh : t('screens.badges.locked') }),
        el('div', 'aps-chips', [typeChip(b.type)]),
        el('div', { class: 'ap-dim aps-badge-sub', text: t('screens.badges.town', { town: town?.nameZh ?? t('screens.common.dash') }) }),
        el('div', { class: 'ap-dim aps-badge-sub', text: t('screens.badges.leader', { leader: CONTENT.characterById[b.leader]?.nameZh ?? t('screens.common.dash') }) }),
      ])
    })
    f.right.append(el('span', { class: 'ap-gold', text: t('screens.pause.badgeValue', { n: ctx.save.badges.length, total: world.badges.length }) }))
    f.body.append(cards.length ? el('div', 'aps-badge-grid', cards) : el('div', { class: 'aps-empty', text: t('screens.badges.none') }))
    api.root.append(f.el)
    const cols = isCompact() ? SCREENS.badges.compactCols : SCREENS.badges.cols
    const grid = api.root.querySelector<HTMLElement>('.aps-badge-grid')
    grid?.style.setProperty('--cols', String(cols))
    const nav = createGridNav({ count: cards.length, cols, audio: ctx.audio, onChange: () => paint() })
    const paint = () => cards.forEach((c, i) => c.classList.toggle('is-active', i === nav.index))
    paint()
    return {
      onInput(input) {
        if (backPressed(input)) { api.close(); return }
        nav.handle(input)
      },
    }
  }, () => undefined)
}
