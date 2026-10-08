export interface CharacterAnimation {
  readonly frame: number
  readonly phase: number
  update(dt: number, moving: boolean, fps: number, travelled?: number, stride?: number, teleportTiles?: number, maxFps?: number): void
  reset(): void
}

export interface CharacterIdle {
  frames: number
  fps: number
  settleMs?: number
  phase?: number
}

/** The same grounded cycle drives UI previews and world actors; displacement is authoritative in the world. */
export function createCharacterAnimation(frames: number, firstWalkFrame = 0, idle?: CharacterIdle): CharacterAnimation {
  const count = Math.max(1, Math.floor(frames))
  const idleCount = Math.max(1, Math.floor(idle?.frames ?? 1))
  const idleFps = Math.max(0, idle?.fps ?? 0)
  const settle = Math.max(0, idle?.settleMs ?? 0) / 1000
  const offset = Math.max(0, idle?.phase ?? 0)
  let idleOffset = offset
  let phase = 0
  let idleTime = 0
  let active = false
  return {
    get frame() {
      return active ? firstWalkFrame + Math.floor(phase) % count
        : idleTime < settle ? 0 : Math.floor((idleTime - settle) * idleFps + idleOffset) % idleCount
    },
    get phase() { return phase },
    update(dt, moving, fps, travelled, stride = 1, teleportTiles = Infinity, maxFps = Infinity) {
      const seconds = Math.max(0, dt)
      const stopped = !moving || (idleCount > 1 && travelled !== undefined && (travelled <= 1e-6 || travelled >= teleportTiles))
      if (stopped) {
        if (active) { idleTime = 0; idleOffset = 0 }
        phase = 0
        active = false
        idleTime += seconds
        return
      }
      const advance = travelled === undefined
        ? seconds * Math.max(0, fps)
        : travelled >= teleportTiles ? 0 : Math.max(0, travelled) * (count / 2) / Math.max(stride, 1e-6)
      const cap = Number.isFinite(maxFps) ? seconds * Math.max(0, maxFps) : Infinity
      const step = Math.min(advance, cap)
      active ||= step > 0
      phase = (phase + step) % count
    },
    reset() { phase = 0; idleTime = 0; idleOffset = 0; active = false },
  }
}
import type { GameConfig } from '../../shared/types.ts'

export function characterFrames(width: number, sprites: GameConfig['sprites']): { cols: number; walkFrames: number; walkStart: number; idleFrames: number } {
  for (const walkFrames of [sprites.sheetWalkFrames, sprites.sheetFrames]) {
    const cols = sprites.sheetIdleFrames + walkFrames
    if (width === sprites.sheetCell * cols) return { cols, walkFrames, walkStart: sprites.sheetIdleFrames, idleFrames: sprites.sheetIdleFrames }
  }
  const atlasCols = sprites.sheetWalkFrames + 1
  return width === sprites.sheetCell * atlasCols
    ? { cols: atlasCols, walkFrames: sprites.sheetWalkFrames, walkStart: 1, idleFrames: 1 }
    : { cols: sprites.sheetFrames, walkFrames: sprites.sheetFrames, walkStart: 0, idleFrames: 1 }
}
