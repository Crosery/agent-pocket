// New game: pick an avatar among the playable CONTENT.characters (animated walk previews + portrait), then a name.
import { CONTENT, t } from '../../../shared/content/index.ts'
import { createGridNav, el } from '../widgets.ts'
import { backPressed, frame, H, isCompact, openScreen, pressed, uiSfx, type ScreenEnv } from './base.ts'
import { SCREENS } from './config.ts'
import { createWalker, portraitEl, type Walker } from './sprites.ts'

export function newGameScreen(env: ScreenEnv): Promise<{ name: string; avatar: string } | null> {
  const { ctx } = env
  const chars = CONTENT.characters.filter((c) => c.playable)
  return openScreen<{ name: string; avatar: string } | null>(env, 'aps-newgame', (api) => {
    const f = frame(env, {
      title: t('screens.newGame.title'),
      onClose: api.guard(() => api.close(null)),
      hints: [['lr', t('screens.newGame.hintPick')], H.confirm(), H.back()],
    })
    const portraitBox = el('div', 'aps-ng-portrait')
    const nameEl = el('div', { class: 'aps-ng-name ap-gold' })
    const preview = el('div', 'aps-ng-preview', [portraitBox, el('div', 'aps-ng-caption', [nameEl, el('div', { class: 'ap-dim', text: t('screens.newGame.caption') })])])
    const walkers: Walker[] = []
    const cards = chars.map((c, i) => {
      const w = createWalker(ctx.assets, c.id, { walking: true })
      walkers.push(w)
      const card = el('button', { class: 'aps-ng-card aps-card', attrs: { type: 'button', 'aria-label': c.nameZh } }, [
        el('div', 'aps-ng-stage', [w.el]),
        el('div', { class: 'aps-ng-card-name', text: c.nameZh }),
      ])
      card.addEventListener('mouseenter', api.guard(() => nav.index !== i && select(i, true)))
      card.addEventListener('click', api.guard(() => { select(i, false); void confirm() }))
      return card
    })
    const grid = el('div', { class: 'aps-ng-grid', attrs: { role: 'listbox', 'aria-label': t('screens.newGame.title') } }, cards)
    f.body.append(el('div', 'aps-ng-layout', [preview, grid]))
    api.root.append(f.el)

    const cols = () => Math.max(1, Math.min(chars.length, isCompact() ? SCREENS.newGame.compactCols : SCREENS.newGame.cols))
    grid.style.setProperty('--cols', String(cols()))
    const nav = createGridNav({ count: chars.length, cols: cols(), audio: ctx.audio, onChange: (i) => paint(i) })
    const paint = (i: number) => {
      cards.forEach((c, k) => { c.classList.toggle('is-active', k === i); c.setAttribute('aria-selected', String(k === i)) })
      walkers.forEach((w, k) => w.setWalking(k === i))
      const ch = chars[i]
      if (!ch) return
      nameEl.textContent = ch.nameZh
      portraitBox.replaceChildren(portraitEl(ctx.assets, ch.id, 'aps-ng-portrait-img'))
    }
    const select = (i: number, sound: boolean) => {
      if (i === nav.index) return
      nav.index = i
      if (sound) uiSfx(env, 'move')
      paint(i)
    }
    const confirm = () => api.run(async () => {
      const ch = chars[nav.index]
      if (!ch) return
      const name = await ctx.ui.prompt(t('screens.newGame.namePrompt'), '', CONTENT.config.net.nameMaxLen)
      if (name === null) return
      const ok = await ctx.ui.confirm(t('screens.newGame.confirm', { name, avatar: ch.nameZh }))
      if (ok) api.close({ name, avatar: ch.id })
    })
    paint(nav.index)
    return {
      onInput(input) {
        if (backPressed(input)) { api.close(null); return }
        if (pressed(input, 'confirm')) { void confirm(); return }
        nav.handle(input)
      },
      update(dt) { for (const w of walkers) w.update(dt) },
    }
  })
}
