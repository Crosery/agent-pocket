// Dynamic minimap markers: unbeaten trainers, quest target, other players, roaming (rare) creatures and
// visible ground items. Building icons (PropDef.minimapIcon) are drawn by the minimap itself.
import type { GameMap, GroundItemDef, SaveData, World } from '../../shared/types.ts'
import type { MinimapMarker } from '../contracts.ts'
import { STORY_CONTENT } from '../../shared/world/story.ts'
import { GAME } from './config.ts'
import type { NpcRuntime } from './npcs.ts'
import { flagSet } from './save-ops.ts'

export interface MarkerSources {
  map: GameMap
  world: World
  save: SaveData
  npcs: readonly NpcRuntime[]
  remotes: Iterable<{ x: number; y: number; name: string }>
  roamers: readonly { x: number; y: number; rare: boolean }[]
  /** Live ground items (streamed on infinite maps); defaults to map.items. */
  items?: readonly GroundItemDef[]
}

export function collectMarkers(s: MarkerSources): MinimapMarker[] {
  const M = GAME.markers
  const out: MinimapMarker[] = []
  const won = STORY_CONTENT.meta.flags.trainerWon
  if (M.trainers) {
    for (const n of s.npcs) {
      if (n.visible && n.def.trainer && (n.def.sightRange ?? 0) > 0 && !flagSet(s.save, won + n.def.trainer)) {
        out.push({ x: n.x, y: n.y, kind: 'trainer', label: n.def.nameZh })
      }
    }
  }
  if (M.quest && s.save.trackedQuest) {
    const q = s.world.quests.find((x) => x.id === s.save.trackedQuest)
    const st = q && s.save.quests[q.id]
    const target = q && st && !st.done ? q.stages[Math.min(st.stage, q.stages.length - 1)]?.target : undefined
    if (target && target.map === s.map.id) out.push({ x: target.x + 0.5, y: target.y + 0.5, kind: 'quest', label: q!.nameZh })
  }
  if (M.others) for (const r of s.remotes) out.push({ x: r.x, y: r.y, kind: 'other', label: r.name })
  for (const r of s.roamers) {
    if (r.rare && M.rares) out.push({ x: r.x, y: r.y, kind: 'rare' })
    else if (!r.rare && M.wild) out.push({ x: r.x, y: r.y, kind: 'wild' })
  }
  if (M.items) {
    const prefix = STORY_CONTENT.meta.flags.groundItem
    for (const it of s.items ?? s.map.items) if (!it.hidden && !flagSet(s.save, prefix + it.id)) out.push({ x: it.x + 0.5, y: it.y + 0.5, kind: 'item' })
  }
  return out
}
