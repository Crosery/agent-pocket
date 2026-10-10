// Shared server-side shapes: a connection and the hub services that chat/trade/presence build on.
import type { WebSocket } from 'ws'
import type { PlayerState, PublicProfile, ServerMsg } from '../shared/protocol.ts'
import type { GameMap } from '../shared/types.ts'
import type { SessionInfo } from './accounts.ts'
import type { ReplayWindow } from '../shared/net-envelope.ts'
import type { RateKey } from './config.ts'
import type { RateLimiter } from './util.ts'

export type LimiterKey = RateKey | 'chat'
export interface VisiblePeerState {
  version: number
  slot: number
  staticKey: string
  lastSentTick: number
}

export interface Conn {
  readonly ws: WebSocket
  readonly ip: string
  readonly connectedAt: number
  /** Authenticated account id from session cookie (null for unauthenticated guest connections). */
  accountId?: string | null
  /** Validated session metadata when connected with an authenticated session cookie. */
  session?: SessionInfo | null
  /** Spatial-index key; equals `id` once registered. */
  key: string
  /** Public player id (null until hello). */
  id: string | null

  /** Per-connection HMAC-SHA256 session key issued on welcome (#22). */
  sessionKey: string
  /** True once the client opts into signed envelopes or sends a signed frame. */
  signed: boolean
  /** Monotonic sliding-window replay detector for this connection. */
  replayWindow: ReplayWindow
  name: string
  avatar: string
  state: PlayerState | null
  profile: PublicProfile | null
  /** Hub-wide monotonically increasing version of `state`, bumped on every change. */
  version: number
  /** True when the client requested compact delta frames in `hello`. */
  compact: boolean
  /** Next compact integer slot id to assign to a newly visible peer. */
  nextSlot: number
  /** Highest `move.seq` received from this client. */
  lastMoveSeq: number
  /** True when `lastMoveSeq` changed and has not yet been acknowledged in a snapshot/pong. */
  ackDirty: boolean
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
  /** Players currently in this connection's interest set → version/slot/staticKey last sent. */
  visible: Map<string, VisiblePeerState>
  /** Last online roster fingerprints sent to this connection (`id -> fingerprint`). */
  rosterSent: Map<string, string>
  lastOnlineCount: number
  /** Map of the last snapshot sent; null forces a fresh snapshot next tick. */
  snapMap: string | null
  /** Per-connection RTT and traffic statistics (#23). */
  pingSentAt: number
  rtt: number
  rttSamples: number[]
  rttDiffSamples: number[]
  rxBytes: number
  txBytes: number
  rxMsgs: number
  txMsgs: number
  rxWindow: { at: number; bytes: number }[]
  txWindow: { at: number; bytes: number }[]
  movesAccepted: number
  movesRejected: number
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
