// WebSocket protocol between client (src/client/net) and server (src/server).
// Transport: JSON text frames on path /ws. Every message has a `t` discriminator.
// Limits/rates live in CONTENT.config.net.
import type {
  BattleAction, BattleEvent, BattleRequest, Creature, CreatureView, Dir, SideIndex,
} from './types.ts'

export interface PresenceLead { speciesId: string; shiny: boolean; level: number }

/** Public, compact state of another player as seen by others. */
export interface PlayerState {
  id: string
  name: string
  avatar: string
  map: string
  x: number
  y: number
  facing: Dir
  moving: boolean
  running: boolean
  lead: PresenceLead | null
  badges: number
  dexCaught: number
  busy: boolean              // in battle / trade
  emote?: string
}

export interface PublicProfile {
  id: string
  name: string
  avatar: string
  badges: string[]
  dexCaught: number
  party: CreatureView[]
  pvpWins: number
  pvpLosses: number
  playTimeSec: number
  /** Server-observed farthest overworld distance from the origin (tiles), filled in by the server only. */
  maxDistance?: number
}

export interface LeaderboardEntry { id: string; name: string; avatar: string; dexCaught: number; badges: number; pvpWins: number; pvpLosses: number; maxDistance?: number }

export type ChatChannel = 'global' | 'local' | 'system' | 'whisper'

// ----------------------------- client -> server -----------------------------

export type ClientMsg =
  | { t: 'hello'; v: number; playerId: string; name: string; avatar: string; map: string; x: number; y: number; facing: Dir; lead: PresenceLead | null; profile: PublicProfile; build?: { devtools: boolean } }
  | { t: 'move'; map: string; x: number; y: number; facing: Dir; moving: boolean; running: boolean }
  | { t: 'lead'; lead: PresenceLead | null }
  | { t: 'profile'; profile: PublicProfile }
  | { t: 'chat'; channel: 'global' | 'local' | 'whisper'; text: string; to?: string }
  | { t: 'emote'; emote: string }
  | { t: 'busy'; busy: boolean }
  | { t: 'inspect'; target: string }
  | { t: 'trade.request'; to: string }
  | { t: 'trade.respond'; from: string; accept: boolean }
  | { t: 'trade.offer'; tradeId: string; creature: Creature | null }
  | { t: 'trade.confirm'; tradeId: string }
  | { t: 'trade.cancel'; tradeId: string }
  | { t: 'pvp.challenge'; to: string }
  | { t: 'pvp.respond'; from: string; accept: boolean }
  | { t: 'pvp.party'; battleId: string; party: Creature[] }
  | { t: 'pvp.action'; battleId: string; action: BattleAction }
  | { t: 'pvp.forfeit'; battleId: string }
  | { t: 'leaderboard' }
  | { t: 'ping'; at: number }

// ----------------------------- server -> client -----------------------------

export type ServerMsg =
  | { t: 'welcome'; selfId: string; serverTime: number; motd: string; online: number }
  | { t: 'snapshot'; map: string; players: PlayerState[] }        // players near you on your map (excludes self)
  | { t: 'join'; player: PlayerState }
  | { t: 'leave'; id: string }
  | { t: 'chat'; from: string; name: string; channel: ChatChannel; text: string; at: number }
  | { t: 'emote'; id: string; emote: string }
  | { t: 'profile'; profile: PublicProfile }
  | { t: 'online'; count: number; players: { id: string; name: string; map: string; avatar: string; busy: boolean }[] }
  | { t: 'trade.requested'; from: string; name: string }
  | { t: 'trade.start'; tradeId: string; with: string; name: string }
  | { t: 'trade.offer'; tradeId: string; side: 'self' | 'other'; creature: Creature | null }
  | { t: 'trade.confirmed'; tradeId: string; side: 'self' | 'other' }
  | { t: 'trade.complete'; tradeId: string; received: Creature; given: string /* uid */ }
  | { t: 'trade.cancelled'; tradeId: string; reason: string }
  | { t: 'pvp.challenged'; from: string; name: string }
  | { t: 'pvp.start'; battleId: string; side: SideIndex; opponent: { id: string; name: string; avatar: string }; levelCap: number }
  | { t: 'pvp.begin'; battleId: string; seed: number; yourParty: CreatureView[]; theirLead: CreatureView; theirPartySize: number }
  | { t: 'pvp.events'; battleId: string; events: BattleEvent[]; request: BattleRequest }   // events already in YOUR perspective (you are side 0)
  | { t: 'pvp.end'; battleId: string; result: 'win' | 'lose' | 'draw' | 'forfeit' | 'disconnect' }
  | { t: 'leaderboard'; entries: LeaderboardEntry[] }
  | { t: 'system'; text: string; level: 'info' | 'warn' | 'error' }
  | { t: 'error'; code: string; message: string }
  | { t: 'pong'; at: number; serverTime: number }
