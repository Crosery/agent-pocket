// Party screen. view: summary / reorder / nickname via a popup; select & battleSwitch: resolve the picked index
// (filter + fainted rules), -1 on cancel. Cards show icon, level, types, status and an animated HP bar.
import type { Creature } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { creatureName, maxHp } from '../../../shared/creature.ts'
import { gradeOf } from '../../../shared/gameplay/quality.ts'
import { bankLevels, bossCardCap, isBossCard } from '../../../shared/gameplay/bosscard.ts'
import { bossMark, createGridNav, creatureIcon, el, expBar, gradeChip, hpBar, statusChip, typeChip } from '../widgets.ts'
import { onUIScaleChange } from '../scale.ts'
import { backPressed, frame, H, isCompact, openScreen, popupMenu, pressed, sfx, uiSfx, type PartyOptions, type ScreenEnv } from './base.ts'
import { SCREENS } from './config.ts'
import { expProgress, isConscious } from './logic.ts'

export type PartyMode = 'view' | 'select' | 'battleSwitch'

export function partyScreen(env: ScreenEnv, mode: PartyMode, opts?: PartyOptions): Promise<number> {
  const { ctx } = env
  const cfg = SCREENS.party
  return openScreen<number>(env, `aps-party is-${mode}`, (api) => {
    const party = () => ctx.save.party
    let dirty = false
    let swapFrom = -1
    const title = opts?.title ?? t(`screens.party.title.${mode}`)
    const f = frame(env, { title, glyph: 'party', onClose: api.guard(() => back()) })
    const banner = el('div', { class: 'aps-party-banner', attrs: { 'aria-live': 'polite' } })
    const grid = el('div', { class: 'aps-party-grid', attrs: { role: 'listbox', 'aria-label': title } })
    f.body.append(banner, grid)
    api.root.append(f.el)

    const cols = () => (isCompact() ? cfg.compactCols : cfg.cols)
    grid.style.setProperty('--cols', String(cols()))
    const makeNav = (initial = 0) => createGridNav({ count: party().length, cols: cols(), initial, audio: ctx.audio, onChange: () => paintCursor() })
    let nav = makeNav()
    let cards: HTMLElement[] = []

    const blocked = (c: Creature): string | null => {
      if (mode === 'battleSwitch' && !isConscious(c)) return t('screens.party.err.fainted', { name: creatureName(c) })
      if (opts?.filter && !opts.filter(c)) return t('screens.party.err.filtered', { name: creatureName(c) })
      return null
    }

    const card = (c: Creature, i: number): HTMLElement => {
      const sp = CONTENT.species[c.speciesId]
      const mhp = maxHp(c)
      const bar = hpBar({ numbers: true, label: t('screens.common.hp'), width: cfg.hpBarWidth, className: 'aps-party-hp' })
      bar.set(c.hp, mhp)
      const xp = expProgress(c)
      const exp = expBar({ label: t('screens.common.exp'), width: cfg.expBarWidth, className: 'aps-party-exp' })
      exp.set(xp.max ? 1 : xp.into, xp.max ? 1 : xp.need)
      const note = opts?.annotate?.(c, i) ?? null
      const boss = isBossCard(c)
      const bank = boss ? bankLevels(c) : 0
      const disabled = mode !== 'view' && !!blocked(c)
      const node = el('button', {
        class: `aps-party-card aps-card${isConscious(c) ? '' : ' is-fainted'}${disabled ? ' is-disabled' : ''}${i === swapFrom ? ' is-swap' : ''}`,
        attrs: { type: 'button', role: 'option', 'aria-label': creatureName(c) },
      }, [
        el('div', 'aps-party-icon', [creatureIcon(ctx.assets.creatureImageUrl(c.speciesId), c.shiny, cfg.iconSize)]),
        el('div', 'aps-party-main', [
          el('div', 'aps-party-line', [
            el('span', { class: 'aps-party-name ap-model-name', text: creatureName(c), title: creatureName(c), attrs: { 'aria-label': creatureName(c) } }),
            el('span', 'aps-party-lvbox', [
              boss ? bossMark() : null,
              el('span', { class: 'aps-party-lv', text: boss ? t('screens.common.levelCap', { level: c.level, cap: bossCardCap(ctx.save.badges.length) }) : t('screens.common.level', { level: c.level }) }),
              gradeChip(gradeOf(c.ivs).id),
            ]),
          ]),
          el('div', 'aps-party-line', [
            el('span', 'aps-chips', [...(sp?.types ?? []).map((ty) => typeChip(ty)), c.status ? statusChip(c.status) : null,
              bank > 0 ? el('span', { class: 'aps-tag is-bank', text: t('hud.party.bank', { n: bank }) }) : null,
              isConscious(c) ? null : el('span', { class: 'aps-tag is-bad', text: t('screens.party.fainted') })]),
          ]),
          bar.el,
          exp.el,
          note ? el('div', { class: `aps-party-note ${note.ok ? 'is-ok' : 'is-bad'}`, text: note.text }) : null,
        ]),
      ])
      node.addEventListener('mouseenter', api.guard(() => { if (nav.index !== i) { nav.index = i; uiSfx(env, 'move'); paintCursor() } }))
      node.addEventListener('click', api.guard(() => { nav.index = i; paintCursor(); void activate() }))
      return node
    }

    const render = () => {
      const list = party()
      nav.setCount(list.length)
      cards = list.map(card)
      const empties = Array.from({ length: Math.max(0, CONTENT.config.party.maxParty - list.length) }, () =>
        el('div', 'aps-party-card aps-card is-empty', [el('span', { class: 'ap-dim', text: t('screens.party.empty') })]))
      grid.replaceChildren(...cards, ...empties)
      paintCursor()
    }
    const paintCursor = () => {
      cards.forEach((c, k) => { c.classList.toggle('is-active', k === nav.index); c.setAttribute('aria-selected', String(k === nav.index)) })
      cards[nav.index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      banner.textContent = swapFrom >= 0 ? t('screens.party.swapHint', { name: creatureName(party()[swapFrom]) }) : ''
      banner.hidden = swapFrom < 0
      f.setHints(swapFrom >= 0
        ? [['confirm', t('screens.party.hint.swapHere')], ['cancel', t('screens.party.hint.swapCancel')]]
        : [H.select(), H.back()])
    }

    const back = () => {
      if (swapFrom >= 0) { swapFrom = -1; uiSfx(env, 'cancel'); render(); return }
      if (dirty) ctx.persist('party')
      api.close(-1)
    }

    const activate = () => api.run(async () => {
      const list = party()
      const i = nav.index
      const c = list[i]
      if (!c) return
      if (swapFrom >= 0) {
        if (swapFrom !== i) {
          ;[list[swapFrom], list[i]] = [list[i], list[swapFrom]]
          dirty = true
          ctx.events.emit('party:changed', {})
          sfx(env, 'drop')
        }
        swapFrom = -1
        render()
        return
      }
      if (mode !== 'view') {
        const err = blocked(c)
        if (err) { sfx(env, 'error'); ctx.ui.toast(err, 'warn'); return }
        if (dirty) ctx.persist('party')
        api.close(i)
        return
      }
      const entries = cfg.viewMenu.filter((m) => m.id !== 'swap' || list.length > 1)
      const pick = await popupMenu(env, entries.map((m) => ({ label: t(m.label) })), { anchor: cards[i], title: creatureName(c) })
      const id = entries[pick]?.id
      if (id === 'summary') {
        await env.internal.summaryOf(list, i)
        render()
      } else if (id === 'swap') {
        swapFrom = i
        render()
      } else if (id === 'nickname') {
        const sp = CONTENT.species[c.speciesId]
        const name = await ctx.ui.prompt(t('screens.party.nicknamePrompt', { name: sp?.nameZh ?? '' }), creatureName(c), CONTENT.config.net.nameMaxLen)
        if (name !== null) {
          c.nickname = name === sp?.nameZh ? undefined : name
          dirty = true
          ctx.events.emit('party:changed', {})
          render()
        }
      }
    })

    render()
    const offScale = onUIScaleChange(() => {
      grid.style.setProperty('--cols', String(cols()))
      nav = makeNav(nav.index)
      paintCursor()
    })
    return {
      onInput(input) {
        if (backPressed(input)) { back(); return }
        if (pressed(input, 'confirm')) { void activate(); return }
        nav.handle(input)
      },
      dispose: offScale,
    }
  })
}
