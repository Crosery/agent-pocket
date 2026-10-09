// F3 overlay (a player-facing info toggle, bound to the "debug" input action): fps, draw calls, position,
// region, terrain, time, weather, network. Stays in the production build, unlike src/client/dev.
import type { GameContext } from './contracts.ts'
import { t } from '../shared/content/index.ts'
import { GAME } from './world/config.ts'
import type { OverworldExt } from './world/controller.ts'

/** F3 overlay: fps, draw calls, position, region, terrain, time, weather, network. */
export function createDebugOverlay(ctx: GameContext, ow: OverworldExt, root: HTMLElement) {
  const el = document.createElement('pre')
  el.id = 'ap-debug'
  el.hidden = true
  root.append(el)
  let frames = 0
  let acc = 0
  let refresh = 0
  let fps = 0
  let frameMs = 0

  const render = () => {
    const info = ctx.renderer.gl.info.render
    const p = ow.player
    const region = ow.region
    el.textContent = [
      t('game.debug.title'),
      t('game.debug.fps', { fps: fps.toFixed(0), ms: frameMs.toFixed(1) }),
      t('game.debug.calls', { calls: info.calls, tris: (info.triangles / 1000).toFixed(1) }),
      t('game.debug.pos', { map: p.map, x: p.x.toFixed(2), y: p.y.toFixed(2), elev: p.elev.toFixed(2) }),
      t('game.debug.region', { region: region?.nameZh ?? '-', terrain: ow.terrainName || '-' }),
      t('game.debug.time', { clock: ctx.clock.label(), tod: t(`hud.tod.${ctx.clock.timeOfDay}`), weather: t(`game.weather.${ow.weather}`) }),
      t('game.debug.net', { status: t(`hud.net.${ctx.net.status}`), n: ctx.net.online, near: ctx.net.remotePlayers().size }),
      t('game.debug.player', { mode: t(`game.mode.${ow.mode}`), repel: ctx.save.repelSteps, roamers: ow.roamerCount }),
    ].join('\n')
  }

  return {
    el,
    toggle(): void { el.hidden = !el.hidden; if (!el.hidden) render() },
    update(dt: number): void {
      frames++
      acc += dt
      if (el.hidden) return
      refresh -= dt * 1000
      if (refresh > 0) return
      refresh = GAME.debug.overlayRefreshMs
      if (acc > 0) { fps = frames / acc; frameMs = (acc / frames) * 1000 }
      frames = 0
      acc = 0
      render()
    },
  }
}
