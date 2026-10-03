// Bottom dialogue box: framed portrait, name plate, typewriter text, bouncing advance indicator.
import type { Settings } from '../../shared/types.ts'
import type { AudioManager, DialogueLine } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import { UI_CONFIG } from './config.ts'
import { advanceTypewriter, completeTypewriter, createTypewriter, typewriterDone, type TypewriterState } from './textflow.ts'
import { el } from './widgets.ts'

export type PortraitResolver = (id: string) => string | null

export interface DialogueBox {
  /** Positioned wrapper (.ap-dlg-wrap); the kit moves it to the top of its stack while a dialogue is active. */
  readonly wrap: HTMLElement
  /** Positioning context for choice windows (aligned to the box's right edge). */
  readonly stage: HTMLElement
  readonly box: HTMLElement
  readonly typing: boolean
  open(): void
  /** Hides after a short linger so consecutive say() calls don't flicker. */
  release(): void
  /** Shows a line (null = no box, e.g. a choice with no prompt). */
  setLine(line: DialogueLine | null, instant?: boolean): void
  finish(): void
  setIndicator(kind: 'more' | 'end' | 'none'): void
  update(dtSec: number): void
}

export function createDialogueBox(audio: AudioManager, getSettings: () => Settings, resolvePortrait: () => PortraitResolver): DialogueBox {
  const cfg = UI_CONFIG.dialogue
  const shown = el('span', { attrs: { 'aria-hidden': 'true' } })
  const hidden = el('span', { class: 'ap-tw-hidden', attrs: { 'aria-hidden': 'true' } })
  const spoken = el('span', 'ap-sr-only')
  const text = el('div', 'ap-dlg-text', [spoken, shown, hidden])
  const name = el('div', 'ap-nameplate')
  const img = el('img', { attrs: { alt: '', draggable: 'false' } })
  const placeholder = el('div', 'ap-dlg-portrait-ph')
  const portrait = el('div', 'ap-dlg-portrait', [img, placeholder])
  const adv = el('div', 'ap-dlg-adv')
  const box = el('div', { class: 'ap-panel ap-dlg', attrs: { role: 'dialog', 'aria-live': 'polite' } }, [portrait, text, name, adv])
  const stage = el('div', 'ap-dlg-stage', [box])
  const wrap = el('div', 'ap-dlg-wrap', [stage])
  wrap.hidden = true

  let tw: TypewriterState = createTypewriter('')
  let lastShown = -1
  let blipCount = 0
  let hideTimer = 0

  img.addEventListener('error', () => { img.hidden = true; placeholder.hidden = false })

  const paintText = () => {
    if (tw.shown === lastShown) return
    lastShown = tw.shown
    shown.textContent = tw.chars.slice(0, tw.shown).join('')
    hidden.textContent = tw.chars.slice(tw.shown).join('')
  }

  const setPortrait = (line: DialogueLine) => {
    const id = line.portrait
    if (!id) { portrait.hidden = true; return }
    portrait.hidden = false
    const url = resolvePortrait()(id)
    const initials = Array.from(line.speaker ?? '').slice(0, cfg.portraitFallbackChars).join('')
    placeholder.textContent = initials
    if (url) {
      img.hidden = false
      placeholder.hidden = true
      if (img.getAttribute('src') !== url) img.src = url
    } else {
      img.hidden = true
      img.removeAttribute('src')
      placeholder.hidden = false
    }
  }

  const api: DialogueBox = {
    wrap,
    stage,
    box,
    get typing() { return !typewriterDone(tw) },
    open() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0 }
      if (wrap.hidden) {
        wrap.hidden = false
        box.classList.remove('ap-anim-in')
        void box.offsetWidth
        box.classList.add('ap-anim-in')
      }
    },
    release() {
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = window.setTimeout(() => {
        hideTimer = 0
        wrap.hidden = true
        stage.classList.remove('no-box')
      }, cfg.lingerMs)
    },
    setLine(line: DialogueLine | null, instant = false) {
      stage.classList.toggle('no-box', !line)
      api.setIndicator('none')
      if (!line) { tw = createTypewriter(''); lastShown = -1; paintText(); return }
      name.textContent = line.speaker ?? ''
      name.hidden = !line.speaker
      setPortrait(line)
      spoken.textContent = line.speaker ? t('ui.dialogue.spoken', { speaker: line.speaker, text: line.text }) : line.text
      tw = createTypewriter(line.text)
      blipCount = 0
      lastShown = -1
      if (instant || cfg.charsPerSecond[getSettings().textSpeed] <= 0) completeTypewriter(tw)
      paintText()
    },
    finish() {
      completeTypewriter(tw)
      paintText()
    },
    setIndicator(kind) {
      adv.classList.toggle('is-on', kind !== 'none')
      adv.classList.toggle('is-end', kind === 'end')
    },
    update(dtSec: number) {
      if (typewriterDone(tw)) return
      const cps = cfg.charsPerSecond[getSettings().textSpeed] ?? cfg.charsPerSecond.normal
      const before = tw.shown
      const added = advanceTypewriter(tw, dtSec, cps, cfg.pause.chars, cfg.pause.ms)
      if (added > 0) {
        let blip = false
        for (let i = before; i < tw.shown; i++) {
          if (/\s/.test(tw.chars[i])) continue
          if (blipCount++ % Math.max(1, cfg.blip.everyChars) === 0) blip = true
        }
        // At most one blip per frame, however many characters a fast speed revealed.
        if (blip) {
          const jitter = (Math.random() * 2 - 1) * cfg.blip.pitchJitter
          audio.playSfx(cfg.blip.sfx, { volume: cfg.blip.volume, pitch: cfg.blip.pitch + jitter })
        }
        paintText()
      }
    },
  }
  return api
}
