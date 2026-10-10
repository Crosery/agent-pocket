// Story triggers (content/world/story/triggers.json): scripts that start themselves when a game event fires.
// Events only queue a trigger; it runs from update() once the world is free, so it never cuts into a fight,
// a menu or another script. Conditions are checked again at run time, `once` triggers write the flag `trig:<id>`.
import type { ScriptStep } from '../../shared/types.ts'
import { storyFeatures, type StoryTrigger } from '../../shared/world/story.ts'
import type { GameContext } from '../contracts.ts'
import { condHolds } from '../onboarding/logic.ts'
import { flagSet } from './save-ops.ts'

export interface TriggerDeps {
  readonly ctx: GameContext
  /** True while nothing else owns the player (controller isFree). */
  isFree(): boolean
  run(steps: readonly ScriptStep[]): Promise<void>
}

const ONCE_FLAG_PREFIX = 'trig:'

/** The payload fields a trigger's `match` can test, per event. */
function viewOf(ctx: GameContext, on: string, p: unknown): Record<string, string> {
  const e = (p ?? {}) as Record<string, unknown>
  if (on === 'dex:caught') return { species: String(e.speciesId ?? '') }
  if (on === 'map:entered') return { map: String(e.mapId ?? '') }
  if (on === 'region:entered') {
    const map = ctx.data.world.maps[String(e.mapId ?? '')]
    return { map: String(e.mapId ?? ''), region: map?.regions?.[Number(e.regionIndex)]?.id ?? '' }
  }
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, String(v)]))
}

export function createTriggers(deps: TriggerDeps) {
  const { ctx } = deps
  const all: StoryTrigger[] = storyFeatures(ctx.data.world).triggers
  const queue: StoryTrigger[] = []
  let running = false

  const open = (t: StoryTrigger) => !(t.once && flagSet(ctx.save, ONCE_FLAG_PREFIX + t.id)) && condHolds(t.when, ctx.save)

  const offs = [...new Set(all.map((t) => t.on))].map((on) =>
    (ctx.events as unknown as { on(type: string, fn: (p: unknown) => void): () => void }).on(on, (payload) => {
      const view = viewOf(ctx, on, payload)
      for (const t of all) {
        if (t.on !== on || queue.includes(t)) continue
        if (Object.entries(t.match ?? {}).some(([k, v]) => view[k] !== v)) continue
        if (open(t)) queue.push(t)
      }
    }))

  return {
    /** Start the oldest queued trigger when the world is free. */
    update(): void {
      if (running || !queue.length || !deps.isFree()) return
      const t = queue.shift()!
      if (!open(t)) return
      running = true
      if (t.once) ctx.save.flags[ONCE_FLAG_PREFIX + t.id] = true
      void deps.run(t.steps).finally(() => { running = false })
    },
    get pending(): number { return queue.length },
    dispose(): void { for (const off of offs) off(); queue.length = 0 },
  }
}

export type TriggerRunner = ReturnType<typeof createTriggers>
