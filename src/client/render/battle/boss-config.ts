// Typed view of content/boss-presentation.json (issue #32): per-boss battle scale, idle theme and the H3 intro
// cut-in manifest. Pure module (no DOM); mechanics stay in bosses.json.
import type { Content } from '../../../shared/content/index.ts'
import presJson from '../../../../content/boss-presentation.json' with { type: 'json' }
import { VFX_SHAPES, type ShotDef, type VfxStep } from './config.ts'

export interface BossBreath { hz: number; squash: number; bob: number }

export interface BossTheme {
  /** Slow float of the whole sprite: amplitude as a fraction of its height, cycles per second. */
  bob: { amp: number; hz: number }
  /** Replaces the creature breathing while the boss is on the field. */
  breath: BossBreath
  /** The steps are spawned together (their `t` is ignored) every this many ms. */
  everyMs: number
  steps: VfxStep[]
}

export interface BossIntroClip {
  src: string
  poster: string
  bytes: number
  width: number
  height: number
  fps: number
  durationSec: number
  /** Where the clip came from, for the manifest only. */
  source: {
    tool: string
    model: string
    taskId: string
    seed: number
    prompt: string
    params: Record<string, unknown>
    firstFrame: string
  }
}

export interface BossEntry {
  species: string
  scale: number
  theme: string
  intro?: BossIntroClip
}

export interface BossIntroConfig {
  maxBytes: number
  /** Give up waiting for the clip to become playable after this long and show the static intro. */
  loadTimeoutMs: number
  /** End the clip early when playback makes no progress for this long. */
  stallMs: number
  fadeInMs: number
  fadeOutMs: number
  holdLastMs: number
  captionDelayMs: number
  /** How long the static (poster + title) intro stays when there is no playable clip. */
  staticHoldMs: number
  prefetch: boolean
  /** Navigator Save-Data and these effective connection types get the static intro without trying the clip. */
  skipOnSaveData: boolean
  slowConnections: string[]
}

export interface BossPresentation {
  frames: Record<string, unknown>
  scaleRange: [number, number]
  framing: { base: ShotDef }
  intro: BossIntroConfig
  themes: Record<string, BossTheme>
  bosses: Record<string, BossEntry>
}

export const BOSS_PRES = presJson as unknown as BossPresentation

export function bossEntry(bossId: string | null | undefined, p: BossPresentation = BOSS_PRES): BossEntry | null {
  return (bossId && p.bosses[bossId]) || null
}

export function bossTheme(bossId: string | null | undefined, p: BossPresentation = BOSS_PRES): BossTheme | null {
  const e = bossEntry(bossId, p)
  return (e && p.themes[e.theme]) || null
}

/** Every glyph the themes use, so the particle atlas can be built with them. */
export function themeGlyphs(p: BossPresentation = BOSS_PRES): string {
  const out = new Set<string>()
  for (const t of Object.values(p.themes)) for (const s of t.steps) if (s.chars) for (const ch of s.chars) out.add(ch)
  return [...out].join('')
}

const HEX = /^#[0-9a-fA-F]{6}$/

/** Problems with the boss presentation content against the boss and species tables (empty = valid). */
export function validateBossPresentation(c: Pick<Content, 'bosses' | 'species'>, p: BossPresentation = BOSS_PRES): string[] {
  const errs: string[] = []
  const [lo, hi] = p.scaleRange
  if (!(lo >= 1 && hi >= lo)) errs.push(`scaleRange: bad range ${lo}..${hi}`)
  for (const id of Object.keys(c.bosses)) if (!p.bosses[id]) errs.push(`bosses.${id}: no presentation entry`)
  for (const [id, b] of Object.entries(p.bosses)) {
    const w = `bosses.${id}`
    const def = c.bosses[id]
    if (!def) errs.push(`${w}: not in bosses.json (orphaned presentation entry)`)
    if (!c.species[b.species]) errs.push(`${w}.species: unknown species "${b.species}"`)
    else if (def && def.species !== b.species) errs.push(`${w}.species: "${b.species}" differs from bosses.json "${def.species}"`)
    if (!(b.scale >= lo && b.scale <= hi)) errs.push(`${w}.scale: ${b.scale} outside ${lo}..${hi}`)
    if (!p.themes[b.theme]) errs.push(`${w}.theme: unknown theme "${b.theme}"`)
    const clip = b.intro
    if (clip) {
      if (!clip.src.endsWith('.mp4') || !clip.poster.endsWith('.jpg')) errs.push(`${w}.intro: src must be .mp4 and poster .jpg`)
      if (!(clip.bytes > 0 && clip.bytes <= p.intro.maxBytes)) errs.push(`${w}.intro.bytes: ${clip.bytes} exceeds ${p.intro.maxBytes}`)
      if (!(clip.durationSec >= 3 && clip.durationSec <= 5.5)) errs.push(`${w}.intro.durationSec: ${clip.durationSec} outside 3..5.5`)
      if (!clip.source?.taskId || !clip.source.prompt) errs.push(`${w}.intro.source: taskId and prompt are required`)
    }
  }
  for (const [name, t] of Object.entries(p.themes)) {
    const w = `themes.${name}`
    if (!(t.everyMs >= 50)) errs.push(`${w}.everyMs: ${t.everyMs}`)
    if (!(t.bob.amp >= 0 && t.bob.hz > 0)) errs.push(`${w}.bob: bad`)
    if (!t.steps.length) errs.push(`${w}.steps: empty`)
    t.steps.forEach((s, i) => {
      if (s.fx !== 'particles') errs.push(`${w}.steps[${i}]: only particles are supported`)
      if (s.shape && !(VFX_SHAPES as readonly string[]).includes(s.shape)) errs.push(`${w}.steps[${i}]: bad shape "${s.shape}"`)
      if (s.shape === 'glyph' && !s.chars) errs.push(`${w}.steps[${i}]: glyph needs chars`)
      for (const col of s.colors ?? []) if (!HEX.test(col)) errs.push(`${w}.steps[${i}]: bad color "${col}"`)
    })
  }
  return errs
}
