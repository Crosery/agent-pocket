// Chat (global / local / whisper), system announcements and emotes.
import type { ClientMsg } from '../shared/protocol.ts'
import { CONTENT, t } from '../shared/content/index.ts'
import { NET, PRESENCE } from './config.ts'
import type { HubCore, Player } from './core.ts'
import { sanitizeChat, sanitizeShort } from './moderation.ts'

type ChatMsg = Extract<ClientMsg, { t: 'chat' }>
type EmoteMsg = Extract<ClientMsg, { t: 'emote' }>

export interface ChatService {
  handleChat(c: Player, msg: ChatMsg): void
  handleEmote(c: Player, msg: EmoteMsg, now?: number): void
  /** Broadcast a system line (channel 'system') to every player. */
  system(key: string, params?: Record<string, string | number>): void
}

const CHANNELS = new Set<string>(['global', 'local', 'whisper'])

export function createChat(core: HubCore): ChatService {
  return {
    handleChat(c, msg) {
      if (!CHANNELS.has(msg.channel)) { core.error(c, 'bad_message'); return }
      if (!c.limits.chat.take()) { core.error(c, 'chat_rate'); return }
      const text = sanitizeChat(msg.text)
      if (!text) { core.error(c, 'chat_empty'); return }
      const at = Date.now()
      if (msg.channel === 'global') {
        core.broadcast(core.players(), { t: 'chat', from: c.id, name: c.name, channel: 'global', text, at })
      } else if (msg.channel === 'local') {
        core.broadcast(core.nearby(c, CONTENT.config.net.localChatRadius, true), { t: 'chat', from: c.id, name: c.name, channel: 'local', text, at })
      } else {
        const target = typeof msg.to === 'string' ? core.find(msg.to) : undefined
        if (!target) { core.error(c, 'not_found'); return }
        if (target === c) { core.error(c, 'self_target'); return }
        core.send(target, { t: 'chat', from: c.id, name: c.name, channel: 'whisper', text, at })
        core.send(c, { t: 'chat', from: c.id, name: t('net.chat.whisperTo', { name: target.name }), channel: 'whisper', text, at })
      }
    },

    handleEmote(c, msg, now = Date.now()) {
      if (!c.limits.emote.take(now)) { core.error(c, 'rate_limited'); return }
      const emote = sanitizeShort(msg.emote, NET.server.emoteMaxLen)
      if (!emote) return
      c.state.emote = emote
      c.emoteUntil = now + NET.server.emoteSeconds * 1000
      core.touch(c)
      core.broadcast(core.nearby(c, PRESENCE.viewRadiusTiles, true), { t: 'emote', id: c.id, emote })
    },

    system(key, params) {
      core.broadcast(core.players(), { t: 'chat', from: '', name: t('net.system.name'), channel: 'system', text: t(key, params), at: Date.now() })
    },
  }
}
