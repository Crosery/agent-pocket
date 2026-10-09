// Typed access to the net/moderation content files. Server tunables live in content/net.json
// (transport, rates, persistence, http, world validation) and content/moderation.json; presence/proximity rules
// in content/multiplayer.json (presence); gameplay limits stay in CONTENT.config.net.
import netJson from '../../content/net.json' with { type: 'json' }
import moderationJson from '../../content/moderation.json' with { type: 'json' }
import multiplayerJson from '../../content/multiplayer.json' with { type: 'json' }
import type { Dir } from '../shared/types.ts'
import { isDir } from './util.ts'

export interface Rate { count: number; perSeconds: number }

export type RateKey =
  | 'message' | 'messageKick' | 'move' | 'jump' | 'emote' | 'profile' | 'inspect' | 'leaderboard'
  | 'tradeRequest' | 'tradeAction' | 'pvp' | 'errors'

export type CloseCodeKey = 'shutdown' | 'duplicate' | 'version' | 'flood' | 'helloTimeout' | 'serverFull' | 'slowConsumer' | 'devNotAllowed'

/** content/net.json server.world: tile-level movement validation on the (infinite) world. */
export interface WorldNetConfig {
  /** |x| and |y| limit on infinite maps (keeps procedural generation inside sane float ranges). */
  maxCoordTiles: number
  /** Extra tiles around the from/to box that a step-path search may use. */
  pathMarginTiles: number
  /** Node cap of the step-path search (beyond it the move counts as a resync jump). */
  pathMaxNodes: number
  /** Global budget of frontier chunks generated for validation; when spent, moves fall back to speed checks. */
  chunkGen: Rate
  /** Interval of provider.retain() around online players. */
  retainSeconds: number
  retainRadiusTiles: number
  /** A frontier interior may be entered only this close to its site (from the last overworld position). */
  interiorReachTiles: number
  /** Walks credit the distance record only when they start within record + slack of the origin. */
  distanceSlackTiles: number
  /** Persist the distance record only when it grew by at least this much. */
  distanceStepTiles: number
}

/** content/multiplayer.json presence: interest management and proximity rules (tiles; null range = unlimited). */
export interface PresenceConfig {
  viewRadiusTiles: number
  /** Already visible players stay visible until viewRadius + leaveMargin (no join/leave flapping). */
  leaveMarginTiles: number
  tradeRangeTiles: number | null
  pvpRangeTiles: number | null
}

export interface NetFile {
  protocol: { wsPath: string; closeCodes: Record<CloseCodeKey, number> }
  server: {
    defaultPort: number
    maxPayloadBytes: number
    heartbeatSeconds: number
    helloTimeoutSeconds: number
    onlineSummarySeconds: number
    onlineListMax: number
    maxClients: number
    maxClientsPerIp: number
    trustProxy: boolean
    snapshotMaxPlayers: number
    maxBufferedBytes: number
    skipSnapshotAboveBytes: number
    emoteSeconds: number
    emoteMaxLen: number
    /** Facing used when a hello carries an invalid one and no world spawn applies. */
    defaultFacing: Dir
    boundsSlackTiles: number
    moveSpeedSlack: number
    moveToleranceTiles: number
    moveMaxDtSeconds: number
    tradeRequestSeconds: number
    sweepSeconds: number
    closeGraceMs: number
    rates: Record<RateKey, Rate>
    profileLimits: { badgesMax: number; idMaxLen: number; maxHp: number; playTimeMaxSec: number }
    world: WorldNetConfig
  }
  store: { defaultDir: string; file: string; debounceMs: number; maxProfiles: number; version: number }
  leaderboard: { size: number; sortBy: LeaderboardSortKey[] }
  http: {
    apiPrefix: string
    healthPath: string
    leaderboardPath: string
    distDir: string
    publicDir: string
    indexFile: string
    hashedAssetPattern: string
    immutableMaxAgeSeconds: number
    defaultMaxAgeSeconds: number
    compressMinBytes: number
    compressCacheBytes: number
    brotliQuality: number
    gzipLevel: number
    compressible: string[]
    defaultMime: string
    mime: Record<string, string>
  }
}

export type LeaderboardSortKey = 'dexCaught' | 'badges' | 'pvpWins' | 'pvpLosses' | 'maxDistance'

export interface ModerationFile {
  mask: string
  /** Characters skipped while matching banned words ("傻 . 逼" still matches). */
  ignoreBetween: string
  /** Matched anywhere (after NFKC + lowercase). */
  bannedWords: string[]
  /** Matched only when not glued to other ASCII letters/digits. */
  bannedWordsWhole: string[]
  name: {
    minLen: number
    /** Length of the id-derived tag used in fallback/duplicate names. */
    tagLength: number
    /** Max suffix attempts when making a name unique. */
    uniqueAttempts: number
    forbiddenChars: string
    reserved: string[]
  }
  chat: { maxRepeatRun: number }
}

export const NET: NetFile = netJson as unknown as NetFile
export const MODERATION: ModerationFile = moderationJson as unknown as ModerationFile
export const PRESENCE: PresenceConfig = (multiplayerJson as unknown as { presence: PresenceConfig }).presence

const RATE_KEYS: readonly RateKey[] = [
  'message', 'messageKick', 'move', 'jump', 'emote', 'profile', 'inspect', 'leaderboard',
  'tradeRequest', 'tradeAction', 'pvp', 'errors',
]
const CLOSE_KEYS: readonly CloseCodeKey[] = ['shutdown', 'duplicate', 'version', 'flood', 'helloTimeout', 'serverFull', 'slowConsumer', 'devNotAllowed']
const SORT_KEYS: readonly LeaderboardSortKey[] = ['dexCaught', 'badges', 'pvpWins', 'pvpLosses', 'maxDistance']

/** Structural validation of content/net.json + content/moderation.json + multiplayer.json presence (empty = OK). */
export function validateNetContent(net: NetFile = NET, mod: ModerationFile = MODERATION, presence: PresenceConfig = PRESENCE): string[] {
  const errs: string[] = []
  const pos = (where: string, v: unknown) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) errs.push(`${where}: must be a positive number`)
  }
  const nonNeg = (where: string, v: unknown) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) errs.push(`${where}: must be a non-negative number`)
  }
  if (!net.protocol?.wsPath?.startsWith('/')) errs.push('net.protocol.wsPath: must start with "/"')
  for (const k of CLOSE_KEYS) {
    const c = net.protocol?.closeCodes?.[k]
    if (typeof c !== 'number' || !(c === 1000 || c === 1001 || (c >= 4000 && c <= 4999))) errs.push(`net.protocol.closeCodes.${k}: must be 1000/1001 or 4000-4999`)
  }
  const s = net.server
  for (const k of [
    'defaultPort', 'maxPayloadBytes', 'heartbeatSeconds', 'helloTimeoutSeconds', 'onlineSummarySeconds', 'onlineListMax',
    'maxClients', 'maxClientsPerIp', 'snapshotMaxPlayers', 'maxBufferedBytes', 'skipSnapshotAboveBytes', 'emoteSeconds',
    'emoteMaxLen', 'moveSpeedSlack', 'moveMaxDtSeconds', 'tradeRequestSeconds', 'sweepSeconds', 'closeGraceMs',
  ] as const) pos(`net.server.${k}`, s?.[k])
  nonNeg('net.server.boundsSlackTiles', s?.boundsSlackTiles)
  nonNeg('net.server.moveToleranceTiles', s?.moveToleranceTiles)
  if (typeof s?.trustProxy !== 'boolean') errs.push('net.server.trustProxy: must be boolean')
  if (!isDir(s?.defaultFacing)) errs.push('net.server.defaultFacing: must be a Dir')
  for (const k of RATE_KEYS) {
    pos(`net.server.rates.${k}.count`, s?.rates?.[k]?.count)
    pos(`net.server.rates.${k}.perSeconds`, s?.rates?.[k]?.perSeconds)
  }
  for (const k of ['badgesMax', 'idMaxLen', 'maxHp', 'playTimeMaxSec'] as const) pos(`net.server.profileLimits.${k}`, s?.profileLimits?.[k])
  const w = s?.world
  for (const k of ['maxCoordTiles', 'pathMaxNodes', 'retainSeconds', 'retainRadiusTiles', 'interiorReachTiles'] as const) pos(`net.server.world.${k}`, w?.[k])
  for (const k of ['pathMarginTiles', 'distanceSlackTiles', 'distanceStepTiles'] as const) nonNeg(`net.server.world.${k}`, w?.[k])
  pos('net.server.world.chunkGen.count', w?.chunkGen?.count)
  pos('net.server.world.chunkGen.perSeconds', w?.chunkGen?.perSeconds)
  pos('multiplayer.presence.viewRadiusTiles', presence?.viewRadiusTiles)
  nonNeg('multiplayer.presence.leaveMarginTiles', presence?.leaveMarginTiles)
  for (const k of ['tradeRangeTiles', 'pvpRangeTiles'] as const) if (presence?.[k] !== null) pos(`multiplayer.presence.${k}`, presence?.[k])
  if (!net.store?.defaultDir || !net.store?.file) errs.push('net.store: defaultDir and file are required')
  for (const k of ['debounceMs', 'maxProfiles', 'version'] as const) pos(`net.store.${k}`, net.store?.[k])
  pos('net.leaderboard.size', net.leaderboard?.size)
  if (!Array.isArray(net.leaderboard?.sortBy) || net.leaderboard.sortBy.length === 0) errs.push('net.leaderboard.sortBy: non-empty array required')
  else for (const k of net.leaderboard.sortBy) if (!SORT_KEYS.includes(k)) errs.push(`net.leaderboard.sortBy: unknown key "${k}"`)
  const h = net.http
  for (const k of ['apiPrefix', 'healthPath', 'leaderboardPath'] as const) if (!h?.[k]?.startsWith('/')) errs.push(`net.http.${k}: must start with "/"`)
  if (!h?.distDir || !h?.indexFile || !h?.defaultMime) errs.push('net.http: distDir, indexFile and defaultMime are required')
  try { new RegExp(h?.hashedAssetPattern ?? '') } catch { errs.push('net.http.hashedAssetPattern: invalid RegExp') }
  for (const k of ['immutableMaxAgeSeconds', 'defaultMaxAgeSeconds', 'compressMinBytes', 'compressCacheBytes'] as const) nonNeg(`net.http.${k}`, h?.[k])
  if (!Number.isInteger(h?.brotliQuality) || h.brotliQuality < 0 || h.brotliQuality > 11) errs.push('net.http.brotliQuality: integer 0-11')
  if (!Number.isInteger(h?.gzipLevel) || h.gzipLevel < 1 || h.gzipLevel > 9) errs.push('net.http.gzipLevel: integer 1-9')
  for (const [ext, mime] of Object.entries(h?.mime ?? {})) {
    if (!/^\.[a-z0-9]+$/.test(ext)) errs.push(`net.http.mime: bad extension key "${ext}"`)
    if (typeof mime !== 'string' || !mime.includes('/')) errs.push(`net.http.mime[${ext}]: bad mime "${String(mime)}"`)
  }
  for (const ext of ['.html', '.js', '.css', '.woff2', '.glb', '.mp3', '.png', '.json']) if (!h?.mime?.[ext]) errs.push(`net.http.mime: missing "${ext}"`)

  if (typeof mod.mask !== 'string' || [...mod.mask].length !== 1) errs.push('moderation.mask: must be a single character')
  if (typeof mod.ignoreBetween !== 'string') errs.push('moderation.ignoreBetween: must be a string')
  for (const k of ['bannedWords', 'bannedWordsWhole'] as const) {
    if (!Array.isArray(mod[k])) { errs.push(`moderation.${k}: must be an array`); continue }
    const seen = new Set<string>()
    for (const w of mod[k]) {
      if (typeof w !== 'string' || w.trim() === '') errs.push(`moderation.${k}: empty entry`)
      else if (seen.has(w.toLowerCase())) errs.push(`moderation.${k}: duplicate "${w}"`)
      else seen.add(w.toLowerCase())
    }
  }
  for (const w of mod.bannedWordsWhole ?? []) if (!/^[a-z0-9]+$/i.test(w)) errs.push(`moderation.bannedWordsWhole: "${w}" must be ASCII alphanumeric`)
  pos('moderation.name.minLen', mod.name?.minLen)
  pos('moderation.name.tagLength', mod.name?.tagLength)
  pos('moderation.name.uniqueAttempts', mod.name?.uniqueAttempts)
  if (typeof mod.name?.forbiddenChars !== 'string') errs.push('moderation.name.forbiddenChars: must be a string')
  if (!Array.isArray(mod.name?.reserved)) errs.push('moderation.name.reserved: must be an array')
  pos('moderation.chat.maxRepeatRun', mod.chat?.maxRepeatRun)
  return errs
}
