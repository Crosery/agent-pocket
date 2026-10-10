// Loads the gameplay content (content/events/**, content/research.json) into GAMEPLAY. Logic only: event text
// keys default to the patterns in content/events/spawn.json `text`, and every roaming legend in
// content/events/legends.json is expanded into its encounter event through the file's `eventTemplate`.
// Imports JSON only (no CONTENT) so src/shared/content/index.ts can validate it without an import cycle.
import type { EventEffect, InstanceFile, ResearchFile, WorldEventDef } from '../types.ts'
import type { EventFile, GameplayData, LegendFile, MythicFile, RoamingLegendDef, SpawnRules } from './schema.ts'

import spawnJson from '../../../content/events/spawn.json' with { type: 'json' }
import festivalsJson from '../../../content/events/festivals.json' with { type: 'json' }
import cultureJson from '../../../content/events/culture.json' with { type: 'json' }
import hiddenJson from '../../../content/events/hidden.json' with { type: 'json' }
import buzzJson from '../../../content/events/buzz.json' with { type: 'json' }
import mythicJson from '../../../content/events/mythic.json' with { type: 'json' }
import legendsJson from '../../../content/events/legends.json' with { type: 'json' }
import researchJson from '../../../content/research.json' with { type: 'json' }
import instancesJson from '../../../content/world/instances.json' with { type: 'json' }

/** Raw event as authored: name/description may be omitted (filled from the text-key patterns). */
type RawEvent = Omit<WorldEventDef, 'nameZh' | 'description'> & { nameZh?: string; description?: string }

interface TextPatterns { name: string; description: string }
type SpawnFile = SpawnRules & { text: TextPatterns }

interface LegendTemplate {
  event: RawEvent
  /** Appended when the legend drags a field weather along ({weather} is substituted). */
  weatherEffect: EventEffect
}

const fill = (s: string, vars: Record<string, string>): string => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m))

/** Deep placeholder substitution over JSON-shaped data. */
function subst<T>(v: T, vars: Record<string, string>): T {
  if (typeof v === 'string') return fill(v, vars) as unknown as T
  if (Array.isArray(v)) return v.map((x) => subst(x, vars)) as unknown as T
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = subst(x, vars)
    return out as T
  }
  return v
}

function finish(raw: RawEvent, text: TextPatterns): WorldEventDef {
  const vars = { id: raw.id }
  return { ...raw, nameZh: raw.nameZh ?? fill(text.name, vars), description: raw.description ?? fill(text.description, vars) }
}

function legendEvent(l: RoamingLegendDef, tpl: LegendTemplate, text: TextPatterns): WorldEventDef {
  const vars = { species: l.species, cue: l.cue, weather: l.weather ?? '' }
  const ev = subst(tpl.event, vars)
  const effects = l.weather ? [...ev.effects, subst(tpl.weatherEffect, vars)] : ev.effects
  return finish({ ...ev, when: l.when, effects }, text)
}

export function buildGameplay(): GameplayData {
  const spawnFile = spawnJson as unknown as SpawnFile
  const { text, ...spawn } = spawnFile
  const legendFile = legendsJson as unknown as LegendFile & { eventTemplate: LegendTemplate }
  const mythic = mythicJson as unknown as MythicFile
  const authored = [festivalsJson, cultureJson, hiddenJson, buzzJson].flatMap((f) => (f as unknown as EventFile).events as RawEvent[])
  const events: WorldEventDef[] = [
    ...authored.map((e) => finish(e, text)),
    ...(mythic.events as RawEvent[]).map((e) => finish(e, text)),
    ...legendFile.legends.map((l) => legendEvent(l, legendFile.eventTemplate, text)),
  ]
  return {
    events,
    eventById: Object.fromEntries(events.map((e) => [e.id, e])),
    spawn,
    legends: legendFile.legends,
    legendBySpecies: Object.fromEntries(legendFile.legends.map((l) => [l.species, l])),
    chains: mythic.chains,
    chainById: Object.fromEntries(mythic.chains.map((c) => [c.id, c])),
    research: researchJson as unknown as ResearchFile,
    instances: (instancesJson as unknown as InstanceFile).instances,
  }
}

export const GAMEPLAY: GameplayData = buildGameplay()
