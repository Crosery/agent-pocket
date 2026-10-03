// Shared server-side shapes: a connection and the hub services that chat/trade/presence build on.
import type { WebSocket } from 'ws'
import type { PlayerState, PublicProfile, ServerMsg } from '../shared/protocol.ts'
import type { GameMap } from '../shared/types.ts'
import type { RateKey } from './config.ts'
import type { RateLimiter } from './util.ts'

export type LimiterKey = RateKey | 'chat'

export interface Conn {
  readonly ws: WebSocket
  readonly ip: string
  readonly connectedAt: number
  /** Spatial-index key; equals `id` once registered. */
  key: string
  /** Public player id (null until hello). */
  id: string | null
  name: string
  avatar: string
  state: PlayerState | null
  profile: PublicProfile | null
  /** Hub-wide monotonically increasing version of `state`, bumped on every change. */
  version: number
  clientBusy: boolean
  pvpBusy: boolean
  tradeId: string | null
  emoteUntil: number
  lastMoveAt: number
  /**
   * Resolved map of `state.map` (null without world rules). Held while the player stays on that map so a
   * frontier interior evicted from the provider's LRU is not regenerated on every move.
   */
  mapRef: { id: string; map: GameMap | null; width: number; height: number; infinite: boolean } | null
  /** Last accepted position on the overworld (frontier interiors must be entered near it). */
  lastOverworld: { x: number; y: number } | null
  /** Server-observed distance record (tiles from the origin, fractional) and the value last written to the store. */
  maxDistance: number
  distanceSaved: number
  /** Players currently in this connection's interest set → version last sent. */
  visible: Map<string, number>
  /** Map of the last snapshot sent; null forces a fresh snapshot next tick. */
  snapMap: string | null
  alive: boolean
  closed: boolean
  limits: Record<LimiterKey, RateLimiter>
  /** Position accessors for the spatial index (meaningful only once `state` is set). */
  get map(): string
  get x(): number
  get y(): number
}

/** A connection that completed hello. */
export type Player = Conn & { id: string; state: PlayerState; profile: PublicProfile }

export interface HubCore {
  send(c: Conn, msg: ServerMsg): void
  /** Same payload to many recipients (serialized once). */
  broadcast(to: Iterable<Conn>, msg: ServerMsg): void
  /** {t:'error', code, message: t('net.error.<code>')}, itself rate-limited per connection. */
  error(c: Conn, code: string): void
  byId(id: string): Player | undefined
  /** Lookup by public id, then by exact (case-insensitive) name. */
  find(target: string): Player | undefined
  players(): Iterable<Player>
  /** Players on the same map within `radius` tiles. */
  nearby(c: Player, radius: number, includeSelf: boolean): Player[]
  /** Same map and within `range` tiles (null = unlimited range). */
  inRange(a: Player, b: Player, range: number | null): boolean
  isBusy(c: Conn): boolean
  /** Recompute derived state (busy) and bump the version so watchers get a fresh snapshot. */
  touch(c: Player): void
}
