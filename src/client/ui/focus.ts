// DOM glue for focus hand-over between text fields, HUD buttons and the game's Input (rules: focus-guard.ts).
import type { Input } from '../contracts.ts'
import type { EscapeStack } from './focus-guard.ts'

/**
 * Mirrors focus on a text field into Input's text mode. Leaving it is deferred two frames so the Enter / Esc
 * that blurred the field cannot leak into gameplay; `release()` forces that check for explicit closes.
 */
export function bindTextField(input: Input, field: HTMLElement): { release(): void } {
  const release = () => {
    requestAnimationFrame(() => requestAnimationFrame(() => { if (document.activeElement !== field) input.setTextInputActive(false) }))
  }
  field.addEventListener('focus', () => input.setTextInputActive(true))
  field.addEventListener('blur', release)
  return { release }
}

/**
 * A button that keeps focus after a pointer click turns Space / Enter into a re-click and (inside its own
 * keydown handlers) can swallow movement keys. Buttons under one of `scopes` hand focus back to the page after
 * a pointer click; keyboard activation (click detail 0) keeps it.
 */
export function releaseButtonFocusAfterClick(root: HTMLElement, scopes: readonly string[]): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.detail === 0) return
    // composedPath() because a handler may already have replaced the clicked glyph inside the button.
    const button = e.composedPath().find((n): n is HTMLButtonElement => n instanceof HTMLButtonElement)
    if (!button || !scopes.some((scope) => button.closest(scope))) return
    if (document.activeElement === button) button.blur()
  }
  root.addEventListener('click', onClick)
  return () => root.removeEventListener('click', onClick)
}

/**
 * Esc dismisses the topmost open overlay whichever element holds focus. Capture phase on the window, so no
 * element handler that stops propagation can swallow it, and the game's own Esc (menu) does not also fire.
 */
export function installEscapeFallback(stack: EscapeStack, target: EventTarget = window): () => void {
  const onKey = (e: Event) => {
    const k = e as KeyboardEvent
    // Esc inside an IME composition only cancels the composition.
    if (k.key !== 'Escape' || k.isComposing || k.keyCode === 229) return
    if (stack.dismissTop() === null) return
    k.preventDefault()
    k.stopImmediatePropagation()
  }
  target.addEventListener('keydown', onKey, { capture: true })
  return () => target.removeEventListener('keydown', onKey, { capture: true })
}
