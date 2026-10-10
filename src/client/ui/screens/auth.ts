// Account login & registration screen, and first-time character binding dialog.
import { t } from '../../../shared/content/index.ts'
import { button, el, panel, tabs } from '../widgets.ts'
import { backPressed, frame, H, openScreen, pressed, sfx, uiSfx, type ScreenEnv } from './base.ts'
import {
  loginAccount, registerAccount, validatePassword, validateUsername,
  type AccountSessionResult,
} from '../../net/auth.ts'
import type { ServerEntry } from '../../net/servers.ts'

export function accountAuthScreen(
  env: ScreenEnv,
  server: ServerEntry,
  httpBase: string,
): Promise<AccountSessionResult | null> {
  const { ctx } = env
  return openScreen<AccountSessionResult | null>(env, 'aps-auth', (api) => {
    let mode: 'login' | 'register' = 'login'

    const f = frame(env, {
      title: t('screens.auth.title'),
      onClose: api.guard(() => api.close(null)),
      hints: ctx.input.lastDevice === 'touch' ? [] : [H.confirm(), H.back()],
    })

    const card = panel(null, { className: 'aps-auth-card' })
    const subtitle = el('div', {
      class: 'aps-auth-sub ap-dim',
      text: t('screens.auth.subtitle', { server: server.name }),
    })

    const tabStrip = tabs([t('screens.auth.tabLogin'), t('screens.auth.tabRegister')], {
      initial: 0,
      audio: ctx.audio,
      onChange: (i) => {
        mode = i === 0 ? 'login' : 'register'
        submitBtn.textContent = mode === 'login' ? t('screens.auth.submitLogin') : t('screens.auth.submitRegister')
        passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password'
        errEl.hidden = true
      },
    })

    const userInput = el('input', {
      class: 'ap-input aps-auth-input',
      attrs: {
        type: 'text',
        autocomplete: 'username',
        maxlength: '16',
        placeholder: t('screens.auth.usernamePlaceholder'),
      },
    }) as HTMLInputElement

    const passwordInput = el('input', {
      class: 'ap-input aps-auth-input',
      attrs: {
        type: 'password',
        autocomplete: 'current-password',
        maxlength: '72',
        placeholder: t('screens.auth.passwordPlaceholder'),
      },
    }) as HTMLInputElement

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

    const submitBtn = button(t('screens.auth.submitLogin'), () => doSubmit(), { primary: true })
    const cancelBtn = button(t('screens.auth.cancel'), () => api.close(null))

    const form = el('form', {
      class: 'aps-auth-form',
      on: {
        submit: (e) => {
          e.preventDefault()
          doSubmit()
        },
      },
    }, [
      el('label', { class: 'aps-auth-label', text: t('screens.auth.usernameLabel') }),
      userInput,
      el('label', { class: 'aps-auth-label', text: t('screens.auth.passwordLabel') }),
      passwordInput,
      errEl,
      el('div', 'aps-auth-btns', [submitBtn, cancelBtn]),
    ])

    card.body.append(subtitle, tabStrip.el, form)
    f.body.append(card.el)
    api.root.append(f.el)

    requestAnimationFrame(() => userInput.focus())

    return {
      onInput(input) {
        if (backPressed(input)) {
          api.close(null)
          return
        }
        if (pressed(input, 'cancel')) {
          api.close(null)
          return
        }
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
      el('div', { class: 'aps-bind-card-desc ap-dim', text: hasLocalSave ? t('screens.auth.bindLocalConfirm') : '（本地暂无可用存档）' }),
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
