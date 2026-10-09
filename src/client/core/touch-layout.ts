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
  buttons: PlacedButton[]
  /** CSS px the pad keeps free: `bottom` only in portrait (the pad sits under the content there); `left` / `right` are the button cluster's side (the stick has no resting place and reserves nothing). */
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
  // Content that must stay clear of the pad when the pad overlays the bottom of the screen (portrait): world-only
  // buttons vanish under menus, so they never reserve space.
  const reserved = cfg.margin + Math.max(0, ...buttons.filter((b) => !b.def.worldOnly).map((b) => b.bottom + b.size))
  const buttonSide = hand === 'right' ? 'right' : 'left'
  return {
    portrait,
    hand,
    scale,
    stickRadius,
    knobRadius: cfg.knobRadius * scale,
    buttons,
    insets: {
      bottom: portrait ? reserved + gap : 0,
      left: buttonSide === 'right' ? 0 : clusterWidth,
      right: buttonSide === 'right' ? clusterWidth : 0,
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

/** Whether a touch at `x` may start the stick: the whole half (zone fraction) of the screen opposite the buttons, any height. */
export function inStickZone(x: number, width: number, hand: Settings['touchHand'], fraction: number): boolean {
  return hand === 'right' ? x < width * fraction : x > width * (1 - fraction)
}

/**
 * A touch may begin a stick only when it lands on the bare canvas (a HUD control under the thumb keeps its own touch),
 * no menu, dialogue or battle owns input, and it falls inside the stick half.
 */
export function mayStartStick(o: { onCanvas: boolean; modalOpen: boolean; x: number; width: number; hand: Settings['touchHand']; fraction: number }): boolean {
  return o.onCanvas && !o.modalOpen && inStickZone(o.x, o.width, o.hand, o.fraction)
}

/** What a pending touch becomes once it has travelled `distPx`: still undecided inside the slop, else a stick (in the zone) or a drag. */
export function moveOutcome(stickCapable: boolean, distPx: number, slopPx: number): 'pending' | 'stick' | 'drag' {
  if (distPx <= slopPx) return 'pending'
  return stickCapable ? 'stick' : 'drag'
}

/** A release is a world tap only when the touch never became a stick or drag, was not cancelled, and was brief. */
export function releaseIsTap(mode: 'pending' | 'stick' | 'drag', heldMs: number, maxMs: number, cancelled: boolean): boolean {
  return mode === 'pending' && !cancelled && heldMs <= maxMs
}

/** Where the ring is drawn: its centre kept `radius + pad` inside the viewport so it never leaves the screen. */
export function clampRing(c: { x: number; y: number }, radius: number, viewport: { width: number; height: number }, pad: number): { x: number; y: number } {
  const m = radius + pad
  const clamp = (v: number, size: number) => (size <= 2 * m ? size / 2 : Math.min(size - m, Math.max(m, v)))
  return { x: clamp(c.x, viewport.width), y: clamp(c.y, viewport.height) }
}

/** Whether a ring of `radius` centred on `c` reaches into `rect` (a card that would sit under the stick). */
export function ringHitsRect(c: { x: number; y: number }, radius: number, rect: { left: number; top: number; right: number; bottom: number }): boolean {
  const nx = Math.min(rect.right, Math.max(rect.left, c.x))
  const ny = Math.min(rect.bottom, Math.max(rect.top, c.y))
  return (c.x - nx) ** 2 + (c.y - ny) ** 2 < radius * radius
}

export interface StickDrive {
  /** The logical base: stays where the thumb landed, and trails the thumb once it is dragged past the ring. */
  origin: { x: number; y: number }
  /** Knob offset from the base, limited to the radius. */
  dx: number
  dy: number
  dist: number
}

/** One stick step for a thumb at `finger`. With `follow`, the base trails the thumb, so reversing needs only a ring's travel. */
export function driveStick(origin: { x: number; y: number }, finger: { x: number; y: number }, radius: number, follow: boolean): StickDrive {
  let o = origin
  let dx = finger.x - o.x
  let dy = finger.y - o.y
  let dist = Math.hypot(dx, dy)
  if (dist > radius) {
    if (follow) o = { x: o.x + (dx / dist) * (dist - radius), y: o.y + (dy / dist) * (dist - radius) }
    dx = (dx / dist) * radius
    dy = (dy / dist) * radius
    dist = radius
  }
  return { origin: o, dx, dy, dist }
}
