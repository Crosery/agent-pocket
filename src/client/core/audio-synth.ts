// WebAudio voices: chiptune oscillators (pulse with duty via PeriodicWave, triangle, noise), ADSR,
// vibrato, FM, filters. Plays instrument notes (music) and layered recipes (SFX, drums, cries).
import type { Envelope, FilterDef, InstrumentDef, MixFile, SfxDef, SfxLayer, Wave } from './audio-data.ts'
import { midiToFreq, noteToMidi } from './audio-sequencer.ts'

export interface Synth {
  readonly ctx: BaseAudioContext
  /** Plays a pitched instrument note; returns the time the voice ends. */
  playNote(inst: InstrumentDef, midi: number, t: number, gate: number, vel: number, dest: AudioNode): number
  /** Plays a layered recipe; returns the time the last layer ends. */
  playRecipe(def: SfxDef, t: number, dest: AudioNode, opts?: { gain?: number; pitch?: number }): number
}

type Source = OscillatorNode | AudioBufferSourceNode

const MIN_TIME = 0.001

export function createSynth(ctx: BaseAudioContext, mix: MixFile): Synth {
  const waves = new Map<number, PeriodicWave>()
  let noise: AudioBuffer | null = null

  /** Band-limited pulse of the given duty cycle (Fourier series of a rectangular wave). */
  const pulseWave = (duty: number): PeriodicWave => {
    const d = Math.min(0.95, Math.max(0.05, duty))
    const key = Math.round(d * 1000)
    let w = waves.get(key)
    if (w) return w
    const n = mix.harmonics
    const real = new Float32Array(n + 1)
    const imag = new Float32Array(n + 1)
    for (let k = 1; k <= n; k++) {
      real[k] = Math.sin(2 * Math.PI * k * d) / (k * Math.PI)
      imag[k] = (1 - Math.cos(2 * Math.PI * k * d)) / (k * Math.PI)
    }
    w = ctx.createPeriodicWave(real, imag)
    waves.set(key, w)
    return w
  }

  const noiseBuffer = (): AudioBuffer => {
    if (noise) return noise
    const len = Math.max(1, Math.floor(ctx.sampleRate * mix.noiseSeconds))
    noise = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = noise.getChannelData(0)
    // Deterministic LFSR-ish white noise so repeated runs sound identical.
    let s = 0x1234567
    for (let i = 0; i < len; i++) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5
      data[i] = ((s >>> 0) / 4294967296) * 2 - 1
    }
    return noise
  }

  const makeSource = (wave: Wave, duty: number | undefined, freq: number, t: number): Source => {
    if (wave === 'noise') {
      const src = ctx.createBufferSource()
      src.buffer = noiseBuffer()
      src.loop = true
      return src
    }
    const osc = ctx.createOscillator()
    if (wave === 'pulse') osc.setPeriodicWave(pulseWave(duty ?? 0.5))
    else osc.type = wave
    osc.frequency.setValueAtTime(freq, t)
    return osc
  }

  const startSource = (src: Source, t: number, end: number) => {
    if (src instanceof AudioBufferSourceNode && src.buffer) src.start(t, Math.random() * src.buffer.duration)
    else src.start(t)
    src.stop(end + 0.02)
  }

  /** Piecewise ADSR on a gain param; returns the end of the release. */
  const envelope = (param: AudioParam, env: Envelope, peak: number, t: number, gate: number): number => {
    const [a, d, s, r] = env
    const A = Math.max(MIN_TIME, a)
    const D = Math.max(MIN_TIME, d)
    const sus = peak * Math.min(1, Math.max(0, s))
    param.setValueAtTime(0, t)
    let level: number
    if (gate <= A) {
      level = peak * (gate / A)
      param.linearRampToValueAtTime(level, t + gate)
    } else {
      param.linearRampToValueAtTime(peak, t + A)
      if (gate < A + D) {
        level = peak + (sus - peak) * ((gate - A) / D)
        param.linearRampToValueAtTime(level, t + gate)
      } else {
        param.linearRampToValueAtTime(sus, t + A + D)
        param.setValueAtTime(sus, t + gate)
        level = sus
      }
    }
    const R = Math.max(0.004, r)
    param.setTargetAtTime(0, t + gate, R / 4)
    param.setValueAtTime(0, t + gate + R)
    return t + gate + R
  }

  const makeFilter = (f: FilterDef, pitch: number, t: number, dur: number): BiquadFilterNode => {
    const node = ctx.createBiquadFilter()
    node.type = f.type
    node.Q.value = f.q ?? mix.defaultQ
    node.frequency.setValueAtTime(clampFreq(f.freq * pitch), t)
    if (f.to !== undefined) node.frequency.exponentialRampToValueAtTime(clampFreq(f.to * pitch), t + Math.max(MIN_TIME, dur))
    return node
  }

  const clampFreq = (f: number) => Math.min(ctx.sampleRate / 2 - 1, Math.max(10, f))

  const addVibrato = (osc: OscillatorNode, rate: number, depthSemis: number, t: number, delay: number, end: number) => {
    const lfo = ctx.createOscillator()
    lfo.frequency.value = rate
    const amt = ctx.createGain()
    amt.gain.setValueAtTime(0, t)
    if (delay > 0) amt.gain.setValueAtTime(0, t + delay)
    amt.gain.linearRampToValueAtTime(depthSemis * 100, t + delay + mix.vibratoRampSec)
    lfo.connect(amt).connect(osc.detune)
    lfo.start(t)
    lfo.stop(end + 0.02)
  }

  const addFm = (osc: OscillatorNode, freq: number, ratio: number, index: number, t: number, decay: number | undefined, end: number) => {
    const mod = ctx.createOscillator()
    mod.frequency.setValueAtTime(freq * ratio, t)
    const amt = ctx.createGain()
    amt.gain.setValueAtTime(index * freq, t)
    if (decay) amt.gain.setTargetAtTime(index * freq * mix.fmSustain, t, decay / 3)
    mod.connect(amt).connect(osc.frequency)
    mod.start(t)
    mod.stop(end + 0.02)
  }

  const layerFreq = (layer: SfxLayer): number => {
    if (layer.freq !== undefined) return layer.freq
    if (layer.note) { const m = noteToMidi(layer.note); if (m !== null) return midiToFreq(m) }
    return 440
  }

  const noteFreq = (n: string | number, base: number): number => {
    if (typeof n === 'number') return base * Math.pow(2, n / 12)
    const m = noteToMidi(n)
    return m === null ? base : midiToFreq(m)
  }

  /** One tone/noise voice of a layer starting at t with frequency f. */
  const voice = (layer: SfxLayer, f: number, t: number, gate: number, gain: number, pitch: number, dest: AudioNode): number => {
    const env = layer.env ?? mix.defaultEnv
    const end = t + gate + Math.max(0.004, env[3])
    const src = makeSource(layer.wave, layer.duty, f, t)
    const amp = ctx.createGain()
    if (src instanceof OscillatorNode) {
      if (layer.bend && layer.bend.length) {
        const pts = layer.bend
        src.frequency.setValueAtTime(clampFreq(f * Math.pow(2, pts[0] / 12)), t)
        for (let i = 1; i < pts.length; i++) {
          src.frequency.linearRampToValueAtTime(clampFreq(f * Math.pow(2, pts[i] / 12)), t + (gate * i) / (pts.length - 1))
        }
      } else if (layer.to !== undefined) {
        src.frequency.exponentialRampToValueAtTime(clampFreq(layer.to * pitch), t + Math.max(MIN_TIME, gate))
      }
      if (layer.vibrato) addVibrato(src, layer.vibrato.rate, layer.vibrato.depth, t, 0, end)
      if (layer.fm) addFm(src, f, layer.fm.ratio, layer.fm.index, t, gate, end)
    } else {
      src.playbackRate.value = pitch
    }
    let head: AudioNode = src
    if (layer.filter) head = head.connect(makeFilter(layer.filter, layer.wave === 'noise' ? 1 : pitch, t, gate))
    head.connect(amp).connect(dest)
    envelope(amp.gain, env, gain * layer.gain, t, gate)
    startSource(src, t, end)
    return end
  }

  const playLayer = (layer: SfxLayer, t0: number, dest: AudioNode, gain: number, pitch: number): number => {
    let end = t0
    const reps = Math.max(1, layer.repeat?.count ?? 1)
    const base = layerFreq(layer) * pitch
    for (let r = 0; r < reps; r++) {
      const t = t0 + (layer.at ?? 0) + r * (layer.repeat?.every ?? 0)
      if (layer.notes && layer.notes.length) {
        const step = layer.step ?? layer.dur
        layer.notes.forEach((n, i) => {
          end = Math.max(end, voice(layer, noteFreq(n, base) * (typeof n === 'number' ? 1 : pitch), t + i * step, layer.dur, gain, pitch, dest))
        })
      } else {
        end = Math.max(end, voice(layer, base, t, layer.dur, gain, pitch, dest))
      }
    }
    return end
  }

  return {
    ctx,
    playNote(inst, midi, t, gate, vel, dest) {
      const f = midiToFreq(midi)
      const end = t + gate + Math.max(0.004, inst.env[3])
      const amp = ctx.createGain()
      let input: AudioNode = amp
      if (inst.filter) {
        const flt = ctx.createBiquadFilter()
        flt.type = inst.filter.type
        flt.Q.value = inst.filter.q ?? mix.defaultQ
        const fbase = clampFreq(inst.filter.freq)
        if (inst.filter.env) {
          flt.frequency.setValueAtTime(clampFreq(fbase * (1 + inst.filter.env)), t)
          flt.frequency.setTargetAtTime(fbase, t, (inst.filter.decay ?? 0.2) / 3)
        } else {
          flt.frequency.setValueAtTime(fbase, t)
        }
        flt.connect(amp)
        input = flt
      }
      const detunes = inst.unison ? [-inst.unison / 2, inst.unison / 2] : [0]
      const voiceGain = detunes.length > 1 ? Math.SQRT1_2 : 1
      for (const dt of detunes) {
        const src = makeSource(inst.wave, inst.duty, f, t)
        if (src instanceof OscillatorNode) {
          src.detune.value = dt + (inst.detune ?? 0)
          if (inst.vibrato && gate > inst.vibrato.delay) addVibrato(src, inst.vibrato.rate, inst.vibrato.depth, t, inst.vibrato.delay, end)
          if (inst.fm) addFm(src, f, inst.fm.ratio, inst.fm.index, t, inst.fm.decay, end)
        }
        if (voiceGain !== 1) {
          const g = ctx.createGain()
          g.gain.value = voiceGain
          src.connect(g).connect(input)
        } else {
          src.connect(input)
        }
        startSource(src, t, end)
      }
      amp.connect(dest)
      return envelope(amp.gain, inst.env, inst.gain * vel, t, gate)
    },
    playRecipe(def, t, dest, opts = {}) {
      const gain = (def.gain ?? 1) * (opts.gain ?? 1)
      const pitch = opts.pitch ?? 1
      let end = t
      for (const layer of def.layers) end = Math.max(end, playLayer(layer, t, dest, gain, pitch))
      return end
    },
  }
}
