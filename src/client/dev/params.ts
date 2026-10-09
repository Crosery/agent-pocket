// URL parameters of the developer mode. Everything but `dev` is ignored unless ?dev=1 is present.
//   &skipTitle=1                 start straight in the world (debug save: random party from content/game.json debug)
//   &slot=<n> &reset=1           save slot (two clients in one browser) / wipe that slot first
//   &map=<id>&x=<n>&y=<n>        start position          &t=<minutes>   clock (frozen per debug.freezeClockWithTime)
//   &weather=<kind>              force field weather     &evolve=1      evolution cutscene for the party lead
//   &battle=wild|trainer [&species=<id>&level=<n> | &trainer=<id>]
//   &battle=boss&boss=<bossId> [&level=<n>]   boss sandbox: sensible team + counter items, boss at its recommended level
//   &screen=party|bag|dex|box|map|quests|settings|shop
//   &seed=<n>                    world seed              &rng=<n>       master random seed (encounters, battles, scripts)
import type { FieldWeatherKind } from '../../shared/types.ts'
import { GAME } from '../world/config.ts'

export interface DebugParams {
  dev: boolean
  skipTitle: boolean
  slot: number
  reset: boolean
  map: string | null
  x: number | null
  y: number | null
  time: number | null
  weather: FieldWeatherKind | null
  battle: 'wild' | 'trainer' | 'boss' | null
  species: string | null
  boss: string | null
  level: number | null
  trainer: string | null
  screen: string | null
  evolve: boolean
  /** World seed (default: config.world.seed). */
  seed: number | null
  /** Master random seed for encounters, battles and scripts (default: random per session). */
  rng: number | null
}

export function readDebugParams(search: string): DebugParams {
  const q = new URLSearchParams(search)
  const dev = q.get('dev') === '1'
  const num = (k: string): number | null => {
    const v = q.get(k)
    if (v === null || v.trim() === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const seedParam = (k: string): number | null => {
    const n = num(k)
    return n !== null && Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : null
  }
  const flag = (k: string) => dev && q.get(k) === '1'
  const str = (k: string) => (dev ? q.get(k) : null)
  const weather = str('weather')
  const battle = str('battle')
  return {
    dev,
    skipTitle: flag('skipTitle'),
    slot: dev ? Math.max(0, Math.floor(num('slot') ?? 0)) : 0,
    reset: flag('reset'),
    map: str('map'),
    x: dev ? num('x') : null,
    y: dev ? num('y') : null,
    time: dev ? num('t') : null,
    // Field weather kinds the game tunes (content/game.json region.weatherIntensity).
    weather: weather && weather in GAME.region.weatherIntensity ? (weather as FieldWeatherKind) : null,
    battle: battle === 'wild' || battle === 'trainer' || battle === 'boss' ? battle : null,
    species: str('species'),
    boss: str('boss'),
    level: dev ? num('level') : null,
    trainer: str('trainer'),
    screen: str('screen'),
    evolve: flag('evolve'),
    seed: dev ? seedParam('seed') : null,
    rng: dev ? seedParam('rng') : null,
  }
}
