// Trainers created per chunk (wandering trainers) are remembered on the chunk object, so the id resolver can find
// them after regenerating the chunk from (seed, cx, cy). Site-bound trainers / quests are rebuilt from their ids.
import type { MapChunk, TrainerDef } from '../../../types.ts'

const CHUNK_TRAINERS = new WeakMap<MapChunk, Map<string, TrainerDef>>()

export function rememberTrainer(chunk: MapChunk, def: TrainerDef): void {
  let m = CHUNK_TRAINERS.get(chunk)
  if (!m) { m = new Map(); CHUNK_TRAINERS.set(chunk, m) }
  m.set(def.id, def)
}

export function chunkTrainer(chunk: MapChunk, id: string): TrainerDef | null {
  return CHUNK_TRAINERS.get(chunk)?.get(id) ?? null
}

export function chunkTrainers(chunk: MapChunk): TrainerDef[] {
  return [...(CHUNK_TRAINERS.get(chunk)?.values() ?? [])]
}

/** Wandering trainer ids: `ft:<cx>:<cy>:<n>`. */
export const wandererId = (cx: number, cy: number, n: number): string => `ft:${cx}:${cy}:${n}`
export function parseWandererId(id: string): { cx: number; cy: number } | null {
  const m = /^ft:(-?\d+):(-?\d+):\d+$/.exec(id)
  return m ? { cx: Number(m[1]), cy: Number(m[2]) } : null
}
