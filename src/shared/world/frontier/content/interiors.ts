// Frontier interiors: house residents (replaces the built-in 'fx-residents': biome lines, gossip, gifts, tips) and
// dungeon floors (lost explorers with floor hints, the boss trainer on the last floor).
import type { NpcDef, ScriptStep } from '../../../types.ts'
import type { InteriorDecorContext } from '../decorate.ts'
import { FRONTIER_PACK } from './data.ts'
import { bossBuild, challengeScript } from './landmarks.ts'
import { residentScript, type Locale } from './people.ts'
import { trainerNpc } from './teams.ts'
import { biomeName, pickLines, sayAll, text, type Params } from './util.ts'

const localeOf = (ctx: InteriorDecorContext): Locale => ({ biome: ctx.region.biome, dist: ctx.distance, nearRefs: [] })

export function decorateResidents(ctx: InteriorDecorContext): void {
  if (ctx.kind !== 'house') return
  const a = ctx.anchors['resident-1']
  if (!a) return
  const id = `${ctx.map.id}:resident`
  const params: Params = { place: ctx.layout.nameZh, biome: biomeName(ctx.region.biome), distance: Math.round(ctx.distance) }
  const r = residentScript(id, localeOf(ctx), ctx.rng('residents'), params)
  ctx.map.npcs.push({ id, x: a.x, y: a.y, facing: 'down', sprite: r.sprite, nameZh: r.name, role: 'villager', script: r.script })
}

export function decorateDungeon(ctx: InteriorDecorContext): void {
  if (ctx.kind !== 'dungeon') return
  const E = FRONTIER_PACK.interiors.explorer
  const params: Params = { place: ctx.layout.nameZh, floor: ctx.floor, floors: ctx.floors, level: ctx.region.levelRange?.[0] ?? 1, biome: biomeName(ctx.region.biome) }
  const taken = new Set(ctx.map.npcs.map((n) => `${n.x},${n.y}`))
  const boss = ctx.anchors.boss
  if (ctx.floor === ctx.floors && boss && !taken.has(`${boss.x},${boss.y}`)) {
    const b = bossBuild(ctx.seed, ctx.site, ctx.layout)
    if (b) {
      ctx.map.npcs.push(trainerNpc(b.def, boss.x, boss.y, 'down', challengeScript(ctx.seed, FRONTIER_PACK.trainers.bosses, b, ctx.site.dist), 0))
      taken.add(`${boss.x},${boss.y}`)
    }
  }
  const rng = ctx.rng('explorer')
  if (!rng.chance(E.chance)) return
  const spots = Object.entries(ctx.anchors).filter(([k]) => k.startsWith('spot-')).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, p]) => p).filter((p) => !taken.has(`${p.x},${p.y}`))
  if (!spots.length) return
  const at = rng.pick(spots)
  const name = rng.pick(E.names)
  const p = { ...params, name }
  const script: ScriptStep[] = [
    ...sayAll(pickLines(E.lines, rng), p),
    { op: 'say', text: text(ctx.floor + 1 >= ctx.floors ? E.bossHint : E.floorHint, p) },
  ]
  const npc: NpcDef = { id: `${ctx.map.id}:explorer`, x: at.x, y: at.y, facing: 'down', sprite: rng.pick(E.sprites), nameZh: name, role: 'villager', script }
  ctx.map.npcs.push(npc)
}
