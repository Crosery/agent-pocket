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
    zoneWidthFraction: number
    zoneHeightFraction: number
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
