// Multiplayer dungeon server adapter: wraps shared coop DungeonRuntime with HubCore and Player presence.
import { randomInt } from 'node:crypto'
import type { CoopClientMsg } from '../shared/coop/protocol.ts'
import {
  createDungeonRuntime,
  type DungeonAuthority,
  type DungeonRuntime,
} from '../shared/coop/runtime.ts'
import type { HubCore, Player } from './core.ts'
import { resolveServerSaveSecret } from './save-sign.ts'
export interface DungeonServerOptions {
  core: HubCore
  authority: DungeonAuthority
  lookupPlayer: (id: string) => Player | null
  log?: (msg: string) => void
}

export interface DungeonServer {
  handle(p: Player, msg: CoopClientMsg): void
  onPlayerLeave(p: Player): void
  close(): void
}

export function createDungeonServer(opts: DungeonServerOptions): DungeonServer {
  const { core, authority } = opts
  const runtime: DungeonRuntime = createDungeonRuntime({
    authority,
    lookupPlayer: (id) => opts.lookupPlayer(id),
    send: (p, msg) => core.send(p as Player, msg),
    inRange: (a, b, range) => core.inRange(a as Player, b as Player, range),
    onBusyChange: (p) => core.touch(p as Player),
    allowParties: true,
    randomSeed: () => randomInt(1, 0x7fffffff),
    secretKey: resolveServerSaveSecret(),
    scrubPublicInit: true,
    log: opts.log,
  })
  return {
    handle: (p, msg) => runtime.handle(p, msg),
    onPlayerLeave: (p) => runtime.onPlayerLeave(p),
    close: () => runtime.close(),
  }
}
