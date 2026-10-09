// Settings, level-of-detail and encounter controls.
import { qualityPreset, type QualityPreset } from '../../render/config.ts'
import { GAME } from '../../world/config.ts'
import { DevError, type CommandRun } from '../registry.ts'

/** QualityPreset keys a developer may change live (the world view rebuilds when they differ from what it built). */
export const LOD_KEYS = ['viewRadius', 'maxChunks', 'decorDensity', 'natureVariants', 'grassPerTile', 'particleScale', 'pointLights'] as const

export const envCommands: Record<string, CommandRun> = {
  /** Changes one player setting (quality tier, shadows, bloom, ...) exactly like the settings screen would. */
  'settings.set': ({ ctx }, a) => {
    const key = String(a.key)
    const cur = (ctx.save.settings as unknown as Record<string, unknown>)[key]
    if (cur === undefined) throw new DevError('dev.err.badArg', { arg: 'key', why: Object.keys(ctx.save.settings).join(' / ') })
    const raw = a.value as unknown
    const next = typeof cur === 'boolean' ? raw === true || raw === 'true' || raw === '1' : typeof cur === 'number' ? Number(raw) : String(raw)
    if (typeof next === 'number' && !Number.isFinite(next)) throw new DevError('dev.err.badArg', { arg: 'value', why: String(raw) })
    ;(ctx.save.settings as unknown as Record<string, unknown>)[key] = next
    ctx.events.emit('settings:changed', { settings: ctx.save.settings })
    return { key, value: next }
  },
  /** Overrides one level-of-detail value of the active quality tier; the overrides last until the page reloads. */
  'render.tune': ({ ctx }, a) => {
    const key = String(a.key)
    if (!(LOD_KEYS as readonly string[]).includes(key)) throw new DevError('dev.err.badArg', { arg: 'key', why: LOD_KEYS.join(' / ') })
    const value = a.value as number
    if (!(value >= 0)) throw new DevError('dev.err.badArg', { arg: 'value', why: String(value) })
    const preset = qualityPreset(ctx.save.settings.quality) as QualityPreset & Record<string, number>
    preset[key] = value
    return { tier: ctx.save.settings.quality, key, value }
  },
  /** Multiplies the tall-grass encounter rate (1 = as shipped, 0 = none). */
  'encounter.rate': (_h, a) => {
    GAME.encounters.grassRateMultiplier = Math.max(0, a.mult as number)
    return { mult: GAME.encounters.grassRateMultiplier }
  },
  'encounter.repel': ({ ctx }, a) => {
    ctx.save.repelSteps = a.on === false ? 0 : 99999
    return { repelSteps: ctx.save.repelSteps }
  },
  /** The next tall-grass encounter is this species (one shot). */
  'encounter.next': ({ overworld }, a) => {
    overworld.devHandles().forceEncounter({ species: String(a.species), level: Math.max(1, Math.floor((a.level as number | undefined) ?? 10)), ...(a.shiny === true ? { shiny: true } : {}) })
    return { species: a.species, level: a.level ?? 10 }
  },
}
