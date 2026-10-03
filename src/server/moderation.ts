// Text hygiene for untrusted player input: control/format characters, HTML, banned words, names.
// Word lists and rules come from content/moderation.json; limits from CONTENT.config.net.
import { CONTENT, t } from '../shared/content/index.ts'
import { MODERATION, type ModerationFile } from './config.ts'
import { codePointLength, truncateCodePoints } from './util.ts'

// Cc = control, Cf = format (zero-width, bidi overrides), Co/Cs = private-use / lone surrogates.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu
const LINEBREAK_RE = /[\r\n\t\u2028\u2029]+/g
const TAG_RE = /<\/?[A-Za-z!?][^<>]*>/g
const ANGLE_RE = /[<>]/g
const SPACES_RE = /\s+/g
const ASCII_WORD_CHAR = /[a-z0-9]/

interface Matcher {
  mask: string
  ignore: Set<string>
  anywhere: string[]
  whole: string[]
  reserved: Set<string>
  forbiddenName: Set<string>
  maxRepeatRun: number
  minNameLen: number
  uniqueAttempts: number
}

const norm = (s: string): string => s.normalize('NFKC').toLowerCase()

export function createMatcher(mod: ModerationFile = MODERATION): Matcher {
  const ignore = new Set([...mod.ignoreBetween])
  const clean = (w: string) => [...norm(w)].filter((ch) => !ignore.has(ch)).join('')
  return {
    mask: mod.mask,
    ignore,
    anywhere: mod.bannedWords.map(clean).filter(Boolean).sort((a, b) => b.length - a.length),
    whole: mod.bannedWordsWhole.map(clean).filter(Boolean).sort((a, b) => b.length - a.length),
    reserved: new Set(mod.name.reserved.map(clean)),
    forbiddenName: new Set([...mod.name.forbiddenChars]),
    maxRepeatRun: mod.chat.maxRepeatRun,
    minNameLen: mod.name.minLen,
    uniqueAttempts: mod.name.uniqueAttempts,
  }
}

const DEFAULT_MATCHER = createMatcher()

/**
 * Normalized view of `text` with a map back to original code-point indices. `gap[i]` is true when
 * separators were skipped right before normalized char i (used for whole-word boundaries).
 */
function normalizedView(cps: string[], m: Matcher): { chars: string[]; origin: number[]; gap: boolean[] } {
  const chars: string[] = []
  const origin: number[] = []
  const gap: boolean[] = []
  let skipped = false
  cps.forEach((cp, i) => {
    for (const ch of norm(cp)) {
      if (m.ignore.has(ch) || /\s/.test(ch)) { skipped = true; continue }
      chars.push(ch)
      origin.push(i)
      gap.push(skipped)
      skipped = false
    }
  })
  gap.push(skipped)
  return { chars, origin, gap }
}

/** Ranges [startCp, endCp] (inclusive, original code-point indices) of banned words in `text`. */
function findBanned(cps: string[], m: Matcher): [number, number][] {
  const { chars, origin, gap } = normalizedView(cps, m)
  if (chars.length === 0) return []
  const out: [number, number][] = []
  const scan = (word: string, whole: boolean) => {
    const w = [...word]
    for (let i = 0; i + w.length <= chars.length; i++) {
      let ok = true
      for (let j = 0; j < w.length; j++) if (chars[i + j] !== w[j]) { ok = false; break }
      if (!ok) continue
      if (whole) {
        // Whole words must be written contiguously and stand apart from neighbouring ASCII letters/digits.
        let inner = false
        for (let j = 1; j < w.length; j++) if (gap[i + j]) { inner = true; break }
        const end = i + w.length
        const gluedBefore = i > 0 && !gap[i] && ASCII_WORD_CHAR.test(chars[i - 1])
        const gluedAfter = end < chars.length && !gap[end] && ASCII_WORD_CHAR.test(chars[end])
        if (inner || gluedBefore || gluedAfter) continue
      }
      out.push([origin[i], origin[i + w.length - 1]])
    }
  }
  for (const w of m.anywhere) scan(w, false)
  for (const w of m.whole) scan(w, true)
  return out
}

export function containsBanned(text: string, m: Matcher = DEFAULT_MATCHER): boolean {
  return findBanned([...text], m).length > 0
}

/** Replace every banned word (including separators smuggled inside it) with the mask char. */
export function maskBanned(text: string, m: Matcher = DEFAULT_MATCHER): string {
  const cps = [...text]
  const ranges = findBanned(cps, m)
  if (ranges.length === 0) return text
  for (const [a, b] of ranges) for (let i = a; i <= b; i++) if (!/\s/.test(cps[i])) cps[i] = m.mask
  return cps.join('')
}

function collapseRuns(text: string, maxRun: number): string {
  const cps = [...text]
  const out: string[] = []
  let run = 0
  for (let i = 0; i < cps.length; i++) {
    run = i > 0 && cps[i] === cps[i - 1] ? run + 1 : 1
    if (run <= maxRun) out.push(cps[i])
  }
  return out.join('')
}

/** Strip control/format chars and HTML, collapse whitespace and spam runs, cap length. No masking. */
export function cleanText(raw: unknown, maxLen: number, m: Matcher = DEFAULT_MATCHER): string {
  if (typeof raw !== 'string') return ''
  let s = raw.length > maxLen * 8 ? raw.slice(0, maxLen * 8) : raw
  s = s.replace(LINEBREAK_RE, ' ').replace(INVISIBLE_RE, '').replace(TAG_RE, '').replace(ANGLE_RE, '')
  s = s.replace(SPACES_RE, ' ').trim()
  s = collapseRuns(s, m.maxRepeatRun)
  return truncateCodePoints(s, maxLen).trim()
}

/** Chat message pipeline: clean + mask banned words. Empty string means "drop". */
export function sanitizeChat(raw: unknown, m: Matcher = DEFAULT_MATCHER): string {
  return maskBanned(cleanText(raw, CONTENT.config.net.chatMaxLen, m), m)
}

/** Short free text (emotes, nicknames): clean + mask. */
export function sanitizeShort(raw: unknown, maxLen: number, m: Matcher = DEFAULT_MATCHER): string {
  return maskBanned(cleanText(raw, maxLen, m), m)
}

/**
 * Player display name. Returns null when the name is unusable (empty, too short, banned or reserved);
 * callers then fall back to `fallbackName`.
 */
export function sanitizeName(raw: unknown, m: Matcher = DEFAULT_MATCHER): string | null {
  const max = CONTENT.config.net.nameMaxLen
  let s = cleanText(raw, max * 2, m)
  s = [...s].filter((ch) => !m.forbiddenName.has(ch)).join('').replace(SPACES_RE, ' ').trim()
  s = truncateCodePoints(s, max).trim()
  if (codePointLength(s) < m.minNameLen) return null
  if (containsBanned(s, m)) return null
  const key = [...norm(s)].filter((ch) => !m.ignore.has(ch) && !/\s/.test(ch)).join('')
  if (m.reserved.has(key)) return null
  return s
}

export function fallbackName(tag: string): string {
  return truncateCodePoints(t('net.name.fallback', { tag }), CONTENT.config.net.nameMaxLen)
}

/** Make `name` unique among `taken` (case-insensitive) using the net.name.duplicate format. */
export function uniqueName(
  name: string, taken: (n: string) => boolean, tagFor: (attempt: number) => string, m: Matcher = DEFAULT_MATCHER,
): string {
  if (!taken(name)) return name
  const max = CONTENT.config.net.nameMaxLen
  for (let attempt = 0; attempt < m.uniqueAttempts; attempt++) {
    const tag = tagFor(attempt)
    const suffixOnly = t('net.name.duplicate', { name: '', tag })
    const room = Math.max(1, max - codePointLength(suffixOnly))
    const candidate = t('net.name.duplicate', { name: truncateCodePoints(name, room), tag })
    if (!taken(candidate)) return candidate
  }
  return name
}
