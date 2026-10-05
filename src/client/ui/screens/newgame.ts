// New game: pick an avatar among the playable CONTENT.characters (animated walk previews + portrait), then a name.
import { CONTENT, t } from '../../../shared/content/index.ts'
import type { Dir } from '../../../shared/types.ts'
import { createGridNav, el } from '../widgets.ts'
import { backPressed, frame, H, isCompact, openScreen, pressed, uiSfx, type ScreenEnv } from './base.ts'
import { onUIScaleChange } from '../scale.ts'
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
    const liveStage = el('div', 'aps-ng-live-stage')
    let previewWalker: Walker | null = null
    let previewDir: Dir = 'down'
    let previewWalking = true
    const directions: Dir[] = ['left', 'up', 'down', 'right']
    const directionButtons = directions.map((dir) => {
      const b = el('button', {
        class: 'ap-btn aps-ng-direction',
        text: t(`screens.newGame.direction.${dir}`),
        attrs: { type: 'button', 'aria-label': t(`screens.newGame.directionLabel.${dir}`), 'aria-pressed': String(dir === previewDir) },
      })
      b.addEventListener('click', api.guard(() => {
        previewDir = dir
        previewWalker?.setDir(dir)
        directionButtons.forEach((btn, k) => btn.setAttribute('aria-pressed', String(directions[k] === dir)))
      }))
      return b
    })
    const motionButton = el('button', {
      class: 'ap-btn aps-ng-motion',
      text: t('screens.newGame.walking'),
      attrs: { type: 'button', 'aria-pressed': 'true' },
    })
    motionButton.addEventListener('click', api.guard(() => {
      previewWalking = !previewWalking
      previewWalker?.setWalking(previewWalking)
      motionButton.setAttribute('aria-pressed', String(previewWalking))
      motionButton.textContent = t(previewWalking ? 'screens.newGame.walking' : 'screens.newGame.standing')
    }))
    const preview = el('div', 'aps-ng-preview', [
      portraitBox,
      el('div', 'aps-ng-caption', [nameEl, el('div', { class: 'ap-dim', text: t('screens.newGame.caption') })]),
      el('div', 'aps-ng-live', [liveStage, el('div', 'aps-ng-preview-controls', [
        el('div', { class: 'aps-ng-directions', attrs: { role: 'group', 'aria-label': t('screens.newGame.previewDirection') } }, directionButtons),
        motionButton,
      ])]),
    ])
    const walkers: Walker[] = []
    const cards = chars.map((c, i) => {
      const w = createWalker(ctx.assets, c.id, { dirs: ['down'], walking: false })
      walkers.push(w)
      const card = el('button', { class: 'aps-ng-card aps-card', attrs: { type: 'button', 'aria-label': c.nameZh } }, [
        el('div', 'aps-ng-stage', [w.el]),
        el('div', { class: 'aps-ng-card-name', text: c.nameZh }),
      ])
      card.addEventListener('mouseenter', api.guard(() => nav.index !== i && select(i, true)))
      card.addEventListener('focus', api.guard(() => select(i, false)))
      card.addEventListener('click', api.guard(() => {
        if (nav.index !== i) select(i, true)
        else void confirm()
      }))
      return card
    })
    const grid = el('div', { class: 'aps-ng-grid', attrs: { role: 'group', 'aria-label': t('screens.newGame.title') } }, cards)
    f.body.append(el('div', 'aps-ng-layout', [preview, grid]))
    api.root.append(f.el)

    const cols = () => Math.max(1, Math.min(chars.length, isCompact() ? SCREENS.newGame.compactCols : SCREENS.newGame.cols))
    grid.style.setProperty('--cols', String(cols()))
    const makeNav = (initial = 0) => createGridNav({ count: chars.length, cols: cols(), initial, audio: ctx.audio, onChange: (i) => paint(i) })
    let nav = makeNav()
    const paint = (i: number) => {
      cards.forEach((c, k) => { c.classList.toggle('is-active', k === i); c.setAttribute('aria-pressed', String(k === i)) })
      walkers.forEach((w, k) => w.setWalking(k === i))
      const ch = chars[i]
      if (!ch) return
      nameEl.textContent = ch.nameZh
      portraitBox.replaceChildren(portraitEl(ctx.assets, ch.id, 'aps-ng-portrait-img'))
      previewWalker = createWalker(ctx.assets, ch.id, { walking: previewWalking })
      previewWalker.setDir(previewDir)
      liveStage.replaceChildren(previewWalker.el)
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
    const offScale = onUIScaleChange(() => {
      if (nav.cols !== cols()) nav = makeNav(nav.index)
      grid.style.setProperty('--cols', String(cols()))
    })
    return {
      onInput(input) {
        if (backPressed(input)) { api.close(null); return }
        if (pressed(input, 'confirm')) {
          const focused = document.activeElement
          if (focused instanceof HTMLButtonElement && api.root.contains(focused) && focused.matches('.aps-ng-direction, .aps-ng-motion, .aps-close')) focused.click()
          else void confirm()
          return
        }
        if (nav.handle(input) === 'move') cards[nav.index]?.focus({ preventScroll: true })
      },
      update(dt) { for (const w of walkers) w.update(dt); previewWalker?.update(dt) },
      dispose() { offScale() },
    }
  })
}
