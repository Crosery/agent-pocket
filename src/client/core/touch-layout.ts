// Where the on-screen pad sits: pure geometry from content/input.json (touch) for a viewport, hand and size preset.
// The DOM layer (input-touch.ts) draws it; the UI reads the insets it reserves (--ap-touch-*).
import type { Settings } from '../../shared/types.ts'
import type { InputConfig, TouchButtonDef } from './input-config.ts'

export type TouchConfig = InputConfig['touch']

export interface PlacedButton {
  def: TouchButtonDef
  /** Edge length in CSS px (preset scale applied). */
  size: number
  /** Offsets from the button-cluster corner (right corner for right-handed, left for left-handed). */
  side: number
  bottom: number
}

export interface TouchLayout {
  portrait: boolean
  hand: Settings['touchHand']
  scale: number
  stickRadius: number
  knobRadius: number
  /** Stick ghost centre from the stick corner (left corner for right-handed). */
  stickRest: { side: number; bottom: number }
  buttons: PlacedButton[]
  /** CSS px the pad keeps free: `bottom` only in portrait (the pad sits under the content there), `left` / `right` always. */
  insets: { bottom: number; left: number; right: number }
}

/** Width and height rules shared by the DOM layer and the tests. */
export function computeTouchLayout(
  cfg: TouchConfig,
  viewport: { width: number; height: number },
  hand: Settings['touchHand'] = 'right',
  size: Settings['touchSize'] = 'normal',
  gap = 0,
): TouchLayout {
  const portrait = viewport.height > viewport.width
  const scale = cfg.sizes[size] ?? 1
  const px = (def: TouchButtonDef) => (def.size === 'large' ? cfg.buttonSize : cfg.smallButtonSize) * scale
  const buttons: PlacedButton[] = cfg.buttons.map((def) => ({ def, size: px(def), side: def.right * scale, bottom: def.bottom * scale }))
  const stickRadius = cfg.stickRadius * scale
  const clusterWidth = cfg.margin + Math.max(0, ...buttons.map((b) => b.side + b.size))
  const stickWidth = cfg.margin + 2 * stickRadius
  // Content that must stay clear of the pad when the pad overlays the bottom of the screen (portrait): world-only
  // buttons vanish under menus, so they never reserve space.
  const reserved = cfg.margin + Math.max(2 * stickRadius, ...buttons.filter((b) => !b.def.worldOnly).map((b) => b.bottom + b.size))
  const buttonSide = hand === 'right' ? 'right' : 'left'
  return {
    portrait,
    hand,
    scale,
    stickRadius,
    knobRadius: cfg.knobRadius * scale,
    stickRest: { side: cfg.margin + stickRadius, bottom: cfg.margin + stickRadius },
    buttons,
    insets: {
      bottom: portrait ? reserved + gap : 0,
      left: buttonSide === 'right' ? stickWidth : clusterWidth,
      right: buttonSide === 'right' ? clusterWidth : stickWidth,
    },
  }
}

export interface Rect { left: number; top: number; right: number; bottom: number }

/** CSS-px rectangle of a placed button for a viewport (safe-area insets passed in). */
export function buttonRect(
  layout: TouchLayout,
  b: PlacedButton,
  cfg: TouchConfig,
  viewport: { width: number; height: number },
  safe: { left: number; right: number; bottom: number } = { left: 0, right: 0, bottom: 0 },
): Rect {
  const fromRight = layout.hand === 'right'
  const edge = cfg.margin + b.side
  const left = fromRight ? viewport.width - safe.right - edge - b.size : safe.left + edge
  const bottom = viewport.height - safe.bottom - cfg.margin - b.bottom
  return { left, right: left + b.size, top: bottom - b.size, bottom }
}

export function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  return a.left < b.right + pad && b.left < a.right + pad && a.top < b.bottom + pad && b.top < a.bottom + pad
}
