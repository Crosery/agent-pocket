// Renders a compiled song into a WebAudio graph: per-track buses (gain, pan, echo send) and
// bar-by-bar note scheduling. Used by the realtime look-ahead scheduler and offline rendering.
import { MIX, SONGS } from './audio-data.ts'
import type { MixFile, SongsFile } from './audio-data.ts'
import { nextBar, stepTime } from './audio-sequencer.ts'
import type { CompiledSong } from './audio-sequencer.ts'
import type { Synth } from './audio-synth.ts'

export interface SongPlayer {
  /** Schedules every bar that starts before `time` (context seconds). */
  scheduleUntil(time: number): void
  /** Moves the play head to `time` if scheduling fell more than a bar behind (stalled timers). */
  resync(time: number): void
}

export function createSongPlayer(synth: Synth, song: CompiledSong, out: AudioNode, startTime: number, file: SongsFile = SONGS, mix: MixFile = MIX): SongPlayer {
  const ctx = synth.ctx
  const songBus = ctx.createGain()
  songBus.gain.value = song.def.gain ?? 1
  songBus.connect(out)

  let echoIn: AudioNode | null = null
  if (song.def.echo) {
    const e = song.def.echo
    const delay = ctx.createDelay(4)
    delay.delayTime.value = Math.min(3.9, (e.beats * 60) / song.def.bpm)
    const feedback = ctx.createGain()
    feedback.gain.value = Math.min(0.92, e.feedback)
    const damp = ctx.createBiquadFilter()
    damp.type = 'lowpass'
    damp.frequency.value = e.damp ?? mix.muffle.open
    const wet = ctx.createGain()
    wet.gain.value = e.wet
    delay.connect(damp).connect(feedback).connect(delay)
    damp.connect(wet).connect(songBus)
    echoIn = delay
  }

  const buses = song.tracks.map((tr) => {
    const gain = ctx.createGain()
    gain.gain.value = tr.def.gain ?? 1
    let tail: AudioNode = gain
    if (tr.def.pan && typeof ctx.createStereoPanner === 'function') {
      const pan = ctx.createStereoPanner()
      pan.pan.value = Math.max(-1, Math.min(1, tr.def.pan))
      tail = gain.connect(pan)
    }
    tail.connect(songBus)
    if (echoIn && tr.def.echo) {
      const send = ctx.createGain()
      send.gain.value = tr.def.echo
      tail.connect(send).connect(echoIn)
    }
    return gain
  })

  let bar = 0
  let barStart = startTime
  const scheduleBar = (b: number, t0: number) => {
    for (const tr of song.tracks) {
      const bus = buses[tr.index]
      const data = tr.bars[b]
      const inst = tr.def.inst ? file.instruments[tr.def.inst] : undefined
      if (inst) {
        for (const n of data.notes) {
          const gate = Math.max(0.01, n.len * song.stepSec * mix.gateFraction)
          const scale = n.midi.length > 1 ? 1 / Math.sqrt(n.midi.length) : 1
          for (const m of n.midi) synth.playNote(inst, m, t0 + stepTime(song, n.step), gate, n.vel * scale, bus)
        }
      }
      for (const d of data.drums) {
        const piece = file.kit[d.piece]
        if (piece) synth.playRecipe(piece, t0 + stepTime(song, d.step), bus, { gain: d.vel })
      }
    }
  }

  return {
    scheduleUntil(time: number) {
      while (barStart < time) {
        scheduleBar(bar, barStart)
        barStart += song.barSec
        bar = nextBar(song, bar)
      }
    },
    resync(time: number) {
      if (barStart < time - song.barSec) barStart = time + mix.scheduler.startDelaySec
    },
  }
}
