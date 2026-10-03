import type { AssetStore, AudioManager } from '../contracts.ts'
import { CONTENT } from '../../shared/content/index.ts'
import { MIX, SFX } from './audio-data.ts'
import { getSong } from './audio-sequencer.ts'
import { createSongPlayer } from './audio-song.ts'
import type { CompiledSong } from './audio-sequencer.ts'
import { createSynth } from './audio-synth.ts'
import type { Synth } from './audio-synth.ts'
import { cryRecipe } from './audio-cry.ts'
import type { SfxDef } from './audio-data.ts'

interface Playing {
  id: string
  out: GainNode
  stop(fadeSec: number): void
}

interface Graph {
  ctx: AudioContext
  synth: Synth
  bgmVolume: GainNode
  muffle: BiquadFilterNode
  duck: GainNode
  sfxVolume: GainNode
}

/**
 * WebAudio manager. BGM: streamed file when the asset store has one (decoded, looped, crossfaded),
 * otherwise the procedural chiptune of content/audio/songs.json. SFX / cries are synthesized.
 * The AudioContext is created on the first unlock() (also auto-armed on the first user gesture).
 */
export function createAudio(assets: AssetStore): AudioManager {
  let graph: Graph | null = null
  let current: Playing | null = null
  let requested: string | null = null
  let bgmLevel = CONTENT.config.defaultSettings.bgmVolume
  let sfxLevel = CONTENT.config.defaultSettings.sfxVolume
  let muffled = false
  const lastSfx = new Map<string, number>()
  const buffers = new Map<string, Promise<AudioBuffer>>()
  const cries = new Map<string, SfxDef>()

  const curve = (v: number) => Math.pow(Math.min(1, Math.max(0, v)), MIX.volumeCurve)

  const build = (): Graph | null => {
    if (graph) return graph
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    const ctx = new Ctor({ latencyHint: 'interactive' })
    const master = ctx.createGain()
    master.gain.value = MIX.master
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = MIX.compressor.threshold
    comp.knee.value = MIX.compressor.knee
    comp.ratio.value = MIX.compressor.ratio
    comp.attack.value = MIX.compressor.attack
    comp.release.value = MIX.compressor.release
    master.connect(comp).connect(ctx.destination)

    const bgmVolume = ctx.createGain()
    const muffle = ctx.createBiquadFilter()
    muffle.type = 'lowpass'
    muffle.frequency.value = muffled ? MIX.muffle.cutoff : MIX.muffle.open
    const duck = ctx.createGain()
    duck.gain.value = muffled ? MIX.muffle.duck : 1
    bgmVolume.connect(muffle).connect(duck).connect(master)

    const sfxVolume = ctx.createGain()
    sfxVolume.connect(master)
    graph = { ctx, synth: createSynth(ctx, MIX), bgmVolume, muffle, duck, sfxVolume }
    applyVolumes()
    return graph
  }

  const applyVolumes = () => {
    if (!graph) return
    const t = graph.ctx.currentTime
    graph.bgmVolume.gain.setTargetAtTime(curve(bgmLevel) * MIX.bgmBus, t, MIX.volumeSmoothingSec)
    graph.sfxVolume.gain.setTargetAtTime(curve(sfxLevel) * MIX.sfxBus, t, MIX.volumeSmoothingSec)
  }

  const running = () => graph !== null && graph.ctx.state === 'running'

  const loadBuffer = (g: Graph, url: string): Promise<AudioBuffer> => {
    let p = buffers.get(url)
    if (!p) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), MIX.bgmFetchTimeoutMs)
      p = fetch(url, { signal: ctrl.signal })
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer() })
        .then((ab) => g.ctx.decodeAudioData(ab))
        .finally(() => clearTimeout(timer))
      p.catch(() => buffers.delete(url))
      buffers.set(url, p)
    }
    return p
  }

  /** Procedural chiptune: look-ahead scheduler that renders whole bars ahead of the play head. */
  const startSequencer = (g: Graph, song: CompiledSong, out: GainNode): (() => void) => {
    const { ctx } = g
    const player = createSongPlayer(g.synth, song, out, ctx.currentTime + MIX.scheduler.startDelaySec)
    const tick = () => {
      const hidden = typeof document !== 'undefined' && document.hidden
      player.resync(ctx.currentTime)
      player.scheduleUntil(ctx.currentTime + (hidden ? MIX.scheduler.hiddenLookaheadSec : MIX.scheduler.lookaheadSec))
    }
    tick()
    const timer = setInterval(tick, MIX.scheduler.intervalMs)
    return () => clearInterval(timer)
  }

  const startTrack = (g: Graph, id: string, fadeSec: number) => {
    const { ctx } = g
    const out = ctx.createGain()
    const t = ctx.currentTime
    out.gain.setValueAtTime(fadeSec > 0 ? 0 : 1, t)
    if (fadeSec > 0) out.gain.linearRampToValueAtTime(1, t + fadeSec)
    out.connect(g.bgmVolume)

    let stopped = false
    let stopSource: (() => void) | null = null
    const playProcedural = () => {
      const song = getSong(id)
      if (song && !stopped) stopSource = startSequencer(g, song, out)
    }
    const url = assets.bgmUrl(id)
    if (url) {
      loadBuffer(g, url).then((buf) => {
        if (stopped) return
        const src = ctx.createBufferSource()
        src.buffer = buf
        src.loop = true
        src.connect(out)
        src.start()
        stopSource = () => { try { src.stop() } catch { /* already stopped */ } }
      }).catch(() => playProcedural())
    } else {
      playProcedural()
    }

    const playing: Playing = {
      id,
      out,
      stop(fade: number) {
        if (stopped) return
        stopped = true
        const now = ctx.currentTime
        out.gain.cancelScheduledValues(now)
        out.gain.setValueAtTime(out.gain.value, now)
        out.gain.linearRampToValueAtTime(0, now + Math.max(0.02, fade))
        setTimeout(() => { stopSource?.(); out.disconnect() }, (Math.max(0.02, fade) + 0.1) * 1000)
      },
    }
    current = playing
  }

  /** Starts the requested track if it is not already the one playing. */
  const sync = (g: Graph, fadeSec: number) => {
    if (!requested || (current && current.id === requested)) return
    current?.stop(fadeSec)
    startTrack(g, requested, fadeSec)
  }

  const unlock = () => {
    const g = build()
    if (!g) return
    if (g.ctx.state === 'running') { sync(g, MIX.crossfadeMs / 1000); return }
    g.ctx.resume().then(() => sync(g, MIX.crossfadeMs / 1000)).catch(() => { /* still locked; a later gesture retries */ })
  }

  if (typeof window !== 'undefined') {
    const gesture = () => {
      unlock()
      if (running()) {
        window.removeEventListener('pointerdown', gesture, true)
        window.removeEventListener('keydown', gesture, true)
        window.removeEventListener('touchend', gesture, true)
      }
    }
    window.addEventListener('pointerdown', gesture, true)
    window.addEventListener('keydown', gesture, true)
    window.addEventListener('touchend', gesture, true)
  }

  return {
    unlock,
    playBgm(id: string, opts?: { fadeMs?: number }) {
      requested = id
      if (running() && graph) sync(graph, (opts?.fadeMs ?? MIX.crossfadeMs) / 1000)
    },
    stopBgm(fadeMs?: number) {
      requested = null
      current?.stop((fadeMs ?? MIX.stopFadeMs) / 1000)
      current = null
    },
    get currentBgm() { return requested },
    playSfx(id: string, opts?: { volume?: number; pitch?: number }) {
      if (!running() || !graph) return
      const def = SFX.sfx[id] ?? SFX.sfx[SFX.fallback]
      if (!def) return
      const nowMs = performance.now()
      if (nowMs - (lastSfx.get(id) ?? -Infinity) < MIX.sfxMinIntervalMs) return
      lastSfx.set(id, nowMs)
      graph.synth.playRecipe(def, graph.ctx.currentTime + MIX.sfxLeadSec, graph.sfxVolume, { gain: opts?.volume ?? 1, pitch: opts?.pitch ?? 1 })
    },
    playCry(speciesId: string, opts?: { pitch?: number }) {
      if (!running() || !graph) return
      let def = cries.get(speciesId)
      if (!def) { def = cryRecipe(speciesId); cries.set(speciesId, def) }
      graph.synth.playRecipe(def, graph.ctx.currentTime + MIX.sfxLeadSec, graph.sfxVolume, { pitch: opts?.pitch ?? 1 })
    },
    setVolumes(bgm: number, sfx: number) {
      bgmLevel = Number.isFinite(bgm) ? bgm : bgmLevel
      sfxLevel = Number.isFinite(sfx) ? sfx : sfxLevel
      applyVolumes()
    },
    setMuffled(on: boolean) {
      muffled = on
      if (!graph) return
      const t = graph.ctx.currentTime
      graph.muffle.frequency.setTargetAtTime(on ? MIX.muffle.cutoff : MIX.muffle.open, t, MIX.muffle.timeConstant)
      graph.duck.gain.setTargetAtTime(on ? MIX.muffle.duck : 1, t, MIX.muffle.timeConstant)
    },
  }
}
