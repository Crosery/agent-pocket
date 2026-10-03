// Local BattleChannel over an in-process BattleEngine (wild / trainer battles). The engine auto-plays AI sides;
// the channel resolves every step until the local player (side 0) has to decide again or the battle is over.
// A rejected action resolves with the engine's error text as a 'msg' event and the unchanged request.
import type { BattleAction, BattleEvent, BattleRequest } from '../../shared/types.ts'
import type { BattleChannel } from '../contracts.ts'
import { BattleEngine, perspective } from '../../shared/battle/engine.ts'
import { BATTLE_UI } from './config.ts'

export interface LocalChannel extends BattleChannel {
  /** The engine behind the channel (full state for the presenter: parties, stages, volatiles). */
  readonly engine: BattleEngine
}

const WAIT: BattleRequest = { kind: 'wait' }

export function isLocalChannel(ch: BattleChannel): ch is LocalChannel {
  return (ch as Partial<LocalChannel>).engine instanceof BattleEngine
}

export function createLocalChannel(engine: BattleEngine, maxAutoSteps = BATTLE_UI.channel.maxAutoSteps): LocalChannel {
  let disposed = false

  /** Steps through turns that need no input from side 0 (recharge turns, AI-only phases). */
  const drain = (events: BattleEvent[]): { events: BattleEvent[]; request: BattleRequest } => {
    for (let i = 0; i < maxAutoSteps && !engine.finished && engine.request(0).kind === 'wait' && engine.ready(); i++) {
      events.push(...engine.step())
    }
    return { events: perspective(events, 0), request: engine.finished || disposed ? WAIT : engine.request(0) }
  }

  return {
    engine,
    async start() {
      return drain([...engine.start()])
    },
    async submit(action: BattleAction) {
      if (disposed || engine.finished) return { events: [], request: WAIT }
      const err = engine.choose(0, action)
      if (err !== null) return { events: [{ t: 'msg', text: err }], request: engine.request(0) }
      const events: BattleEvent[] = engine.ready() ? [...engine.step()] : []
      return drain(events)
    },
    dispose() {
      disposed = true
    },
  }
}
