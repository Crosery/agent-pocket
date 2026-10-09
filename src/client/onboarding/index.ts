// Onboarding: a persistent "当前目标" tracker (HUD, top-left) and one-time contextual tips with device-aware key
// glyphs. All rules and texts live in content/tutorial.json + content/text/zh-CN/tutorial.json; this module only
// evaluates them against the save and the live game state (see logic.ts) and renders them (see view.ts).
import type { GameContext } from '../contracts.ts'
import type { OverworldExt } from '../world/controller.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { maxHp } from '../../shared/creature.ts'
import { STORY_CONTENT } from '../../shared/world/story.ts'
import { ON_EVENTS, TUTORIAL, type TipDef } from './config.ts'
import { afterDone, battleCues, condHolds, enrich, isTallGrassName, matchPayload, tipFlag, tipLive, type LiveView, type Place } from './logic.ts'
import { createObjectiveView, createTipView } from './view.ts'

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
  const objective = createObjectiveView(uiRoot)
  const tips = createTipView(uiRoot, ctx.input)
  const tipById = new Map(cfg.tips.list.map((x) => [x.id, x]))

  let visible = false
  let refreshT = 0
  let objectiveRule = ''
  let pending: { tip: TipDef; at: number; born: number }[] = []
  let clock = 0
  let freeSince = 0
  let showing: { tip: TipDef; doneOn?: TipDef['doneOn']; startPos: Place; until: number } | null = null
  let nextAllowed = 0
  const shownThisSession = new Set<string>()

  const here = (): Place => ({ map: overworld.player.map, x: overworld.player.x, y: overworld.player.y })
  const settings = () => ctx.save.settings

  const live = (): LiveView => ({ timeOfDay: ctx.clock.timeOfDay })
  const orderOf = new Map(cfg.tips.list.map((x, i) => [x.id, i]))
  type Phase = 'battle' | 'field' | 'screen'
  const phaseOf = (tip: TipDef): Phase => {
    const tr = tip.trigger
    return tr.kind === 'battle' ? 'battle' : tr.kind === 'menu' ? 'screen' : tr.kind === 'on' ? tr.phase : 'field'
  }

  const queue = (tip: TipDef, delaySec = 0) => {
    if (shownThisSession.has(tip.id) || pending.some((p) => p.tip.id === tip.id) || !tipLive(tip, ctx.save)) return
    pending.push({ tip, at: clock + delaySec, born: clock })
  }

  // -- objective -------------------------------------------------------------------------------------------
  function refreshObjective(): void {
    const route = overworld.questNavigation
    const on = visible && settings().showObjective && overworld.mapId !== null && route !== null
    objective.setVisible(on)
    if (!on) { objectiveRule = ''; return }
    if (!route) return
    objectiveRule = route.questId
    const from = here()
    const next = route.path[1]
    const angle = next ? Math.atan2(next.y + 0.5 - from.y, next.x + 0.5 - from.x) : 0
    objective.set({
      textKey: 'tutorial.objective.next',
      params: { stage: route.text },
      arrow: next ? { angle, steps: route.steps } : null,
      note: route.status === 'ready' ? undefined : `tutorial.objective.navigation.${route.status}`,
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

  // -- one-time notice for a save that was migrated to natures (it got the persona-card gift) ------------------------
  const offLegacy = ctx.events.on('map:entered', () => {
    const f = ctx.save.flags
    const { legacyGift, legacyToast } = ctx.data.quality.flags
    if (!f[legacyGift] || f[legacyToast]) return
    f[legacyToast] = true
    ctx.ui.toast(t('screens.quality.legacyToast'), 'success')
    ctx.persist('legacy-notice')
  })

  // -- tips ----------------------------------------------------------------------------------------------------
  const offBattle = ctx.events.on('battle:start', ({ kind }) => {
    for (const tip of cfg.tips.list) {
      const tr = tip.trigger
      if (tr.kind !== 'battle') continue
      if (tr.battleKinds && !tr.battleKinds.includes(kind)) continue
      if (!condHolds(tr.needs, ctx.save, live())) continue
      queue(tip, tr.delaySec ?? 0)
    }
  })
  const offBattleEnd = ctx.events.on('battle:end', () => { dropPhase('battle') })

  /** Queues every `on` tip listening to `name` whose payload matches. */
  function fire(name: string, raw: Record<string, unknown>): void {
    const payload = enrich(name, raw, ctx.data.world)
    for (const tip of cfg.tips.list) {
      const tr = tip.trigger
      if (tr.kind !== 'on' || tr.on !== name || !matchPayload(tr.match, payload) || !condHolds(tr.needs, ctx.save, live())) continue
      queue(tip, tr.delaySec ?? 0)
    }
  }
  const offBus = (ON_EVENTS as readonly string[])
    .filter((name) => cfg.tips.list.some((x) => x.trigger.kind === 'on' && x.trigger.on === name))
    .map((name) => (ctx.events.on as (n: string, fn: (p: Record<string, unknown>) => void) => () => void)(name, (p) => fire(name, p)))
  const offCues = ctx.events.on('battle:events', ({ events }) => { for (const c of battleCues(events)) fire(c.cue, c.payload) })

  function dropPhase(phase: Phase): void {
    pending = pending.filter((p) => phaseOf(p.tip) !== phase)
    if (showing && phaseOf(showing.tip) === phase) closeTip()
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
    tips.show({ textKey: tip.text, device: ctx.input.lastDevice, openKey: tip.open?.text, place: tip.trigger.kind === 'menu' ? 'menu' : tip.place ?? (phaseOf(tip) === 'battle' ? 'battle' : 'bottom') })
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
          if (condHolds(tr.needs, ctx.save, live())) queue(tip, Math.max(0, (tr.delaySec ?? 0) - (clock - freeSince)))
          break
        case 'near': {
          const map = ctx.data.world.maps[p.map]
          const list = tr.what === 'sign' ? map?.signs : map?.items?.filter((it) => !it.hidden && !ctx.save.flags[`${STORY_CONTENT.meta.flags.groundItem}${it.id}`])
          hold(tip, !!list?.some((o) => Math.abs(Math.floor(p.x) - o.x) + Math.abs(Math.floor(p.y) - o.y) <= tr.radius))
          break
        }
        case 'npcNear': {
          const map = ctx.data.world.maps[p.map]
          const near = map?.npcs.some((n) => !n.trainer && npcVisible(n) && Math.abs(Math.floor(p.x) - n.x) + Math.abs(Math.floor(p.y) - n.y) <= tr.radius)
          hold(tip, !!near)
          break
        }
        case 'tallGrass':
          hold(tip, isTallGrassName(overworld.terrainName))
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
    const blocking = ctx.ui.isBlocking()
    const inBattle = overworld.battleActive
    if (!blocking) dropPhase('screen')
    if (showing) {
      const open = showing.tip.open
      const keyed = !!open && ctx.input.pressed(open.action)
      if (open && (tips.openRequested() || keyed)) {
        if (keyed) ctx.input.consume(open.action)
        closeTip()
        void ctx.screens.typeChart()
        return
      }
      if (tipFinished(showing) || tips.dismissed()) closeTip()
      else if (tips.disableRequested()) { closeTip(); disableTips() }
      return
    }
    if (clock < nextAllowed || !settings().showTips) return
    pending = pending.filter((p) => !(phaseOf(p.tip) !== 'field' && clock - p.born > cfg.tips.layer.staleSec))
    const eligible = pending.filter((p) => p.at <= clock && tipEligible(p.tip, free, inBattle, blocking))
    if (!eligible.length) return
    const next = eligible.reduce((a, b) => ((orderOf.get(a.tip.id) ?? 0) <= (orderOf.get(b.tip.id) ?? 0) ? a : b))
    pending = pending.filter((p) => p !== next)
    if (tipLive(next.tip, ctx.save)) present(next.tip)
  }

  function tipEligible(tip: TipDef, free: boolean, inBattle: boolean, blocking: boolean): boolean {
    if (!afterDone(tip, cfg.tips.list, ctx.save)) return false
    switch (phaseOf(tip)) {
      case 'battle': return inBattle
      case 'screen': return blocking && !inBattle
      default: return free
    }
  }

  /** The tip card's 「不再提示」: switch the setting off for good (the manual stays readable). */
  function disableTips(): void {
    settings().showTips = false
    pending = []
    ctx.events.emit('settings:changed', { settings: settings() })
    ctx.persist('settings')
    ctx.ui.toast(t('tutorial.tip.disabled'), 'info')
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
    dispose() { offRegion(); offLegacy(); offBattle(); offBattleEnd(); offCues(); offBus.forEach((off) => off()); objective.dispose(); tips.dispose() },
  }
  return api
}
