// Screenshot preparation (ADR 0002 §4.6): freeze time, hide the developer UI (and optionally the HUD), let loading and
// streaming settle by re-rendering at dt 0, and report the state digest to put in the report next to the picture.
import type { DevHost } from './kit.ts'

export interface ShotOpts { hideDev?: boolean; hideHud?: boolean; settleFrames?: number }

export interface Shot {
  prepare(o?: ShotOpts): Promise<{ digest: string; settleFrames: number }>
  release(): void
}

const nextFrame = () => new Promise<void>((ok) => requestAnimationFrame(() => ok()))

export function createShot(host: DevHost, digestOf: () => string, defaults: { settleFrames: number; idleTimeoutMs: number }): Shot {
  const html = document.documentElement
  let wasPaused: boolean | null = null

  async function idle(timeoutMs: number): Promise<void> {
    const end = Date.now() + timeoutMs
    const loading = () => { const el = document.getElementById('ap-loading'); return !!el && !el.hidden && !el.classList.contains('is-done') }
    while ((loading() || host.overworld.mapId === null) && Date.now() < end) await nextFrame()
  }

  return {
    async prepare(o = {}) {
      const settle = o.settleFrames ?? defaults.settleFrames
      wasPaused ??= host.clock.state().paused
      host.clock.pause()
      html.classList.toggle('apd-shot', o.hideDev !== false)
      html.classList.toggle('apd-shot-hud', o.hideHud === true)
      await idle(defaults.idleTimeoutMs)
      for (let i = 0; i < settle; i++) { host.tick(0); await nextFrame() }
      return { digest: digestOf(), settleFrames: settle }
    },
    release() {
      html.classList.remove('apd-shot', 'apd-shot-hud')
      if (wasPaused === false) host.clock.resume()
      wasPaused = null
    },
  }
}
