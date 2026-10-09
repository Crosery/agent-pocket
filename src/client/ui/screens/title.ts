// Title screen: key art (assets.uiUrl, placed by title-art.ts so the cast stays on screen at any aspect) or the
// procedural pixel scene, logo, drifting motes, "press any key", then the main menu from content/screens.json.
// Plays the title music.
import { t } from '../../../shared/content/index.ts'
import pkg from '../../../../package.json' with { type: 'json' }
import { createRowMenu } from '../menu.ts'
import { getUIScale, onUIScaleChange } from '../scale.ts'
import { el } from '../widgets.ts'
import { SCREENS, type TitleChoice } from './config.ts'
import { openScreen, sfx, type ScreenEnv } from './base.ts'
import { placeTitleArt, type Size } from './title-art.ts'
import { createMotes, paintTitleScene } from './title-scene.ts'

export function titleScreen(env: ScreenEnv, hasSave: boolean): Promise<TitleChoice> {
  const { ctx } = env
  const cfg = SCREENS.title
  ctx.audio.playBgm(cfg.music)
  return openScreen<TitleChoice>(env, 'aps-titlescreen', (api) => {
    const artUrl = ctx.assets.uiUrl(cfg.keyArt)
    const pan = cfg.art.pan
    const art = artUrl
      ? el('div', {
        class: 'aps-title-art is-image',
        vars: { '--pan-s': `${SCREENS.anim.artPanSeconds}s`, '--pan-x': `${pan.x * 100}%`, '--pan-y': `${pan.y * 100}%`, '--pan-scale': pan.scale },
      })
      : el('canvas', 'aps-title-art is-procedural')
    if (artUrl) (art as HTMLElement).style.backgroundImage = `url("${artUrl}")`
    // Natural size of the key art, known once decoded; until then CSS `cover` shows it.
    let artSize: Size | null = null
    const placeArt = () => {
      if (!artSize || !art.clientWidth || !art.clientHeight) return
      const p = placeTitleArt(artSize, { w: art.clientWidth, h: art.clientHeight }, cfg.art)
      art.style.backgroundSize = `${p.w}px ${p.h}px`
      art.style.backgroundPosition = `${p.x}px ${p.y}px`
    }
    if (artUrl) {
      const probe = new Image()
      probe.src = artUrl
      probe.decode().then(() => {
        artSize = { w: probe.naturalWidth, h: probe.naturalHeight }
        if (!api.closed) placeArt()
      }, () => { /* keep the CSS cover fallback */ })
    }
    const fx = el('canvas', 'aps-title-fx')
    const logoUrl = ctx.assets.uiUrl(cfg.logo)
    const logo = logoUrl
      ? el('img', { class: 'aps-title-logo-img', attrs: { src: logoUrl, alt: t('screens.title.logo'), draggable: 'false' } })
      : el('div', 'aps-title-logo-text', [
        el('div', { class: 'aps-title-logo-main', text: t('screens.title.logo') }),
        el('div', { class: 'aps-title-logo-sub', text: t('screens.title.subtitle') }),
      ])
    const press = el('div', { class: 'aps-title-press', text: t(document.documentElement.dataset.touchControls === 'on' ? 'screens.title.pressTouch' : 'screens.title.press'), vars: { '--blink-ms': `${SCREENS.anim.pressBlinkMs}ms` } })
    const entries = cfg.menu.filter((m) => !m.needsSave || hasSave)
    const menu = createRowMenu(entries.map((m) => ({ label: t(m.label) })), {
      visibleRows: entries.length,
      wrap: true,
      audio: ctx.audio,
      onPick: api.guard((i: number) => pick(i)),
    })
    const menuWin = el('nav', { class: 'aps-title-menu ap-panel', attrs: { 'aria-label': t('screens.title.menuLabel') } }, [menu.el])
    menuWin.hidden = true
    const online = el('span', 'aps-title-online')
    const foot = el('div', 'aps-title-foot', [
      el('span', { text: t('screens.title.version', { v: pkg.version }) }),
      online,
    ])
    const vg = cfg.vignette
    const vignette = el('div', {
      class: 'aps-title-vignette',
      vars: {
        '--vig-w': `${vg.ellipse[0]}%`, '--vig-h': `${vg.ellipse[1]}%`, '--vig-x': `${vg.ellipse[2]}%`, '--vig-y': `${vg.ellipse[3]}%`,
        '--vig-clear': `${vg.clearTo * 100}%`, '--vig-corner': vg.corner, '--vig-top': vg.top, '--vig-top-to': `${vg.topTo * 100}%`,
        '--vig-bottom-from': `${vg.bottomFrom * 100}%`, '--vig-bottom': vg.bottom,
      },
    })
    api.root.style.setProperty('--logo-units', String(cfg.logoSize.units))
    api.root.style.setProperty('--logo-vw', `${cfg.logoSize.maxVw}vw`)
    api.root.append(
      art, fx, vignette,
      el('div', 'aps-title-center', [el('div', 'aps-title-logo', [logo]), press, menuWin]),
      foot,
    )

    const motes = createMotes(fx, cfg.particles)
    const layout = () => {
      const s = getUIScale()
      motes.resize(s.unitsW, s.unitsH)
      if (!artUrl) paintTitleScene(art as HTMLCanvasElement, s.unitsW / 2, s.unitsH / 2, cfg.scene)
      else placeArt()
    }
    layout()
    const offScale = onUIScaleChange(layout)

    const refreshOnline = () => {
      const st = ctx.net.status
      online.dataset.status = st
      online.textContent = st === 'online' ? t('screens.title.online', { n: ctx.net.online }) : t(`screens.title.net.${st}`)
    }
    refreshOnline()
    const offNet = ctx.events.on('net:status', refreshOnline)
    let onlineTimer = 0

    let phase: 'press' | 'menu' = 'press'
    const toMenu = () => {
      if (phase !== 'press') return
      phase = 'menu'
      ctx.audio.unlock()
      sfx(env, 'press')
      press.hidden = true
      menuWin.hidden = false
      menuWin.classList.add('ap-anim-in')
    }
    const anyKey = (e: Event) => {
      if (phase !== 'press' || api.closed) return
      if (e instanceof KeyboardEvent && (e.repeat || e.isComposing)) return
      // Defer to the next frame so the same key cannot also activate the menu.
      requestAnimationFrame(toMenu)
    }
    window.addEventListener('keydown', anyKey)
    api.root.addEventListener('pointerdown', anyKey)

    const pick = (i: number) => {
      if (phase !== 'menu') return
      sfx(env, 'start')
      api.close(entries[i].id)
    }

    return {
      onInput(input) {
        if (phase === 'press') {
          for (const a of ['confirm', 'cancel', 'menu'] as const) {
            if (input.pressed(a)) { input.consume(a); toMenu(); return }
          }
          return
        }
        if (menu.handleInput(input) === 'confirm') pick(menu.index)
      },
      update(dt) {
        motes.update(dt)
        onlineTimer += dt
        if (onlineTimer > 1) { onlineTimer = 0; refreshOnline() }
      },
      dispose() {
        offScale()
        offNet()
        window.removeEventListener('keydown', anyKey)
      },
    }
  })
}
