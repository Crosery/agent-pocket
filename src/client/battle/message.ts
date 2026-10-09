// Battle message window: typewriter text (speed per Settings.textSpeed), auto-advance or confirm to continue,
// click/tap to skip. Driven by update(dt) from the battle render loop.
import type { Settings } from '../../shared/types.ts'
import type { AudioManager, Input } from '../contracts.ts'
import { advanceTypewriter, completeTypewriter, createTypewriter, typewriterDone, type TypewriterState } from '../ui/textflow.ts'
import { el, panel } from '../ui/widgets.ts'
import { BATTLE_UI } from './config.ts'
import { battleMs } from './speed.ts'

/** 'auto': advances by itself after the configured delay (or on confirm); 'confirm': waits for confirm; 'none': resolves once typed. */
export type MessageWait = 'auto' | 'confirm' | 'none'

export interface MessageBox {
  readonly el: HTMLElement
  show(text: string, wait?: MessageWait): Promise<void>
  /** Shows text instantly and keeps it (prompts next to menus). */
  hold(text: string): void
  clear(): void
  readonly waiting: boolean
  /** Finishes typing / advances. Returns true when it consumed the action. */
  advance(): boolean
  input(inp: Input): boolean
  update(dtSec: number): void
}

export function createMessageBox(audio: AudioManager, settings: () => Settings, pace: () => Pick<Settings, 'battleSpeed'> = settings): MessageBox {
  const M = BATTLE_UI.message
  const shown = el('span')
  const hidden = el('span', 'apb-tw-hidden')
  const text = el('div', { class: 'apb-msg-text', attrs: { 'aria-live': 'polite' } }, [shown, hidden])
  const adv = el('div', 'apb-msg-adv')
  const p = panel(null, { className: 'apb-msg' })
  p.body.append(text)
  p.el.append(adv)

  let tw: TypewriterState = createTypewriter('')
  let lastShown = -1
  let wait: MessageWait = 'none'
  let held = 0
  let blips = 0
  let resolve: (() => void) | null = null

  const paint = () => {
    if (tw.shown === lastShown) return
    lastShown = tw.shown
    shown.textContent = tw.chars.slice(0, tw.shown).join('')
    hidden.textContent = tw.chars.slice(tw.shown).join('')
  }
  const done = () => {
    const r = resolve
    resolve = null
    adv.classList.remove('is-on')
    r?.()
  }
  const setText = (s: string, instant: boolean) => {
    done()
    tw = createTypewriter(s)
    lastShown = -1
    held = 0
    blips = 0
    if (instant || M.charsPerSecond[settings().textSpeed] <= 0) completeTypewriter(tw)
    paint()
  }

  const api: MessageBox = {
    el: p.el,
    show(s, w = M.autoAdvance ? 'auto' : 'confirm') {
      setText(s, false)
      wait = w
      return new Promise<void>((r) => { resolve = r })
    },
    hold(s) {
      setText(s, true)
      wait = 'none'
    },
    clear() {
      setText('', true)
      wait = 'none'
    },
    get waiting() { return resolve !== null },
    advance() {
      if (!resolve) return false
      if (!typewriterDone(tw)) { completeTypewriter(tw); paint(); return true }
      audio.playSfx(BATTLE_UI.sfx.advance)
      done()
      return true
    },
    input(inp) {
      if (!resolve) return false
      if (inp.pressed('confirm') || inp.pressed('cancel')) {
        inp.consume('confirm')
        inp.consume('cancel')
        api.advance()
        return true
      }
      return false
    },
    update(dt) {
      if (!typewriterDone(tw)) {
        const speed = settings().textSpeed
        const before = tw.shown
        advanceTypewriter(tw, dt, M.charsPerSecond[speed] ?? M.charsPerSecond.normal, M.pause.chars, M.pause.ms)
        let blip = false
        for (let i = before; i < tw.shown; i++) if (!/\s/.test(tw.chars[i]) && blips++ % M.blip.everyChars === 0) blip = true
        if (blip) audio.playSfx(M.blip.sfx, { volume: M.blip.volume, pitch: M.blip.pitch })
        paint()
        return
      }
      if (!resolve) return
      if (wait === 'none') { done(); return }
      adv.classList.add('is-on')
      if (wait === 'auto') {
        held += battleMs(dt, pace())
        if (held >= M.autoAdvanceMs[settings().textSpeed]) done()
      }
    },
  }
  p.el.addEventListener('click', (e) => { e.stopPropagation(); api.advance() })
  return api
}
