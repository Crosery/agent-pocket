// Battle scene lifecycle shared by battles and evolution cutscenes: covers the screen, builds the HD-2D battle stage
// and the battle view (pushed as a UIKit panel so it owns input and blocks the overworld), runs its own render loop,
// reveals, and tears everything down behind a fade.
import type { BiomeId, TimeOfDay } from '../../shared/types.ts'
import type { GameContext, UIPanel } from '../contracts.ts'
import { createBattleStage, type BattleStage } from '../render/battle/index.ts'
import { BATTLE_UI } from './config.ts'
import { createBattleView, type BattleView } from './view.ts'

/**
 * How the screen gets covered before the scene appears:
 *  'covered'    the caller already covered it with a renderer transition (overworld encounter);
 *  'transition' play the configured renderer transition over whatever is on screen (PvP);
 *  'fade'       DOM fade to black (field evolution).
 */
export type CoverMode = 'covered' | 'transition' | 'fade'

export interface SceneOptions { biome: BiomeId; timeOfDay: TimeOfDay; indoor: boolean; cover: CoverMode }

export interface BattleScene {
  readonly stage: BattleStage
  readonly view: BattleView
  /** Uncovers the scene (resolves when fully visible). */
  reveal(): Promise<void>
  /** Waits scene time (advances with the render loop). */
  wait(ms: number): Promise<void>
  /** Resolves with `p`, or after timing.stageGuardMs of wall time: a stuck animation never blocks the battle. */
  settle(p: Promise<unknown>): Promise<void>
  /** Called every frame with dt (seconds) before rendering. */
  onFrame(fn: ((dt: number) => void) | null): void
  /** Fades to black, disposes the scene and starts the return fade-in (not awaited). */
  close(): Promise<void>
}

/** requestAnimationFrame tween (0..1) independent of any scene. */
export function tween(ms: number, fn: (k: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now()
    const tick = () => {
      const k = Math.min(1, (performance.now() - start) / Math.max(1, ms))
      fn(k)
      if (k >= 1) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

const HTML_CLASS = 'ap-battle-on'

export async function openScene(ctx: GameContext, opts: SceneOptions): Promise<BattleScene> {
  const TR = BATTLE_UI.transition
  if (opts.cover === 'transition') {
    ctx.audio.playSfx(TR.selfCover.sfx)
    await tween(TR.selfCover.ms, (k) => ctx.renderer.setTransition(TR.selfCover.kind, k))
  } else if (opts.cover === 'fade') {
    await ctx.ui.fade(true, TR.exit.fadeMs)
  }

  let built: BattleStage | null = null
  let view: BattleView
  try {
    built = createBattleStage(ctx.renderer, ctx.assets, { biome: opts.biome, timeOfDay: opts.timeOfDay, indoor: opts.indoor })
    view = createBattleView(ctx.audio, () => ctx.save.settings)
  } catch (err) {
    // Uncover whatever was there so a failed scene never leaves the screen black.
    try { built?.dispose() } catch { /* already failing */ }
    ctx.renderer.setTransition('none', 0)
    if (opts.cover === 'fade') void ctx.ui.fade(false, TR.returnFadeMs)
    throw err
  }
  const stage: BattleStage = built
  const panel: UIPanel = { el: view.root, onInput: (inp) => view.input(inp) }
  document.documentElement.classList.add(HTML_CLASS)
  ctx.ui.pushPanel(panel)

  const waits: { left: number; done: () => void }[] = []
  let frameHook: ((dt: number) => void) | null = null
  let raf = 0
  let last = performance.now()
  let closed = false
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(BATTLE_UI.stage.maxDtSec, Math.max(0, (now - last) / 1000))
    last = now
    for (let i = waits.length - 1; i >= 0; i--) {
      waits[i].left -= dt * 1000
      if (waits[i].left <= 0) waits.splice(i, 1)[0].done()
    }
    frameHook?.(dt)
    stage.update(dt)
    view.update(dt)
    ctx.renderer.render(stage.view, dt)
  }
  raf = requestAnimationFrame(frame)

  return {
    stage,
    view,
    async reveal() {
      if (opts.cover === 'fade') { await ctx.ui.fade(false, TR.reveal.ms); return }
      await tween(TR.reveal.ms, (k) => ctx.renderer.setTransition(TR.reveal.kind, 1 - k))
      ctx.renderer.setTransition('none', 0)
    },
    wait(ms) {
      if (ms <= 0 || closed) return Promise.resolve()
      return new Promise<void>((done) => waits.push({ left: ms, done }))
    },
    settle(p) {
      if (closed) return Promise.resolve()
      return new Promise<void>((done) => {
        const timer = setTimeout(() => {
          console.warn('[battle] stage animation timed out')
          done()
        }, BATTLE_UI.timing.stageGuardMs)
        const finish = () => { clearTimeout(timer); done() }
        p.then(finish, (err: unknown) => { console.error('[battle] stage animation failed', err); finish() })
      })
    },
    onFrame(fn) { frameHook = fn },
    async close() {
      if (closed) return
      try {
        await ctx.ui.fade(true, TR.exit.fadeMs)
      } finally {
        closed = true
        cancelAnimationFrame(raf)
        for (const w of waits.splice(0)) w.done()
        frameHook = null
        ctx.ui.popPanel(panel)
        view.root.remove()
        document.documentElement.classList.remove(HTML_CLASS)
        try { stage.dispose() } catch (err) { console.error('[battle] stage dispose failed', err) }
        ctx.renderer.setTransition('none', 0)
        void ctx.ui.fade(false, TR.returnFadeMs)
      }
    },
  }
}
