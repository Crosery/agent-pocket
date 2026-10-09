// Developer-mode content read straight from disk (the browser gets the same files through Vite's glob import).
import { readdirSync, readFileSync } from 'node:fs'
import type { DevAcceptance, DevBeat, DevScenario, DevTeam } from '../src/shared/types.ts'
import type { DevContent } from '../src/client/dev/content.ts'

const dir = new URL('../content/dev/', import.meta.url)
const json = <T>(rel: string): T => JSON.parse(readFileSync(new URL(rel, dir), 'utf8')) as T

export function devContentFromDisk(): DevContent {
  const scenarios: Record<string, DevScenario> = {}
  for (const f of readdirSync(new URL('scenarios/', dir)).filter((n) => n.endsWith('.json')).sort()) {
    const sc = json<DevScenario>(`scenarios/${f}`)
    scenarios[sc.id] = sc
  }
  const acceptance = readdirSync(new URL('acceptance/', dir)).filter((n) => n.endsWith('.json')).map((f) => json<DevAcceptance>(`acceptance/${f}`)).sort((a, b) => a.issue - b.issue)
  const saves: Record<string, unknown> = {}
  const fx = new URL('../tests/fixtures/', import.meta.url)
  for (const f of readdirSync(fx).filter((n) => /^save-v1-.+\.json$/.test(n))) saves[f.slice(0, -'.json'.length)] = JSON.parse(readFileSync(new URL(f, fx), 'utf8'))
  return { scenarios, beats: json<Record<string, DevBeat>>('beats.json'), teams: json<Record<string, DevTeam>>('teams.json'), acceptance, saves }
}
