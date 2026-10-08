// Chat: passive fading log (bottom-left) + open panel with channel tabs, input field and slash commands.
// Open with the 'chat' action (call update() per frame) or focus(); Enter sends, Esc closes, Tab cycles channel.
// Single source of truth: the chat is open exactly while focus is inside its box (input or own controls). Focus
// leaving the box closes it (focusout, every update() and every isOpen read), so a click elsewhere hands the keys
// straight back to the game. A stall watch releases it if movement keys are held against it with no input focus.
import type { ChatChannel } from '../../shared/protocol.ts'
import type { ChatUI, Input } from '../contracts.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { UI_CONFIG, type ChatTab, type SendChannel } from './config.ts'
import { ensureUIEnvironment, getUIScale, onUIScaleChange, prepareRoot } from './scale.ts'
import { bindTextField } from './focus.ts'
import { chatFocusVerdict, createStallWatch } from './focus-guard.ts'
import { clampCodePoints, clockParts, codePointLength, createRateLimiter, parseChatInput } from './textflow.ts'
import { button, el, glyphEl, tabs } from './widgets.ts'

export interface ChatUIHandle extends ChatUI {
  readonly el: HTMLElement
  readonly isOpen: boolean
  /** Per-frame: opens on the 'chat' action when allowOpen; pass false while menus/dialogue own input (hides the passive log). */
  update(dtSec: number, allowOpen?: boolean): void
  close(): void
  setCollapsed(collapsed: boolean): void
  dispose(): void
}

interface Entry { name: string; channel: ChatChannel; text: string; at: number; self: boolean; label: string }

const CFG = UI_CONFIG.chat

export function createChatUI(
  root: HTMLElement, input: Input,
  onSend: (channel: 'global' | 'local' | 'whisper', text: string, to?: string) => void,
): ChatUIHandle {
  ensureUIEnvironment()
  prepareRoot(root)
  const maxLen = CONTENT.config.net.chatMaxLen
  const limiter = createRateLimiter(CONTENT.config.net.chatRate.count, CONTENT.config.net.chatRate.perSeconds)

  const entries: Entry[] = []
  let open = false
  let collapsed = false
  let tab: ChatTab = CFG.tabs[0]
  let sendChannel: SendChannel = CFG.defaultChannel
  let replyTarget: string | null = null
  let whisperTarget: string | null = null
  const sentWhispers: string[] = []
  let unread = 0
  let idleTimer = 0
  let hovering = false
  /** Set when the chat was opened by keyboard-activating the Chat button: Esc then returns focus to it. */
  let restoreFocus = false
  const stall = createStallWatch(UI_CONFIG.focus.stallSec)

  // ---- passive view
  const passiveLog = el('div', { class: 'ap-chat-log', attrs: { 'aria-hidden': 'true' } })
  const unreadEl = el('span', 'ap-chat-unread')
  const openBtn = button('', (e) => { restoreFocus = e.detail === 0; api.focus() }, { className: 'ap-chat-open ap-hud-frame' })
  openBtn.append(glyphEl('chat'))
  openBtn.setAttribute('aria-label', t('ui.chat.open'))
  openBtn.setAttribute('aria-controls', 'ap-chat-box')
  openBtn.title = t('ui.chat.open')
  const collapseBtn = button('', () => api.setCollapsed(!collapsed), { className: 'ap-chat-collapse' })
  const bar = el('div', 'ap-chat-bar', [openBtn, collapseBtn, unreadEl])

  // ---- open view
  const tabStrip = tabs(CFG.tabs.map((k) => t(`ui.chat.tab.${k}`)), {
    onChange: (i) => {
      tab = CFG.tabs[i]
      if (tab === 'global' || tab === 'local') setSendChannel(tab)
      else if (tab === 'whisper' && whisperTarget) setSendChannel('whisper')
      renderOpen()
      field.focus()
    },
  })
  const openLog = el('div', { class: 'ap-chat-log', attrs: { role: 'log', 'aria-live': 'polite', tabindex: '-1' } })
  const chanBtn = button('', () => { cycleChannel(); field.focus() }, { className: 'ap-chat-chan' })
  const field = el('input', {
    class: 'ap-field',
    attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'send', placeholder: t('ui.chat.placeholder'), 'aria-label': t('ui.chat.title') },
  })
  const count = el('span', 'ap-field-count')
  const sendBtn = button(t('ui.chat.send'), () => submit(), { primary: true })
  const box = el('div', { class: 'ap-panel ap-chat-box ap-hud-frame', attrs: { id: 'ap-chat-box' } }, [
    tabStrip.el,
    openLog,
    el('div', 'ap-chat-input-row', [chanBtn, field, count, sendBtn]),
    el('div', { class: 'ap-chat-hint', text: t('ui.chat.switchHint') }),
  ])

  const wrap = el('div', 'ap-chat', [passiveLog, bar, box])
  const layer = el('div', 'ap-layer ap-l-chat', [wrap])
  root.append(layer)

  const colorOf = (ch: ChatChannel) => CFG.channelColors[ch] ?? CFG.channelColors.local

  const line = (e: Entry) => {
    const time = clockParts(e.at)
    const node = el('div', { class: `ap-chat-line${e.self ? ' is-self' : ''}`, data: { ch: e.channel }, vars: { '--ch-c': colorOf(e.channel) } }, [
      el('span', { class: 'ap-chat-time', text: t('ui.chat.time', time) }),
      el('span', { class: 'ap-chat-ch', text: t('ui.chat.tag', { channel: t(`ui.chat.channel.${e.channel}`) }), style: { color: colorOf(e.channel) } }),
      e.label ? el('span', { class: 'ap-chat-name', text: t('ui.chat.speaker', { name: e.label }) }) : null,
      el('span', { class: 'ap-chat-text', text: e.text }),
    ])
    return node
  }

  const passiveLines = () => (getUIScale().compact ? CFG.compactPassiveLines : CFG.passiveLines)

  const renderPassive = () => {
    const n = passiveLines()
    passiveLog.style.setProperty('--lines', String(n))
    passiveLog.replaceChildren(...entries.slice(-n).map(line))
  }
  const renderOpen = () => {
    openLog.style.setProperty('--lines', String(CFG.openLines))
    const shown = tab === 'all' ? entries : entries.filter((e) => e.channel === tab)
    openLog.replaceChildren(...shown.map(line))
    openLog.scrollTop = openLog.scrollHeight
  }
  const renderBar = () => {
    const label = collapsed ? t('ui.chat.expand') : t('ui.chat.collapse')
    collapseBtn.replaceChildren(glyphEl(collapsed ? 'scrollUp' : 'scrollDown'))
    collapseBtn.setAttribute('aria-label', label)
    collapseBtn.title = label
    collapseBtn.hidden = entries.length === 0
    openBtn.setAttribute('aria-expanded', String(open))
    unreadEl.textContent = collapsed && unread > 0 ? t('ui.chat.unread', { n: unread }) : ''
    wrap.classList.toggle('is-collapsed', collapsed)
  }
  const recount = () => { count.textContent = t('ui.chat.count', { n: codePointLength(field.value), max: maxLen }) }

  const setSendChannel = (ch: SendChannel) => {
    sendChannel = ch
    const label = ch === 'whisper' && whisperTarget ? t('ui.chat.whisperTo', { name: whisperTarget }) : t(`ui.chat.channel.${ch}`)
    chanBtn.textContent = label
    chanBtn.style.setProperty('--ch-c', colorOf(ch))
  }
  const cycleChannel = () => {
    const order: SendChannel[] = whisperTarget ? ['global', 'local', 'whisper'] : ['global', 'local']
    const i = order.indexOf(sendChannel)
    setSendChannel(order[(i + 1) % order.length])
  }

  const wake = () => {
    wrap.classList.remove('is-idle')
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = window.setTimeout(() => { idleTimer = 0; if (!open && !hovering) wrap.classList.add('is-idle') }, CFG.idleFadeMs)
  }

  const push = (e: Entry) => {
    entries.push(e)
    if (entries.length > CFG.maxLines) entries.splice(0, entries.length - CFG.maxLines)
    if (collapsed && !open) unread++
    renderPassive()
    if (open) {
      const atBottom = openLog.scrollHeight - openLog.scrollTop - openLog.clientHeight < 4
      if (tab === 'all' || tab === e.channel) {
        openLog.append(line(e))
        while (openLog.childElementCount > CFG.maxLines) openLog.firstElementChild?.remove()
        if (atBottom || e.self) openLog.scrollTop = openLog.scrollHeight
      }
    }
    renderBar()
    wake()
  }

  const systemNote = (text: string) => push({ name: '', channel: 'system', text, at: Date.now(), self: false, label: '' })

  const textMode = bindTextField(input, field)
  const wantsToMove = () => { const a = input.axis(); return a.x !== 0 || a.y !== 0 }
  const focusInside = () => box.contains(document.activeElement)
  /** Re-checks the open <-> focus invariant; closes a chat whose focus has gone elsewhere. */
  const settle = () => {
    if (chatFocusVerdict(open, focusInside()) === 'close') api.close()
  }

  const submit = () => {
    const parsed = parseChatInput(field.value, sendChannel, CFG.commands, { maxLen, replyTarget, whisperTarget })
    if (parsed.kind === 'empty') { api.close(); return }
    if (parsed.kind === 'switch') { setSendChannel(parsed.channel); field.value = ''; recount(); return }
    if (parsed.kind === 'error') {
      systemNote(t(`ui.chat.${parsed.key}`, { max: maxLen }))
      return
    }
    if (!limiter.allow(Date.now())) { systemNote(t('ui.chat.tooFast')); return }
    if (parsed.channel === 'whisper' && parsed.to) {
      sentWhispers.push(parsed.to)
      if (sentWhispers.length > CFG.maxLines) sentWhispers.shift()
      whisperTarget = parsed.to
    }
    onSend(parsed.channel, parsed.text, parsed.to)
    field.value = ''
    recount()
    if (CFG.closeOnSend) api.close()
  }

  field.addEventListener('input', () => {
    const clamped = clampCodePoints(field.value, maxLen)
    if (clamped !== field.value) field.value = clamped
    recount()
  })
  field.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close() }
    else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); cycleChannel() }
  })
  // Focus moving anywhere outside the box (canvas click, other UI) ends the chat. Decided one task later: when the
  // whole window loses focus the input stays the active element and must keep the chat open for when it returns.
  wrap.addEventListener('focusout', (e) => {
    if (e.relatedTarget instanceof Node && box.contains(e.relatedTarget)) return
    window.setTimeout(settle, 0)
  })
  // A click inside the panel must not strand focus on a button or on the page: the input keeps it, except in the
  // log, where focus stays inside the box so text can still be selected and copied.
  box.addEventListener('mousedown', (e) => {
    if (e.target !== field && !openLog.contains(e.target as Node)) e.preventDefault()
  })
  openLog.addEventListener('pointerup', () => {
    if (open && window.getSelection()?.isCollapsed !== false) field.focus({ preventScroll: true })
  })
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!open) {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        return
      }
      e.preventDefault()
      api.close()
    }
    // Typing, and the keys native buttons / focus traversal need, stay in the chat; movement and menu keys pass
    // through so a button that happens to hold focus never freezes the game.
    const nativeKey = e.key === 'Tab' || ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLButtonElement)
    if (e.target === field || nativeKey || e.key === 'Escape') e.stopPropagation()
  })
  wrap.addEventListener('pointerenter', () => { hovering = true; wrap.classList.remove('is-idle') })
  wrap.addEventListener('pointerleave', () => { hovering = false; wake() })

  const unsubscribe = onUIScaleChange(() => renderPassive())

  const api: ChatUIHandle = {
    el: wrap,
    get isOpen() { settle(); return open },
    addMessage(m) {
      let label = m.name
      if (m.channel === 'whisper') {
        if (m.self) label = t('ui.chat.whisperTo', { name: sentWhispers.shift() ?? m.name })
        else {
          label = t('ui.chat.whisperFrom', { name: m.name })
          replyTarget = m.name
          whisperTarget = m.name
        }
      } else if (m.channel === 'system') label = m.name
      push({ name: m.name, channel: m.channel, text: m.text, at: m.at, self: !!m.self, label })
    },
    focus() {
      if (layer.hidden) return
      if (!open) {
        open = true
        unread = 0
        collapsed = false
        wrap.classList.add('is-open')
        wrap.classList.remove('is-idle')
        renderOpen()
        renderBar()
        wrap.dispatchEvent(new CustomEvent('ap-hud-expand', { bubbles: true }))
      }
      setSendChannel(sendChannel)
      recount()
      field.focus()
      settle()
    },
    close() {
      if (!open) return
      const keepHud = restoreFocus && focusInside() && !layer.hidden
      restoreFocus = false
      open = false
      wrap.classList.remove('is-open')
      field.blur()
      if (focusInside() && document.activeElement instanceof HTMLElement) document.activeElement.blur()
      textMode.release()
      if (keepHud) openBtn.focus({ preventScroll: true })
      stall.reset()
      renderPassive()
      renderBar()
      wake()
    },
    setVisible(v: boolean) {
      layer.hidden = !v
      if (!v) api.close()
    },
    setCollapsed(c: boolean) {
      collapsed = c
      if (!c) unread = 0
      renderBar()
    },
    update(dtSec: number, allowOpen = true) {
      settle()
      if (open) {
        // Last resort: movement keys held against an open chat that has no focused input would trap the player.
        const blocked = document.activeElement !== field
        if (stall.step(dtSec, blocked, blocked && wantsToMove())) {
          console.warn('[chat] released a chat that was open without input focus while movement keys were held')
          api.close()
        }
      }
      // While menus/dialogue own the screen the passive log steps aside.
      wrap.classList.toggle('is-suppressed', !allowOpen && !open)
      if (!open && allowOpen && !layer.hidden && input.pressed('chat')) {
        input.consume('chat')
        restoreFocus = false
        api.focus()
      }
    },
    dispose() {
      if (idleTimer) clearTimeout(idleTimer)
      unsubscribe()
      api.close()
      layer.remove()
    },
  }
  setSendChannel(sendChannel)
  renderPassive()
  renderBar()
  wake()
  return api
}
