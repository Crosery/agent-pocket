// The fake game server behind the developer net simulation (ADR 0002 §3.4): a pure state machine that answers client
// messages and produces the periodic snapshots of a crowd of walking fake players. It owns no timers or sockets;
// src/client/dev/net-sim.ts drives it, scripts/dev/bots.ts reuses its walking patterns for real bot connections.
import type { ClientMsg, LeaderboardEntry, PlayerState, PublicProfile, ServerMsg } from '../protocol.ts'
import type { Dir } from '../types.ts'

export type WalkPattern =
  | { kind: 'circle'; radius: number; speed: number }
  | { kind: 'line'; axis: 'x' | 'y'; length: number; speed: number }
  | { kind: 'wander'; radius: number; turnEverySec: number }
  | { kind: 'idle' }

export interface FakeConfig {
  selfId: string
  snapshotHz: number
  onlineSeconds: number
  peers: number
  /** Fake players start within this many tiles of the real player's position. */
  radiusTiles: number
  positionDecimals: number
  /** Every n-th fake player is shown as busy. */
  busyEvery: number
  dexMax: number
  badgesMax: number
  pvpMax: number
  patterns: WalkPattern[]
}

export interface FakeText {
  motd: string
  peerName(n: number): string
  /** Told to the player when they try something the fake server cannot do (trades, PvP). */
  unsupported: string
}

export interface PeerPose { x: number; y: number; facing: Dir; moving: boolean }

const GOLDEN = 0.6180339887498949

/** Deterministic hash of two integers to [0, 1). */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  h = Math.imul(h, 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

const frac = (v: number): number => v - Math.floor(v)
/** Triangle wave in [0, 1] with period 1. */
const tri = (v: number): number => 1 - Math.abs(2 * frac(v) - 1)

function facingOf(dx: number, dy: number, fallback: Dir): Dir {
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return fallback
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')
}

const DIRS: Dir[] = ['down', 'left', 'right', 'up']

/** Where peer `index` starts: a deterministic spot on a spread ring around the centre. */
export function peerHome(cfg: FakeConfig, index: number, center: { x: number; y: number }): { x: number; y: number } {
  const angle = index * GOLDEN * Math.PI * 2
  const dist = cfg.radiusTiles * (0.35 + 0.65 * frac((index + 1) * GOLDEN))
  return { x: center.x + Math.cos(angle) * dist, y: center.y + Math.sin(angle) * dist }
}

/** Pose of peer `index` `tSec` seconds after the simulation started. Pure: the same inputs always give the same pose. */
export function peerAt(cfg: FakeConfig, index: number, tSec: number, center: { x: number; y: number }): PeerPose {
  const pat = cfg.patterns[index % cfg.patterns.length]
  const home = peerHome(cfg, index, center)
  const phase = hash01(index, 7)
  const idleFacing = DIRS[Math.floor(hash01(index, 3) * 4)]
  switch (pat.kind) {
    case 'idle': return { ...home, facing: idleFacing, moving: false }
    case 'circle': {
      const w = pat.speed / pat.radius
      const a = phase * Math.PI * 2 + w * tSec
      return { x: home.x + Math.cos(a) * pat.radius, y: home.y + Math.sin(a) * pat.radius, facing: facingOf(-Math.sin(a), Math.cos(a), idleFacing), moving: true }
    }
    case 'line': {
      const k = phase + (pat.speed * tSec) / (2 * pat.length)
      const along = tri(k) * pat.length
      const forward = frac(k) < 0.5 ? 1 : -1
      const [dx, dy] = pat.axis === 'x' ? [forward, 0] : [0, forward]
      return { x: home.x + (pat.axis === 'x' ? along : 0), y: home.y + (pat.axis === 'y' ? along : 0), facing: facingOf(dx, dy, idleFacing), moving: true }
    }
    case 'wander': {
      const seg = Math.floor(tSec / pat.turnEverySec)
      const u = (tSec - seg * pat.turnEverySec) / pat.turnEverySec
      const at = (k: number) => ({ x: home.x + (hash01(index, 100 + k) * 2 - 1) * pat.radius, y: home.y + (hash01(index, 200 + k) * 2 - 1) * pat.radius })
      const a = at(seg)
      const b = at(seg + 1)
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, facing: facingOf(b.x - a.x, b.y - a.y, idleFacing), moving: true }
    }
  }
}

const peerId = (i: number): string => `dev-peer-${i}`

export class FakeServer {
  private n: number
  private hello = false
  private map = ''
  private selfName = ''
  private center = { x: 0, y: 0 }
  private lastOnlineAt = 0
  private readonly cfg: FakeConfig
  private readonly text: FakeText
  private readonly avatars: string[]
  private readonly startMs: number

  constructor(cfg: FakeConfig, text: FakeText, avatars: string[], peers: number, startMs: number) {
    this.cfg = cfg
    this.text = text
    this.avatars = avatars
    this.n = peers
    this.startMs = startMs
  }

  get peers(): number { return this.n }

  private round(v: number): number { const f = 10 ** this.cfg.positionDecimals; return Math.round(v * f) / f }

  private state(i: number, now: number): PlayerState {
    const p = peerAt(this.cfg, i, (now - this.startMs) / 1000, this.center)
    const stats = this.stats(i)
    return {
      id: peerId(i), name: this.text.peerName(i + 1), avatar: this.avatars[i % this.avatars.length] ?? '', map: this.map,
      x: this.round(p.x), y: this.round(p.y), facing: p.facing, moving: p.moving, running: false, lead: null,
      badges: stats.badges, dexCaught: stats.dexCaught, busy: this.cfg.busyEvery > 0 && i % this.cfg.busyEvery === this.cfg.busyEvery - 1,
    }
  }

  private stats(i: number) {
    return {
      dexCaught: Math.floor(hash01(i, 1) * (this.cfg.dexMax + 1)),
      badges: Math.floor(hash01(i, 2) * (this.cfg.badgesMax + 1)),
      pvpWins: Math.floor(hash01(i, 4) * (this.cfg.pvpMax + 1)),
      pvpLosses: Math.floor(hash01(i, 5) * (this.cfg.pvpMax + 1)),
    }
  }

  private snapshot(now: number): ServerMsg {
    return { t: 'snapshot', map: this.map, players: Array.from({ length: this.n }, (_, i) => this.state(i, now)) }
  }

  private online(now: number): ServerMsg {
    this.lastOnlineAt = now
    const peers = Array.from({ length: this.n }, (_, i) => { const s = this.state(i, now); return { id: s.id, name: s.name, map: s.map, avatar: s.avatar, busy: s.busy } })
    return { t: 'online', count: this.n + 1, players: [{ id: this.cfg.selfId, name: this.selfName, map: this.map, avatar: '', busy: false }, ...peers] }
  }

  private leaderboard(): LeaderboardEntry[] {
    return Array.from({ length: this.n }, (_, i) => ({ id: peerId(i), name: this.text.peerName(i + 1), avatar: this.avatars[i % this.avatars.length] ?? '', ...this.stats(i) }))
      .sort((a, b) => b.dexCaught - a.dexCaught || a.id.localeCompare(b.id))
  }

  private profile(i: number): PublicProfile {
    const s = this.stats(i)
    return { id: peerId(i), name: this.text.peerName(i + 1), avatar: this.avatars[i % this.avatars.length] ?? '', badges: [], dexCaught: s.dexCaught, party: [], pvpWins: s.pvpWins, pvpLosses: s.pvpLosses, playTimeSec: Math.floor(hash01(i, 6) * 100000) }
  }

  /** The replies to one client message. */
  handle(msg: ClientMsg, now: number): ServerMsg[] {
    switch (msg.t) {
      case 'hello':
        this.hello = true
        this.map = msg.map
        this.selfName = msg.name
        this.center = { x: msg.x, y: msg.y }
        return [{ t: 'welcome', selfId: this.cfg.selfId, serverTime: now, motd: this.text.motd, online: this.n + 1 }, this.online(now), this.snapshot(now)]
      case 'move':
        if (msg.map !== this.map) { this.map = msg.map; this.center = { x: msg.x, y: msg.y } }
        return []
      case 'ping': return [{ t: 'pong', at: msg.at, serverTime: now }]
      case 'chat':
        return msg.channel === 'whisper' ? [] : [{ t: 'chat', from: this.cfg.selfId, name: this.selfName, channel: msg.channel, text: msg.text, at: now }]
      case 'leaderboard': return [{ t: 'leaderboard', entries: this.leaderboard() }]
      case 'inspect': {
        const i = Number(msg.target.replace('dev-peer-', ''))
        return Number.isInteger(i) && i >= 0 && i < this.n && msg.target === peerId(i)
          ? [{ t: 'profile', profile: this.profile(i) }]
          : [{ t: 'system', text: this.text.unsupported, level: 'info' }]
      }
      case 'trade.request':
      case 'pvp.challenge':
        return [{ t: 'system', text: this.text.unsupported, level: 'info' }]
      default: return []
    }
  }

  /** Periodic output: the snapshot every tick and the online summary every `onlineSeconds`. */
  tick(now: number): ServerMsg[] {
    if (!this.hello) return []
    const out: ServerMsg[] = [this.snapshot(now)]
    if (now - this.lastOnlineAt >= this.cfg.onlineSeconds * 1000) out.push(this.online(now))
    return out
  }

  /** Changes the crowd size; the newcomers join and the surplus leaves, like on a real server. */
  setPeers(n: number, now: number): ServerMsg[] {
    const old = this.n
    this.n = n
    if (!this.hello) return []
    const out: ServerMsg[] = []
    for (let i = old; i < n; i++) out.push({ t: 'join', player: this.state(i, now) })
    for (let i = n; i < old; i++) out.push({ t: 'leave', id: peerId(i) })
    if (n !== old) out.push(this.online(now))
    return out
  }
}
