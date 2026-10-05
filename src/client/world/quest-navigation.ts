import type { NpcDef, QuestDef, SaveData, Warp, World } from '../../shared/types.ts'
import { propDoor } from '../../shared/world/collision.ts'
import { canStep, getMap, objectsInRect, warpAt } from '../../shared/world/worldapi.ts'
import { gridField, type MotionGrid } from './motion.ts'

export interface RoutePoint { x: number; y: number }
export interface RoutePlace extends RoutePoint { map: string }
export interface NavigationRules {
  nodesPerFrame: number
  frameBudgetMs: number
  maxNodes: number
  marginTiles: number
  recheckSec: number
  retrySec: number
  trailTiles: number
}
export interface QuestNavigation {
  questId: string
  title: string
  text: string
  status: 'searching' | 'ready' | 'arrived' | 'unreachable'
  target: RoutePlace
  waypoint: RoutePlace
  nextMap?: string
  /** Tile indices, including the player's tile. */
  path: readonly RoutePoint[]
  steps: number
}

export function trackedQuest(world: World, save: Pick<SaveData, 'quests' | 'trackedQuest'>): { def: QuestDef; stage: number } | null {
  const id = save.trackedQuest
  const progress = id ? save.quests[id] : undefined
  const def = id && progress && !progress.done ? world.quests.find(q => q.id === id) : undefined
  return def ? { def, stage: Math.min(progress!.stage, def.stages.length - 1) } : null
}

const keyOf = (p: RoutePoint) => `${p.x},${p.y}`
const STEPS = [[0, -1], [0, 1], [-1, 0], [1, 0]] as const
const visible = (npc: NpcDef, save: Pick<SaveData, 'flags'>) =>
  !(npc.hiddenIfFlag && save.flags[npc.hiddenIfFlag]) && !(npc.hiddenUnlessFlag && !save.flags[npc.hiddenUnlessFlag])

/** Building anchors name the doorstep; continue inside rather than guide the player back out of the room. */
function destination(world: World, quest: QuestDef, target: RoutePlace, save: Pick<SaveData, 'flags'>): RoutePlace {
  const map = getMap(world, target.map)
  if (!map) return target
  const props = map.infinite ? objectsInRect(map, target.x - 12, target.y - 12, target.x + 2, target.y + 2).props : map.props
  const door = props.map(propDoor).find(d => d?.front.x === target.x && d.front.y === target.y)
  const entry = door && warpAt(map, door.x, door.y)
  const room = entry && getMap(world, entry.toMap)
  if (!room || !entry) return target
  const npcs = room.npcs.filter(n => visible(n, save))
  const npc = npcs.find(n => JSON.stringify(n.script).includes(`"quest":"${quest.id}"`))
    ?? npcs.find(n => n.role === 'professor' || n.role === 'gymLeader')
  return npc ? { map: room.id, x: npc.x, y: npc.y } : { map: room.id, x: entry.toX, y: entry.toY }
}

/** All first-hop doors on a shortest map chain. A* chooses the reachable, shortest walking approach. */
export function navigationWaypoints(world: World, from: RoutePlace, target: RoutePlace): { point: RoutePlace; nextMap?: string }[] {
  if (from.map === target.map) return [{ point: target }]
  const here = getMap(world, from.map), goal = getMap(world, target.map)
  if (!here || !goal) return []
  const links = new Map<string, Warp[]>()
  for (const map of Object.values(world.maps)) links.set(map.id, [...map.warps])
  // A frontier room's entrance lives in a generated chunk, not in the core overworld's legacy warp list.
  for (const map of Object.values(world.maps)) {
    for (const exit of map.warps) {
      const parent = world.maps[exit.toMap]
      if (!parent?.infinite) continue
      if (links.get(parent.id)?.some(w => w.toMap === map.id)) continue
      const doors = objectsInRect(parent, exit.toX - 2, exit.toY - 2, exit.toX + 3, exit.toY + 3).warps
        .filter(w => w.toMap === map.id)
      const list = links.get(parent.id)!
      for (const door of doors) if (!list.some(w => w.x === door.x && w.y === door.y)) list.push(door)
    }
  }
  const distance = new Map<string, number>([[target.map, 0]])
  const queue = [target.map]
  const reverse = new Map<string, Set<string>>()
  for (const [id, warps] of links) for (const warp of warps) {
    let parents = reverse.get(warp.toMap)
    if (!parents) reverse.set(warp.toMap, parents = new Set())
    parents.add(id)
  }
  for (let i = 0; i < queue.length; i++) {
    for (const parent of reverse.get(queue[i]) ?? []) {
      if (distance.has(parent)) continue
      distance.set(parent, distance.get(queue[i])! + 1)
      queue.push(parent)
    }
  }
  const hops = distance.get(from.map)
  if (hops === undefined) return []
  return (links.get(here.id) ?? []).filter(w => distance.get(w.toMap) === hops - 1)
    .map(w => ({ point: { map: here.id, x: w.x, y: w.y }, nextMap: w.toMap }))
}

interface HeapEntry { index: number; score: number; cost: number }
const precedes = (a: HeapEntry, b: HeapEntry) => a.score < b.score || a.score === b.score && a.cost >= b.cost
class RouteHeap {
  private entries: HeapEntry[] = []
  get size() { return this.entries.length }
  push(entry: HeapEntry): void {
    let i = this.entries.length
    this.entries.push(entry)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (precedes(this.entries[p], entry)) break
      this.entries[i] = this.entries[p]
      i = p
    }
    this.entries[i] = entry
  }
  pop(): HeapEntry {
    const top = this.entries[0], end = this.entries.pop()!
    if (!this.entries.length) return top
    let i = 0
    while (i * 2 + 1 < this.entries.length) {
      let child = i * 2 + 1
      if (child + 1 < this.entries.length && precedes(this.entries[child + 1], this.entries[child])) child++
      if (precedes(end, this.entries[child])) break
      this.entries[i] = this.entries[child]
      i = child
    }
    this.entries[i] = end
    return top
  }
}

export interface RouteSearch {
  readonly status: 'searching' | 'ready' | 'unreachable'
  readonly path: readonly RoutePoint[]
  readonly visited: number
  advance(nodes: number, timeBudgetMs?: number): void
}

/** Sparse, frame-budgeted A*. It owns its heap: generating a frontier chunk may itself run the world-builder's A*. */
export function createRouteSearch(grid: MotionGrid, from: RoutePoint, goals: readonly RoutePoint[], surf: boolean, rules: Pick<NavigationRules, 'maxNodes' | 'marginTiles'>): RouteSearch {
  const start = { x: Math.floor(from.x), y: Math.floor(from.y) }
  const margin = rules.marginTiles
  const inCore = (p: RoutePoint) => p.x >= 0 && p.y >= 0 && p.x < grid.map.width && p.y < grid.map.height
  // Story routes can detour through several regions, far outside the start/goal rectangle.
  // Keep core searches inside the authored continent; frontier searches retain a bounded local window.
  const core = !grid.map.infinite || inCore(start) && goals.every(inCore)
  const x0 = core ? 0 : Math.min(start.x, ...goals.map(p => p.x)) - margin
  const y0 = core ? 0 : Math.min(start.y, ...goals.map(p => p.y)) - margin
  const x1 = core ? grid.map.width - 1 : Math.max(start.x, ...goals.map(p => p.x)) + margin
  const y1 = core ? grid.map.height - 1 : Math.max(start.y, ...goals.map(p => p.y)) + margin
  const width = x1 - x0 + 1
  const indexOf = (x: number, y: number) => (y - y0) * width + x - x0
  const pointOf = (i: number) => ({ x: x0 + i % width, y: y0 + Math.floor(i / width) })
  const goalSet = new Set(goals.map(p => indexOf(p.x, p.y)))
  const heuristic = (x: number, y: number) => {
    let best = Infinity
    for (const goal of goals) best = Math.min(best, Math.abs(goal.x - x) + Math.abs(goal.y - y))
    return best
  }
  const heap = new RouteHeap()
  // Long bounded searches avoid millions of Map lookups. Local repairs and huge
  // frontier windows stay sparse; zero encodes an unseen cost, otherwise g + 1.
  const slots = width * (y1 - y0 + 1)
  const dense = slots <= rules.maxNodes && (slots <= (2 * margin + 1) ** 2 || heuristic(start.x, start.y) > margin)
  const costs = dense ? new Uint32Array(slots) : new Map<number, number>()
  const parents = dense ? new Int32Array(slots) : new Map<number, number>()
  const closed = dense ? new Uint8Array(slots) : new Set<number>()
  const costAt = (i: number) => costs instanceof Map ? costs.get(i) ?? Infinity : costs[i] ? costs[i] - 1 : Infinity
  const setCost = (i: number, cost: number) => { if (costs instanceof Map) costs.set(i, cost); else costs[i] = cost + 1 }
  const isClosed = (i: number) => closed instanceof Set ? closed.has(i) : closed[i] === 1
  const setClosed = (i: number) => { if (closed instanceof Set) closed.add(i); else closed[i] = 1 }
  const setParent = (i: number, parent: number) => { if (parents instanceof Map) parents.set(i, parent); else parents[i] = parent }
  const field = gridField(grid)
  const doors = core ? new Set(grid.map.warps.map(w => indexOf(w.x, w.y))) : null
  const startIndex = indexOf(start.x, start.y)
  const parentOf = (i: number) => i === startIndex ? undefined : parents instanceof Map ? parents.get(i) : parents[i]
  let visited = 0
  let status: RouteSearch['status'] = goals.length ? 'searching' : 'unreachable'
  let path: RoutePoint[] = []
  setCost(startIndex, 0)
  heap.push({ index: startIndex, score: heuristic(start.x, start.y), cost: 0 })
  return {
    get status() { return status },
    get path() { return path },
    get visited() { return visited },
    advance(nodes, timeBudgetMs = Infinity) {
      if (status !== 'searching') return
      const deadline = performance.now() + timeBudgetMs
      for (let n = 0; n < nodes && heap.size; n++) {
        if (n % 32 === 0 && performance.now() >= deadline) return
        const current = heap.pop()
        if (isClosed(current.index) || costAt(current.index) !== current.cost) continue
        const at = pointOf(current.index)
        if (goalSet.has(current.index)) {
          for (let i: number | undefined = current.index; i !== undefined; i = parentOf(i)) path.push(pointOf(i))
          path.reverse()
          status = 'ready'
          return
        }
        setClosed(current.index)
        if (++visited >= rules.maxNodes) { status = 'unreachable'; return }
        for (const [dx, dy] of STEPS) {
          const x = at.x + dx, y = at.y + dy
          if (x < x0 || x > x1 || y < y0 || y > y1) continue
          const index = indexOf(x, y)
          if (isClosed(index) || grid.blocked?.(x, y) || !canStep(grid.map, field, at.x, at.y, x, y, { surf })
            || (grid.stepGuard && !grid.stepGuard(at.x, at.y, x, y))) continue
          // Walking across a different door would change maps before this route reached its destination.
          if (!goalSet.has(index) && (doors ? doors.has(index) : warpAt(grid.map, x, y))) continue
          const cost = current.cost + 1
          if (cost >= costAt(index)) continue
          setCost(index, cost)
          setParent(index, current.index)
          heap.push({ index, score: cost + heuristic(x, y), cost })
        }
      }
      if (!heap.size) status = 'unreachable'
    },
  }
}

export function createQuestNavigator(world: World, rules: NavigationRules) {
  let state: QuestNavigation | null = null
  let search: RouteSearch | null = null
  let goals: { point: RoutePlace; nextMap?: string }[] = []
  let key = ''
  let checkT = 0
  let retryT = 0
  let canonicalTarget: RoutePlace | null = null
  let repairTail: readonly RoutePoint[] | null = null
  const clear = () => { state = null; search = null; goals = []; key = ''; repairTail = null; canonicalTarget = null }
  const repair = (path: readonly RoutePoint[], from: RoutePoint, grid: MotionGrid, surf: boolean) => {
    let nearest = 0, distance = Infinity
    path.forEach((p, i) => {
      const d = Math.abs(p.x - from.x) + Math.abs(p.y - from.y)
      if (d < distance) { nearest = i; distance = d }
    })
    repairTail = path.slice(Math.min(path.length - 1, nearest + rules.trailTiles))
    search = createRouteSearch(grid, from, [repairTail[0]], surf, rules)
    state = { ...state!, status: 'searching', path: [], steps: 0 }
  }
  return {
    get state() { return state },
    clear,
    update(dt: number, grid: MotionGrid, player: RoutePoint, save: SaveData, surf: boolean, liveNpc?: (target: RoutePoint) => RoutePoint | null) {
      const quest = save.settings.showObjective ? trackedQuest(world, save) : null
      const stage = quest?.def.stages[quest.stage]
      if (!quest || !stage?.target) { clear(); return }
      const nextKey = `${grid.map.id}|${quest.def.id}|${quest.stage}|${surf}`
      const from = { map: grid.map.id, x: Math.floor(player.x), y: Math.floor(player.y) }
      checkT -= dt
      retryT -= dt
      let replan = key !== nextKey
      if (state?.status === 'ready' || state?.status === 'arrived') {
        const index = state.path.findIndex(p => p.x === from.x && p.y === from.y)
        if (index < 0) replan = true
        else if (index > 0) {
          state = { ...state, path: state.path.slice(index), steps: state.path.length - index - 1 }
          state.status = state.steps ? 'ready' : 'arrived'
        }
        if (checkT <= 0 && !replan) {
          checkT = rules.recheckSec
          const moved = canonicalTarget?.map === from.map && liveNpc?.(canonicalTarget)
          if (moved && (Math.floor(moved.x) !== state.target.x || Math.floor(moved.y) !== state.target.y)) replan = true
          for (let i = 1; i < Math.min(state.path.length, rules.trailTiles); i++) {
            const a = state.path[i - 1], b = state.path[i]
            if (grid.blocked?.(b.x, b.y) || !canStep(grid.map, gridField(grid), a.x, a.y, b.x, b.y, { surf })
              || grid.stepGuard && !grid.stepGuard(a.x, a.y, b.x, b.y)) { replan = true; break }
          }
        }
      } else if (state?.status === 'unreachable' && retryT <= 0) replan = true
      if (replan || !state) {
        const previous = key === nextKey ? state : null
        key = nextKey
        canonicalTarget = destination(world, quest.def, stage.target, save)
        const live = canonicalTarget.map === from.map && liveNpc?.(canonicalTarget)
        const target = live ? { ...canonicalTarget, x: Math.floor(live.x), y: Math.floor(live.y) } : canonicalTarget
        goals = navigationWaypoints(world, from, target)
        const field = gridField(grid)
        if (target.map === from.map && (live || grid.blocked?.(target.x, target.y) || grid.map.npcs.some(n => n.x === target.x && n.y === target.y && visible(n, save)))) {
          goals = [[0, -1], [0, 1], [-1, 0], [1, 0]].map(([dx, dy]) => ({
            point: { map: target.map, x: target.x + dx, y: target.y + dy },
          })).filter(g => !grid.blocked?.(g.point.x, g.point.y) && (field.at(g.point.x, g.point.y) === 0 || surf && field.at(g.point.x, g.point.y) === 2))
        }
        if (previous?.path.length && previous.target.map === target.map && keyOf(previous.target) === keyOf(target)) {
          repair(previous.path, from, grid, surf)
        } else {
          repairTail = null
          search = createRouteSearch(grid, from, goals.map(g => g.point), surf, rules)
          state = { questId: quest.def.id, title: quest.def.nameZh, text: stage.text, target,
            waypoint: goals[0]?.point ?? from, status: 'searching', path: [], steps: 0 }
        }
        checkT = rules.recheckSec
        retryT = rules.retrySec
      }
      if (search?.status === 'searching') search.advance(rules.nodesPerFrame, rules.frameBudgetMs)
      if (search && state && search.status !== 'searching') {
        if (search.status === 'unreachable' && repairTail) {
          // A local repair may meet a newly closed passage; retry the actual destination before giving up.
          repairTail = null; key = ''; search = null
          return
        }
        if (search.status === 'unreachable') state = { ...state, status: 'unreachable', path: [], steps: 0 }
        else {
          const planned = repairTail ? [...search.path, ...repairTail.slice(1)] : search.path
          if (!repairTail) {
            const goal = goals.find(g => keyOf(g.point) === keyOf(planned.at(-1)!))!
            state = { ...state, waypoint: goal.point, nextMap: goal.nextMap }
          }
          repairTail = null
          const index = planned.findIndex(p => p.x === from.x && p.y === from.y)
          if (index < 0) { repair(planned, from, grid, surf); return }
          const path = planned.slice(index)
          state = { ...state, path, steps: path.length - 1, status: path.length > 1 ? 'ready' : 'arrived' }
        }
        search = null
      }
    },
  }
}
