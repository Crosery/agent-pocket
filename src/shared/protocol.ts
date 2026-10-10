// WebSocket protocol between client (src/client/net) and server (src/server).
// Transport: JSON text frames on path /ws. Every message has a `t` discriminator.
// Limits/rates live in CONTENT.config.net.
import type {
  BattleAction, BattleEvent, BattleInit, BattleRequest, BattleResult, Creature, CreatureView, Dir, SaveData, SideIndex, TimeOfDay, WeatherId,
} from './types.ts'
import type { CompactMoveTuple, CompactPlayerTuple } from './net-codec.ts'
export type { CompactMoveTuple, CompactPlayerTuple } from './net-codec.ts'

import type { CoopClientMsg, CoopServerMsg } from './coop/protocol.ts'
export * from './coop/index.ts'
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

export interface MoveClientMsg {
  t: 'move'
  seq?: number
  map?: string
  x?: number
  y?: number
  facing?: Dir
  moving?: boolean
  running?: boolean
  d?: CompactMoveTuple
}

export interface EnvelopeFields {
  /** Distinct monotonic per-connection sequence number for signed envelope replay protection (separate from move.seq). */
  authSeq?: number
  /** Hex HMAC-SHA256 signature over `${authSeq}:${canonicalJson(payloadWithoutSig)}`. */
  sig?: string
}

export type ClientMsgCore =
  | { t: 'hello'; v: number; playerId: string; name: string; avatar: string; map: string; x: number; y: number; facing: Dir; lead: PresenceLead | null; profile: PublicProfile; build?: { devtools: boolean }; compact?: boolean; signed?: boolean }
  | MoveClientMsg
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
  | { t: 'ping'; at: number; rtt?: number }
  | {
    t: 'battle.start'
    kind: 'wild' | 'trainer' | 'boss'
    speciesId?: string
    level?: number
    scripted?: boolean
    roamer?: boolean
    moves?: string[]
    gradeFloor?: string
    catchRateMul?: number
    flee?: { chancePerTurn: number; afterTurn: number }
    trainerId?: string
    bossId?: string
    tierId?: string
    assist?: boolean
    coach?: boolean
    skipBrief?: boolean
    captureAfterWin?: boolean
    timeOfDay?: TimeOfDay
    weather?: WeatherId
  }
  | { t: 'battle.action'; battleId: string; action: BattleAction }
  | { t: 'battle.contract'; battleId: string; bossId: string; tierId: string; ballId: string }
  | { t: 'shop.buy'; itemId: string; qty: number; priceMul?: number }
  | { t: 'shop.sell'; itemId: string; qty: number }
  | { t: 'item.use'; itemId: string; partyIndex?: number; moveIndex?: number; natureId?: string }
  | { t: 'exchange.deal'; desk: string; offerIndex: number; qty: number }
  | { t: 'creature.evolve'; partyIndex: number; toSpeciesId: string }
  | { t: 'creature.learnMove'; partyIndex: number; moveId: string; replaceIndex?: number }
  | { t: 'creature.nickname'; uid: string; nickname?: string }
  | { t: 'party.swap'; a: number; b: number }
  | { t: 'box.move'; from: { area: 'party' | 'box'; box: number; index: number }; to: { area: 'party' | 'box'; box: number; index: number } }
  | { t: 'box.release'; slot: { area: 'party' | 'box'; box: number; index: number } }
  | {
    t: 'script.op'
    op:
      | 'chooseStarter'
      | 'heal'
      | 'blackout'
      | 'pickup'
      | 'setFlag'
      | 'quest'
      | 'giveItem'
      | 'takeItem'
      | 'giveMoney'
      | 'takeMoney'
      | 'giveCreature'
      | 'setRespawn'
      | 'unlockTown'
      | 'teach'
      | 'research'
      | 'settleBossCards'
    speciesId?: string
    itemId?: string
    groundId?: string
    qty?: number
    amount?: number
    level?: number
    shiny?: boolean
    nature?: string
    ability?: string
    moves?: string[]
    gradeFloor?: string
    creature?: Creature
    flag?: string
    value?: boolean | number | string
    questId?: string
    stage?: number
    done?: boolean
    map?: string
    x?: number
    y?: number
    facing?: Dir
    townId?: string
    lesson?: string
    task?: string
  }
  | { t: 'save.import'; save: unknown; slotSig?: string | null; slotIndex?: number }

export type ClientMsg = (ClientMsgCore | CoopClientMsg) & EnvelopeFields
// ----------------------------- server -> client -----------------------------

export type ServerMsg =
  | {
    t: 'welcome'; selfId: string; serverTime: number; motd: string; online: number
    sessionKey?: string; authority?: boolean; save?: SaveData; saveRev?: number; untrustedImport?: boolean
  }
  | { t: 'snapshot'; map: string; players: PlayerState[]; d?: CompactPlayerTuple[]; at?: number; ack?: number }
  | { t: 'join'; player: PlayerState; s?: number }
  | { t: 'leave'; id: string }
  | { t: 'move.correct'; seq: number; map: string; x: number; y: number; facing: Dir; reason?: string }
  | { t: 'chat'; from: string; name: string; channel: ChatChannel; text: string; at: number }
  | { t: 'emote'; id: string; emote: string }
  | { t: 'profile'; profile: PublicProfile }
  | { t: 'online'; count: number; players: { id: string; name: string; map: string; avatar: string; busy: boolean }[]; delta?: boolean; left?: string[] }
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
  | { t: 'pong'; at: number; serverTime: number; ack?: number }
  | { t: 'state.sync'; save: SaveData; rev: number; reason?: string }
  | { t: 'battle.started'; battleId: string; seed: number; init: BattleInit; events: BattleEvent[]; request: BattleRequest }
  | { t: 'battle.events'; battleId: string; events: BattleEvent[]; request: BattleRequest }
  | { t: 'battle.end'; battleId: string; result: BattleResult; moneyDelta: number; caught?: Creature; save: SaveData; rev: number }
  | {
    t: 'battle.contracted'
    battleId: string
    signed: { card: Creature; where: 'party' | 'box'; newEntry: boolean } | null
    save: SaveData
    rev: number
  }
  | CoopServerMsg
