// Compiles song data (content/audio/songs.json) into timed note / drum events. Pure — no WebAudio.
//
// Pitched bar strings are whitespace-separated tokens; the token count must divide the bar's steps and
// every token spans an equal share of the bar:
//   .        rest              -        hold (ties the previous note, also across bars)
//   5  #4  b7  1'  6,         scale degree (melody tracks), octave marks ' (up) , (down)
//   c1 c3'                    chord tone (melody tracks)      s5  scale degree (chord tracks)
//   1 2 3 R                   chord tone (chord tracks; R = root)
//   C                         every chord tone (stab)
//   suffix ! accent, ? soft
// Chords: "<[#|b]degree>[:quality]"; no quality = diatonic triad, ":dN" = diatonic N-note stack.
// Drum bars map kit-piece ids to hit strings: x hit, X accent, o soft, . rest.
import { MIX, SONGS } from './audio-data.ts'
import type { MixFile, SongDef, SongsFile, TrackDef } from './audio-data.ts'

/** Music-theory structure (not game data): natural pitch classes. */
const NATURAL_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

export interface CompiledNote { step: number; len: number; midi: number[]; vel: number }
export interface CompiledDrum { step: number; piece: string; vel: number }
export interface CompiledBar { notes: CompiledNote[]; drums: CompiledDrum[] }
export interface CompiledTrack { index: number; def: TrackDef; bars: CompiledBar[] }
export interface CompiledSong {
  id: string
  def: SongDef
  stepsPerBar: number
  stepsPerBeat: number
  stepSec: number
  barSec: number
  swing: number
  loopFrom: number
  length: number
  tracks: CompiledTrack[]
}

export function pitchClass(name: string): number | null {
  const m = /^([A-Ga-g])([#b]?)$/.exec(name.trim())
  if (!m) return null
  const base = NATURAL_PC[m[1].toUpperCase()]
  return (base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12
}

/** 'C4' -> 60, 'F#5' -> 78, 'Bb2' -> 46. */
export function noteToMidi(name: string): number | null {
  const m = /^([A-Ga-g][#b]?)(-?\d)$/.exec(name.trim())
  if (!m) return null
  const pc = pitchClass(m[1])
  if (pc === null) return null
  const letter = m[1][0].toUpperCase()
  // B# / Cb cross the octave boundary.
  const octaveFix = letter === 'B' && m[1][1] === '#' ? 1 : letter === 'C' && m[1][1] === 'b' ? -1 : 0
  return 12 * (Number(m[2]) + 1 + octaveFix) + pc
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

const accidental = (s: string) => (s === '#' ? 1 : s === 'b' ? -1 : 0)
const octaveMarks = (s: string) => [...s].reduce((n, ch) => n + (ch === "'" ? 1 : ch === ',' ? -1 : 0), 0)

function scaleSemis(scale: number[], degree: number, acc: number): number {
  const i = degree - 1
  const n = scale.length
  return scale[((i % n) + n) % n] + 12 * Math.floor(i / n) + acc
}

/** Chord tones as semitones relative to the key tonic, ascending from the root. */
export function parseChord(token: string, scale: number[], qualities: Record<string, number[]>): number[] {
  const m = /^([#b]?)(\d+)(?::([\w#+-]+))?$/.exec(token)
  if (!m) throw new Error(`bad chord "${token}"`)
  const degree = Number(m[2])
  if (degree < 1) throw new Error(`bad chord degree "${token}"`)
  const acc = accidental(m[1])
  const root = scaleSemis(scale, degree, acc)
  const q = m[3]
  if (q === undefined || /^d\d$/.test(q)) {
    const count = q === undefined ? 3 : Number(q.slice(1))
    return Array.from({ length: count }, (_, k) => scaleSemis(scale, degree + 2 * k, acc))
  }
  const intervals = qualities[q]
  if (!intervals) throw new Error(`unknown chord quality "${q}" in "${token}"`)
  return intervals.map((iv) => root + iv)
}

function chordTone(tones: number[], index: number): number {
  const k = index - 1
  const n = tones.length
  return tones[((k % n) + n) % n] + 12 * Math.floor(k / n)
}

interface Ctx {
  where: string
  song: SongDef
  scale: number[]
  tonicMidi: (octave: number) => number
  qualities: Record<string, number[]>
  mix: MixFile
}

const TOKEN = /^(C|R|[cs]?[#b]?\d+)([',]*)([!?]?)$/

function parseToken(tok: string, track: TrackDef, chord: number[], ctx: Ctx): { midi: number[]; vel: number } {
  const m = TOKEN.exec(tok)
  if (!m) throw new Error(`${ctx.where}: bad token "${tok}"`)
  const head = m[1]
  const shift = 12 * octaveMarks(m[2])
  const vel = m[3] === '!' ? ctx.mix.accentVelocity : m[3] === '?' ? ctx.mix.softVelocity : ctx.mix.defaultVelocity
  const base = ctx.tonicMidi(track.octave ?? 4) + shift
  if (head === 'C') return { midi: chord.map((s) => base + s), vel }
  if (head === 'R') return { midi: [base + chordTone(chord, 1)], vel }
  let ns = track.kind === 'melody' ? 's' : 'c'
  let body = head
  if (body[0] === 'c' || body[0] === 's') { ns = body[0]; body = body.slice(1) }
  const acc = body[0] === '#' || body[0] === 'b' ? accidental(body[0]) : 0
  const num = Number(acc ? body.slice(1) : body)
  if (!(num >= 1)) throw new Error(`${ctx.where}: bad degree in "${tok}"`)
  const semis = ns === 's' ? scaleSemis(ctx.scale, num, acc) : chordTone(chord, num) + acc
  return { midi: [base + semis], vel }
}

function splitTokens(bar: string): string[] {
  return bar.trim().split(/\s+/).filter(Boolean)
}

function spanOf(count: number, stepsPerBar: number, where: string): number {
  if (count === 0 || stepsPerBar % count !== 0) throw new Error(`${where}: ${count} tokens do not divide ${stepsPerBar} steps`)
  return stepsPerBar / count
}

export function compileSong(id: string, def: SongDef, file: SongsFile = SONGS, mix: MixFile = MIX): CompiledSong {
  const scale = file.scales[def.scale]
  if (!scale || !scale.length) throw new Error(`song ${id}: unknown scale "${def.scale}"`)
  const tonic = pitchClass(def.key)
  if (tonic === null) throw new Error(`song ${id}: bad key "${def.key}"`)
  if (!(def.bpm > 0)) throw new Error(`song ${id}: bpm must be > 0`)
  if (!def.chords.length) throw new Error(`song ${id}: needs chords`)
  const stepsPerBeat = def.stepsPerBeat ?? 4
  const stepsPerBar = (def.beatsPerBar ?? 4) * stepsPerBeat
  const stepSec = 60 / def.bpm / stepsPerBeat
  const length = Math.max(def.chords.length, ...def.tracks.map((t) => t.bars.length))
  const loopFrom = def.loopFrom ?? 0
  if (loopFrom < 0 || loopFrom >= length) throw new Error(`song ${id}: loopFrom out of range`)

  const ctx: Ctx = {
    where: `song ${id}`, song: def, scale, qualities: file.chordQualities, mix,
    tonicMidi: (octave) => 12 * (octave + 1) + tonic,
  }

  // Chord timeline per bar: [{ start step, tones }]
  const chordBars = def.chords.map((entry, bi) => {
    const toks = splitTokens(entry)
    const span = spanOf(toks.length, stepsPerBar, `song ${id} chords bar ${bi}`)
    return toks.map((tok, i) => {
      try { return { start: i * span, tones: parseChord(tok, scale, file.chordQualities) } } catch (e) {
        throw new Error(`song ${id} chords bar ${bi}: ${(e as Error).message}`)
      }
    })
  })
  const chordAt = (bar: number, step: number): number[] => {
    const list = chordBars[bar % chordBars.length]
    let cur = list[0].tones
    for (const c of list) if (c.start <= step) cur = c.tones
    return cur
  }

  const tracks: CompiledTrack[] = def.tracks.map((track, ti) => {
    if (!track.bars.length) throw new Error(`song ${id} track ${ti}: needs bars`)
    if (track.kind !== 'drums' && (!track.inst || !file.instruments[track.inst])) {
      throw new Error(`song ${id} track ${ti}: unknown instrument "${track.inst}"`)
    }
    const bars: CompiledBar[] = []
    let last: CompiledNote | null = null
    for (let b = 0; b < length; b++) {
      const src = track.bars[b % track.bars.length]
      const where = `song ${id} track ${ti} bar ${b}`
      const bar: CompiledBar = { notes: [], drums: [] }
      if (track.kind === 'drums') {
        if (typeof src !== 'object') throw new Error(`${where}: drum bars must be objects`)
        for (const [piece, hits] of Object.entries(src)) {
          if (!file.kit[piece]) throw new Error(`${where}: unknown kit piece "${piece}"`)
          const chars = [...hits.replace(/\s+/g, '')]
          const span = spanOf(chars.length, stepsPerBar, where)
          chars.forEach((ch, i) => {
            if (ch === '.' || ch === '-') return
            const vel = ch === 'X' ? mix.accentVelocity : ch === 'x' ? mix.defaultVelocity : ch === 'o' ? mix.softVelocity : NaN
            if (Number.isNaN(vel)) throw new Error(`${where}: bad drum char "${ch}"`)
            bar.drums.push({ step: i * span, piece, vel })
          })
        }
        bar.drums.sort((a, b2) => a.step - b2.step)
      } else {
        if (typeof src !== 'string') throw new Error(`${where}: pitched bars must be strings`)
        const toks = splitTokens(src)
        const span = spanOf(toks.length, stepsPerBar, where)
        toks.forEach((tok, i) => {
          if (tok === '.') { last = null; return }
          if (tok === '-') { if (last) last.len += span; return }
          const { midi, vel } = parseToken(tok, track, chordAt(b, i * span), { ...ctx, where })
          for (const m of midi) if (m < 12 || m > 120) throw new Error(`${where}: note ${m} out of range`)
          last = { step: i * span, len: span, midi, vel }
          bar.notes.push(last)
        })
      }
      bars.push(bar)
    }
    return { index: ti, def: track, bars }
  })

  return {
    id, def, stepsPerBar, stepsPerBeat, stepSec, barSec: stepSec * stepsPerBar,
    swing: def.swing ?? 0, loopFrom, length, tracks,
  }
}

/** Time offset (s) of a step inside its bar, with swing applied to off-beat steps. */
export function stepTime(song: CompiledSong, step: number): number {
  const swingUnit = song.stepsPerBeat % 2 === 0 ? 1 : 0
  const off = swingUnit && step % 2 === 1 ? song.swing * song.stepSec : 0
  return step * song.stepSec + off
}

/** Next bar index after `bar`, honouring the intro / loop point. */
export function nextBar(song: CompiledSong, bar: number): number {
  return bar + 1 >= song.length ? song.loopFrom : bar + 1
}

const compiledCache = new Map<string, CompiledSong>()

/** Compiled song for an id, falling back to the configured fallback song. Null if neither exists. */
export function getSong(id: string, file: SongsFile = SONGS): CompiledSong | null {
  const key = file.songs[id] ? id : file.fallback
  const def = file.songs[key]
  if (!def) return null
  if (file === SONGS) {
    const hit = compiledCache.get(key)
    if (hit) return hit
  }
  const song = compileSong(key, def, file)
  if (file === SONGS) compiledCache.set(key, song)
  return song
}
