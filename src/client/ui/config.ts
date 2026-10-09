// Typed view of content/ui.json (UI tunables + pixel glyph art). Pure module: no DOM access.
import uiJson from '../../../content/ui.json' with { type: 'json' }
import inputJson from '../../../content/input.json' with { type: 'json' }
import type { Settings } from '../../shared/types.ts'
import type { InputAction } from '../contracts.ts'

export type ToastKind = 'info' | 'success' | 'warn' | 'error'
export type ChatTab = 'all' | 'global' | 'local' | 'whisper' | 'system'
export type SendChannel = 'global' | 'local' | 'whisper'

/** Pixel-art glyph: each row is a string; '.' is transparent, other chars index the palette. */
export interface GlyphDef { rows: string[]; palette?: Record<string, string> }

export interface MarkerStyle {
  glyph: string
  z: number
  /** Base glyph points up; rotated by the marker's facing. */
  rotate?: boolean
  blinkMs?: number
  /** Pin to the minimap ring when outside the visible radius. */
  clampToEdge?: boolean
  /** Visible even inside unexplored fog. */
  showInFog?: boolean
  palette?: Record<string, string>
}

export interface PhoneHudZones {
  /** Toast lane offsets from the top and the two sides. */
  toast: { top: number; left: number; right: number }
  /** Width of the HUD cards under the region plate (quest card), so the toast lane beside them stays clear. */
  lowerStackWidth: number
  /** Lines of the region / event banner's subtitle (0 hides it: the headline alone). */
  bannerSubLines: number
}

export interface UIConfig {
  scale: { baseWidth: number; baseHeight: number; minCssPerUnit: number; maxDeviceScale: number; compactBelowWidth: number }
  /** Layout audit limits (scripts/qa-layout-audit.mjs): text size range per viewport class, scrollers a class may have. */
  audit: { fontPx: Record<'desktop' | 'phone', { min: number; maxVhFrac: number }>; scrollOk: Record<'desktop' | 'phone', string[]> }
  /**
   * Full-screen panels (pause, party, bag, ...) on a pointer device use a finer unit than the HUD so text stays near
   * bodyHeightFrac of the window height (clamped to min/maxBodyPx) instead of growing with the integer HUD scale.
   * Device px per unit moves in stepDevicePerUnit steps (never above the HUD's, never below minDevicePerUnit).
   */
  screenScale: { bodyUnits: number; bodyHeightFrac: number; minBodyPx: number; maxBodyPx: number; minTextPx: number; tiers: Record<'hero' | 'title' | 'body' | 'label' | 'caption', number>; stepDevicePerUnit: number; minDevicePerUnit: number }
  anim: { panelOpenMs: number; panelCloseMs: number; modalOpenMs: number; cursorBobMs: number; toastEnterMs: number; toastLeaveMs: number }
  fade: { defaultMs: number }
  sfx: { move: string; confirm: string; cancel: string; error: string; open: string; close: string; tab: string }
  dialogue: {
    /** Characters per second by Settings.textSpeed; 0 = instant. */
    charsPerSecond: Record<Settings['textSpeed'], number>
    blip: { sfx: string; everyChars: number; volume: number; pitch: number; pitchJitter: number }
    pause: { chars: string; ms: number }
    lingerMs: number
    portraitFallbackChars: number
  }
  list: {
    visibleRows: number; compactVisibleRows: number; rowHeight: number; wrap: boolean; pageStep: number; minWidth: number; detailWidth: number
    /** With the touch pad on, rows grow to at least this many CSS px (a finger, not a cursor)... */
    touchRowCss: number
    /** ...and a list shows no more rows than fit in the viewport height minus this many CSS px of header, detail pane and footer
     *  (portrait also counts the pad strip); never fewer than minTouchRows. */
    touchReservePx: { portrait: number; landscape: number }
    minTouchRows: number
  }
  prompt: { shakeMs: number }
  toast: { max: number; durationMs: Record<ToastKind, number>; sfx: Record<ToastKind, string> }
  bars: {
    hp: { midBelow: number; lowBelow: number; drainPerSecond: number; width: number }
    exp: { fillPerSecond: number; width: number }
  }
  rarity: { glowMinOrder: number; shimmerMinOrder: number }
  /** padX/padY: UI pixels around the polygon reserved for axis labels. */
  radar: { size: number; rings: number; labelGap: number; padX: number; padY: number; minRatio: number; labelAnchor: number }
  widgets: { creatureIconSize: number; tooltipOffsetPx: number; chipDarkInkAboveLuminance: number }
  hud: { bannerMs: number; bannerFadeMs: number; regionFadeMs: number; moneyTweenMs: number; todGlyph: Record<string, string> }
  minimap: {
    size: number
    compactSize: number
    ring: number
    /** Ring bevel: light direction dot-product thresholds and the inner shadow line alpha (0..255). */
    ringShade: { highlightAbove: number; shadowBelow: number; innerShadowAlpha: number }
    tilesVisible: number
    followRate: number
    /** Added to marker/player coords before mapping to baked pixels (pixel i spans tile [i, i+1)). */
    tileCenterOffset: number
    /** UI pixels reserved around the expanded map: side legend (landscape), title/frame, legend below (portrait). */
    expanded: { maxFraction: number; chromeXUnits: number; chromeYUnits: number; portraitLegendUnits: number; minLabelTiles: number }
    fog: { kinds: string[]; revealRadiusChunks: number; color: string; alpha: number; ditherTiles: number }
    bake: MapBakeConfig
    autoBuildingMarkers: boolean
    markers: Record<string, MarkerStyle>
    fallbackMarker: string
  }
  /** Phone HUD zones (UI units unless noted); published as --ap-ph-* by scale.ts, used by phone.css and the layout audit. */
  phoneHud: {
    portrait: PhoneHudZones
    landscape: PhoneHudZones
    /** Lines a toast may take. */
    toastLines: number
    /** CSS px kept free above the bottom edge for the chat button row (landscape tip card rests above it). */
    chatClearPx: number
    /** CSS px between a tip's dismiss button and its close button. */
    tipFootGapPx: number
    audit: { playerPadPx: { x: number; top: number; bottom: number } }
  }
  chat: {
    passiveLines: number
    compactPassiveLines: number
    touchPassiveLines: { portrait: number; landscape: number }
    openLines: number
    maxLines: number
    idleFadeMs: number
    idleOpacity: number
    fadeMs: number
    closeOnSend: boolean
    defaultChannel: SendChannel
    tabs: ChatTab[]
    channelColors: Record<string, string>
    commands: { whisper: string[]; reply: string[]; global: string[]; local: string[] }
  }
  /**
   * stallSec: seconds of held movement keys the chat may block while its input has no focus before it is released.
   * escapeOrder: overlay ids Esc dismisses, topmost first. releaseClickScopes: CSS scopes whose buttons give focus
   * back to the game after a pointer click.
   */
  focus: { stallSec: number; escapeOrder: string[]; releaseClickScopes: string[] }
  glyphPalette: Record<string, string>
  glyphs: Record<string, GlyphDef>
}

export interface MapBakeConfig {
  unknownTerrain: string
  noise: number
  hillshade: { light: number; shadow: number; heightTint: number; cliffShadow: number }
  canopy: { minHeight: number; darken: number }
  smallProp: { minHeight: number; darken: number }
  structure: { minArea: number; minHeight: number; color: string }
  building: { default: string; edgeDarken: number; roofLight: number; byIcon: Record<string, string> }
}

export const UI_CONFIG: UIConfig = uiJson as unknown as UIConfig

/** Read-only view of the bindings in content/input.json (owned by core/), used for key hints. */
export interface InputBindings {
  keyboard: Partial<Record<InputAction, string[]>>
  gamepad: { buttons: Partial<Record<InputAction, number[]>> }
  touch: {
    buttons: { action: InputAction; label: string; size: 'large' | 'small'; bottom: number; right: number }[]
    stickRadius: number; margin: number; buttonSize: number; smallButtonSize: number; zoneWidthFraction: number
  }
}
export const INPUT_BINDINGS: InputBindings = inputJson as unknown as InputBindings

/** Validates content/ui.json against the content registry; returns human-readable problems (empty = OK). */
export function validateUIConfig(cfg: UIConfig, knownSfx: readonly string[]): string[] {
  const errs: string[] = []
  const sfx = new Set(knownSfx)
  const checkSfx = (where: string, id: string) => { if (!sfx.has(id)) errs.push(`${where}: unknown sfx "${id}"`) }
  for (const [k, id] of Object.entries(cfg.sfx)) checkSfx(`ui.sfx.${k}`, id)
  checkSfx('ui.dialogue.blip.sfx', cfg.dialogue.blip.sfx)
  for (const [k, id] of Object.entries(cfg.toast.sfx)) checkSfx(`ui.toast.sfx.${k}`, id)

  for (const [id, g] of Object.entries(cfg.glyphs)) {
    if (!g.rows.length) { errs.push(`glyph ${id}: no rows`); continue }
    const w = g.rows[0].length
    g.rows.forEach((r, i) => { if (r.length !== w) errs.push(`glyph ${id}: row ${i} width ${r.length} != ${w}`) })
    const pal = { ...cfg.glyphPalette, ...(g.palette ?? {}) }
    for (const r of g.rows) for (const ch of r) if (ch !== '.' && !(ch in pal)) errs.push(`glyph ${id}: palette has no "${ch}"`)
  }
  const glyph = (where: string, id: string) => { if (!cfg.glyphs[id]) errs.push(`${where}: unknown glyph "${id}"`) }
  for (const [k, id] of Object.entries(cfg.hud.todGlyph)) glyph(`ui.hud.todGlyph.${k}`, id)
  for (const [k, m] of Object.entries(cfg.minimap.markers)) glyph(`ui.minimap.markers.${k}`, m.glyph)
  if (!cfg.minimap.markers[cfg.minimap.fallbackMarker]) errs.push(`ui.minimap.fallbackMarker "${cfg.minimap.fallbackMarker}" has no style`)
  if (cfg.minimap.tilesVisible <= 0) errs.push('ui.minimap.tilesVisible must be > 0')
  if (cfg.chat.tabs.length === 0) errs.push('ui.chat.tabs must not be empty')
  if (!(cfg.focus.stallSec > 0)) errs.push('ui.focus.stallSec must be > 0')
  for (const o of ['portrait', 'landscape'] as const) {
    const z = cfg.phoneHud[o]
    if (!(z.lowerStackWidth > 0) || !(z.bannerSubLines >= 0)) errs.push(`ui.phoneHud.${o}: lowerStackWidth must be positive and bannerSubLines >= 0`)
    for (const k of ['top', 'left', 'right'] as const) if (!(z.toast[k] >= 0)) errs.push(`ui.phoneHud.${o}.toast.${k} must be >= 0`)
    if (!(cfg.chat.touchPassiveLines[o] >= 1)) errs.push(`ui.chat.touchPassiveLines.${o} must be >= 1`)
  }
  const ss = cfg.screenScale
  if (!(ss.bodyUnits > 0) || !(ss.bodyHeightFrac > 0) || !(ss.minBodyPx > 0) || !(ss.maxBodyPx >= ss.minBodyPx) || !(ss.minTextPx > 0) || !(ss.tiers.caption > 0 && ss.tiers.caption <= ss.tiers.label && ss.tiers.label <= ss.tiers.body && ss.tiers.body <= ss.tiers.title && ss.tiers.title <= ss.tiers.hero) || !(ss.stepDevicePerUnit > 0) || !(ss.minDevicePerUnit > 0)) errs.push('ui.screenScale: bodyUnits, bodyHeightFrac, steps and px limits must be positive and maxBodyPx >= minBodyPx')
  if (cfg.focus.escapeOrder.length === 0) errs.push('ui.focus.escapeOrder must not be empty')
  return errs
}

/** Height (CSS px) covered by core's virtual pad, from its layout in content/input.json. */
export function touchPadHeight(b: InputBindings = INPUT_BINDINGS): number {
  const t = b.touch
  if (!t) return 0
  const buttons = t.buttons.map((x) => x.bottom + (x.size === 'large' ? t.buttonSize : t.smallButtonSize))
  return (t.margin ?? 0) + Math.max(0, ...buttons)
}
