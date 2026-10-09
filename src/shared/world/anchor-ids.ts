// Ids of teleport anchors. An anchor is a prop; its id encodes kind and footprint top-left tile, so a save can
// store plain strings and every client / the server resolves the same position without a registry.
import type { AnchorKindId } from './schema.ts'

export const ANCHOR_KINDS: readonly AnchorKindId[] = ['grand', 'minor']

export function anchorId(kind: AnchorKindId, x: number, y: number): string { return `anchor:${kind}:${x}:${y}` }

export function parseAnchorId(id: string): { kind: AnchorKindId; x: number; y: number } | null {
  const p = id.split(':')
  if (p.length !== 4 || p[0] !== 'anchor') return null
  const kind = ANCHOR_KINDS.find((k) => k === p[1])
  const x = Number(p[2]), y = Number(p[3])
  if (!kind || !Number.isInteger(x) || !Number.isInteger(y)) return null
  return { kind, x, y }
}
