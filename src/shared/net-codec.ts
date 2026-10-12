// Compact wire codec for high-frequency movement and interest-set delta snapshots (#23).
// Keeps frames JSON-compatible while shrinking per-move and per-tick player updates by ~5-15x.
import type { Dir } from './types.ts'
import type { PlayerState } from './protocol.ts'

export const MOVE_DIRS: readonly Dir[] = ['down', 'left', 'right', 'up']

/**
 * Bit layout of motion flags (0..31):
 * - bits 0..1: facing ('down'=0, 'left'=1, 'right'=2, 'up'=3)
 * - bit 2 (4): moving
 * - bit 3 (8): running
 * - bit 4 (16): busy
 */
export function encodeMoveFlags(facing: Dir, moving: boolean, running: boolean, busy = false): number {
  const dirIdx = Math.max(0, MOVE_DIRS.indexOf(facing))
  return (dirIdx & 3) | (moving ? 4 : 0) | (running ? 8 : 0) | (busy ? 16 : 0)
}

export function decodeMoveFlags(flags: number): { facing: Dir; moving: boolean; running: boolean; busy: boolean } {
  const n = Number.isInteger(flags) ? flags : 0
  return {
    facing: MOVE_DIRS[n & 3] ?? 'down',
    moving: (n & 4) !== 0,
    running: (n & 8) !== 0,
    busy: (n & 16) !== 0,
  }
}

/** Compact client -> server move payload: [centiX, centiY, flags]. */
export type CompactMoveTuple = [cx: number, cy: number, flags: number]

/** Compact server -> client remote player delta: [slot, centiX, centiY, flags]. */
export type CompactPlayerTuple = [slot: number, cx: number, cy: number, flags: number]

export interface DecodedMove {
  seq?: number
  map: string
  x: number
  y: number
  facing: Dir
  moving: boolean
  running: boolean
}

export function encodeMoveFrame(
  m: { seq?: number; map: string; x: number; y: number; facing: Dir; moving: boolean; running: boolean },
  includeMap: boolean,
): { t: 'move'; seq?: number; map?: string; d: CompactMoveTuple } {
  const d: CompactMoveTuple = [Math.round(m.x * 100), Math.round(m.y * 100), encodeMoveFlags(m.facing, m.moving, m.running)]
  return {
    t: 'move',
    ...(m.seq !== undefined ? { seq: m.seq } : {}),
    ...(includeMap ? { map: m.map } : {}),
    d,
  }
}

/** Decodes either a compact `{ t: 'move', d: [cx, cy, flags], map?, seq? }` or a full `{ t: 'move', map, x, y, facing, moving, running, seq? }`. */
export function decodeMoveFrame(raw: Record<string, unknown>, fallbackMap: string): DecodedMove | null {
  const seq = typeof raw.seq === 'number' && Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : undefined
  const map = typeof raw.map === 'string' && raw.map.length > 0 ? raw.map : fallbackMap
  if (!map) return null
  if (Array.isArray(raw.d) && raw.d.length >= 3) {
    const [cx, cy, flags] = raw.d
    if (typeof cx !== 'number' || !Number.isFinite(cx) || typeof cy !== 'number' || !Number.isFinite(cy) || typeof flags !== 'number' || !Number.isFinite(flags)) {
      return null
    }
    const decoded = decodeMoveFlags(flags)
    return {
      ...(seq !== undefined ? { seq } : {}),
      map,
      x: cx / 100,
      y: cy / 100,
      facing: decoded.facing,
      moving: decoded.moving,
      running: decoded.running,
    }
  }
  if (typeof raw.x === 'number' && Number.isFinite(raw.x) && typeof raw.y === 'number' && Number.isFinite(raw.y)) {
    const facing = typeof raw.facing === 'string' && (MOVE_DIRS as readonly string[]).includes(raw.facing) ? (raw.facing as Dir) : null
    if (!facing) return null
    return {
      ...(seq !== undefined ? { seq } : {}),
      map,
      x: raw.x,
      y: raw.y,
      facing,
      moving: raw.moving === true,
      running: raw.running === true,
    }
  }
  return null
}

export function encodePlayerDelta(
  slot: number,
  p: Pick<PlayerState, 'x' | 'y' | 'facing' | 'moving' | 'running' | 'busy'>,
): CompactPlayerTuple {
  const cx = Math.round(p.x * 100), cy = Math.round(p.y * 100)
  return [slot, cx, cy, encodeMoveFlags(p.facing, p.moving, p.running, p.busy)]
}

export function decodePlayerDelta(
  tuple: unknown,
): { slot: number; x: number; y: number; facing: Dir; moving: boolean; running: boolean; busy: boolean } | null {
  if (!Array.isArray(tuple) || tuple.length < 4) return null
  const [slot, cx, cy, flags] = tuple
  if (
    typeof slot !== 'number' || !Number.isInteger(slot) || slot <= 0 ||
    typeof cx !== 'number' || !Number.isFinite(cx) ||
    typeof cy !== 'number' || !Number.isFinite(cy) ||
    typeof flags !== 'number' || !Number.isFinite(flags)
  ) {
    return null
  }
  const decoded = decodeMoveFlags(flags)
  return {
    slot,
    x: cx / 100,
    y: cy / 100,
    ...decoded,
  }
}

export function applyPlayerDelta(base: PlayerState, tuple: unknown): PlayerState | null {
  const d = decodePlayerDelta(tuple)
  if (!d) return null
  return {
    ...base,
    x: d.x,
    y: d.y,
    facing: d.facing,
    moving: d.moving,
    running: d.running,
    busy: d.busy,
  }
}

/** Fingerprint of non-motion fields on PlayerState; when unchanged, a 4-int CompactPlayerTuple suffices. */
export function staticStateKey(p: PlayerState): string {
  const lead = p.lead ? `${p.lead.speciesId}:${p.lead.shiny ? 1 : 0}:${p.lead.level}` : ''
  return `${p.name}\0${p.avatar}\0${p.map}\0${lead}\0${p.badges}\0${p.dexCaught}\0${p.emote ?? ''}`
}
