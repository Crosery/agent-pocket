// Code-side option lists that console.json arguments refer to by name (ArgSpec.enumRef).
import { GAME } from '../world/config.ts'
import type { EnumRefs } from './registry.ts'

export const ENUMS: EnumRefs = {
  weather: () => Object.keys(GAME.region.weatherIntensity),
}
