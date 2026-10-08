// Typed view of content/events/client.json: client-side tunables of the world-event / rarity-spawn / research
// runtime and the cue registry implementation (cue key -> world fx, bubble, sfx, aura colour, ping colour, screen
// ambience overlay). The cue keys themselves are declared by content/events/spawn.json `cues` (shared gameplay).
// Pure module: no DOM, safe for node tests.
import type { GameMap, Rarity } from '../../shared/types.ts'
import type { MinimapMarker, WorldFx } from '../contracts.ts'
import { CONTENT, type Content } from '../../shared/content/index.ts'
import { GAMEPLAY } from '../../shared/gameplay/data.ts'
import type { GameplayData } from '../../shared/gameplay/schema.ts'
import clientJson from '../../../content/events/client.json' with { type: 'json' }

type MapKind = GameMap['kind']
type ToastKind = 'info' | 'success' | 'warn' | 'error'

/** Screen overlay animations implemented by src/client/ui/event-hud.css (capability ids). */
export const OVERLAY_ANIMS = ['none', 'pulse', 'flicker', 'drift', 'scan', 'hue', 'glitch', 'alarm', 'thunder', 'heat', 'flash'] as const
export type OverlayAnim = typeof OVERLAY_ANIMS[number]
const BLENDS = ['normal', 'screen', 'multiply', 'overlay', 'color', 'soft-light', 'lighten', 'darken'] as const

export interface CueDef {
  /** World fx played at the cue position (spawn / notice / flee moments). */
  fx?: WorldFx[]
  /** Speech bubble over the creature (notice). */
  bubble?: string
  bubbleMs?: number
  sfx?: string
  flash?: { color: string; ms: number; everySec?: number }
  shake?: { intensity: number; ms: number }
  /** Aura ring colour (aura cues) or ping colour (ping cues). */
  color?: string
  /** Minimap marker kind a ping cue maps to. */
  marker?: 'legend' | 'event'
  /** Ambience: world fx scattered around the player every `everySec`. */
  ambient?: { fx: WorldFx[]; everySec: number; radius: number; count: number }
  /** Ambience: full-screen DOM overlay under the HUD. */
  overlay?: { background: string; blend: typeof BLENDS[number]; anim: OverlayAnim; opacity: number }
}

export interface GameplayClientConfig {
  scheduler: { mapKinds: MapKind[]; minCheckRealSec: number; localEndDistance: number; fallbackAreaLevel: [number, number]; seedSalt: string }
  places: { nearCacheTiles: number; revealSearchRadius: number; revealPinReachTiles: number; revealPinsMax: number; revealPingMinutes: number }
  start: { bannerTags: string[]; bannerCooldownSec: number; hiddenSfx: string; startSfx: string; rumorToastKind: ToastKind; hiddenToastKind: ToastKind }
  /** Flag prefixes owned by the client runtime (news log, consumed event spawns / items, places revealed by events). */
  flags: { news: string; spawnTaken: string; itemTaken: string; revealed: string }
  rumors: { townEnterChance: number; cooldownMinutes: number; ambientEveryMinutes: number; ambientChance: number; toastKind: ToastKind }
  items: { pickupRadius: number; glintEverySec: number; hiddenGlintRadius: number; visibleFx: WorldFx; hiddenFx: WorldFx; sfx: string; snapRadius: number }
  special: {
    mapKinds: MapKind[]; speed: number; wanderRadius: number; idleSec: [number, number]; fleeSpeedMul: number; chaseSpeedMul: number; noticeRange: number; touchRadius: number
    cullDistance: number; despawnDistance: number; snapRadius: number; arriveEpsilon: number; shinyCue: string
  }
  legends: { checkSec: number; mapKinds: MapKind[]; senseToastCooldownSec: number; despawnBeyondMul: number; senseAmbience: boolean }
  roaming: { rareFromOrder: number; noticeBubbleFallback: string }
  /** Scripted wildBattle of these rarities first materialises the creature in front of the player. */
  presentation: { arriveHoldMs: number; arriveDistance: number; rarities: Rarity[] }
  research: { claimFlag: string; toastGains: boolean; toastKind: ToastKind; visibleRows: number; compactVisibleRows: number }
  /** maxChips limits collapsed colour pips, not the complete activity list. overlayFadeMs matches event-hud.css. */
  hud: { maxChips: number; refreshSec: number; overlayFadeMs: number; chipTags: string[]; tagColors: Record<string, string>; defaultColor: string }
  intel: { calendarDays: number; maxNews: number; maxRumors: number; visibleRows: number; compactVisibleRows: number }
  markers: { legendRoamer: MinimapMarker['kind']; eventRoamer: MinimapMarker['kind']; revealPin: MinimapMarker['kind']; senseClampTiles: number }
  /** Cue (ping group) used for each map ping kind. */
  pings: Record<'legend' | 'mythic' | 'event' | 'place', string>
  debug: { global: string; key: string }
  cues: Record<string, CueDef>
}

export const GPC: GameplayClientConfig = clientJson as unknown as GameplayClientConfig

export function cueDef(key: string | null | undefined): CueDef | null {
  return key ? GPC.cues[key] ?? null : null
}

/** Colour of a map ping kind (cue colour; `cue` overrides the kind's default cue). */
export function pingColor(kind: keyof GameplayClientConfig['pings'], cue?: string | null): string {
  return cueDef(cue)?.color ?? cueDef(GPC.pings[kind])?.color ?? ''
}

/** Aura ring colour for an aura cue key (falls back to the rarity colour when the cue is unknown). */
export function auraCueColor(cue: string | null | undefined, rarity: string, c: Content = CONTENT): string | null {
  if (!cue) return null
  return cueDef(cue)?.color ?? c.rarityById[rarity]?.color ?? null
}

const WORLD_FX: readonly WorldFx[] = ['exclaim', 'question', 'grass', 'dust', 'sparkle', 'splash', 'heart', 'warp', 'levelup', 'shiny']
const MAP_KINDS: readonly MapKind[] = ['overworld', 'interior', 'cave']
const COLOR = /^#[0-9a-fA-F]{6}$/

/** Reference check of content/events/client.json against the cue registry, audio and content tables. */
export function validateGameplayClient(cfg: GameplayClientConfig = GPC, c: Content = CONTENT, g: GameplayData = GAMEPLAY): string[] {
  const errs: string[] = []
  const sfx = new Set(c.audio.sfx)
  const needSfx = (where: string, id: string | undefined) => { if (id && !sfx.has(id)) errs.push(`${where}: unknown sfx "${id}"`) }
  const needFx = (where: string, list: readonly string[] | undefined) => {
    for (const f of list ?? []) if (!WORLD_FX.includes(f as WorldFx)) errs.push(`${where}: unknown world fx "${f}"`)
  }
  if (!(cfg.hud.overlayFadeMs >= 0)) errs.push('hud.overlayFadeMs must be >= 0')
  const registry = g.spawn.cues
  const declared = new Set(Object.values(registry).flat())
  for (const [group, keys] of Object.entries(registry)) {
    for (const k of keys) {
      const d = cfg.cues[k]
      if (!d) { errs.push(`cues.${k}: cue of group "${group}" has no client implementation`); continue }
      if (group === 'aura' && !(d.color && COLOR.test(d.color))) errs.push(`cues.${k}: aura cue needs a #rrggbb color`)
      if (group === 'ping' && !(d.color && COLOR.test(d.color) && d.marker)) errs.push(`cues.${k}: ping cue needs color + marker`)
      if (group === 'ambience' && !d.ambient && !d.overlay) errs.push(`cues.${k}: ambience cue needs ambient fx or an overlay`)
    }
  }
  for (const [k, d] of Object.entries(cfg.cues)) {
    if (!declared.has(k)) errs.push(`cues.${k}: not declared in content/events/spawn.json cues`)
    needFx(`cues.${k}.fx`, d.fx)
    needFx(`cues.${k}.ambient.fx`, d.ambient?.fx)
    needSfx(`cues.${k}`, d.sfx)
    if (d.flash && !COLOR.test(d.flash.color)) errs.push(`cues.${k}.flash: bad color`)
    if (d.overlay) {
      if (!OVERLAY_ANIMS.includes(d.overlay.anim)) errs.push(`cues.${k}.overlay: unknown anim "${d.overlay.anim}"`)
      if (!(BLENDS as readonly string[]).includes(d.overlay.blend)) errs.push(`cues.${k}.overlay: unknown blend "${d.overlay.blend}"`)
    }
    if (d.ambient && !(d.ambient.everySec > 0)) errs.push(`cues.${k}.ambient: everySec must be > 0`)
  }
  for (const kinds of [cfg.scheduler.mapKinds, cfg.special.mapKinds, cfg.legends.mapKinds]) {
    for (const k of kinds) if (!MAP_KINDS.includes(k)) errs.push(`unknown map kind "${k}"`)
  }
  needFx('items.visibleFx', [cfg.items.visibleFx])
  needFx('items.hiddenFx', [cfg.items.hiddenFx])
  needSfx('items.sfx', cfg.items.sfx)
  needSfx('start.hiddenSfx', cfg.start.hiddenSfx)
  needSfx('start.startSfx', cfg.start.startSfx)
  for (const [k, cue] of Object.entries(cfg.pings)) if (!cfg.cues[cue]?.color) errs.push(`pings.${k}: cue "${cue}" has no color`)
  if (!cfg.cues[cfg.special.shinyCue]) errs.push(`special.shinyCue: unknown cue "${cfg.special.shinyCue}"`)
  if (!(cfg.special.noticeRange > 0)) errs.push('special.noticeRange: must be > 0')
  if (!(cfg.special.chaseSpeedMul > 0)) errs.push('special.chaseSpeedMul: must be > 0')
  for (const r of cfg.presentation.rarities) if (!c.rarityById[r]) errs.push(`presentation.rarities: unknown rarity "${r}"`)
  const prefixes = [cfg.flags.news, cfg.flags.spawnTaken, cfg.flags.itemTaken, cfg.flags.revealed, g.spawn.rumor.flagPrefix]
  if (new Set(prefixes).size !== prefixes.length) errs.push('flags: prefixes must be distinct')
  return errs
}
