// Typed view of content/placeholders.json: art-style parameters for procedural placeholder assets.
import placeholdersJson from '../../../content/placeholders.json' with { type: 'json' }
import type { RampStyle } from './pixel.ts'

export interface Weighted { id: string; weight: number }

export interface ChibiDims {
  ground: number
  legH: number
  legW: number
  legGap: number
  shoeH: number
  torsoH: number
  torsoW: number
  armW: number
  armH: number
  headRx: number
  headRy: number
  neckOverlap: number
  eyeW: number
  eyeH: number
  eyeDx: number
  eyeDy: number
}

/** A motif drawn on a creature: a procedural capability (`draw`) or a pixel stamp from `stamps`. */
export interface MotifDef {
  draw?: string
  stamp?: string
  anchor?: string
  /** 'type' | 'type2' | 'hair' | 'top' | 'trim' | '#hex' */
  color?: string
  /** Overrides of look fields (topStyle, ears, tail, eyeStyle, ...). */
  set?: Record<string, string>
}

export interface StampDef {
  rows: string[]
  /** Pixel of the stamp placed on the anchor point. */
  pivot: [number, number]
}

export interface TerrainRecipe {
  /** Pattern capability id implemented in placeholder-terrain.ts. */
  pattern: string
  /** Base ramp, darkest first. */
  colors: string[]
  /** Detail colours (flowers, pebbles, highlights, moss, ...). */
  accents?: string[]
  /** Pattern-specific parameters (density, cell size, ...). */
  params?: Record<string, number>
}

export interface PlaceholdersFile {
  shading: RampStyle
  /** Softer ramp for skin so shadows stay warm instead of turning red. */
  skinShading: RampStyle
  outline: { lightness: number; hue: number; dark: string; mix: number }
  contour: { lightness: number; hue: number }
  stampPalette: Record<string, string>
  stamps: Record<string, StampDef>
  face: { blush: string; blushAlpha: number; mouth: string; eyeWhite: string; lash: string; highlight: string }
  /** Small fixed-colour details of procedural parts. */
  details: {
    foxTailTip: string; robotCable: string; robotPlug: string; earInner: string; earInnerMix: number; antenna: string
    mouthInner: string; drawstring: string; goggleBand: string; visorTint: string; visorTintMix: number
    shine: string; shineMix: number; neutral: string
  }
  /** Cel shading: light direction (screen space) and band thresholds of the light dot product. */
  cel: { light: [number, number]; bright: number; light1: number; shade1: number; shade2: number }
  creature: {
    logicalSize: number
    stages: ChibiDims[]
    skinTones: string[]
    eyeStyles: Weighted[]
    hairStyles: Weighted[]
    earStyles: Weighted[]
    tailStyles: Weighted[]
    topStyles: Weighted[]
    bottomStyles: Weighted[]
    mouths: Weighted[]
    neutralTops: string[]
    bottoms: string[]
    shoes: string[]
    eyeFallback: string[]
    hairJitter: { hue: number; lightness: number }
    secondaryShift: { hue: number; lightness: number }
    minEyeSaturation: number
    typeMotifs: Record<string, MotifDef[]>
    defaultMotifs: MotifDef[]
    stageMotifs: MotifDef[][]
    rarityMotifs: Record<string, MotifDef[]>
  }
  character: {
    dims: ChibiDims
    skin: { default: string; keywords: Record<string, string> }
    colors: Record<string, string>
    hairWords: string[]
    topWords: Record<string, string>
    bottomWords: Record<string, string>
    shoeWords: string[]
    hatWords: Record<string, string>
    /** Ordered [word, style] pairs: first match in the hair phrase wins, then in the whole description. */
    hairStyleWords: [string, string][]
    extraWords: Record<string, string>
    extraColors: Record<string, string>
    eyeColors: string[]
    fallback: { hair: string[]; top: string[]; bottom: string[]; shoes: string[] }
    defaultHairStyle: string
    defaultTopStyle: string
    defaultBottomStyle: string
  }
  terrain: {
    size: number
    recipes: Record<string, TerrainRecipe>
    fallback: TerrainRecipe
    tuft: {
      colors: string[]; blades: number; minHeight: number; maxHeight: number
      /** Max sideways lean, top-curve factor, chance/extent/shade of 2px-wide blades. */
      lean: number; curve: number; wideChance: number; wideUntil: number; wideShade: number
    }
    tuftColors: Record<string, string[]>
  }
  items: {
    size: number
    logicalSize: number
    ball: { white: string; band: string; button: string }
    categoryColors: Record<string, string>
    effectColors: Record<string, string>
    keyIcons: Record<string, string>
    /** Effect kind -> stamp; overrides the category icon. */
    effectIcons: Record<string, string>
    categoryIcons: Record<string, string>
  }
}

export const PH = placeholdersJson as unknown as PlaceholdersFile
