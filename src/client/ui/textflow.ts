// Pure text logic shared by dialogue and chat: typewriter reveal, chat command parsing, rate limiting.
import type { SendChannel } from './config.ts'

// ---------------------------------------------------------------------------
// Typewriter
// ---------------------------------------------------------------------------

export interface TypewriterState {
  readonly chars: string[]
  shown: number
  /** Fractional progress toward the next character (0..1). */
  acc: number
  /** Remaining punctuation pause (seconds). */
  pause: number
}

export function createTypewriter(text: string): TypewriterState {
  return { chars: Array.from(text), shown: 0, acc: 0, pause: 0 }
}

export const typewriterDone = (tw: TypewriterState) => tw.shown >= tw.chars.length

export function completeTypewriter(tw: TypewriterState): void {
  tw.shown = tw.chars.length
  tw.acc = 0
  tw.pause = 0
}

/**
 * Advances by dtSec at `cps` characters per second (cps <= 0 reveals everything).
 * Characters in `pauseChars` add a pause of pauseMs after them. Returns the number of newly revealed characters.
 */
export function advanceTypewriter(tw: TypewriterState, dtSec: number, cps: number, pauseChars: string, pauseMs: number): number {
  const len = tw.chars.length
  const before = tw.shown
  if (cps <= 0) { completeTypewriter(tw); return len - before }
  let t = Math.max(0, dtSec)
  while (t > 0 && tw.shown < len) {
    if (tw.pause > 0) {
      const d = Math.min(t, tw.pause)
      tw.pause -= d
      t -= d
      continue
    }
    const need = (1 - tw.acc) / cps
    if (t >= need) {
      t -= need
      tw.acc = 0
      tw.shown++
      if (tw.shown < len && pauseChars.includes(tw.chars[tw.shown - 1])) tw.pause = pauseMs / 1000
    } else {
      tw.acc += t * cps
      t = 0
    }
  }
  return tw.shown - before
}

// ---------------------------------------------------------------------------
// Chat input parsing
// ---------------------------------------------------------------------------

export interface ChatCommands { whisper: string[]; reply: string[]; global: string[]; local: string[] }

export type ChatParse =
  | { kind: 'send'; channel: SendChannel; text: string; to?: string }
  | { kind: 'switch'; channel: 'global' | 'local' }
  | { kind: 'error'; key: 'whisperUsage' | 'noReplyTarget' | 'tooLong' }
  | { kind: 'empty' }

export const codePointLength = (s: string) => Array.from(s).length

export function clampCodePoints(s: string, max: number): string {
  const cps = Array.from(s)
  return cps.length > max ? cps.slice(0, max).join('') : s
}

/**
 * Parses a chat line. `/w name text` whispers, `/r text` replies to `replyTarget`, `/g` `/l` prefixes pick the
 * channel (alone they switch the active channel). Plain text goes to `current`; on the whisper channel it needs
 * `whisperTarget`. Unknown slash words are sent as plain text.
 */
export function parseChatInput(
  raw: string, current: SendChannel, cmds: ChatCommands,
  opts: { maxLen: number; replyTarget: string | null; whisperTarget: string | null },
): ChatParse {
  const text = raw.trim()
  if (!text) return { kind: 'empty' }
  const finish = (channel: SendChannel, body: string, to?: string): ChatParse => {
    const b = body.trim()
    if (codePointLength(b) > opts.maxLen) return { kind: 'error', key: 'tooLong' }
    return to ? { kind: 'send', channel, text: b, to } : { kind: 'send', channel, text: b }
  }
  if (text.startsWith('/')) {
    const m = /^(\S+)\s*([\s\S]*)$/.exec(text)!
    const word = m[1].toLowerCase()
    const rest = m[2]
    const is = (list: string[]) => list.some((c) => c.toLowerCase() === word)
    if (is(cmds.whisper)) {
      const w = /^(\S+)\s+([\s\S]+)$/.exec(rest.trim())
      if (!w) return { kind: 'error', key: 'whisperUsage' }
      return finish('whisper', w[2], w[1])
    }
    if (is(cmds.reply)) {
      if (!opts.replyTarget) return { kind: 'error', key: 'noReplyTarget' }
      if (!rest.trim()) return { kind: 'error', key: 'whisperUsage' }
      return finish('whisper', rest, opts.replyTarget)
    }
    if (is(cmds.global)) return rest.trim() ? finish('global', rest) : { kind: 'switch', channel: 'global' }
    if (is(cmds.local)) return rest.trim() ? finish('local', rest) : { kind: 'switch', channel: 'local' }
  }
  if (current === 'whisper') {
    if (!opts.whisperTarget) return { kind: 'error', key: 'whisperUsage' }
    return finish('whisper', text, opts.whisperTarget)
  }
  return finish(current, text)
}

/** Sliding-window limiter mirroring CONTENT.config.net.chatRate so the player gets feedback before the server rejects. */
export function createRateLimiter(count: number, perSeconds: number) {
  const stamps: number[] = []
  return {
    allow(nowMs: number): boolean {
      const windowStart = nowMs - perSeconds * 1000
      while (stamps.length && stamps[0] <= windowStart) stamps.shift()
      if (stamps.length >= count) return false
      stamps.push(nowMs)
      return true
    },
  }
}

export function clockParts(atMs: number): { h: string; m: string } {
  const d = new Date(atMs)
  return { h: String(d.getHours()).padStart(2, '0'), m: String(d.getMinutes()).padStart(2, '0') }
}
