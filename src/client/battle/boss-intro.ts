// Boss intro cut-in (issue #32): a short MiniMax H3 clip per boss, played full screen before the battle is revealed.
// The clip is lazy: nothing is requested until the boss battle starts, and a slow network, a decode error or a
// stalled playback falls back to the static intro (poster + name card). Always skippable.
import { CONTENT, t } from '../../shared/content/index.ts'
import type { Input } from '../contracts.ts'
import { publicAssetUrl } from '../core/assets.ts'
import { BOSS_PRES, bossEntry, type BossEntry, type BossIntroClip } from '../render/battle/boss-config.ts'
import { actionKeyLabel, el } from '../ui/widgets.ts'
import { createSkipGate, shouldSkipClip, type Connection, type SkipGate } from './boss-intro-core.ts'
import type { BattleView } from './view.ts'

export type BossIntroResult = 'played' | 'skipped' | 'static' | 'none'

const connection = (): Connection | undefined => (typeof navigator === 'undefined' ? undefined : (navigator as { connection?: Connection }).connection)

export interface BossIntroPrefetch {
  readonly video: HTMLVideoElement | null
  cancel(): void
}

/** Starts fetching the clip (hidden, muted element) so it is buffered by the time the battle scene is ready. */
export function prefetchBossIntro(bossId: string | null | undefined): BossIntroPrefetch | null {
  const clip = bossEntry(bossId)?.intro
  if (!clip || !BOSS_PRES.intro.prefetch || shouldSkipClip(connection()) || typeof document === 'undefined') return null
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = publicAssetUrl(clip.src)
  video.load()
  return {
    video,
    cancel() { video.removeAttribute('src'); video.load() },
  }
}

const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Resolves true when the video is playable without waiting (enough data buffered), false on timeout, error or skip. */
function whenPlayable(video: HTMLVideoElement, timeoutMs: number, gate: SkipGate): Promise<boolean> {
  return new Promise((resolve) => {
    if (video.readyState >= 4) { resolve(true); return }
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      off()
      video.removeEventListener('canplaythrough', onOk)
      video.removeEventListener('error', onErr)
      resolve(ok)
    }
    const onOk = () => finish(true)
    const onErr = () => finish(false)
    const timer = setTimeout(() => finish(false), timeoutMs)
    const off = gate.onSkip(() => finish(false))
    video.addEventListener('canplaythrough', onOk)
    video.addEventListener('error', onErr)
  })
}

/**
 * Plays the boss's intro on top of the battle view. `prefetch` is the element started by prefetchBossIntro().
 * Resolves when the intro is over; the caller reveals the battle after that.
 */
export async function playBossIntro(view: BattleView, bossId: string, prefetch: BossIntroPrefetch | null): Promise<BossIntroResult> {
  const entry = bossEntry(bossId)
  const def = CONTENT.bosses[bossId]
  if (!entry || !def) return 'none'
  const C = BOSS_PRES.intro
  const clip = entry.intro
  const species = CONTENT.species[entry.species]

  const poster = el('img', { class: 'apb-bi-poster', attrs: { alt: '', draggable: 'false' } }) as HTMLImageElement
  if (clip) poster.src = publicAssetUrl(clip.poster)
  const caption = el('div', 'apb-bi-caption', [
    el('div', { class: 'apb-bi-name ap-model-name', text: species?.nameZh ?? entry.species }),
    el('div', { class: 'apb-bi-title', text: t(def.title) }),
  ])
  const skip = el('button', { class: 'apb-bi-skip', attrs: { type: 'button' }, text: coarsePointer() ? t('battleui.bossIntro.skip') : t('battleui.bossIntro.skipHint', { key: actionKeyLabel('confirm') }) })
  const overlay = el('div', 'apb-bi', [poster, caption, skip])
  overlay.style.setProperty('--apb-bi-in', `${C.fadeInMs}ms`)
  overlay.style.setProperty('--apb-bi-out', `${C.fadeOutMs}ms`)
  view.root.append(overlay)

  const gate = createSkipGate()
  const stop = () => gate.fire()
  overlay.addEventListener('pointerdown', (e) => { e.stopPropagation(); stop() })
  overlay.addEventListener('click', (e) => e.stopPropagation())
  view.setInterceptor((inp: Input) => {
    if (inp.pressed('confirm') || inp.pressed('cancel') || inp.pressed('menu')) {
      inp.consume('confirm'); inp.consume('cancel'); inp.consume('menu')
      stop()
    }
    return true
  })

  let result: BossIntroResult = 'static'
  let video: HTMLVideoElement | null = null
  try {
    requestAnimationFrame(() => overlay.classList.add('is-in'))
    await gate.wait(C.fadeInMs)
    const useClip = !!clip && !shouldSkipClip(connection())
    video = useClip ? (prefetch?.video ?? makeVideo(clip)) : null
    if (video && clip && !gate.skipped) {
      video.className = 'apb-bi-video'
      overlay.insertBefore(video, caption)
      const ok = await whenPlayable(video, C.loadTimeoutMs, gate)
      if (ok && !gate.skipped) {
        result = (await playClip(video, clip, C.stallMs, overlay, gate)) ? 'played' : 'static'
        if (result === 'played') await gate.wait(C.holdLastMs)
      } else video.remove()
    }
    if (result === 'static' && !gate.skipped) {
      overlay.classList.add('is-static')
      caption.classList.add('is-on')
      await gate.wait(C.staticHoldMs)
    }
    if (gate.skipped) result = 'skipped'
  } finally {
    view.setInterceptor(null)
    overlay.classList.remove('is-in')
    overlay.classList.add('is-out')
    await sleep(C.fadeOutMs)
    video?.pause()
    video?.removeAttribute('src')
    video?.load()
    overlay.remove()
  }
  return result
}

function makeVideo(clip: BossIntroClip): HTMLVideoElement {
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  v.src = publicAssetUrl(clip.src)
  return v
}

/** Plays to the end; false when playback failed or stalled (the static intro takes over). */
async function playClip(
  video: HTMLVideoElement,
  clip: BossIntroClip,
  stallMs: number,
  overlay: HTMLElement,
  gate: SkipGate,
): Promise<boolean> {
  video.currentTime = 0
  try { await video.play() } catch { return false }
  overlay.classList.add('is-playing')
  const captionAt = BOSS_PRES.intro.captionDelayMs
  let last = -1
  let stalledFor = 0
  const tick = 100
  for (let elapsed = 0; !gate.skipped; elapsed += tick) {
    if (video.ended) return true
    if (video.error) return false
    if (elapsed >= captionAt) overlay.querySelector('.apb-bi-caption')?.classList.add('is-on')
    if (video.currentTime === last && !video.paused) stalledFor += tick
    else stalledFor = 0
    if (stalledFor >= stallMs) return video.currentTime > clip.durationSec * 0.6
    last = video.currentTime
    await gate.wait(tick)
  }
  return true
}
