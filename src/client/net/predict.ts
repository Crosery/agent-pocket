// Local player movement prediction and smooth authoritative reconciliation (#23, ADR 0001 §4.2).
// Local inputs move immediately; each outbound move carries a monotonic `seq`. When the server rejects or clamps a
// move (`move.correct`), logical coordinates reconcile immediately (preventing collision/teleport exploits) while a
// bounded visual offset decays over `correctionMs` so the camera and character never snap on high-latency links.
import type { Dir } from '../../shared/types.ts'

export interface PredictedMove {
  seq: number
  map: string
  x: number
  y: number
  dx: number
  dy: number
  facing: Dir
  moving: boolean
  running: boolean
  at: number
}

export interface CorrectionState {
  seq: number
  map: string
  /** Reconciled authoritative logical coordinates. */
  x: number
  y: number
  facing: Dir
  /** Initial visual offset (rendered = logical + decaying offset) so frame 0 has zero visual discontinuity. */
  ox: number
  oy: number
  /** True when the error exceeded snapDistanceTiles or crossed maps (snaps immediately). */
  snapped: boolean
  startAt: number
  durationMs: number
  reason?: string
}

export type StepReplayFn = (map: string, x: number, y: number, dx: number, dy: number) => { x: number; y: number }

export interface PredictorOptions {
  correctionMs: number
  snapDistanceTiles: number
  maxPending: number
  maxReplayStepTiles: number
}

export interface Predictor {
  readonly nextSeq: number
  readonly lastAckSeq: number
  readonly pending: readonly PredictedMove[]
  readonly corrections: number
  readonly lastCorrection: CorrectionState | null
  readonly position: { map: string; x: number; y: number; facing: Dir }
  record(move: { map: string; x: number; y: number; facing: Dir; moving: boolean; running: boolean }, now: number): number
  ack(seq: number): void
  reconcile(
    msg: { seq: number; map: string; x: number; y: number; facing: Dir; reason?: string },
    now: number,
    replayStep?: StepReplayFn | null,
  ): CorrectionState
  /** Current visual offset at `now`, decaying smoothly to (0, 0) over `correctionMs`. */
  visualOffset(now: number): { ox: number; oy: number; active: boolean }
  /** Rendered position combining reconciled logical coordinates with the active smoothing offset. */
  renderedPosition(now: number, logical?: { x: number; y: number }): { x: number; y: number; ox: number; oy: number; correcting: boolean }
  reset(initial?: { map: string; x: number; y: number; facing: Dir }): void
}

export function createPredictor(opts: PredictorOptions): Predictor {
  let seq = 0
  let lastAck = 0
  let corrections = 0
  let lastCorrection: CorrectionState | null = null
  const pending: PredictedMove[] = []
  let current = { map: '', x: 0, y: 0, facing: 'down' as Dir }

  function visualOffset(now: number): { ox: number; oy: number; active: boolean } {
    if (!lastCorrection || lastCorrection.snapped) return { ox: 0, oy: 0, active: false }
    const elapsed = Math.max(0, now - lastCorrection.startAt)
    if (elapsed >= lastCorrection.durationMs || lastCorrection.durationMs <= 0) {
      return { ox: 0, oy: 0, active: false }
    }
    const k = elapsed / lastCorrection.durationMs
    const remain = (1 - k) * (1 - k)
    const ox = lastCorrection.ox * remain
    const oy = lastCorrection.oy * remain
    if (Math.hypot(ox, oy) < 1e-3) return { ox: 0, oy: 0, active: false }
    return { ox, oy, active: true }
  }

  return {
    get nextSeq() { return seq + 1 },
    get lastAckSeq() { return lastAck },
    get pending() { return pending },
    get corrections() { return corrections },
    get lastCorrection() { return lastCorrection },
    get position() { return { ...current } },

    record(move, now) {
      const next = ++seq
      const sameMap = current.map === move.map && current.map !== ''
      const dx = sameMap ? move.x - current.x : 0
      const dy = sameMap ? move.y - current.y : 0
      current = { map: move.map, x: move.x, y: move.y, facing: move.facing }
      pending.push({
        seq: next,
        map: move.map,
        x: move.x,
        y: move.y,
        dx,
        dy,
        facing: move.facing,
        moving: move.moving,
        running: move.running,
        at: now,
      })
      if (pending.length > opts.maxPending) pending.splice(0, pending.length - opts.maxPending)
      return next
    },

    ack(ackSeq) {
      if (!Number.isFinite(ackSeq) || ackSeq <= lastAck) return
      lastAck = ackSeq
      let drop = 0
      while (drop < pending.length && pending[drop].seq <= lastAck) drop++
      if (drop > 0) pending.splice(0, drop)
    },

    reconcile(msg, now, replayStep) {
      corrections++
      const prevOff = visualOffset(now)
      const prevVisualX = current.x + prevOff.ox
      const prevVisualY = current.y + prevOff.oy
      const rejected = pending.find((m) => m.seq === msg.seq)
      if (msg.seq > lastAck) lastAck = msg.seq
      let drop = 0
      while (drop < pending.length && pending[drop].seq <= msg.seq) drop++
      if (drop > 0) pending.splice(0, drop)

      if (current.map !== '' && msg.map !== current.map) {
        pending.length = 0
        current = { map: msg.map, x: msg.x, y: msg.y, facing: msg.facing }
        lastCorrection = {
          seq: msg.seq, map: msg.map, x: msg.x, y: msg.y, facing: msg.facing,
          ox: 0, oy: 0, snapped: true, startAt: now, durationMs: opts.correctionMs, reason: msg.reason,
        }
        return lastCorrection
      }

      let rx = msg.x
      let ry = msg.y
      let rFacing = msg.facing
      const rejDx = rejected ? rejected.x - msg.x : 0
      const rejDy = rejected ? rejected.y - msg.y : 0

      for (let i = 0; i < pending.length; i++) {
        const m = pending[i]
        if (m.map !== msg.map || Math.hypot(m.dx, m.dy) > opts.maxReplayStepTiles) {
          pending.splice(i)
          break
        }
        if (replayStep) {
          const stepped = replayStep(msg.map, rx, ry, m.dx, m.dy)
          rx = stepped.x
          ry = stepped.y
        } else {
          // Without a collision callback, only replay steps that do not push further along the rejected vector.
          const dot = m.dx * rejDx + m.dy * rejDy
          if (dot <= 0) {
            rx += m.dx
            ry += m.dy
          }
        }
        rFacing = m.facing
        m.x = rx
        m.y = ry
      }

      const errX = prevVisualX - rx
      const errY = prevVisualY - ry
      const dist = Math.hypot(errX, errY)
      const snapped = current.map === '' || dist > opts.snapDistanceTiles
      current = { map: msg.map, x: rx, y: ry, facing: rFacing }
      lastCorrection = {
        seq: msg.seq,
        map: msg.map,
        x: rx,
        y: ry,
        facing: rFacing,
        ox: snapped ? 0 : errX,
        oy: snapped ? 0 : errY,
        snapped,
        startAt: now,
        durationMs: opts.correctionMs,
        reason: msg.reason,
      }
      return lastCorrection
    },

    visualOffset,

    renderedPosition(now, logical) {
      const base = logical ?? current
      const off = visualOffset(now)
      return {
        x: base.x + off.ox,
        y: base.y + off.oy,
        ox: off.ox,
        oy: off.oy,
        correcting: off.active,
      }
    },

    reset(initial) {
      seq = 0
      lastAck = 0
      pending.length = 0
      lastCorrection = null
      current = initial ? { ...initial } : { map: '', x: 0, y: 0, facing: 'down' }
    },
  }
}
