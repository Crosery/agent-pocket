import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import audio from '../content/audio.json' with { type: 'json' }
import captionsJson from '../assets_src/music/captions.json' with { type: 'json' }

interface LoopParams {
  crossfadeSeconds: number
  startSearchSeconds: number
  endSearchSeconds: number
  similarityWindowSeconds: number
  minKeepRatio: number
}
interface MusicCategory { durationSeconds: number; durationRange: [number, number]; loop: LoopParams }
interface MusicSection { tag: string; text: string }
type MusicTrack = Record<string, unknown> & { category: string; durationSeconds?: number; sections: MusicSection[] }
interface MusicCaptions {
  paths: Record<string, string>
  generation: { minDurationSeconds: number; maxDurationSeconds: number }
  categories: Record<string, MusicCategory>
  style: Record<string, string>
  template: { description: string; blocks: { heading: string; lines: string[] }[]; section: string }
  tracks: Record<string, MusicTrack>
}
interface ReportEntry { ok: boolean; problems: string[]; output: { codec: string; sampleRate: number; durationSeconds: number } }

const captions = captionsJson as unknown as MusicCaptions
const root = fileURLToPath(new URL('..', import.meta.url))
const bgmIds = audio.bgm.map((b) => b.id)
const PLACEHOLDER = /\{([A-Za-z_][\w.]*)\}/g

function lookup(ctx: Record<string, unknown>, dotted: string): unknown {
  let value: unknown = ctx
  for (const part of dotted.split('.')) {
    if (typeof value !== 'object' || value === null || !(part in value)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

function unresolved(template: string, ctx: Record<string, unknown>): string[] {
  return [...template.matchAll(PLACEHOLDER)]
    .map((m) => m[1])
    .filter((key) => !['string', 'number'].includes(typeof lookup(ctx, key)))
}

test('every bgm track in content/audio.json has a valid caption', () => {
  const errors: string[] = []
  for (const id of bgmIds) {
    const track = captions.tracks[id]
    if (!track) { errors.push(`${id}: missing caption`); continue }
    const category = captions.categories[track.category]
    if (!category) { errors.push(`${id}: unknown category ${track.category}`); continue }
    const duration = track.durationSeconds ?? category.durationSeconds
    const [lo, hi] = category.durationRange
    if (duration < lo || duration > hi) errors.push(`${id}: duration ${duration} outside [${lo}, ${hi}]`)
    if (duration < captions.generation.minDurationSeconds || duration > captions.generation.maxDurationSeconds) {
      errors.push(`${id}: duration ${duration} outside model limits`)
    }
    if (!track.sections?.length) errors.push(`${id}: no sections`)
    const ctx: Record<string, unknown> = { ...category, ...track, id, style: captions.style, sections: '' }
    const templates = [captions.template.description, ...captions.template.blocks.flatMap((b) => b.lines)]
    for (const tpl of templates) for (const key of unresolved(tpl, ctx)) errors.push(`${id}: unresolved {${key}}`)
    for (const section of track.sections ?? []) {
      for (const key of unresolved(captions.template.section, { ...ctx, ...section })) errors.push(`${id}: section {${key}}`)
    }
  }
  assert.deepEqual(errors, [], errors.join('\n'))
})

test('category loop parameters are sane', () => {
  for (const [name, cat] of Object.entries(captions.categories)) {
    assert.ok(cat.loop.crossfadeSeconds > 0, `${name}: crossfade`)
    assert.ok(cat.loop.minKeepRatio > 0 && cat.loop.minKeepRatio <= 1, `${name}: minKeepRatio`)
    assert.ok(cat.loop.startSearchSeconds > 0 && cat.loop.endSearchSeconds > 0, `${name}: search windows`)
    assert.ok(cat.durationRange[0] <= cat.durationSeconds && cat.durationSeconds <= cat.durationRange[1], `${name}: default duration`)
  }
})

test('built BGM files were verified by the pipeline', () => {
  const reportPath = `${root}${captions.paths.report}`
  const report: Record<string, ReportEntry> = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {}
  for (const id of bgmIds) {
    const mp3 = `${root}${captions.paths.outDir}/${id}.mp3`
    if (!existsSync(mp3)) continue
    const entry = report[id]
    assert.ok(entry, `${id}: mp3 present but not in build report`)
    assert.ok(entry.ok, `${id}: ${entry.problems.join(', ')}`)
    assert.equal(entry.output.codec, 'mp3')
  }
})
