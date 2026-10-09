// The seam between src/client/game.ts and the developer tooling. Type-only: game.ts imports it with
// `import type` and loads the implementation (./index.ts) through a dynamic import that exists only when
// DEVTOOLS is true, so the production bundle holds neither this contract nor anything behind it.
import type { DevCommandCall, SaveData, World } from '../../shared/types.ts'
import type { GameContext, SaveManager, Screens } from '../contracts.ts'
import type { RngHub } from '../core/rng-hub.ts'
import type { Onboarding } from '../onboarding/index.ts'
import type { OverworldExt } from '../world/controller.ts'
import type { StorageLike } from '../core/save.ts'
import type { DevClock } from './clock.ts'
import type { DevContent } from './content.ts'
import type { Editor } from './editor/index.ts'
import type { NetSim } from './net-sim.ts'

/** What game.ts hands to the developer tooling: the live game objects and one frame of the main loop. */
export interface GameHost {
  ctx: GameContext
  overworld: OverworldExt
  world: World
  onboarding: Onboarding
  flyTo(placeId: string): Promise<void>
  /** Runs one main-loop frame of `dtSec` seconds (what the frame callback does after dt is known). */
  tick(dtSec: number): void
}

/** What developer commands may touch: the game plus the dev-owned time and random controls. */
export interface DevHost extends GameHost {
  rng: RngHub
  clock: DevClock
  content: DevContent
  /** The WebSocket replacement: link quality, forced drops, the fake server. */
  net: NetSim
  /** The world editor (select, drag, rotate, delete, place, write back). */
  editor: Editor
  /** Which scenario the session is in (info(), scenario.check()). */
  session: { scenario: string | null }
  /** Runs one command through the registry (scenarios and the command line use it). */
  run(call: DevCommandCall): Promise<unknown>
  /** The state document ({ save, runtime, world }); `sections` limits the work. */
  dump(sections?: readonly ('save' | 'runtime' | 'world')[]): Record<string, unknown>
}

export interface DevKit {
  /** Save slot of this tab (several clients share one browser's localStorage). */
  readonly slot: number
  /** Start straight in the world with a debug save instead of the title flow. */
  readonly skipTitle: boolean
  /** Scenario mode keeps the save in memory (no slot is touched) unless &slot was given. */
  readonly storage: StorageLike | null
  /** Pinned world seed (&seed=, else the scenario's), or null for the configured one. */
  readonly worldSeed: number | null
  /** Pinned master random seed (&rng=), or null for a random one per session. */
  readonly rngSeed: number | null
  /** Seconds to simulate for a real frame, or null while the developer paused time. */
  frameDt(realDtSec: number): number | null
  /** The in-game clock is held still (&t=<minutes>). */
  clockFrozen(): boolean
  /** The world is built: content self-checks and the &reset=1 slot wipe. */
  afterWorld(world: World): void
  /** A ready-to-play save for an empty slot (skipTitle). */
  newSave(saves: SaveManager, world: World): SaveData
  /** Start overrides (position, clock) for the save about to be played. */
  applyStart(ctx: GameContext, world: World): void
  /** Console and automation hooks (window.__ap and friends). */
  install(host: GameHost): void
  /** Post-load actions: forced weather, evolution, a battle, a screen. */
  runActions(ctx: GameContext, overworld: OverworldExt, world: World, screens: Screens): Promise<void>
}
