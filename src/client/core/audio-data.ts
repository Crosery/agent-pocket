// Typed views of content/audio/*.json. All music, SFX, cry and mixing parameters are data.
import songsJson from '../../../content/audio/songs.json' with { type: 'json' }
import sfxJson from '../../../content/audio/sfx.json' with { type: 'json' }
import criesJson from '../../../content/audio/cries.json' with { type: 'json' }
import mixJson from '../../../content/audio/mix.json' with { type: 'json' }

export type Wave = 'pulse' | 'square' | 'triangle' | 'sine' | 'sawtooth' | 'noise'
/** [attack s, decay s, sustain level 0..1, release s] */
export type Envelope = [number, number, number, number]

export interface FilterDef { type: BiquadFilterType; freq: number; to?: number; q?: number }

/** One synthesized voice layer of an SFX / drum piece / cry. */
export interface SfxLayer {
  wave: Wave
  duty?: number
  /** Base frequency (Hz) or note name; noise layers use it only through the filter. */
  freq?: number
  note?: string
  /** End frequency (Hz) of an exponential sweep across `dur`. */
  to?: number
  /** Semitone offsets spread evenly across `dur` (pitch contour). */
  bend?: number[]
  /** Arpeggio: note names or semitone offsets from the base, one every `step` seconds. */
  notes?: (string | number)[]
  step?: number
  /** Start offset (s). */
  at?: number
  /** Gate length (s); per note when `notes` is set. */
  dur: number
  env?: Envelope
  gain: number
  filter?: FilterDef
  vibrato?: { rate: number; depth: number }
  fm?: { ratio: number; index: number }
  repeat?: { count: number; every: number }
}

export interface SfxDef { gain?: number; layers: SfxLayer[] }

export interface InstrumentDef {
  wave: Wave
  duty?: number
  env: Envelope
  gain: number
  /** Second detuned voice (cents) for a chorus effect. */
  unison?: number
  detune?: number
  vibrato?: { rate: number; depth: number; delay: number }
  filter?: FilterDef & { env?: number; decay?: number }
  fm?: { ratio: number; index: number; decay?: number }
}

export type DrumBar = Record<string, string>

export interface TrackDef {
  /** Instrument id (pitched tracks); ignored for drums (they use the kit). */
  inst?: string
  /** melody: tokens are scale degrees; chord: tokens are chord tones; drums: per-piece hit strings. */
  kind: 'melody' | 'chord' | 'drums'
  octave?: number
  bars: (string | DrumBar)[]
  gain?: number
  pan?: number
  echo?: number
}

export interface SongDef {
  bpm: number
  key: string
  scale: string
  beatsPerBar?: number
  stepsPerBeat?: number
  /** Delay of off-beat steps as a fraction of a step. */
  swing?: number
  /** Bar index the loop returns to (earlier bars form a one-shot intro). */
  loopFrom?: number
  gain?: number
  echo?: { beats: number; feedback: number; wet: number; damp?: number }
  /** One entry per bar; several space-separated chords split the bar evenly. */
  chords: string[]
  tracks: TrackDef[]
}

export interface SongsFile {
  scales: Record<string, number[]>
  chordQualities: Record<string, number[]>
  instruments: Record<string, InstrumentDef>
  kit: Record<string, SfxDef>
  fallback: string
  songs: Record<string, SongDef>
}

export interface SfxFile { fallback: string; sfx: Record<string, SfxDef> }

export interface CriesFile {
  gain: number
  baseFreq: [number, number]
  sizeExponent: number
  stagePitch: number[]
  waves: { wave: Wave; duty?: number; weight: number }[]
  typeWaves: Record<string, Wave>
  syllables: [number, number]
  syllableDur: [number, number]
  lastSyllableStretch: number
  gap: [number, number]
  contours: number[][]
  contourScale: [number, number]
  syllableDrift: [number, number]
  env: { attack: [number, number]; decay: [number, number]; sustain: [number, number]; release: [number, number] }
  vibrato: { chance: number; rate: [number, number]; depth: [number, number] }
  fm: { chance: number; ratio: number[]; index: [number, number] }
  noise: { chance: number; gain: [number, number]; freq: [number, number]; q: number }
  harmony: { chance: number; intervals: number[]; gain: number }
  filter: { freq: [number, number]; q: number }
}

export interface MixFile {
  master: number
  volumeCurve: number
  compressor: { threshold: number; knee: number; ratio: number; attack: number; release: number }
  bgmBus: number
  sfxBus: number
  crossfadeMs: number
  stopFadeMs: number
  muffle: { cutoff: number; open: number; duck: number; timeConstant: number }
  scheduler: { intervalMs: number; lookaheadSec: number; hiddenLookaheadSec: number; startDelaySec: number }
  sfxMinIntervalMs: number
  harmonics: number
  noiseSeconds: number
  defaultEnv: Envelope
  defaultVelocity: number
  accentVelocity: number
  softVelocity: number
  bgmFetchTimeoutMs: number
  /** Fraction of a note's step length that is gated (articulation). */
  gateFraction: number
  volumeSmoothingSec: number
  /** Scheduling lead for immediate SFX. */
  sfxLeadSec: number
  vibratoRampSec: number
  /** FM index fraction left after the modulation decays. */
  fmSustain: number
  defaultQ: number
}

export const SONGS = songsJson as unknown as SongsFile
export const SFX = sfxJson as unknown as SfxFile
export const CRIES = criesJson as unknown as CriesFile
export const MIX = mixJson as unknown as MixFile
