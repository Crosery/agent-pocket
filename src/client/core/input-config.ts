// Typed view of content/input.json (bindings, repeat timings, touch layout, display scaling).
import type { InputAction } from '../contracts.ts'
import inputJson from '../../../content/input.json' with { type: 'json' }

export interface TouchButtonDef {
  action: InputAction
  /** Text key for the button face (t()). */
  label: string
  size: 'large' | 'small'
  /** Offsets in CSS px from the bottom-right safe corner. */
  right: number
  bottom: number
  /** Latches on tap instead of acting while held. */
  toggle?: boolean
  /** Only shown while the world is free to roam (hidden under menus, dialogue and battles). */
  worldOnly?: boolean
}

/** Tap-to-move tuning (world/tap-move.ts). Distances in tiles unless noted. */
export interface TapMoveConfig {
  /** A tap grabs the nearest NPC / item / door / prop whose body is within this many CSS px. */
  pickRadiusPx: number
  /** Height (world units) above the ground of the point of a body that is hit-tested. */
  bodyLift: number
  /** Only things this close to the player are hit-tested. */
  candidateTiles: number
  maxNodes: number
  marginTiles: number
  /** The route waypoint advances when the body is this close to its tile centre. */
  waypointReach: number
  finalReach: number
  /** No progress for stuckSec seconds (moved less than stuckMinMove) re-plans, up to `replans` times, then gives up. */
  stuckSec: number
  stuckMinMove: number
  replans: number
  /** Refinements of the ground hit against the real terrain height. */
  elevationPasses: number
  /** Pixels subtracted from a candidate's screen distance by kind (bigger = easier to grab). */
  kindBiasPx: Record<string, number>
  markerFx: string
  blockedFx: string
}

export interface TouchButtonColors { hi: string; base: string; lo: string }

/** CSS colour values for the touch overlay. */
export interface TouchStyle {
  idleOpacity: number
  frame: string
  ringFill: string
  ringEdge: string
  knobHi: string
  knobLo: string
  label: string
  labelShadow: string
  toggleGlow: string
  buttons: Partial<Record<InputAction, TouchButtonColors>>
  buttonDefault: TouchButtonColors
}

export interface InputConfig {
  keyboard: Partial<Record<InputAction, string[]>>
  gamepad: {
    buttons: Partial<Record<InputAction, number[]>>
    stick: { xAxis: number; yAxis: number; deadzone: number; digitalThreshold: number }
    buttonThreshold: number
  }
  repeat: { actions: InputAction[]; delayMs: number; intervalMs: number }
  touch: {
    stickRadius: number
    knobRadius: number
    deadzone: number
    digitalThreshold: number
    margin: number
    buttonSize: number
    smallButtonSize: number
    /** Pixel grid (CSS px) of the stepped outlines. */
    pixel: number
    /** Label font size as a fraction of the button size. */
    labelScale: Record<TouchButtonDef['size'], number>
    /** The stick base follows a thumb dragged past the ring instead of letting it run away from the knob. */
    follow: boolean
    /** CSS px kept between the pad and the UI above it (portrait). */
    insetGap: number
    zoneWidthFraction: number
    zoneHeightFraction: { portrait: number; landscape: number }
    /** A touch is a world tap when it moves less than slopPx and ends within maxMs; a hold of stickHoldMs starts the stick. */
    tap: { slopPx: number; maxMs: number; stickHoldMs: number }
    /** navigator.vibrate durations (ms). */
    haptics: { button: number; toggle: number; stick: number; tap: number }
    /** Button size presets (Settings.touchSize) as a factor of the sizes above. */
    sizes: Record<'small' | 'normal' | 'large', number>
    tapMove: TapMoveConfig
    buttons: TouchButtonDef[]
    style: TouchStyle
  }
  display: { referenceWidth: number; referenceHeight: number; scaleStep: number; minScale: number; maxScale: number }
}

export const INPUT_CONFIG = inputJson as unknown as InputConfig

/** Every action that has at least one binding on any device. */
export function boundActions(cfg: InputConfig = INPUT_CONFIG): InputAction[] {
  const set = new Set<InputAction>([
    ...(Object.keys(cfg.keyboard) as InputAction[]),
    ...(Object.keys(cfg.gamepad.buttons) as InputAction[]),
    ...cfg.touch.buttons.map((b) => b.action),
  ])
  return [...set]
}
