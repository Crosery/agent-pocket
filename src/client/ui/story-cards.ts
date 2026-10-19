// Story presentation panels run by the 'chapter' and 'message' script ops (world/controller.ts wires them into the
// script host): the cinematic chapter title card and the phone chat thread. Timings and sfx: content/ui.json
// storyCards; texts: story.chapter.<id>.* (content/text/zh-CN/story.json) and ui.story.* (ui.json).
import type { GameContext, Input, UIPanel } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import { chapterById, chapterTextKey, type ChapterPart } from '../../shared/world/chapters.ts'
import { UI_CONFIG } from './config.ts'
import { actionKeyLabel, el } from './widgets.ts'
import './story-cards.css'

export interface PhoneMessage {
  /** Contact name heading the thread. */
  from: string
  /** Incoming bubbles, shown one by one after a typing indicator. */
  lines: string[]
  /** The player's earlier message at the top of the thread. */
  ask?: string
  /** The player's answer, sent after the last incoming bubble. */
  reply?: string
  /** Portrait id of the contact (absent or unknown: the first character of the name). */
  avatar?: string
}

const pressedAny = (input: Input): boolean => {
  if (!input.pressed('confirm') && !input.pressed('cancel') && !input.pressed('menu')) return false
  input.consume('confirm'); input.consume('cancel'); input.consume('menu')
  return true
}

const hintText = (ctx: GameContext, keyText: string, touchText: string): string =>
  ctx.input.lastDevice === 'touch' ? t(touchText) : t(keyText, { key: actionKeyLabel('confirm', ctx.input.lastDevice) })

/** Letterboxed chapter title card: chapter number, the title revealed glyph by glyph, town, quote and goal. */
export function showChapterCard(ctx: GameContext, chapterId: string): Promise<void> {
  const cfg = UI_CONFIG.storyCards.chapter
  const ch = chapterById(chapterId)
  const part = (p: ChapterPart) => t(chapterTextKey(chapterId, p))
  const town = ch ? ctx.data.world.towns.find((x) => x.id === ch.town)?.nameZh ?? '' : ''
  const title = part('title')
  const chars = Array.from(title)
  const titleEl = el('div', { class: 'aps-ch-title', attrs: { 'aria-label': title } }, chars.map((c, i) =>
    el('span', { class: 'aps-ch-glyph', text: c, vars: { '--i': i }, attrs: { 'aria-hidden': 'true' } })))
  const settle = cfg.titleDelayMs + chars.length * cfg.titleStepMs
  const root = el('div', {
    class: 'aps-screen ap-fullscreen aps-chapter',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': `${part('no')} ${title}` },
    vars: { '--ch-step': `${cfg.titleStepMs}ms`, '--ch-delay': `${cfg.titleDelayMs}ms`, '--ch-settle': `${settle}ms` },
  }, [
    el('div', 'aps-ch-bar is-top'),
    el('div', 'aps-ch-center', [
      el('div', 'aps-ch-no', [el('span', { class: 'aps-ch-gem', text: '◆' }), el('span', { text: part('no') }), el('span', { class: 'aps-ch-gem', text: '◆' })]),
      titleEl,
      el('div', 'aps-ch-rule'),
      town ? el('div', { class: 'aps-ch-town', text: town }) : null,
      el('div', { class: 'aps-ch-quote', text: part('quote') }),
    ]),
    el('div', 'aps-ch-bar is-bottom', [
      el('div', 'aps-ch-goal', [el('span', { class: 'aps-ch-goal-k', text: t('ui.story.chapter.goal') }), el('span', { class: 'aps-ch-goal-v', text: part('goal') })]),
      el('div', { class: 'aps-ch-hint', text: hintText(ctx, 'ui.story.chapter.next', 'ui.story.chapter.nextTouch') }),
    ]),
  ])
  if (ch) root.dataset.chapter = ch.id
  ctx.audio.playSfx(cfg.sfx)

  return new Promise<void>((resolve) => {
    const opened = performance.now()
    let closed = false
    let timer = 0
    const close = () => {
      if (closed) return
      closed = true
      window.clearTimeout(timer)
      root.classList.add('is-leaving')
      window.setTimeout(() => { ctx.ui.popPanel(api); resolve() }, cfg.leaveMs)
    }
    // Early presses (a confirm still held from the line before) don't skip the card before it can be read.
    const tryClose = () => { if (performance.now() - opened >= cfg.minMs) close() }
    const api: UIPanel = {
      el: root,
      onInput(input: Input) {
        if (pressedAny(input)) tryClose()
        return true
      },
    }
    root.addEventListener('pointerdown', (e) => { e.preventDefault(); tryClose() })
    ctx.ui.pushPanel(api)
    if (cfg.autoCloseMs > 0) timer = window.setTimeout(close, cfg.autoCloseMs + settle)
  })
}

/** A chat thread on a pixel phone: `ask` sits on top, `lines` arrive after a typing indicator, then `reply` goes out. */
export function showPhoneMessage(ctx: GameContext, m: PhoneMessage): Promise<void> {
  const cfg = UI_CONFIG.storyCards.phone
  const url = m.avatar ? ctx.assets.portraitUrl(m.avatar) : null
  const initial = Array.from(m.from)[0] ?? ''
  const avatar = el('div', `aps-pm-avatar${m.avatar?.startsWith('creature:') ? ' is-creature' : ''}`, [
    url ? el('img', { attrs: { src: url, alt: '', draggable: 'false' } }) : el('span', { text: initial }),
  ])
  const thread = el('div', { class: 'aps-pm-thread', attrs: { 'aria-live': 'polite' } })
  const hint = el('div', 'aps-pm-hint')
  const device = el('div', 'aps-pm-device', [
    el('div', 'aps-pm-notch'),
    el('div', 'aps-pm-head', [avatar, el('div', 'aps-pm-who', [el('div', { class: 'aps-pm-name', text: m.from }), el('div', { class: 'aps-pm-online', text: t('ui.story.phone.online') })])]),
    thread,
    el('div', 'aps-pm-foot', [hint]),
  ])
  const root = el('div', {
    class: 'aps-screen ap-fullscreen aps-phone-msg',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('ui.story.phone.label', { from: m.from }) },
  }, [device])

  // An incoming line opening with a thinking-time stamp (ui.json dialogue.thought) is a reasoning block: chip + dim text.
  const thoughtRe = new RegExp(UI_CONFIG.dialogue.thought.pattern)
  const bubble = (text: string, out: boolean) => {
    const stamp = out ? null : thoughtRe.exec(text)
    if (!stamp) return el('div', { class: `aps-pm-bubble ${out ? 'is-out' : 'is-in'}`, text })
    return el('div', 'aps-pm-bubble is-in is-thought', [
      el('div', { class: 'aps-pm-thought', text: t(UI_CONFIG.dialogue.thought.text, { sec: stamp[1] ?? '' }) }),
      el('div', { class: 'aps-pm-thought-text', text: text.slice(stamp[0].length).trimStart() }),
    ])
  }
  const scroll = () => { thread.scrollTop = thread.scrollHeight }
  // The thread as a timeline: each beat waits `ms`, then runs.
  const beats: { ms: number; run: () => void }[] = []
  let typing: HTMLElement | null = null
  const stopTyping = () => { typing?.remove(); typing = null }
  if (m.ask) thread.append(bubble(m.ask, true))
  m.lines.forEach((line, i) => {
    beats.push({ ms: i === 0 ? cfg.firstMs : cfg.gapMs, run: () => {
      typing = el('div', { class: 'aps-pm-bubble is-in is-typing', attrs: { 'aria-label': t('ui.story.phone.typing') } }, [el('i'), el('i'), el('i')])
      thread.append(typing)
      scroll()
    } })
    beats.push({ ms: Math.min(cfg.maxTypingMs, cfg.typingMs + Array.from(line).length * cfg.perCharMs), run: () => {
      stopTyping()
      thread.append(bubble(line, false))
      ctx.audio.playSfx(cfg.lineSfx)
      scroll()
    } })
  })
  if (m.reply) {
    const reply = m.reply
    beats.push({ ms: cfg.replyMs, run: () => { thread.append(bubble(reply, true)); ctx.audio.playSfx(cfg.replySfx); scroll() } })
  }
  const setHint = (done: boolean) => {
    hint.textContent = done
      ? hintText(ctx, 'ui.story.phone.close', 'ui.story.phone.closeTouch')
      : hintText(ctx, 'ui.story.phone.skip', 'ui.story.phone.skipTouch')
    hint.classList.toggle('is-done', done)
  }
  setHint(beats.length === 0)
  ctx.audio.playSfx(cfg.openSfx)

  return new Promise<void>((resolve) => {
    let next = 0
    let wait = beats[0]?.ms ?? 0
    let closed = false
    const done = () => next >= beats.length
    const finishAll = () => {
      while (!done()) beats[next++].run()
      stopTyping()
      setHint(true)
    }
    const close = () => {
      if (closed) return
      closed = true
      root.classList.add('is-leaving')
      window.setTimeout(() => { ctx.ui.popPanel(api); resolve() }, cfg.leaveMs)
    }
    // The first press shows the whole thread at once, the next one puts the phone away.
    const press = () => { if (done()) close(); else finishAll() }
    const api: UIPanel = {
      el: root,
      onInput(input: Input) {
        if (pressedAny(input)) press()
        return true
      },
      update(dtSec: number) {
        if (closed || done()) return
        wait -= dtSec * 1000
        while (!done() && wait <= 0) {
          beats[next++].run()
          wait += beats[next]?.ms ?? 0
        }
        if (done()) setHint(true)
      },
    }
    root.addEventListener('pointerdown', (e) => { e.preventDefault(); press() })
    ctx.ui.pushPanel(api)
  })
}
