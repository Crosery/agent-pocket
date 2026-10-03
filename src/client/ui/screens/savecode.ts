// Save-code panels: export (read-only code + copy) and import (paste + validate through ctx.saves.importCode).
import type { SaveData } from '../../../shared/types.ts'
import { t } from '../../../shared/content/index.ts'
import type { UIPanel } from '../../contracts.ts'
import { button, el, panel } from '../widgets.ts'
import { backPressed, pressed, uiSfx, type ScreenEnv } from './base.ts'
import { SCREENS } from './config.ts'

function codePanel(env: ScreenEnv, build: (finish: () => void, area: HTMLTextAreaElement) => { win: HTMLElement; onConfirm(): void }): Promise<void> {
  const { ctx } = env
  return new Promise<void>((resolve) => {
    let done = false
    const area = el('textarea', { class: 'aps-code-area', attrs: { spellcheck: 'false', autocomplete: 'off', 'aria-label': t('screens.code.label') } })
    const setText = (on: boolean) => {
      if (on) ctx.input.setTextInputActive(true)
      else requestAnimationFrame(() => requestAnimationFrame(() => { if (document.activeElement !== area) ctx.input.setTextInputActive(false) }))
    }
    area.addEventListener('focus', () => setText(true))
    area.addEventListener('blur', () => setText(false))
    const finish = () => {
      if (done) return
      done = true
      area.blur()
      setText(false)
      ctx.ui.popPanel(p)
      resolve()
    }
    const { win, onConfirm } = build(finish, area)
    area.addEventListener('keydown', (e) => {
      if (e.isComposing) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish() }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); onConfirm() }
    })
    const layer = el('div', 'aps-popup-layer is-center', [win])
    const p: UIPanel = {
      el: layer,
      onInput(input) {
        if (backPressed(input)) finish()
        else if (pressed(input, 'confirm')) onConfirm()
        return true
      },
    }
    ctx.ui.pushPanel(p)
  })
}

/** Shows the export code with a copy button. */
export function exportCodePanel(env: ScreenEnv): Promise<void> {
  const { ctx } = env
  const code = ctx.saves.exportCode(ctx.save)
  return codePanel(env, (finish, area) => {
    area.value = code
    area.readOnly = true
    const status = el('div', { class: 'aps-code-status', attrs: { role: 'status' } })
    const copy = async () => {
      area.select()
      let ok = false
      try { await navigator.clipboard.writeText(code); ok = true } catch {
        try { ok = document.execCommand('copy') } catch { ok = false }
      }
      status.textContent = t(ok ? 'screens.code.copied' : 'screens.code.copyFailed')
      status.dataset.ok = String(ok)
      uiSfx(env, ok ? 'confirm' : 'error')
    }
    const win = panel(t('screens.code.exportTitle'), { className: 'aps-code ap-anim-in' })
    win.body.append(
      el('p', { class: 'aps-code-text', text: t('screens.code.exportText') }),
      area,
      status,
      el('div', 'ap-btn-row', [button(t('screens.common.close'), () => finish()), button(t('screens.code.copy'), () => void copy(), { primary: true })]),
    )
    requestAnimationFrame(() => area.select())
    return { win: win.el, onConfirm: () => void copy() }
  })
}

/** Lets the player paste a save code; resolves the validated save or null when cancelled. */
export function promptSaveCode(env: ScreenEnv): Promise<SaveData | null> {
  const { ctx } = env
  let result: SaveData | null = null
  return codePanel(env, (finish, area) => {
    area.maxLength = SCREENS.settings.codeMaxLen
    area.placeholder = t('screens.code.placeholder')
    const status = el('div', { class: 'aps-code-status', attrs: { role: 'alert' } })
    const win = panel(t('screens.code.importTitle'), { className: 'aps-code ap-anim-in' })
    const submit = () => {
      const code = area.value.trim()
      if (!code) { status.textContent = t('screens.code.empty'); status.dataset.ok = 'false'; uiSfx(env, 'error'); area.focus(); return }
      const data = ctx.saves.importCode(code)
      if (!data) {
        status.textContent = t('screens.code.invalid')
        status.dataset.ok = 'false'
        uiSfx(env, 'error')
        win.el.classList.remove('ap-shake')
        void win.el.offsetWidth
        win.el.classList.add('ap-shake')
        return
      }
      result = data
      uiSfx(env, 'confirm')
      finish()
    }
    const paste = async () => {
      try { area.value = await navigator.clipboard.readText(); status.textContent = '' } catch {
        status.textContent = t('screens.code.pasteFailed')
        status.dataset.ok = 'false'
      }
      area.focus()
    }
    win.el.addEventListener('animationend', () => win.el.classList.remove('ap-shake'))
    win.body.append(
      el('p', { class: 'aps-code-text', text: t('screens.code.importText') }),
      area,
      status,
      el('div', 'ap-btn-row', [
        button(t('screens.common.cancel'), () => finish()),
        button(t('screens.code.paste'), () => void paste()),
        button(t('screens.code.import'), () => submit(), { primary: true }),
      ]),
    )
    requestAnimationFrame(() => area.focus())
    return { win: win.el, onConfirm: submit }
  }).then(() => result)
}
