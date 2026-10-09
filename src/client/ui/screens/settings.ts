// Settings: tabs from content/screens.json — options (every Settings field as slider / toggle / choice, live
// applied), save (info + export / import code), key help (bindings from content/input.json), credits.
import type { Settings } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { fullscreenAvailable, isFullscreen, toggleFullscreen } from '../../core/fullscreen.ts'
import { applyDocumentSettings } from '../../core/settings.ts'
import { INPUT_BINDINGS } from '../config.ts'
import { actionKeyLabel, button, el, tabs } from '../widgets.ts'
import { backPressed, frame, infoRow, keepVisible, moneyEl, openScreen, pressed, sfx, textOrKey, uiSfx, type ScreenEnv } from './base.ts'
import { SCREENS, type SettingsField } from './config.ts'
import { dexCounts, playTimeParts, stepSetting } from './logic.ts'
import { exportCodePanel, promptSaveCode } from './savecode.ts'

type Zone = 'tabs' | 'content'

export function settingsScreen(env: ScreenEnv): Promise<void> {
  const { ctx } = env
  const cfg = SCREENS.settings
  return openScreen<void>(env, 'aps-settings', (api) => {
    let tab = 0
    let zone: Zone = 'content'
    let row = 0
    let dirty = false
    const f = frame(env, { title: t('screens.settings.title'), glyph: 'settings', onClose: api.guard(() => close()) })
    const tabBar = tabs(cfg.tabs.map((x) => t(x.label)), { audio: ctx.audio, onChange: (i) => { tab = i; row = 0; render() } })
    const page = el('div', 'aps-set-page ap-panel')
    f.body.append(el('div', 'aps-set-layout', [tabBar.el, page]))
    api.root.append(f.el)

    let rows: { el: HTMLElement; activate?: () => void; step?: (d: number) => void }[] = []
    const tabId = () => cfg.tabs[tab]?.id

    const apply = (s: Settings) => {
      ctx.save.settings = s
      ctx.audio.setVolumes(s.bgmVolume, s.sfxVolume)
      applyDocumentSettings(s)
      ctx.renderer?.applySettings?.(s)
      ctx.minimap?.setVisible?.(s.showMinimap)
      ctx.events.emit('settings:changed', { settings: s })
      dirty = true
    }

    const valueText = (fd: SettingsField, v: unknown): string => {
      if (fd.kind === 'toggle') return t(v ? 'screens.settings.on' : 'screens.settings.off')
      if (fd.kind === 'slider') return t('screens.settings.percent', { n: Math.round(Number(v) * 100) })
      if (fd.format) return t(fd.format, { value: String(v) })
      return t(`screens.settings.opt.${fd.key}.${String(v)}`)
    }

    const control = (fd: SettingsField, v: unknown): HTMLElement => {
      if (fd.kind === 'slider') {
        const min = fd.min ?? 0
        const max = fd.max ?? 1
        const steps = Math.round((max - min) / (fd.step ?? 0.1))
        const on = Math.round((Number(v) - min) / (fd.step ?? 0.1))
        const seg = Array.from({ length: steps }, (_, i) => el('span', `aps-seg${i < on ? ' is-on' : ''}`))
        return el('div', 'aps-slider', [el('span', 'aps-segs', seg), el('span', { class: 'aps-set-val', text: valueText(fd, v) })])
      }
      if (fd.kind === 'toggle') return el('div', `aps-toggle${v ? ' is-on' : ''}`, [el('span', 'aps-toggle-knob'), el('span', { class: 'aps-set-val', text: valueText(fd, v) })])
      return el('div', 'aps-choice', [el('span', 'aps-choice-arrow is-left'), el('span', { class: 'aps-set-val', text: valueText(fd, v) }), el('span', 'aps-choice-arrow is-right')])
    }

    const optionsPage = () => {
      const out: HTMLElement[] = []
      rows = []
      let section = ''
      let group: HTMLElement | null = null
      for (const fd of cfg.fields) {
        if (fd.section !== section || !group) {
          section = fd.section
          group = el('div', 'aps-set-group', [el('div', { class: 'aps-sec', text: t(`screens.settings.section.${section}`) })])
          out.push(group)
        }
        const s = ctx.save.settings
        const v = (s as unknown as Record<string, unknown>)[fd.key]
        const set = (nv: unknown) => {
          if (nv === v) return
          const next = { ...ctx.save.settings, [fd.key]: nv } as Settings
          apply(next)
          uiSfx(env, 'move')
          render()
        }
        const node = el('div', { class: 'aps-set-row ap-cursor-host', attrs: { role: 'option' } }, [el('span', { class: 'aps-set-label', text: t(`screens.settings.field.${fd.key}`) }), control(fd, v)])
        const idx = rows.length
        node.addEventListener('mouseenter', api.guard(() => { if (zone !== 'content' || row !== idx) { zone = 'content'; row = idx; paintCursor() } }))
        node.addEventListener('click', api.guard((e: MouseEvent) => {
          zone = 'content'
          row = idx
          const box = node.getBoundingClientRect()
          const leftHalf = e.clientX < box.left + box.width * 0.75
          if (fd.kind === 'slider') {
            const segs = node.querySelector('.aps-segs')?.getBoundingClientRect()
            if (segs && e.clientX >= segs.left && e.clientX <= segs.right) {
              const min = fd.min ?? 0
              const max = fd.max ?? 1
              const step = fd.step ?? 0.1
              const k = Math.ceil(((e.clientX - segs.left) / segs.width) * Math.round((max - min) / step))
              set(Math.min(max, Math.max(min, Number((min + k * step).toFixed(6)))))
              return
            }
            set(stepSetting(fd, v, leftHalf ? -1 : 1))
          } else set(stepSetting(fd, v, fd.kind === 'choice' && leftHalf && e.clientX < box.left + box.width * 0.5 ? -1 : 1))
        }))
        rows.push({ el: node, activate: () => set(stepSetting(fd, v, 1)), step: (d) => set(stepSetting(fd, v, d)) })
        group.append(node)
      }
      if (fullscreenAvailable() && document.documentElement.dataset.touchControls === 'on') {
        const on = isFullscreen()
        const node = el('div', { class: 'aps-set-row ap-cursor-host', attrs: { role: 'option' } }, [
          el('span', { class: 'aps-set-label', text: t('screens.settings.field.fullscreen') }),
          el('div', `aps-toggle${on ? ' is-on' : ''}`, [el('span', 'aps-toggle-knob'), el('span', { class: 'aps-set-val', text: t(on ? 'screens.settings.on' : 'screens.settings.off') })]),
        ])
        const flip = () => void toggleFullscreen().then(() => { uiSfx(env, 'move'); render() })
        const idx = rows.length
        node.addEventListener('mouseenter', api.guard(() => { if (zone !== 'content' || row !== idx) { zone = 'content'; row = idx; paintCursor() } }))
        node.addEventListener('click', api.guard(() => { zone = 'content'; row = idx; flip() }))
        rows.push({ el: node, activate: flip, step: flip })
        group?.append(node)
      }
      const reset = el('div', { class: 'aps-set-row aps-set-action ap-cursor-host', attrs: { role: 'option' } }, [el('span', { class: 'aps-set-label', text: t('screens.settings.resetDefaults') })])
      const doReset = () => api.run(async () => {
        if (!await ctx.ui.confirm(t('screens.settings.resetConfirm'))) return
        apply(ctx.saves.defaultSettings())
        render()
      })
      const idx = rows.length
      reset.addEventListener('mouseenter', api.guard(() => { zone = 'content'; row = idx; paintCursor() }))
      reset.addEventListener('click', api.guard(() => void doReset()))
      rows.push({ el: reset, activate: () => void doReset() })
      out.push(reset)
      return out
    }

    const savePage = () => {
      const s = ctx.save
      const pt = playTimeParts(s.playTimeSec)
      const dc = dexCounts(s)
      rows = []
      const info = el('div', 'aps-save-info', [
        infoRow(t('screens.settings.save.name'), s.name),
        infoRow(t('screens.settings.save.playTime'), t('screens.common.playTime', pt)),
        infoRow(t('screens.settings.save.money'), moneyEl(s.money)),
        infoRow(t('screens.settings.save.badges'), t('screens.common.count', { n: s.badges.length })),
        infoRow(t('screens.settings.save.dex'), t('screens.settings.save.dexValue', { caught: dc.caught, seen: dc.seen })),
        infoRow(t('screens.settings.save.created'), new Date(s.createdAt).toLocaleDateString(t('ui.locale'))),
      ])
      const actions = cfg.saveActions.map((a) => {
        const run = () => api.run(async () => {
          if (a.id === 'export') await exportCodePanel(env)
          else if (a.id === 'import') await importFlow()
        })
        const b = button(t(a.label), api.guard(() => void run()), { className: 'aps-set-btn' })
        const idx = rows.length
        b.addEventListener('mouseenter', api.guard(() => { zone = 'content'; row = idx; paintCursor() }))
        rows.push({ el: b, activate: () => void run() })
        return b
      })
      return [info, el('p', { class: 'ap-dim aps-save-note', text: t('screens.settings.save.note') }), el('div', 'aps-set-actions', actions)]
    }

    const importFlow = async () => {
      const data = await promptSaveCode(env)
      if (!data) return
      const pt = playTimeParts(data.playTimeSec)
      if (!await ctx.ui.confirm(t('screens.settings.importConfirm', { name: data.name, h: pt.h, m: pt.m }))) return
      ctx.save = data
      if (!ctx.saves.write(data)) { sfx(env, 'error'); ctx.ui.toast(t('screens.settings.writeFailed'), 'error'); return }
      ctx.events.emit('save:changed', { reason: 'import' })
      sfx(env, 'save')
      ctx.ui.toast(t('screens.settings.imported'), 'success')
      if (cfg.reloadAfterImport) window.setTimeout(() => location.reload(), SCREENS.anim.pressBlinkMs)
    }

    const keysPage = () => {
      rows = []
      const head = el('div', 'aps-key-row is-head', [el('span', { text: t('screens.keys.action') }), el('span', { text: t('screens.keys.keyboard') }), el('span', { text: t('screens.keys.gamepad') })])
      const list = cfg.keyHelp.map((a) => {
        const codes = INPUT_BINDINGS.keyboard[a] ?? []
        const names = [...new Set(codes.map((code) => (`ui.keyNames.${code}` in CONTENT.text ? t(`ui.keyNames.${code}`) : code.replace(/^(Key|Digit)/, ''))))]
        const keys = names.map((name) => el('kbd', { text: name }))
        const pad = INPUT_BINDINGS.gamepad.buttons[a]?.length ? actionKeyLabel(a, 'gamepad') : t('screens.common.dash')
        const node = el('div', 'aps-key-row', [el('span', { text: t(`screens.keys.${a}`) }), el('span', 'aps-key-caps', keys), el('span', 'aps-key-caps', [el('kbd', { text: pad })])])
        rows.push({ el: node })
        return node
      })
      return [head, ...list]
    }

    const creditsPage = () => {
      rows = []
      const blocks = cfg.credits.map((c) => {
        const node = el('div', 'aps-credit', [el('div', { class: 'aps-credit-role ap-gold', text: t(c.role) }), ...c.names.map((n) => el('div', { class: 'aps-credit-name', text: textOrKey(n) }))])
        rows.push({ el: node })
        return node
      })
      return [el('div', { class: 'aps-credit-title', text: t('screens.title.logo') }), ...blocks]
    }

    const render = () => {
      const id = tabId()
      page.dataset.tab = id ?? ''
      page.classList.toggle('is-options', id === 'options')
      page.replaceChildren(...(id === 'options' ? optionsPage() : id === 'save' ? savePage() : id === 'keys' ? keysPage() : creditsPage()))
      row = Math.min(row, Math.max(0, rows.length - 1))
      paintCursor()
    }
    const selectable = () => tabId() === 'options' || tabId() === 'save'
    const paintCursor = () => {
      rows.forEach((r, i) => r.el.classList.toggle('is-active', selectable() && zone === 'content' && i === row))
      tabBar.el.classList.toggle('is-focus', zone === 'tabs')
      if (zone === 'content') keepVisible(page, rows[row]?.el)
      const opt = tabId() === 'options'
      f.setHints(zone === 'tabs'
        ? [['lr', t('screens.hint.tabs')], ['down', t('screens.settings.hint.toContent')], ['cancel', t('screens.hint.back')]]
        : opt
          ? [['ud', t('screens.hint.choose')], ['lr', t('screens.settings.hint.adjust')], ['up', t('screens.settings.hint.toTabs')], ['cancel', t('screens.hint.back')]]
          : selectable()
            ? [['ud', t('screens.hint.choose')], ['confirm', t('screens.hint.confirm')], ['lr', t('screens.hint.tabs')], ['cancel', t('screens.hint.back')]]
            : [['ud', t('screens.settings.hint.scroll')], ['lr', t('screens.hint.tabs')], ['cancel', t('screens.hint.back')]])
    }

    const close = () => {
      if (dirty) ctx.persist('settings')
      api.close()
    }

    render()
    return {
      onInput(input) {
        if (backPressed(input)) {
          if (zone === 'tabs' && tabId() === 'options') { zone = 'content'; uiSfx(env, 'cancel'); paintCursor(); return }
          close()
          return
        }
        if (zone === 'tabs') {
          if (pressed(input, 'left', true)) tabBar.prev()
          else if (pressed(input, 'right', true)) tabBar.next()
          else if (pressed(input, 'down', true) || pressed(input, 'confirm')) { zone = 'content'; row = 0; uiSfx(env, 'move'); paintCursor() }
          return
        }
        const opt = tabId() === 'options'
        if (!opt && pressed(input, 'left', true)) { tabBar.prev(); return }
        if (!opt && pressed(input, 'right', true)) { tabBar.next(); return }
        if (!selectable()) {
          const step = SCREENS.anim.creditsScrollUnits * (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ap-ui-scale')) || 1)
          if (pressed(input, 'up', true)) { if (page.scrollTop <= 0) { zone = 'tabs'; paintCursor() } else page.scrollTop -= step }
          else if (pressed(input, 'down', true)) page.scrollTop += step
          return
        }
        if (pressed(input, 'up', true)) {
          if (row === 0) { zone = 'tabs'; uiSfx(env, 'move'); paintCursor() } else { row--; uiSfx(env, 'move'); paintCursor() }
        } else if (pressed(input, 'down', true)) {
          row = (row + 1) % Math.max(1, rows.length); uiSfx(env, 'move'); paintCursor()
        } else if (opt && pressed(input, 'left', true)) rows[row]?.step?.(-1)
        else if (opt && pressed(input, 'right', true)) rows[row]?.step?.(1)
        else if (pressed(input, 'confirm')) rows[row]?.activate?.()
      },
    }
  })
}
