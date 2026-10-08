// Reference checks for the gameplay content (rarity behaviour, content/events/**, content/research.json).
// Called from validateContent() (src/shared/content/index.ts) — imports only types and world JSON, never CONTENT,
// so there is no import cycle. Returns human-readable problems (empty = consistent).
import type { EventCondition, EventEffect, ScriptStep, SpeciesPick, WorldEventDef } from '../types.ts'
import type { Content } from '../content/index.ts'
import type { GameplayData } from './schema.ts'
import townsJson from '../../../content/world/towns.json' with { type: 'json' }
import poisJson from '../../../content/world/pois.json' with { type: 'json' }

/** Schema literals (mirror the types.ts unions — structure, not data). */
const FIELD_WEATHERS = ['clear', 'rain', 'snow', 'sand', 'fog', 'aurora', 'ash']
const SPAWN_KINDS = ['grass', 'visible', 'event', 'legend']
const SCOPES = ['global', 'region', 'local']
const TRIGGERS = ['auto', 'script', 'legend']
const MODIFIER_TARGETS = ['shopPrice', 'money', 'exp', 'catchRate', 'shiny', 'encounterRate', 'fleeChance', 'friendship']
const PATTERNS = ['orbit', 'wander', 'tide', 'blink']
const TASK_KINDS = [
  'see', 'catch', 'defeat', 'evolve', 'catchShiny', 'catchAtTime', 'catchInWeather', 'useMoveType', 'befriend', 'trade',
  'seeAtTime', 'seeInWeather', 'catchInBiome', 'defeatRoaming', 'chainStep',
]
const FLAG_RE = /^[A-Za-z0-9_.:-]+$/
/** Placeholders allowed inside flag names (expanded at runtime by events.expandFlag). */
const FLAG_VARS = /\{(?:year|day)\}/g
const DATE_RE = /^(?:\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const NEAREST = 'nearest:'
const TEXT_NS = ['events.', 'research.']

export function validateGameplay(g: GameplayData, c: Content): string[] {
  const errs: string[] = []
  const towns = new Set((townsJson as unknown as { id: string }[]).map((x) => x.id))
  const templates = new Set(Object.keys((poisJson as unknown as { templates: Record<string, unknown> }).templates))
  const times = new Set(c.config.time.phases.map((p) => p.id))
  const rarities = new Set(c.rarities.map((r) => r.id))
  const bgm = new Set(c.audio.bgm.map((x) => x.id))
  const knownCue = (group: string, cue: string) => (group === 'music' ? bgm.has(cue) : (g.spawn.cues[group] ?? []).includes(cue))
  const research = new Set(g.research.tasks.map((x) => x.id))

  const text = (where: string, key: string | undefined) => {
    if (key === undefined) return
    if (!TEXT_NS.some((ns) => key.startsWith(ns))) errs.push(`${where}: "${key.slice(0, 24)}" is raw text — use an events.*/research.* text key`)
    else if (!(key in c.text)) errs.push(`${where}: missing text "${key}"`)
  }
  const flag = (where: string, f: string) => { if (!FLAG_RE.test(f.replace(FLAG_VARS, 'x'))) errs.push(`${where}: malformed flag "${f}"`) }
  const species = (where: string, id: string | undefined) => { if (id !== undefined && !c.species[id]) errs.push(`${where}: unknown species "${id}"`) }
  const item = (where: string, id: string) => { if (!c.items[id]) errs.push(`${where}: unknown item "${id}"`) }
  const type = (where: string, id: string) => { if (!c.typeById[id]) errs.push(`${where}: unknown type "${id}"`) }
  const rarity = (where: string, id: string) => { if (!rarities.has(id)) errs.push(`${where}: unknown rarity "${id}"`) }
  const weather = (where: string, w: string) => { if (!FIELD_WEATHERS.includes(w)) errs.push(`${where}: unknown field weather "${w}"`) }
  const time = (where: string, tod: string) => { if (!times.has(tod as never)) errs.push(`${where}: unknown time of day "${tod}"`) }
  const event = (where: string, id: string) => { if (!g.eventById[id]) errs.push(`${where}: unknown event "${id}"`) }
  const placeRef = (where: string, ref: string) => {
    const tpl = ref.startsWith(NEAREST) ? ref.slice(NEAREST.length) : null
    if (tpl !== null ? !templates.has(tpl) : !towns.has(ref)) errs.push(`${where}: unknown place ref "${ref}"`)
  }
  const pick = (where: string, p: SpeciesPick) => {
    p.types?.forEach((x) => type(where, x))
    p.rarities?.forEach((x) => rarity(where, x))
  }
  const range = (where: string, v: [number, number] | undefined, lo: number, hi: number) => {
    if (v && (v.length !== 2 || v.some((x) => !Number.isFinite(x) || x < lo || x > hi))) errs.push(`${where}: range ${JSON.stringify(v)} outside [${lo},${hi}]`)
  }

  const cond = (where: string, w: EventCondition) => {
    w.timeOfDay?.forEach((x) => time(where, x))
    range(`${where}.hourRange`, w.hourRange, 0, 24)
    range(`${where}.minuteRange`, w.minuteRange, 0, 1440)
    range(`${where}.realHourRange`, w.realHourRange, 0, 24)
    w.dayOfWeek?.forEach((d) => { if (!Number.isInteger(d) || d < 0 || d > 6) errs.push(`${where}: bad weekday ${d}`) })
    if (w.realDate && ((w.realDate.month ?? 1) < 1 || (w.realDate.month ?? 1) > 12 || (w.realDate.day ?? 1) < 1 || (w.realDate.day ?? 1) > 31)) errs.push(`${where}: bad realDate`)
    w.realDateRanges?.forEach((r) => { if (!DATE_RE.test(r.from) || !(r.days >= 1)) errs.push(`${where}: bad realDateRange ${JSON.stringify(r)}`) })
    w.weather?.forEach((x) => weather(where, x))
    w.biomes?.forEach((b) => { if (!c.biomeById[b]) errs.push(`${where}: unknown biome "${b}"`) })
    Object.keys(w.flags ?? {}).forEach((f) => flag(where, f))
    if (w.partyHasType) type(where, w.partyHasType)
    species(where, w.partyHasSpecies)
    species(where, w.leadSpecies)
    if (w.partyHasRarity) rarity(where, w.partyHasRarity)
    if (w.hasItem) item(where, w.hasItem)
    w.caught?.forEach((x) => species(where, x))
    w.notCaught?.forEach((x) => species(where, x))
    w.eventsActive?.forEach((x) => event(where, x))
    w.eventsDone?.forEach((x) => event(where, x))
    w.nearPlace?.forEach((p) => { if (!templates.has(p) && !towns.has(p)) errs.push(`${where}: unknown nearPlace "${p}"`) })
    if (w.chancePerCheck !== undefined && !(w.chancePerCheck >= 0 && w.chancePerCheck <= 1)) errs.push(`${where}: chancePerCheck out of [0,1]`)
    w.anyOf?.forEach((sub, i) => cond(`${where}.anyOf[${i}]`, sub))
  }

  const steps = (where: string, list: readonly ScriptStep[]) => {
    list.forEach((s, i) => {
      const at = `${where}[${i}]`
      switch (s.op) {
        case 'say': text(at, s.text); if (s.speaker) text(at, s.speaker); break
        case 'choice':
          text(at, s.text); s.options.forEach((o) => text(at, o))
          if (s.branches.length !== s.options.length) errs.push(`${at}: choice needs one branch per option`)
          s.branches.forEach((b, k) => steps(`${at}.b${k}`, b))
          break
        case 'setFlag': flag(at, s.flag); break
        case 'ifFlag': flag(at, s.flag); steps(at, s.then); steps(at, s.else ?? []); break
        case 'ifBadges': case 'ifDex': steps(at, s.then); steps(at, s.else ?? []); break
        case 'ifItem': item(at, s.item); steps(at, s.then); steps(at, s.else ?? []); break
        case 'ifCaught': species(at, s.species); if (s.type) type(at, s.type); steps(at, s.then); steps(at, s.else ?? []); break
        case 'random':
          if (!(s.chance >= 0 && s.chance <= 1)) errs.push(`${at}: random chance out of [0,1]`)
          steps(at, s.then); steps(at, s.else ?? []); break
        case 'ifTime': s.times.forEach((x) => time(at, x)); steps(at, s.then); steps(at, s.else ?? []); break
        case 'ifWeather': s.weather.forEach((x) => weather(at, x)); steps(at, s.then); steps(at, s.else ?? []); break
        case 'giveItem': case 'takeItem': item(at, s.item); break
        case 'giveCreature': case 'wildBattle':
          if (!s.species && !s.pick) errs.push(`${at}: needs species or pick`)
          species(at, s.species); if (s.pick) pick(at, s.pick)
          if (s.op === 'wildBattle' && s.music && !bgm.has(s.music)) errs.push(`${at}: unknown bgm "${s.music}"`)
          break
        case 'triggerEvent': event(at, s.event); break
        case 'revealPlace': placeRef(at, s.place); break
        case 'research':
          species(at, s.species)
          if (!research.has(s.task)) errs.push(`${at}: unknown research task "${s.task}"`)
          break
        case 'shop': s.items.forEach((x) => item(at, x)); break
        case 'sfx': if (!c.audio.sfx.includes(s.id)) errs.push(`${at}: unknown sfx "${s.id}"`); break
        case 'bgm': if (!bgm.has(s.id)) errs.push(`${at}: unknown bgm "${s.id}"`); break
        case 'battle': errs.push(`${at}: story trainer battles are not allowed in events (use a 'trainer' effect)`); break
        default: break
      }
    })
  }

  const sprite = (where: string, id: string) => { if (!c.characterById[id]) errs.push(`${where}: unknown sprite "${id}"`) }
  const effect = (where: string, e: EventEffect) => {
    switch (e.kind) {
      case 'spawn':
        if (!e.species && !e.pick) errs.push(`${where}: spawn needs species or pick`)
        species(where, e.species); if (e.pick) pick(where, e.pick)
        if (!(e.count >= 1)) errs.push(`${where}: spawn count must be >= 1`)
        if (e.aura && !knownCue('aura', e.aura)) errs.push(`${where}: undeclared aura cue "${e.aura}"`)
        if (!e.levelFromArea && (e.level[0] < 1 || e.level[1] < e.level[0])) errs.push(`${where}: bad absolute level range`)
        break
      case 'weather': weather(where, e.weather); break
      case 'npc': sprite(where, e.npc.sprite); text(where, e.npc.nameZh); steps(`${where}.script`, e.npc.script); break
      case 'rumor': text(where, e.text); break
      case 'reveal': placeRef(where, e.place); break
      case 'script': steps(where, e.steps); break
      case 'encounterBoost':
        e.types?.forEach((x) => type(where, x)); e.rarities?.forEach((x) => rarity(where, x)); e.species?.forEach((x) => species(where, x))
        if (!(e.multiplier >= 0)) errs.push(`${where}: multiplier must be >= 0`)
        break
      case 'setFlag': flag(where, e.flag); break
      case 'modifier':
        if (!MODIFIER_TARGETS.includes(e.target)) errs.push(`${where}: unknown modifier target "${e.target}"`)
        e.types?.forEach((x) => type(where, x))
        if (!(e.multiplier >= 0)) errs.push(`${where}: multiplier must be >= 0`)
        break
      case 'ambience': if (!knownCue('ambience', e.cue)) errs.push(`${where}: undeclared ambience cue "${e.cue}"`); break
      case 'trainer':
        sprite(where, e.sprite); text(where, e.nameZh); text(where, e.classZh)
        e.introText.forEach((k) => text(where, k)); e.defeatText.forEach((k) => text(where, k))
        e.party.forEach((m) => { species(where, m.species); if (m.pick) pick(where, m.pick); if (!m.species && !m.pick) errs.push(`${where}: party entry needs species or pick`) })
        break
      case 'scatter': item(where, e.item); break
      default: errs.push(`${where}: unknown effect kind`)
    }
  }

  // ---- rarity behaviour
  for (const r of c.rarities) {
    const b = r.behavior
    const w = `rarity ${r.id}.behavior`
    if (!b) { errs.push(`${w}: missing`); continue }
    b.spawn.forEach((s) => { if (!SPAWN_KINDS.includes(s)) errs.push(`${w}: unknown spawn kind "${s}"`) })
    if (!(b.fleeChancePerTurn >= 0 && b.fleeChancePerTurn <= 1)) errs.push(`${w}: fleeChancePerTurn out of [0,1]`)
    if (b.lifeMinutes && b.lifeMinutes[1] < b.lifeMinutes[0]) errs.push(`${w}: lifeMinutes reversed`)
    for (const [k, cue] of Object.entries(b.cues ?? {})) if (cue && !knownCue(k, cue)) errs.push(`${w}: undeclared ${k} cue "${cue}"`)
    if (b.cue && !knownCue('aura', b.cue)) errs.push(`${w}: undeclared aura cue "${b.cue}"`)
  }

  // ---- events
  const seen = new Set<string>()
  for (const d of g.events) {
    const w = `event ${d.id}`
    if (seen.has(d.id)) errs.push(`${w}: duplicate id`)
    seen.add(d.id)
    text(w, d.nameZh); text(w, d.description); text(w, d.rumor)
    if (!SCOPES.includes(d.scope)) errs.push(`${w}: unknown scope "${d.scope}"`)
    if (d.trigger && !TRIGGERS.includes(d.trigger)) errs.push(`${w}: unknown trigger "${d.trigger}"`)
    if (!(d.durationMinutes >= 1)) errs.push(`${w}: durationMinutes must be >= 1`)
    if (!(d.cooldownDays >= 0)) errs.push(`${w}: cooldownDays must be >= 0`)
    cond(`${w}.when`, d.when)
    if (d.rumorWhen) cond(`${w}.rumorWhen`, d.rumorWhen)
    if (d.chain && !g.chainById[d.chain]) errs.push(`${w}: unknown chain "${d.chain}"`)
    if (d.legend && !g.legendBySpecies[d.legend]) errs.push(`${w}: unknown legend "${d.legend}"`)
    d.effects.forEach((e, i) => effect(`${w}.effects[${i}]`, e))
  }

  // ---- spawn rules
  const S = g.spawn
  for (const [tod, row] of Object.entries(S.typeAffinity.time)) { time('spawn.typeAffinity.time', tod); Object.keys(row ?? {}).forEach((x) => type(`spawn.typeAffinity.time.${tod}`, x)) }
  for (const [wx, row] of Object.entries(S.typeAffinity.weather)) { weather('spawn.typeAffinity.weather', wx); Object.keys(row ?? {}).forEach((x) => type(`spawn.typeAffinity.weather.${wx}`, x)) }
  for (const [ty, list] of Object.entries(S.typeConditions)) { type('spawn.typeConditions', ty); list.forEach((x, i) => cond(`spawn.typeConditions.${ty}[${i}]`, x)) }
  for (const [sp, list] of Object.entries(S.speciesConditions)) { species('spawn.speciesConditions', sp); list.forEach((x, i) => cond(`spawn.speciesConditions.${sp}[${i}]`, x)) }
  for (const t of c.types) if (!S.typeConditions[t.id]) errs.push(`spawn.typeConditions: type "${t.id}" has no conditions`)
  S.pickExcludeRarities.forEach((x) => rarity('spawn.pickExcludeRarities', x))
  const stances = ['neutral', 'chase', 'flee']
  const knownCountries = new Set(c.speciesList.map((x) => x.country))
  const stance = (w: string, v: { base: string; outleveled: string } | undefined) => {
    if (!v || !stances.includes(v.base) || !stances.includes(v.outleveled)) errs.push(`${w}: base/outleveled must be one of ${stances.join('/')}`)
  }
  stance('spawn.roamingPolicy.default', S.roamingPolicy?.default)
  for (const [code, v] of Object.entries(S.roamingPolicy?.countries ?? {})) {
    stance(`spawn.roamingPolicy.countries.${code}`, v)
    if (!knownCountries.has(code)) errs.push(`spawn.roamingPolicy.countries: no species has country "${code}"`)
  }
  const E = S.legends.bandEdges
  if (E[0] !== 0 || E.some((x, i) => i > 0 && x <= E[i - 1])) errs.push('spawn.legends.bandEdges must start at 0 and increase')
  if (!S.legends.levelByBand.length) errs.push('spawn.legends.levelByBand is empty')

  // ---- roaming legends
  const legendTier = new Set(c.rarities.filter((r) => r.behavior?.spawn.includes('legend')).map((r) => r.id))
  for (const l of g.legends) {
    const w = `legend ${l.species}`
    species(w, l.species)
    if (c.species[l.species] && !legendTier.has(c.species[l.species].rarity)) errs.push(`${w}: species tier has no 'legend' spawn`)
    if (!PATTERNS.includes(l.pattern)) errs.push(`${w}: unknown pattern "${l.pattern}"`)
    if (l.weather) weather(w, l.weather)
    l.biomes.forEach((b) => { if (!c.biomeById[b]) errs.push(`${w}: unknown biome "${b}"`) })
    for (const k of ['title', 'appear', 'rumor']) text(w, `events.legend.${l.species}.${k}`)
  }
  for (const s of c.speciesList) if (legendTier.has(s.rarity) && !g.legendBySpecies[s.id]) errs.push(`species ${s.id}: legend-tier species without a roaming legend`)

  // ---- mythic chains
  const chainTier = new Set(c.rarities.filter((r) => r.behavior && r.behavior.spawn.length === 1 && r.behavior.spawn[0] === 'event').map((r) => r.id))
  for (const ch of g.chains) {
    const w = `chain ${ch.id}`
    species(w, ch.species)
    flag(w, ch.doneFlag)
    cond(`${w}.requires`, ch.requires)
    if (ch.steps.length < 4) errs.push(`${w}: needs at least 4 steps`)
    ch.steps.forEach((s, i) => {
      const at = `${w}.steps[${i}]`
      event(at, s.event); flag(at, s.flag); text(at, s.clue)
      const ev = g.eventById[s.event]
      if (ev && ev.chain !== ch.id) errs.push(`${at}: event "${s.event}" is not tagged with chain "${ch.id}"`)
      if (ev && !setsFlag(ev, s.flag)) errs.push(`${at}: event "${s.event}" never sets "${s.flag}"`)
    })
    const last = g.eventById[ch.steps[ch.steps.length - 1]?.event ?? '']
    if (last && !setsFlag(last, ch.doneFlag)) errs.push(`${w}: final step never sets doneFlag "${ch.doneFlag}"`)
  }
  for (const s of c.speciesList) if (chainTier.has(s.rarity) && !g.chains.some((ch) => ch.species === s.id)) errs.push(`species ${s.id}: event-only species without a mythic chain`)

  // ---- research
  const R = g.research
  const tids = new Set<string>()
  for (const tk of R.tasks) {
    const w = `research task ${tk.id}`
    if (tids.has(tk.id)) errs.push(`${w}: duplicate id`)
    tids.add(tk.id)
    text(w, tk.nameZh)
    if (!TASK_KINDS.includes(tk.kind)) errs.push(`${w}: unknown kind "${tk.kind}"`)
    if (!tk.thresholds.length || tk.thresholds.some((x, i) => !(x > 0) || (i > 0 && x <= tk.thresholds[i - 1]))) errs.push(`${w}: thresholds must be positive and increasing`)
    if (!(tk.points >= 0)) errs.push(`${w}: points must be >= 0`)
  }
  for (const r of c.rarities) if (!R.byRarity[r.id]?.length) errs.push(`research.byRarity: rarity "${r.id}" has no tasks`)
  for (const [r, list] of Object.entries(R.byRarity)) { rarity('research.byRarity', r); list.forEach((x) => { if (!tids.has(x)) errs.push(`research.byRarity.${r}: unknown task "${x}"`) }) }
  R.levels.forEach((lv, i) => {
    if (i > 0 && !(lv.points > R.levels[i - 1].points)) errs.push(`research.levels[${i}]: points must increase`)
    for (const id of Object.keys(lv.reward?.items ?? {})) item(`research.levels[${i}]`, id)
  })
  return errs
}

function setsFlag(ev: WorldEventDef, f: string): boolean {
  const inSteps = (list: readonly ScriptStep[]): boolean => list.some((s) => {
    if (s.op === 'setFlag') return s.flag === f
    if (s.op === 'choice') return s.branches.some(inSteps)
    if ('then' in s) return inSteps(s.then) || inSteps(s.else ?? [])
    return false
  })
  return ev.effects.some((e) => (e.kind === 'setFlag' && e.flag === f) || (e.kind === 'script' && inSteps(e.steps)) || (e.kind === 'npc' && inSteps(e.npc.script)))
}
