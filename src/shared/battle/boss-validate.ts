// Reference checks for content/bosses.json. Called from validateContent() (src/shared/content/index.ts); imports only
// types so there is no import cycle. Returns human-readable problems (empty = consistent).
import type { BossCond, BossDef, BossOp } from '../types.ts'
import type { Content } from '../content/index.ts'

const BORROWED = '$borrowed'
const TEXT_PREFIX = 'boss.'

/** The coach bar shows one short line. */
export const COACH_MAX_CHARS = 24

export function validateBosses(list: readonly BossDef[], c: Content): string[] {
  const errs: string[] = []
  const seen = new Set<string>()
  const baitTags = new Set(c.itemList.flatMap((it) => (it.effect.kind === 'bait' ? [it.effect.tag] : [])))

  for (const b of list) {
    const w = `boss ${b.id}`
    if (seen.has(b.id)) errs.push(`${w}: duplicate id`)
    seen.add(b.id)
    if (!c.species[b.species]) errs.push(`${w}: unknown species "${b.species}"`)
    if (!(b.level >= 1 && b.level <= c.config.party.maxLevel)) errs.push(`${w}: level out of range`)
    if (!b.forms[b.initialForm]) errs.push(`${w}: initialForm "${b.initialForm}" missing`)
    const text = (where: string, key: string | undefined) => {
      if (key === undefined) return
      if (!key.startsWith(TEXT_PREFIX)) errs.push(`${where}: "${key.slice(0, 24)}" is raw text — use a boss.* text key`)
      else if (!(key in c.text)) errs.push(`${where}: missing text "${key}"`)
    }
    text(`${w}.title`, b.title)
    text(`${w}.hint.seen`, b.hint.seen)
    text(`${w}.hint.won`, b.hint.won)
    b.taunt.forEach((k, i) => text(`${w}.taunt[${i}]`, k))
    b.gossip.forEach((k, i) => text(`${w}.gossip[${i}]`, k))
    if (b.gossip.length === 0) errs.push(`${w}: needs at least one gossip line (NPC rumour)`)
    if (!(b.expMul > 0)) errs.push(`${w}: expMul must be > 0`)
    if (!(b.catchRateMul > 0)) errs.push(`${w}: catchRateMul must be > 0`)
    for (const id of Object.keys(b.reward.items ?? {})) if (!c.items[id]) errs.push(`${w}.reward: unknown item "${id}"`)

    if (b.coach) {
      const k = b.coach
      if (!(k.speaker in c.text)) errs.push(`${w}.coach: missing text "${k.speaker}"`)
      if (k.portrait?.startsWith('creature:') && !c.species[k.portrait.slice(9)]) errs.push(`${w}.coach: unknown portrait "${k.portrait}"`)
      if (!(k.maxPerFight >= 1)) errs.push(`${w}.coach: maxPerFight must be >= 1`)
      const lines = new Set(b.triggers.flatMap((tr) => tr.do.filter((o) => o.op === 'coach').map((o) => (o as { text: string }).text.slice((o as { text: string }).text.lastIndexOf('.') + 1))))
      for (const n of k.skipBriefLines ?? []) if (!lines.has(n)) errs.push(`${w}.coach: skipBriefLines "${n}" is no coach line`)
      for (const [sp, suf] of Object.entries(k.variants ?? {})) if (!c.species[sp] || !suf) errs.push(`${w}.coach.variants: bad entry "${sp}"`)
      for (const tr of b.triggers) for (const o of tr.do) if (o.op === 'coach') {
        for (const key of [o.text, ...Object.values(k.variants ?? {}).map((suf) => `${o.text}${suf}`).filter((v) => v in c.text)]) if (!(key in c.text)) errs.push(`${w}.coach: missing text "${key}"`)
        // The coach bar is one line: at most 24 characters once the placeholders are gone.
        for (const key of [o.text, ...Object.values(k.variants ?? {}).map((suf) => `${o.text}${suf}`)]) {
          const v = c.text[key]
          if (v !== undefined && Array.from(v.replace(/\{[^}]*\}/g, '')).length > COACH_MAX_CHARS) errs.push(`${w}.coach: "${key}" is longer than ${COACH_MAX_CHARS} characters`)
        }
      }
    }

    const meters = new Set<string>()
    for (const m of b.meters) {
      if (meters.has(m.id)) errs.push(`${w}: duplicate meter "${m.id}"`)
      meters.add(m.id)
      text(`${w}.meter.${m.id}`, m.label)
      if (!(m.max >= 1)) errs.push(`${w}.meter.${m.id}: max must be >= 1`)
      m.states?.forEach((k) => text(`${w}.meter.${m.id}.states`, k))
      if (m.states && m.states.length !== m.max + 1) errs.push(`${w}.meter.${m.id}: states needs ${m.max + 1} entries`)
    }

    const triggerIds = new Set(b.triggers.map((tr) => tr.id))
    if (triggerIds.size !== b.triggers.length) errs.push(`${w}: duplicate trigger id`)

    const cond = (where: string, k: BossCond | undefined) => {
      if (!k) return
      for (const f of [...(k.form ?? []), ...(k.notForm ?? [])]) if (!b.forms[f]) errs.push(`${where}: unknown form "${f}"`)
      for (const p of [k.phase, k.notPhase]) if (p !== undefined && !triggerIds.has(p)) errs.push(`${where}: unknown phase "${p}"`)
      if (k.meter && !meters.has(k.meter.id)) errs.push(`${where}: unknown meter "${k.meter.id}"`)
      if (k.turnCycle && !(k.turnCycle.period >= 1 && k.turnCycle.from >= 0 && k.turnCycle.to > k.turnCycle.from)) errs.push(`${where}: bad turnCycle`)
      if (typeof k.foeStatus === 'string' && !c.statusById[k.foeStatus]) errs.push(`${where}: unknown status "${k.foeStatus}"`)
      for (const wid of [...(k.weather ?? []), ...(k.notWeather ?? [])]) if (wid !== 'none' && !c.weatherById[wid]) errs.push(`${where}: unknown weather "${wid}"`)
      for (const d of [k.foeReleasedBefore, k.foeReleasedFrom]) if (d !== undefined && !/^\d{4}-\d{2}(-\d{2})?$/.test(d)) errs.push(`${where}: release date needs YYYY-MM[-DD]`)
    }
    const type = (where: string, ids: readonly string[] | undefined) => {
      for (const t of ids ?? []) if (!c.typeById[t]) errs.push(`${where}: unknown type "${t}"`)
    }
    const move = (where: string, id: string) => { if (!c.moves[id]) errs.push(`${where}: unknown move "${id}"`) }
    const op = (where: string, o: BossOp) => {
      switch (o.op) {
        case 'say': text(where, o.text); break
        case 'coach': text(where, o.text); if (!b.coach) errs.push(`${where}: a coach op needs the boss's coach block`); break
        case 'form': if (!b.forms[o.form]) errs.push(`${where}: unknown form "${o.form}"`); break
        case 'status': if (!c.statusById[o.status]) errs.push(`${where}: unknown status "${o.status}"`); break
        case 'volatile': if (!c.volatileById[o.volatile]) errs.push(`${where}: unknown volatile "${o.volatile}"`); break
        case 'meter': if (!meters.has(o.id)) errs.push(`${where}: unknown meter "${o.id}"`); break
        case 'charge': move(where, o.move); text(where, o.warn); break
        case 'learn': text(where, o.say); break
        case 'weather': if (o.weather !== 'none' && !c.weatherById[o.weather]) errs.push(`${where}: unknown weather "${o.weather}"`); break
        default: break
      }
    }

    for (const [fid, f] of Object.entries(b.forms)) {
      const fw = `${w}.form.${fid}`
      if (!c.species[f.species]) errs.push(`${fw}: unknown species "${f.species}"`)
      if (f.ability !== undefined && !c.abilities[f.ability]) errs.push(`${fw}: unknown ability "${f.ability}"`)
      if (f.moves.length < 1 || f.moves.length > c.config.party.maxMoves) errs.push(`${fw}: needs 1..${c.config.party.maxMoves} moves`)
      f.moves.forEach((m) => move(fw, m))
      text(`${fw}.banner`, f.banner)
      if (!f.pattern.length) errs.push(`${fw}: empty pattern`)
      for (const p of f.pattern) {
        if (p.move !== BORROWED && !f.moves.includes(p.move)) errs.push(`${fw}.pattern: "${p.move}" is not one of the form's moves`)
        if (!(p.weight > 0)) errs.push(`${fw}.pattern: weight must be > 0`)
        cond(`${fw}.pattern`, p.if)
      }
      const rids = new Set<string>()
      for (const r of f.rules ?? []) {
        if (rids.has(r.id)) errs.push(`${fw}: duplicate rule "${r.id}"`)
        rids.add(r.id)
        cond(`${fw}.rule.${r.id}`, r.if)
        for (const e of r.takenMul ?? []) {
          type(`${fw}.rule.${r.id}`, e.moveTypes)
          type(`${fw}.rule.${r.id}`, e.notMoveTypes)
          text(`${fw}.rule.${r.id}.note`, e.note)
        }
        if (r.hitCap !== undefined && !(r.hitCap > 0 && r.hitCap <= 1)) errs.push(`${fw}.rule.${r.id}: hitCap must be in (0,1]`)
        if (r.extraAction && !(r.extraAction.every >= 1)) errs.push(`${fw}.rule.${r.id}: extraAction.every must be >= 1`)
      }
    }

    for (const tr of b.triggers) {
      const tw = `${w}.trigger.${tr.id}`
      cond(tw, tr.if)
      type(tw, tr.moveTypes)
      tr.moves?.forEach((m) => move(tw, m))
      const ons = Array.isArray(tr.on) ? tr.on : [tr.on]
      if (ons.includes('foeItem')) {
        if (tr.tag === undefined) errs.push(`${tw}: foeItem trigger needs a bait tag`)
        else if (!baitTags.has(tr.tag)) errs.push(`${tw}: no bait item provides tag "${tr.tag}"`)
      }
      if (tr.chance !== undefined && !(tr.chance > 0 && tr.chance < 1)) errs.push(`${tw}: chance must be in (0,1)`)
      for (const o of tr.do) op(tw, o)
    }
    for (const g of b.gates) {
      if (!triggerIds.has(g.phase)) errs.push(`${w}.gates: unknown phase "${g.phase}"`)
      if (!(g.floor > 0 && g.floor < 1)) errs.push(`${w}.gates: floor must be in (0,1)`)
    }
    if (b.enrage) {
      for (const k of [b.enrage.warn, b.enrage.start, b.enrage.tick]) text(`${w}.enrage`, k)
      if (!(b.enrage.turn >= 1 && b.enrage.max >= 1)) errs.push(`${w}.enrage: turn and max must be >= 1`)
    }

    if (b.signature) {
      if (b.signature.ability !== undefined && !c.abilities[b.signature.ability]) errs.push(`${w}.signature: unknown ability "${b.signature.ability}"`)
      if (b.signature.move !== undefined) move(`${w}.signature`, b.signature.move)
    }
    if (b.tiers) {
      const base = b.forms[b.initialForm]
      const ruleIds = new Set((base?.rules ?? []).map((r) => r.id))
      text(`${w}.contract`, `${TEXT_PREFIX}${b.id}.contract`)
      for (const [tid, tier] of Object.entries(b.tiers)) {
        const tw = `${w}.tier.${tid}`
        text(tw, `${TEXT_PREFIX}${b.id}.tier.${tid}`)
        if (!(tier.level >= 1 && tier.level <= c.config.party.maxLevel)) errs.push(`${tw}: level out of range`)
        const layers: [string, Omit<typeof tier, 'level' | 'byStarter' | 'assist'>][] = [[tw, tier]]
        for (const [sid, l] of Object.entries(tier.byStarter ?? {})) {
          if (!c.species[sid]) errs.push(`${tw}.byStarter: unknown species "${sid}"`)
          layers.push([`${tw}.byStarter.${sid}`, l])
        }
        if (tier.assist) {
          layers.push([`${tw}.assist`, tier.assist])
          for (const [sid, l] of Object.entries(tier.assist.byStarter ?? {})) {
            if (!c.species[sid]) errs.push(`${tw}.assist.byStarter: unknown species "${sid}"`)
            layers.push([`${tw}.assist.byStarter.${sid}`, l])
          }
        }
        for (const [lw, l] of layers) {
          if (l.expMul !== undefined && !(l.expMul > 0)) errs.push(`${lw}: expMul must be > 0`)
          if (l.residualMul !== undefined && !(l.residualMul > 0)) errs.push(`${lw}: residualMul must be > 0`)
          for (const [k, v] of Object.entries(l.statMul ?? {})) if (!(v > 0)) errs.push(`${lw}.statMul.${k}: must be > 0`)
          for (const id of Object.keys(l.rules ?? {})) if (!ruleIds.has(id)) errs.push(`${lw}.rules: unknown rule "${id}"`)
          for (const [id, r] of Object.entries(l.rules ?? {})) {
            if (r.dealtMul !== undefined && !(r.dealtMul > 0)) errs.push(`${lw}.rules.${id}: dealtMul must be > 0`)
            if (r.takenMul !== undefined && !(r.takenMul > 0)) errs.push(`${lw}.rules.${id}: takenMul must be > 0`)
          }
          for (const r of l.addRules ?? []) {
            if (ruleIds.has(r.id)) errs.push(`${lw}.addRules: rule "${r.id}" already exists on the form`)
            cond(`${lw}.addRules.${r.id}`, r.if)
            if (r.if?.foeCompany && !r.if.foeCompany.length) errs.push(`${lw}.addRules.${r.id}: foeCompany is empty`)
            for (const e of r.takenMul ?? []) text(`${lw}.addRules.${r.id}.note`, e.note)
          }
          l.moves?.forEach((m) => move(lw, m))
          if (l.moves && (l.moves.length < 1 || l.moves.length > c.config.party.maxMoves)) errs.push(`${lw}: needs 1..${c.config.party.maxMoves} moves`)
          for (const p of l.pattern ?? []) {
            if (!(l.moves ?? tier.moves ?? base?.moves ?? []).includes(p.move)) errs.push(`${lw}.pattern: "${p.move}" is not one of the tier's moves`)
            if (!(p.weight > 0)) errs.push(`${lw}.pattern: weight must be > 0`)
          }
        }
      }
    }
  }
  return errs
}
