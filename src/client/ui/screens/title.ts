// Title screen: key art (assets.uiUrl, placed by title-art.ts so the cast stays on screen at any aspect) or the
// procedural pixel scene, logo, drifting motes, "press any key", then the main menu from content/screens.json.
// Plays the title music.
import type { SaveData } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import pkg from '../../../../package.json' with { type: 'json' }
import { createRowMenu } from '../menu.ts'
import { getUIScale, onUIScaleChange } from '../scale.ts'
import { button, el, panel } from '../widgets.ts'
import { SCREENS, type TitleChoice } from './config.ts'
import { backPressed, infoRow, moneyEl, openScreen, sfx, type ScreenEnv } from './base.ts'
import { placeTitleArt, type Size } from './title-art.ts'
import { createMotes, paintTitleScene } from './title-scene.ts'
import { portraitEl } from './sprites.ts'

const ACCOUNT_AVATARS = ['hero_boy', 'hero_girl', 'hero_hacker', 'hero_engineer', 'hero_ranger', 'hero_idol'] as const
export function titleScreen(
  env: ScreenEnv,
  hasSave: boolean,
  session?: { account: { id: string; username: string }; save: SaveData | null } | null,
  onSwitchAccount?: () => void,
): Promise<TitleChoice> {
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
    const mainEntries = cfg.menu
    const spConfig = cfg.singleplayerMenu ?? [
      { id: 'continue', label: 'screens.title.menu.continue', needsSave: true },
      { id: 'new', label: 'screens.title.menu.new' },
      { id: 'import', label: 'screens.title.menu.import' },
      { id: 'back', label: 'screens.title.menu.back' },
    ]
    const spEntries = spConfig.filter((m) => !m.needsSave || hasSave)

    let phase: 'press' | 'main' | 'singleplayer' = 'press'

    const mainMenu = createRowMenu(mainEntries.map((m) => ({ label: t(m.label) })), {
      visibleRows: mainEntries.length,
      wrap: true,
      audio: ctx.audio,
      onPick: api.guard((i: number) => pickMain(i)),
    })

    const spMenu = createRowMenu(spEntries.map((m) => ({ label: t(m.label) })), {
      visibleRows: spEntries.length,
      wrap: true,
      audio: ctx.audio,
      onPick: api.guard((i: number) => pickSP(i)),
    })

    const menuWin = el('nav', { class: 'aps-title-menu ap-panel', attrs: { 'aria-label': t('screens.title.menuLabel') } }, [mainMenu.el])
    menuWin.hidden = true
    const online = el('span', 'aps-title-online')
    let rightFooter: HTMLElement = online
    if (session?.account) {
      const acc = session.account
      const save = session.save
      const storageKey = `ap_account_avatar_${acc.username}`
      let hash = 0
      for (let i = 0; i < acc.username.length; i++) hash = ((hash << 5) - hash + acc.username.charCodeAt(i)) | 0
      const fallbackAvatar = ACCOUNT_AVATARS[Math.abs(hash) % ACCOUNT_AVATARS.length]
      const pickInitialAvatar = (): string => {
        try {
          const saved = localStorage.getItem(storageKey)
          if (saved && CONTENT.characterById[saved]?.portrait) return saved
        } catch { /* ignore */ }
        if (save?.avatar && CONTENT.characterById[save.avatar]?.portrait) return save.avatar
        return fallbackAvatar
      }
      let currentAvatarId = pickInitialAvatar()

      const badgeAvatarWrap = el('div', 'aps-title-account-portrait', [
        portraitEl(ctx.assets, currentAvatarId, 'aps-title-account-avatar-img'),
      ])
      const nameSpan = el('span', { class: 'aps-title-account-name', text: acc.username })
      const accountBadge = el('div', {
        class: 'aps-title-account',
        attrs: { role: 'button', tabindex: '0', 'aria-label': '账号信息' },
        on: {
          click: (e) => {
            e.stopPropagation()
            openAccountDetails()
          },
        },
      }, [
        badgeAvatarWrap,
        nameSpan,
      ])
      rightFooter = accountBadge

      const openAccountDetails = () => {
        sfx(env, 'press')
        const p = panel('账号信息', { className: 'aps-account-modal-panel ap-anim-in' })
        const modalBackdrop = el('div', {
          class: 'aps-account-modal-backdrop',
          attrs: { role: 'dialog', 'aria-modal': 'true' },
          on: {
            click: (e) => { if (e.target === modalBackdrop) closeModal() },
            keydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeModal() } },
          },
        }, [p.el])

        const closeModal = () => {
          sfx(env, 'press')
          modalBackdrop.remove()
        }

        const bigAvatarBox = el('div', 'aps-pc-avatar', [
          portraitEl(ctx.assets, currentAvatarId, 'aps-pc-portrait'),
        ])
        const classTitle = el('div', {
          class: 'aps-pc-class ap-dim',
          text: CONTENT.characterById[currentAvatarId]?.nameZh ?? '训练家',
        })

        const head = el('div', 'aps-account-modal-head', [
          bigAvatarBox,
          el('div', 'aps-pc-id', [
            el('div', { class: 'aps-pc-name', text: acc.username }),
            classTitle,
          ]),
        ])

        const avatarOptionBtns = ACCOUNT_AVATARS.map((id) => {
          const btn = el('button', {
            class: `aps-account-avatar-opt${id === currentAvatarId ? ' is-active' : ''}`,
            attrs: { type: 'button', title: CONTENT.characterById[id]?.nameZh ?? id },
            on: {
              click: () => {
                sfx(env, 'pick')
                currentAvatarId = id
                try { localStorage.setItem(storageKey, id) } catch { /* ignore */ }
                bigAvatarBox.replaceChildren(portraitEl(ctx.assets, id, 'aps-pc-portrait'))
                badgeAvatarWrap.replaceChildren(portraitEl(ctx.assets, id, 'aps-title-account-avatar-img'))
                classTitle.textContent = CONTENT.characterById[id]?.nameZh ?? '训练家'
                avatarOptionBtns.forEach((b, idx) => b.classList.toggle('is-active', ACCOUNT_AVATARS[idx] === id))
              },
            },
          }, [
            portraitEl(ctx.assets, id, 'aps-account-avatar-opt-img'),
          ])
          return btn
        })

        const avatarPicker = el('div', 'aps-account-avatar-picker', [
          el('div', { class: 'aps-account-avatar-label', text: '形象头像' }),
          el('div', 'aps-account-avatar-grid', avatarOptionBtns),
        ])

        const infoRows = el('div', 'aps-account-modal-rows', save ? [
          infoRow('角色名称', save.name),
          infoRow('Token 币', moneyEl(save.money)),
          infoRow('同行智灵', `${save.party.length} / 6`),
          infoRow('道馆徽章', `${save.badges.length} / 8`),
        ] : [
          infoRow('角色状态', '尚未创建角色'),
        ])

        const logoutBtn = button('切换账号', () => {
          closeModal()
          onSwitchAccount?.()
        }, { className: 'aps-account-modal-logout' })
        const closeBtn = button('关 闭', () => closeModal(), { primary: true })

        p.body.append(head, avatarPicker, infoRows, el('div', 'aps-account-modal-btns', [logoutBtn, closeBtn]))
        api.root.append(modalBackdrop)
        requestAnimationFrame(() => closeBtn.focus())
      }
    }

    const foot = el('div', 'aps-title-foot', [
      el('span', { text: t('screens.title.version', { v: pkg.version }) }),
      rightFooter,
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

    const toMenu = () => {
      if (phase !== 'press') return
      phase = 'main'
      ctx.audio.unlock()
      sfx(env, 'press')
      press.hidden = true
      menuWin.hidden = false
      menuWin.replaceChildren(mainMenu.el)
      mainMenu.setIndex(0, false)
      menuWin.classList.add('ap-anim-in')
    }
    const anyKey = (e: Event) => {
      if (phase !== 'press' || api.closed) return
      if (e instanceof KeyboardEvent && (e.repeat || e.isComposing)) return
      requestAnimationFrame(toMenu)
    }
    window.addEventListener('keydown', anyKey)
    api.root.addEventListener('pointerdown', anyKey)

    const backToMain = () => {
      sfx(env, 'press')
      phase = 'main'
      menuWin.replaceChildren(mainMenu.el)
      mainMenu.setIndex(0, false)
    }

    const pickMain = (i: number) => {
      if (phase !== 'main') return
      const chosen = mainEntries[i].id
      if (chosen === 'singleplayer') {
        sfx(env, 'press')
        phase = 'singleplayer'
        menuWin.replaceChildren(spMenu.el)
        spMenu.setIndex(0, false)
        return
      }
      sfx(env, 'start')
      api.close(chosen)
    }

    const pickSP = (i: number) => {
      if (phase !== 'singleplayer') return
      const chosen = spEntries[i].id
      if (chosen === 'back') {
        backToMain()
        return
      }
      sfx(env, 'start')
      api.close(chosen)
    }

    return {
      onInput(input) {
        if (phase === 'press') {
          for (const a of ['confirm', 'cancel', 'menu'] as const) {
            if (input.pressed(a)) { input.consume(a); toMenu(); return }
          }
          return
        }
        if (phase === 'main') {
          if (mainMenu.handleInput(input) === 'confirm') pickMain(mainMenu.index)
        } else if (phase === 'singleplayer') {
          if (backPressed(input)) {
            backToMain()
            return
          }
          if (spMenu.handleInput(input) === 'confirm') pickSP(spMenu.index)
        }
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
