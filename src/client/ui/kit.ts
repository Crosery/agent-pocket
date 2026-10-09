// UIKit: modal stack + input routing + dialogue/choices/prompt/list/toast/fade/panels.
// Only the top-most layer receives Input (keyboard/gamepad/touch buttons); pointer events go to DOM directly
// (click/tap rows and the dialogue box, wheel/drag to scroll lists, right-click = cancel where cancellable).
// A layer ignores input on its first frame, so the key that opened it cannot also act on it.
// Notes on the UIKit contract as implemented here:
//   say/choose/confirm share one dialogue box and are serialised (calls queue in order).
//   DialogueLine.portrait: URL-like strings are used directly; other ids go through setPortraitResolver().
//   list(..., { width }) is in UI pixels; detail(i) is rendered in a side window (stacked on compact screens).
//   prompt() rejects empty input with feedback; resolves null on cancel.
//   pushPanel(): panel.el is shown full-screen (.ap-pushed) with open/close animation and menu_open/close sfx.
import type { Settings } from '../../shared/types.ts'
import type { AudioManager, DialogueLine, Input, ListItem, UIKit, UIPanel } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import { UI_CONFIG, type ToastKind } from './config.ts'
import { createDialogueBox, type PortraitResolver } from './dialogue.ts'
import { bindTextField } from './focus.ts'
import { createRowMenu } from './menu.ts'
import { ensureUIEnvironment, getUIScale, prepareRoot } from './scale.ts'
import { codePointLength, clampCodePoints } from './textflow.ts'
import { button, el, panel } from './widgets.ts'

export interface UIKitHandle extends UIKit {
  /** Maps DialogueLine.portrait ids to image URLs (e.g. assets.portraitUrl). Unresolved ids show a framed initial. */
  setPortraitResolver(fn: PortraitResolver | null): void
  /** Number of modal layers (dialogue, windows, panels) currently open. */
  depth(): number
  dispose(): void
}

interface Layer {
  readonly el: HTMLElement | null
  /** Skips input on its first frame so the key that opened it cannot also act on it. */
  fresh: boolean
  input(input: Input): void
  update?(dtSec: number): void
  pointerCancel?(): void
  panel?: UIPanel
}

/** Ids that are already URLs (absolute, relative path, data:, blob:) pass through; others need a resolver. */
const defaultPortraitResolver: PortraitResolver = (id) => (/[/:.]/.test(id) ? id : null)

export function createUIKit(root: HTMLElement, input: Input, audio: AudioManager, getSettings: () => Settings): UIKitHandle {
  ensureUIEnvironment()
  prepareRoot(root)
  const sfx = (k: keyof typeof UI_CONFIG.sfx) => audio.playSfx(UI_CONFIG.sfx[k])

  const stackEl = el('div', 'ap-kit-stack')
  const fadeEl = el('div', 'ap-fade')
  const toastsEl = el('div', { class: 'ap-toasts', attrs: { role: 'status', 'aria-live': 'polite' } })
  const layerEl = el('div', 'ap-layer ap-l-kit', [stackEl, fadeEl, toastsEl])
  root.append(layerEl)

  const stack: Layer[] = []
  let fading = 0
  let portraitResolver: PortraitResolver = defaultPortraitResolver
  const dlg = createDialogueBox(audio, getSettings, () => portraitResolver)
  let dlgActivate: (() => void) | null = null
  let dlgChain: Promise<unknown> = Promise.resolve()

  const top = () => stack[stack.length - 1]
  const push = (l: Layer) => {
    stack.push(l)
    if (l.el && l.el.parentElement !== stackEl) stackEl.append(l.el)
    else if (l.el && stackEl.lastElementChild !== l.el) stackEl.append(l.el)
  }
  const pull = (l: Layer) => {
    const i = stack.indexOf(l)
    if (i >= 0) stack.splice(i, 1)
  }
  const raiseDialogue = () => {
    if (stackEl.lastElementChild !== dlg.wrap) stackEl.append(dlg.wrap)
    dlg.open()
  }
  const removeAnimated = (node: HTMLElement, cls: string, ms: number) => {
    node.classList.add(cls)
    window.setTimeout(() => { if (node.classList.contains(cls)) node.remove() }, ms)
  }
  /** Serialises everything that uses the shared dialogue box. */
  const withDialogue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = dlgChain.then(fn, fn)
    dlgChain = run.catch(() => undefined)
    return run
  }
  const normLine = (l: string | DialogueLine): DialogueLine => (typeof l === 'string' ? { text: l } : l)
  const visibleRows = () => (getUIScale().compact ? UI_CONFIG.list.compactVisibleRows : UI_CONFIG.list.visibleRows)

  dlg.box.addEventListener('click', () => {
    const l = top()
    if (dlgActivate && l && !l.fresh) dlgActivate()
  })
  const onContextMenu = (e: MouseEvent) => {
    const l = top()
    if (!l?.pointerCancel) return
    e.preventDefault()
    l.pointerCancel()
  }
  layerEl.addEventListener('contextmenu', onContextMenu)

  // -------------------------------------------------------------------------
  // say / choose / confirm
  // -------------------------------------------------------------------------

  const say = (lines: (string | DialogueLine)[], opts?: { autoCloseMs?: number }): Promise<void> => withDialogue(() => new Promise<void>((resolve) => {
    const queue = lines.map(normLine)
    if (!queue.length) { resolve(); return }
    let idx = 0
    let waited = 0
    const show = () => { dlg.setLine(queue[idx]); waited = 0 }
    const advance = () => {
      if (dlg.typing) { dlg.finish(); return }
      sfx('move')
      idx++
      if (idx < queue.length) { show(); return }
      pull(layer)
      dlgActivate = null
      dlg.release()
      resolve()
    }
    const layer: Layer = {
      el: null,
      fresh: true,
      input(inp) {
        if (inp.pressed('confirm') || inp.pressed('cancel')) {
          inp.consume('confirm')
          inp.consume('cancel')
          advance()
        }
      },
      update(dt) {
        dlg.update(dt)
        if (dlg.typing) return
        dlg.setIndicator(idx < queue.length - 1 ? 'more' : 'end')
        if (opts?.autoCloseMs !== undefined) {
          waited += dt * 1000
          if (waited >= opts.autoCloseMs) advance()
        }
      },
    }
    raiseDialogue()
    push(layer)
    dlgActivate = advance
    show()
  }))

  const choose = (
    prompt: string | DialogueLine | null, options: string[],
    opts?: { cancelIndex?: number; speaker?: string; portrait?: string },
  ): Promise<number> => withDialogue(() => new Promise<number>((resolve) => {
    const line = prompt === null ? null : typeof prompt === 'string'
      ? { text: prompt, speaker: opts?.speaker, portrait: opts?.portrait }
      : { ...prompt, speaker: prompt.speaker ?? opts?.speaker, portrait: prompt.portrait ?? opts?.portrait }
    const cancelIndex = opts?.cancelIndex
    let done = false
    const finish = (i: number) => {
      if (done) return
      done = true
      sfx(i === cancelIndex ? 'cancel' : 'confirm')
      pull(layer)
      dlgActivate = null
      removeAnimated(win.el, 'ap-anim-out', UI_CONFIG.anim.panelCloseMs)
      dlg.release()
      resolve(i)
    }
    const menu = createRowMenu(options.map((label) => ({ label })), {
      visibleRows: Math.max(visibleRows(), Math.min(options.length, UI_CONFIG.list.visibleRows)),
      audio,
      onPick: (i) => { if (!layer.fresh) finish(i) },
    })
    const win = panel(null, { className: 'ap-choices' })
    win.body.append(menu.el)
    win.el.hidden = true
    const reveal = () => {
      if (!win.el.hidden) return
      win.el.hidden = false
      win.el.classList.add('ap-anim-in')
    }
    const layer: Layer = {
      el: null,
      fresh: true,
      input(inp) {
        if (dlg.typing) {
          if (inp.pressed('confirm') || inp.pressed('cancel')) { inp.consume('confirm'); inp.consume('cancel'); dlg.finish() }
          return
        }
        const r = menu.handleInput(inp)
        if (r === 'confirm') finish(menu.index)
        else if (r === 'cancel' && cancelIndex !== undefined && cancelIndex >= 0 && cancelIndex < options.length) finish(cancelIndex)
      },
      update(dt) {
        dlg.update(dt)
        if (!dlg.typing) reveal()
      },
      pointerCancel: cancelIndex !== undefined ? () => finish(cancelIndex) : undefined,
    }
    raiseDialogue()
    dlg.setLine(line)
    dlg.stage.append(win.el)
    push(layer)
    dlgActivate = () => { if (dlg.typing) dlg.finish() }
    if (!dlg.typing) reveal()
  }))

  const confirm = (text: string): Promise<boolean> =>
    choose(text, [t('ui.confirm.yes'), t('ui.confirm.no')], { cancelIndex: 1 }).then((i) => i === 0)

  // -------------------------------------------------------------------------
  // prompt
  // -------------------------------------------------------------------------

  const prompt = (text: string, initial: string, maxLen: number): Promise<string | null> => new Promise((resolve) => {
    const limit = Math.max(1, Math.floor(maxLen))
    const field = el('input', { class: 'ap-field', attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': text } })
    field.value = clampCodePoints(initial, limit)
    const counter = el('span', 'ap-field-count')
    const error = el('div', { class: 'ap-field-error', attrs: { role: 'alert' } })
    const ok = button(t('ui.prompt.ok'), () => submit(), { primary: true })
    const cancel = button(t('ui.prompt.cancel'), () => finish(null))
    const win = panel(null, { className: 'ap-prompt ap-anim-in' })
    win.body.append(
      el('div', { class: 'ap-prompt-text', text }),
      el('div', 'ap-field-row', [field, counter]),
      error,
      el('div', 'ap-btn-row', [el('span', { class: 'ap-dim', text: t('ui.prompt.hint') }), cancel, ok]),
    )
    const center = el('div', 'ap-modal-center', [win.el])
    let done = false

    const recount = () => { counter.textContent = t('ui.prompt.count', { n: codePointLength(field.value), max: limit }) }
    const textMode = bindTextField(input, field)
    const submit = () => {
      const v = field.value.trim()
      if (!v) {
        error.textContent = t('ui.prompt.empty')
        sfx('error')
        win.el.classList.remove('ap-shake')
        void win.el.offsetWidth
        win.el.classList.add('ap-shake')
        field.focus()
        return
      }
      finish(v)
    }
    const finish = (v: string | null) => {
      if (done) return
      done = true
      sfx(v === null ? 'cancel' : 'confirm')
      pull(layer)
      field.blur()
      textMode.release()
      removeAnimated(center, 'ap-anim-out', UI_CONFIG.anim.panelCloseMs)
      resolve(v)
    }

    field.addEventListener('input', () => {
      const clamped = clampCodePoints(field.value, limit)
      if (clamped !== field.value) field.value = clamped
      error.textContent = ''
      recount()
    })
    field.addEventListener('keydown', (e) => {
      if (e.isComposing) return
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit() }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null) }
    })
    win.el.addEventListener('animationend', () => win.el.classList.remove('ap-shake'))

    const layer: Layer = {
      el: center,
      fresh: true,
      input(inp) {
        if (inp.pressed('confirm')) { inp.consume('confirm'); submit() }
        // Esc (menu) cancels too: once the field has lost focus it is the only cancel key the hint promises.
        else if (inp.pressed('cancel') || inp.pressed('menu')) { inp.consume('cancel'); inp.consume('menu'); finish(null) }
      },
      pointerCancel: () => finish(null),
    }
    recount()
    push(layer)
    requestAnimationFrame(() => { if (!done) { field.focus(); field.select() } })
  })

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  const list = (
    title: string, items: ListItem[],
    opts?: { initial?: number; width?: number; onHighlight?: (i: number) => void; detail?: (i: number) => HTMLElement | null },
  ): Promise<number> => new Promise((resolve) => {
    const win = panel(title || null, { className: 'ap-listwin ap-anim-in' })
    if (opts?.width) win.el.style.width = `calc(var(--u) * ${opts.width})`
    const detail = opts?.detail ? panel(null, { className: 'ap-detail ap-anim-in' }) : null
    const center = el('div', 'ap-modal-center', [el('div', 'ap-modal-row', [win.el, detail?.el])])
    let done = false
    const refresh = (i: number) => {
      opts?.onHighlight?.(i)
      if (detail && opts?.detail) {
        const node = i >= 0 ? opts.detail(i) : null
        detail.body.replaceChildren(...(node ? [node] : []))
        detail.el.hidden = !node
      }
    }
    const finish = (i: number) => {
      if (done) return
      done = true
      sfx(i < 0 ? 'cancel' : 'confirm')
      pull(layer)
      removeAnimated(center, 'ap-anim-out', UI_CONFIG.anim.panelCloseMs)
      resolve(i)
    }
    const menu = createRowMenu(items, {
      visibleRows: visibleRows(),
      initial: opts?.initial,
      audio,
      onChange: refresh,
      onPick: (i) => { if (!layer.fresh) finish(i) },
    })
    win.body.append(menu.el)
    const layer: Layer = {
      el: center,
      fresh: true,
      input(inp) {
        const r = menu.handleInput(inp)
        if (r === 'confirm') finish(menu.index)
        else if (r === 'cancel') finish(-1)
      },
      pointerCancel: () => finish(-1),
    }
    push(layer)
    refresh(menu.index)
  })

  // -------------------------------------------------------------------------
  // toast / fade / panels
  // -------------------------------------------------------------------------

  const toast = (text: string, kind: ToastKind = 'info') => {
    const node = el('div', { class: `ap-toast ap-toast--${kind}` }, [el('span', { class: 'ap-toast-text', text })])
    toastsEl.append(node)
    audio.playSfx(UI_CONFIG.toast.sfx[kind] ?? UI_CONFIG.toast.sfx.info)
    const leave = () => {
      if (node.classList.contains('is-leaving')) return
      removeAnimated(node, 'is-leaving', UI_CONFIG.anim.toastLeaveMs)
    }
    const live = [...toastsEl.children].filter((c) => !c.classList.contains('is-leaving')) as HTMLElement[]
    for (let i = 0; i < live.length - UI_CONFIG.toast.max; i++) live[i].dispatchEvent(new Event('ap-dismiss'))
    node.addEventListener('ap-dismiss', leave)
    window.setTimeout(leave, UI_CONFIG.toast.durationMs[kind] ?? UI_CONFIG.toast.durationMs.info)
  }

  const fade = (toBlack: boolean, ms = UI_CONFIG.fade.defaultMs): Promise<void> => new Promise((resolve) => {
    fading++
    fadeEl.style.transitionDuration = `${Math.max(0, ms)}ms`
    void fadeEl.offsetWidth
    fadeEl.style.opacity = toBlack ? '1' : '0'
    fadeEl.classList.toggle('is-on', toBlack)
    window.setTimeout(() => { fading--; resolve() }, Math.max(0, ms))
  })

  const pushPanel = (p: UIPanel) => {
    if (stack.some((l) => l.panel === p)) return
    p.el.classList.remove('ap-pushed-out')
    p.el.classList.add('ap-pushed', 'ap-pushed-in')
    const layer: Layer = {
      el: p.el,
      fresh: true,
      panel: p,
      input(inp) { p.onInput(inp) },
      update(dt) { p.update?.(dt) },
    }
    push(layer)
    sfx('open')
    p.onShow?.()
  }

  const popPanel = (p: UIPanel) => {
    const layer = stack.find((l) => l.panel === p)
    if (!layer) return
    pull(layer)
    p.el.classList.remove('ap-pushed-in')
    removeAnimated(p.el, 'ap-pushed-out', UI_CONFIG.anim.panelCloseMs)
    sfx('close')
    p.onHide?.()
  }

  return {
    root: layerEl,
    isBlocking: () => stack.length > 0 || fading > 0,
    update(dtSec: number) {
      for (const l of [...stack]) if (stack.includes(l)) l.update?.(dtSec)
      const l = top()
      if (!l) return
      if (l.fresh) { l.fresh = false; return }
      l.input(input)
    },
    say,
    choose,
    confirm,
    prompt,
    list,
    toast,
    fade,
    pushPanel,
    popPanel,
    setPortraitResolver(fn) { portraitResolver = fn ?? defaultPortraitResolver },
    depth: () => stack.length,
    dispose() {
      layerEl.removeEventListener('contextmenu', onContextMenu)
      layerEl.remove()
      stack.length = 0
    },
  }
}
