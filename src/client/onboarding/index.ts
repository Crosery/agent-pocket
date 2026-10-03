// Onboarding: a persistent "当前目标" tracker (HUD, top-left) and one-time contextual tips with device-aware key
// glyphs. All rules and texts live in content/tutorial.json + content/text/zh-CN/tutorial.json; this module only
// evaluates them against the save and the live game state (see logic.ts) and renders them (see view.ts).
import type { GameContext } from '../contracts.ts'
import type { OverworldExt } from '../world/controller.ts'
import { CONTENT } from '../../shared/content/index.ts'
import { maxHp } from '../../shared/creature.ts'
import { TUTORIAL, type TipDef } from './config.ts'
import { bearing, condHolds, nearestTarget, pickObjective, tipFlag, tipLive, type Place } from './logic.ts'
import { createObjectiveView, createTipView } from './view.ts'
import { worldAnchors } from '../../shared/world/index.ts'

export interface Onboarding {
  update(dt: number): void
  setVisible(v: boolean): void
  /** Pause menu opened (game.ts owns that modal). */
  notifyMenuOpened(): void
  /** Dev / test hook: force a tip regardless of triggers or seen flags. */
  debugShow(id: string): void
  readonly objectiveId: string
  dispose(): void
}

export function createOnboarding(ctx: GameContext, overworld: OverworldExt, uiRoot: HTMLElement): Onboarding {
  const cfg = TUTORIAL
  const anchors = worldAnchors(ctx.data.world)
  const objective = createObjectiveView(uiRoot)
  const tips = createTipView(uiRoot, ctx.input)
  const tipById = new Map(cfg.tips.list.map((x) => [x.id, x]))

  let visible = false
  let refreshT = 0
  let objectiveRule = ''
  let pending: { tip: TipDef; at: number }[] = []
  let clock = 0
  let freeSince = 0
  let showing: { tip: TipDef; doneOn?: TipDef['doneOn']; startPos: Place; until: number } | null = null
  let nextAllowed = 0
  const shownThisSession = new Set<string>()

  const here = (): Place => ({ map: overworld.player.map, x: overworld.player.x, y: overworld.player.y })
  const settings = () => ctx.save.settings

  const queue = (tip: TipDef, delaySec = 0) => {
    if (shownThisSession.has(tip.id) || pending.some((p) => p.tip.id === tip.id) || !tipLive(tip, ctx.save)) return
    pending.push({ tip, at: clock + delaySec })
  }

  // -- objective -------------------------------------------------------------------------------------------
  function refreshObjective(): void {
    const on = visible && settings().showObjective && overworld.mapId !== null
    objective.setVisible(on)
    if (!on) return
    const view = pickObjective(ctx.data.world, ctx.save, cfg)
    objectiveRule = view.ruleId
    const candidates: Place[] = view.questTarget ? [view.questTarget] : view.targets.flatMap((a) => (anchors[a] ? [anchors[a]] : []))
    const from = here()
    const target = nearestTarget(ctx.data.world, from, candidates)
    const arrow = target ? bearing(from, target) : null
    objective.set({
      textKey: view.textKey,
      params: view.params,
      arrow: arrow && arrow.tiles >= cfg.objective.arrow.minDistance ? { angle: arrow.angle, steps: arrow.tiles * cfg.objective.arrow.stepsPerTile } : null,
      device: ctx.input.lastDevice,
    })
  }

  // -- progress markers (region visits that have no other persistent trace) --------------------------------------
  const offRegion = ctx.events.on('region:entered', ({ regionIndex, mapId }) => {
    const map = ctx.data.world.maps[mapId]
    const region = map?.regions[regionIndex]
    if (!region) return
    for (const m of cfg.objective.markers) if (m.on === 'region:entered' && m.region === region.id) ctx.save.flags[m.flag] = true
  })

  // -- tips ----------------------------------------------------------------------------------------------------
  const offBattle = ctx.events.on('battle:start', ({ kind }) => {
    for (const tip of cfg.tips.list) {
      const tr = tip.trigger
      if (tr.kind !== 'battle') continue
      if (tr.battleKinds && !tr.battleKinds.includes(kind)) continue
      queue(tip, tr.delaySec ?? 0)
    }
  })
  const offBattleEnd = ctx.events.on('battle:end', () => { dropBattleTips() })

  function dropBattleTips(): void {
    pending = pending.filter((p) => p.tip.trigger.kind !== 'battle')
    if (showing?.tip.trigger.kind === 'battle') closeTip()
  }

  function closeTip(): void {
    showing = null
    tips.hide()
    nextAllowed = clock + cfg.tips.layer.gapSec
  }

  function present(tip: TipDef): void {
    shownThisSession.add(tip.id)
    ctx.save.flags[tipFlag(tip.id)] = true
    showing = { tip, ...(tip.doneOn ? { doneOn: tip.doneOn } : {}), startPos: here(), until: clock + cfg.tips.layer.ttlSec }
    tips.show({ textKey: tip.text, device: ctx.input.lastDevice, place: tip.place ?? 'bottom' })
    ctx.audio.playSfx('select', { volume: 0.4 })
  }

  const npcVisible = (n: { hiddenIfFlag?: string; hiddenUnlessFlag?: string }) =>
    !(n.hiddenIfFlag && ctx.save.flags[n.hiddenIfFlag]) && !(n.hiddenUnlessFlag && !ctx.save.flags[n.hiddenUnlessFlag])

  /** Situational tips are only worth showing while the situation lasts. */
  function hold(tip: TipDef, on: boolean, delaySec = 0): void {
    if (on) queue(tip, delaySec)
    else pending = pending.filter((p) => p.tip !== tip)
  }

  function scanTriggers(free: boolean): void {
    if (free) {
      if (!freeSince) freeSince = clock
    } else freeSince = 0
    if (!free) return
    const p = overworld.player
    for (const tip of cfg.tips.list) {
      const tr = tip.trigger
      if (!tipLive(tip, ctx.save)) continue
      switch (tr.kind) {
        case 'free':
          if (condHolds(tr.needs, ctx.save)) queue(tip, Math.max(0, (tr.delaySec ?? 0) - (clock - freeSince)))
          break
        case 'npcNear': {
          const map = ctx.data.world.maps[p.map]
          const near = map?.npcs.some((n) => !n.trainer && npcVisible(n) && Math.abs(Math.floor(p.x) - n.x) + Math.abs(Math.floor(p.y) - n.y) <= tr.radius)
          hold(tip, !!near)
          break
        }
        case 'tallGrass':
          hold(tip, !!CONTENT.terrainByKey[overworld.terrainName]?.tallGrass)
          break
        case 'hurt':
          hold(tip, ctx.save.party.some((c) => c.hp < maxHp(c, ctx.data) * tr.hpBelow), tr.delaySec ?? 0)
          break
        default:
          break
      }
    }
  }

  function tipFinished(s: NonNullable<typeof showing>): boolean {
    if (clock >= s.until) return true
    if (s.doneOn === 'moved') {
      const p = here()
      return p.map !== s.startPos.map || Math.hypot(p.x - s.startPos.x, p.y - s.startPos.y) >= 2
    }
    if (s.doneOn === 'dialogue') return ctx.ui.isBlocking()
    return false
  }

  function pump(free: boolean): void {
    if (showing) {
      if (tipFinished(showing) || tips.dismissed() || (showing.tip.trigger.kind === 'menu' && !ctx.ui.isBlocking())) closeTip()
      return
    }
    if (clock < nextAllowed || !settings().showTips) return
    const inBattle = overworld.battleActive
    const next = pending.find((p) => p.at <= clock && tipEligible(p.tip, free, inBattle))
    if (!next) return
    pending = pending.filter((p) => p !== next)
    if (tipLive(next.tip, ctx.save)) present(next.tip)
  }

  function tipEligible(tip: TipDef, free: boolean, inBattle: boolean): boolean {
    const after = tip.trigger.kind === 'battle' ? tip.trigger.after : undefined
    if (after && !shownThisSession.has(after) && tipLive(tipById.get(after)!, ctx.save)) return false
    switch (tip.trigger.kind) {
      case 'battle': return inBattle
      case 'menu': return ctx.ui.isBlocking()
      default: return free
    }
  }

  const api: Onboarding = {
    update(dt) {
      clock += dt
      if (!visible) return
      const free = overworld.free && !ctx.ui.isBlocking()
      if (!settings().showTips) { if (showing) closeTip(); pending = [] } else {
        scanTriggers(free)
        pump(free)
      }
      refreshT -= dt
      if (refreshT <= 0) { refreshT = cfg.objective.refreshSec; refreshObjective() }
    },
    setVisible(v) {
      visible = v
      if (!v) { objective.setVisible(false); if (showing) closeTip() } else refreshT = 0
    },
    notifyMenuOpened() { const tip = tipById.get('menu'); if (tip?.trigger.kind === 'menu') queue(tip, tip.trigger.delaySec ?? 0) },
    debugShow(id) {
      const tip = tipById.get(id)
      if (!tip) return
      if (showing) closeTip()
      present(tip)
    },
    get objectiveId() { return objectiveRule },
    dispose() { offRegion(); offBattle(); offBattleEnd(); objective.dispose(); tips.dispose() },
  }
  return api
}
