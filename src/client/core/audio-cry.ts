// Deterministic creature cries: species id hash + content/audio/cries.json ranges -> SFX recipe. Pure.
import { CONTENT } from '../../shared/content/index.ts'
import type { Content } from '../../shared/content/index.ts'
import { CRIES } from './audio-data.ts'
import type { CriesFile, SfxDef, SfxLayer } from './audio-data.ts'
import { hashString, seededRandom } from './hash.ts'

export function cryRecipe(speciesId: string, c: Content = CONTENT, cfg: CriesFile = CRIES): SfxDef {
  const rnd = seededRandom(hashString(`cry:${speciesId}`))
  const range = (r: [number, number]) => rnd.range(r[0], r[1])
  const species = c.species[speciesId]

  const [fMin, fMax] = cfg.baseFreq
  let freq = Math.exp(Math.log(fMin) + rnd.next() * (Math.log(fMax) - Math.log(fMin)))
  if (species) {
    if (species.size > 0) freq *= Math.pow(species.size, cfg.sizeExponent)
    const stageIdx = Math.max(0, Math.min(cfg.stagePitch.length - 1, species.stage - 1))
    freq *= cfg.stagePitch[stageIdx] ?? 1
  }

  const picked = rnd.weighted(cfg.waves, (w) => w.weight)
  const typeWave = species ? cfg.typeWaves[species.types[0]] : undefined
  const wave = typeWave ?? picked.wave
  const duty = picked.duty

  const contour = rnd.pick(cfg.contours)
  const contourScale = range(cfg.contourScale)
  const drift = range(cfg.syllableDrift)
  const syllables = rnd.int(cfg.syllables[0], cfg.syllables[1])
  const vibrato = rnd.chance(cfg.vibrato.chance) ? { rate: range(cfg.vibrato.rate), depth: range(cfg.vibrato.depth) } : undefined
  const fm = rnd.chance(cfg.fm.chance) ? { ratio: rnd.pick(cfg.fm.ratio), index: range(cfg.fm.index) } : undefined
  const noise = rnd.chance(cfg.noise.chance) ? { gain: range(cfg.noise.gain), freq: range(cfg.noise.freq) } : undefined
  const harmony = rnd.chance(cfg.harmony.chance) ? rnd.pick(cfg.harmony.intervals) : null
  const cutoff = range(cfg.filter.freq)
  const env: [number, number, number, number] = [range(cfg.env.attack), range(cfg.env.decay), range(cfg.env.sustain), range(cfg.env.release)]

  const layers: SfxLayer[] = []
  let at = 0
  for (let i = 0; i < syllables; i++) {
    const dur = range(cfg.syllableDur) * (i === syllables - 1 ? cfg.lastSyllableStretch : 1)
    const bend = contour.map((p) => p * contourScale + drift * i)
    const tone: SfxLayer = {
      wave, duty, freq, bend, at, dur, env, gain: 1,
      filter: { type: 'lowpass', freq: cutoff, q: cfg.filter.q },
    }
    if (vibrato) tone.vibrato = vibrato
    if (fm) tone.fm = fm
    layers.push(tone)
    if (harmony !== null) layers.push({ ...tone, bend: bend.map((b) => b + harmony), gain: cfg.harmony.gain })
    if (noise) {
      layers.push({ wave: 'noise', at, dur, env, gain: noise.gain, filter: { type: 'bandpass', freq: noise.freq, q: cfg.noise.q } })
    }
    at += dur + range(cfg.gap)
  }
  return { gain: cfg.gain, layers }
}
