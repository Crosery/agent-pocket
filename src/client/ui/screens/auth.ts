// Account login & registration screen, and first-time character binding dialog.
import { t } from '../../../shared/content/index.ts'
import pkg from '../../../../package.json' with { type: 'json' }
import { getUIScale, onUIScaleChange } from '../scale.ts'
import { button, el, panel, tabs } from '../widgets.ts'
import { backPressed, frame, H, openScreen, pressed, sfx, uiSfx, type ScreenEnv } from './base.ts'
import { SCREENS } from './config.ts'
import { placeTitleArt, type Size } from './title-art.ts'
import { createMotes, paintTitleScene } from './title-scene.ts'
import {
  loginAccount, registerAccount, validatePassword, validateUsername,
  type AccountSessionResult,
} from '../../net/auth.ts'
import type { ServerEntry } from '../../net/servers.ts'

export function accountAuthScreen(
  env: ScreenEnv,
  server: ServerEntry,
  httpBase: string,
  opts?: { required?: boolean },
): Promise<AccountSessionResult | null> {
  const { ctx } = env
  const cfg = SCREENS.title
  const required = !!opts?.required
  ctx.audio.playBgm(cfg.music)
  return openScreen<AccountSessionResult | null>(env, 'aps-auth', (api) => {
    let mode: 'login' | 'register' = 'login'
    let showPassword = false

    const artUrl = ctx.assets.uiUrl(cfg.keyArt)
    const pan = cfg.art.pan
    const art = artUrl
      ? el('div', {
        class: 'aps-title-art is-image aps-auth-bg-art',
        vars: { '--pan-s': `${SCREENS.anim.artPanSeconds}s`, '--pan-x': `${pan.x * 100}%`, '--pan-y': `${pan.y * 100}%`, '--pan-scale': pan.scale },
      })
      : el('canvas', 'aps-title-art is-procedural aps-auth-bg-art')
    if (artUrl) (art as HTMLElement).style.backgroundImage = `url("${artUrl}")`
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
      }, () => {})
    }
    const fx = el('canvas', 'aps-title-fx')
    const vg = cfg.vignette
    const vignette = el('div', {
      class: 'aps-title-vignette aps-auth-vignette',
      vars: {
        '--vig-w': `${vg.ellipse[0]}%`, '--vig-h': `${vg.ellipse[1]}%`, '--vig-x': `${vg.ellipse[2]}%`, '--vig-y': `${vg.ellipse[3]}%`,
        '--vig-clear': `${vg.clearTo * 100}%`, '--vig-corner': vg.corner, '--vig-top': vg.top, '--vig-top-to': `${vg.topTo * 100}%`,
        '--vig-bottom-from': `${vg.bottomFrom * 100}%`, '--vig-bottom': vg.bottom,
      },
    })
    const motes = createMotes(fx, cfg.particles)
    const layout = () => {
      const s = getUIScale()
      motes.resize(s.unitsW, s.unitsH)
      if (!artUrl) paintTitleScene(art as HTMLCanvasElement, s.unitsW / 2, s.unitsH / 2, cfg.scene)
      else placeArt()
    }
    layout()
    const offScale = onUIScaleChange(layout)

    // Full-screen title-style layout without top bar
    const logoUrl = ctx.assets.uiUrl(cfg.logo)
    const logoNode = logoUrl
      ? el('img', { class: 'aps-auth-logo-img', attrs: { src: logoUrl, alt: t('screens.title.logo'), draggable: 'false' } })
      : el('div', { class: 'aps-auth-logo-text', text: t('screens.title.logo') })

    const hero = el('div', 'aps-auth-hero', [
      logoNode,
      el('div', { class: 'aps-auth-badge', text: t('screens.auth.badge') }),
    ])

    const card = panel(null, { className: 'aps-auth-card ap-anim-in' })
    const hintEl = el('div', { class: 'aps-auth-hint', text: t('screens.auth.hintLogin') })

    const tabStrip = tabs([t('screens.auth.tabLogin'), t('screens.auth.tabRegister')], {
      initial: 0,
      audio: ctx.audio,
      className: 'aps-auth-tabs',
      onChange: (i) => {
        mode = i === 0 ? 'login' : 'register'
        submitBtn.textContent = mode === 'login' ? t('screens.auth.submitLogin') : t('screens.auth.submitRegister')
        passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password'
        hintEl.textContent = mode === 'login' ? t('screens.auth.hintLogin') : t('screens.auth.hintRegister')
        errEl.hidden = true
      },
    })

    const userRuleEl = el('span', { class: 'aps-auth-rule', text: t('screens.auth.usernameRule') })
    const userInput = el('input', {
      class: 'ap-input aps-auth-input',
      attrs: {
        type: 'text',
        autocomplete: 'username',
        maxlength: '16',
        placeholder: t('screens.auth.usernamePlaceholder'),
      },
    }) as HTMLInputElement

    userInput.addEventListener('input', () => {
      const len = userInput.value.trim().length
      userRuleEl.textContent = len > 0 ? `${len} / 16` : t('screens.auth.usernameRule')
      if (!errEl.hidden) errEl.hidden = true
    })

    const pwdRuleEl = el('span', { class: 'aps-auth-rule', text: t('screens.auth.passwordRule') })
    const passwordInput = el('input', {
      class: 'ap-input aps-auth-input aps-auth-input--pwd',
      attrs: {
        type: 'password',
        autocomplete: 'current-password',
        maxlength: '72',
        placeholder: t('screens.auth.passwordPlaceholder'),
      },
    }) as HTMLInputElement

    passwordInput.addEventListener('input', () => {
      const len = passwordInput.value.length
      pwdRuleEl.textContent = len > 0 ? `${len} / 72` : t('screens.auth.passwordRule')
      if (!errEl.hidden) errEl.hidden = true
    })

    const togglePwdBtn = el('button', {
      class: 'aps-auth-pwd-toggle',
      text: t('screens.auth.showPassword'),
      attrs: { type: 'button', tabindex: '-1' },
      on: {
        click: (e) => {
          e.preventDefault()
          showPassword = !showPassword
          passwordInput.type = showPassword ? 'text' : 'password'
          togglePwdBtn.textContent = showPassword ? t('screens.auth.hidePassword') : t('screens.auth.showPassword')
          passwordInput.focus()
        },
      },
    })

    const errEl = el('div', { class: 'aps-auth-error ap-shake', text: '' })
    errEl.hidden = true

    const doSubmit = () => {
      const uVal = userInput.value.trim()
      const pVal = passwordInput.value

      const uErr = validateUsername(uVal)
      if (uErr) {
        errEl.textContent = uErr
        errEl.hidden = false
        userInput.focus()
        return
      }

      const pErr = validatePassword(pVal)
      if (pErr) {
        errEl.textContent = pErr
        errEl.hidden = false
        passwordInput.focus()
        return
      }

      errEl.hidden = true
      void api.run(async () => {
        try {
          const result = mode === 'login'
            ? await loginAccount(httpBase, { username: uVal, password: pVal })
            : await registerAccount(httpBase, { username: uVal, password: pVal })
          sfx(env, 'start')
          api.close(result)
        } catch (err) {
          sfx(env, 'error')
          errEl.textContent = err instanceof Error ? err.message : String(err)
          errEl.hidden = false
          passwordInput.value = ''
          passwordInput.focus()
        }
      })
    }

    const submitBtn = button(t('screens.auth.submitLogin'), () => doSubmit(), { primary: true, className: 'aps-auth-submit' })
    const cancelBtn = !required
      ? button(t('screens.auth.cancel'), () => api.close(null), { className: 'aps-auth-cancel' })
      : null

    const userField = el('div', 'aps-auth-field', [
      el('div', 'aps-auth-label-row', [
        el('label', { class: 'aps-auth-label', text: t('screens.auth.usernameLabel') }),
        userRuleEl,
      ]),
      el('div', 'aps-auth-input-wrap', [
        el('span', { class: 'aps-auth-input-icon', text: '◈', attrs: { 'aria-hidden': 'true' } }),
        userInput,
      ]),
    ])

    const pwdField = el('div', 'aps-auth-field', [
      el('div', 'aps-auth-label-row', [
        el('label', { class: 'aps-auth-label', text: t('screens.auth.passwordLabel') }),
        pwdRuleEl,
      ]),
      el('div', 'aps-auth-input-wrap', [
        el('span', { class: 'aps-auth-input-icon', text: '❖', attrs: { 'aria-hidden': 'true' } }),
        passwordInput,
        togglePwdBtn,
      ]),
    ])

    const form = el('form', {
      class: 'aps-auth-form',
      on: {
        submit: (e) => {
          e.preventDefault()
          doSubmit()
        },
        keydown: (e) => {
          if (e.isComposing) return
          if (e.key === 'Escape' && !required) {
            e.preventDefault()
            e.stopPropagation()
            api.close(null)
          }
        },
      },
    }, [
      userField,
      pwdField,
      hintEl,
      errEl,
      el('div', 'aps-auth-btns', [submitBtn, cancelBtn]),
    ])

    card.body.append(tabStrip.el, form)
    const stage = el('div', 'aps-auth-stage', [hero, card.el])
    const foot = el('div', 'aps-title-foot aps-auth-foot', [
      el('span', { text: t('screens.title.version', { v: pkg.version }) }),
      el('span', { text: t('screens.auth.footerHint') }),
    ])
    api.root.append(art, fx, vignette, el('div', 'aps-auth-shell', [stage]), foot)

    requestAnimationFrame(() => userInput.focus())

    return {
      onInput(input) {
        if (!required && (backPressed(input) || pressed(input, 'cancel'))) {
          api.close(null)
        }
      },
      update(dt) {
        motes.update(dt)
      },
      dispose() {
        offScale()
      },
    }
  })
}

export function accountBindScreen(
  env: ScreenEnv,
  server: ServerEntry,
  hasLocalSave: boolean,
): Promise<{ choice: 'new' | 'local' | 'cancel' }> {
  return openScreen<{ choice: 'new' | 'local' | 'cancel' }>(env, 'aps-bind', (api) => {
    let currentChoice: 'new' | 'local' = 'new'

    const f = frame(env, {
      title: t('screens.auth.bindTitle'),
      onClose: api.guard(() => api.close({ choice: 'cancel' })),
      hints: env.ctx.input.lastDevice === 'touch' ? [] : [H.confirm(), H.back()],
    })

    const desc = el('div', { class: 'aps-bind-desc', text: `${server.name} · ${t('screens.auth.bindDesc')}` })

    const newCard = el('div', {
      class: `aps-bind-card ap-panel ${currentChoice === 'new' ? 'is-active' : ''}`,
      attrs: { role: 'button', tabindex: '0' },
      on: {
        click: api.guard(() => {
          currentChoice = 'new'
          confirmChoice()
        }),
      },
    }, [
      el('div', { class: 'aps-bind-card-title', text: t('screens.auth.bindNew') }),
      el('div', { class: 'aps-bind-card-desc ap-dim', text: t('screens.auth.bindNewConfirm') }),
    ])

    const localCard = el('div', {
      class: `aps-bind-card ap-panel ${!hasLocalSave ? 'is-disabled' : ''}`,
      attrs: { role: 'button', tabindex: hasLocalSave ? '0' : '-1' },
      on: {
        click: api.guard(() => {
          if (!hasLocalSave) return
          currentChoice = 'local'
          confirmChoice()
        }),
      },
    }, [
      el('div', { class: 'aps-bind-card-title', text: t('screens.auth.bindLocal') }),
      el('div', { class: 'aps-bind-card-desc ap-dim', text: hasLocalSave ? t('screens.auth.bindLocalConfirm') : t('screens.auth.localSaveUnavailable') }),
    ])

    const cancelBtn = button(t('screens.auth.bindCancel'), () => api.close({ choice: 'cancel' }))

    const confirmChoice = () => {
      sfx(env, 'start')
      api.close({ choice: currentChoice })
    }

    const cardsContainer = el('div', 'aps-bind-cards', [newCard, localCard])
    f.body.append(desc, cardsContainer, el('div', 'aps-bind-foot', [cancelBtn]))
    api.root.append(f.el)

    return {
      onInput(input) {
        if (backPressed(input)) {
          api.close({ choice: 'cancel' })
          return
        }
        if (hasLocalSave && (pressed(input, 'left') || pressed(input, 'right') || pressed(input, 'up') || pressed(input, 'down'))) {
          currentChoice = (currentChoice === 'new' ? 'local' : 'new') as 'new' | 'local'
          newCard.classList.toggle('is-active', currentChoice === 'new')
          localCard.classList.toggle('is-active', currentChoice === 'local')
          uiSfx(env, 'move')
          return
        }
        if (pressed(input, 'confirm')) {
          confirmChoice()
        }
      },
    }
  })
}
