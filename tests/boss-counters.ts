// Scripted counter strategies for the boss simulator: what a player who has read the hints does on top of the AI.
// Each entry is a policy (returns an action to override the AI, or null to let the AI choose), the items the player
// brought, and optionally a team that suits the boss.
import type { BattleAction, MoveDef } from '../src/shared/types.ts'
import { CONTENT, typeEffectiveness } from '../src/shared/content/index.ts'
import type { Helpers, SimOpts } from './boss-sim.ts'
import { pilot } from '../tools/balance/pilot.ts'

export type Counter = Pick<SimOpts, 'policy' | 'bag' | 'partyIds' | 'partyRole'>

const move = (h: Helpers, index: number): BattleAction => ({ kind: 'move', moveIndex: index })

/** A damaging move of the active creature chosen by `better(a, b)` (true when a is preferred); null when none is left. */
const pickAttack = (h: Helpers, ok: (m: MoveDef) => boolean = () => true): BattleAction | null => {
  const a = h.attacks().find((x) => ok(x.move))
  return a ? move(h, a.index) : null
}

const countryOf = (h: Helpers, idx: number): string => CONTENT.species[h.engine.party(0)[idx].speciesId]?.country ?? ''

/** An attack passing `ok`; failing that, a switch to a healthy teammate who has one; else null (the pilot decides). */
const attackOrSwitch = (h: Helpers, ok: (m: MoveDef) => boolean): BattleAction | null => {
  const hit = pickAttack(h, ok)
  if (hit) return hit
  const party = h.engine.party(0)
  const has = (cr: (typeof party)[number]) => cr.hp > 0 && cr.moves.some((s) => s.pp > 0 && CONTENT.moves[s.id]?.power > 0 && ok(CONTENT.moves[s.id]))
  const i = party.findIndex((cr, idx) => idx !== h.engine.activeIndex(0) && has(cr))
  return h.req.canSwitch && i >= 0 ? { kind: 'switch', partyIndex: i } : null
}

/** The pilot's play (heals, switches, status moves ...), except that a damaging move failing `ok` becomes an `ok` attack or a switch to a teammate who has one. */
const pilotAttacks = (h: Helpers, ok: (m: MoveDef) => boolean): BattleAction | null => {
  const a = pilot(h.engine, 0, h.rng)
  const m = a.kind === 'move' ? CONTENT.moves[h.active.moves[a.moveIndex]?.id] : undefined
  return m && m.power > 0 && !ok(m) ? (attackOrSwitch(h, ok) ?? a) : a
}

/** The balance pilot's own choice, except where `no` rejects it: then the best attack that is allowed (or the pilot's choice if there is none). */
const pilotExcept = (h: Helpers, no: (a: BattleAction, m: MoveDef | undefined) => boolean): BattleAction | null => {
  const a = pilot(h.engine, 0, h.rng)
  const m = a.kind === 'move' ? CONTENT.moves[h.active.moves[a.moveIndex]?.id] : undefined
  return no(a, m) ? (pickAttack(h, (x) => !no({ kind: 'move', moveIndex: 0 }, x)) ?? a) : a
}


/**
 * What an unaware player does on top of the shared AI (the balance pilot never uses items, a real player does): the
 * baseline "plain" runs of bosses whose counter is about an everyday habit (none at the moment).
 */
export const PLAIN: Record<string, Pick<SimOpts, 'policy'>> = {}

export const COUNTERS: Record<string, Counter> = {
  // Test it with the pelican while it is sauced (the tell is the "too fast" line); once it has the pelican in its samples, test with the bike.
  astra: {
    bag: { 'pelican-test': 5, 'bike-pelican': 5 },
    policy: (h) => (h.state.form === 'base' && h.state.meters.juice >= 1 ? h.bait((h.state.fired.library ?? 0) >= 1 ? 'bike-pelican' : 'pelican-test') : null),
  },

  // The coupon turns the peak hours it announces into valley pricing; nothing else is needed.
  deepseek: { bag: { 'off-peak-coupon': 6 }, policy: (h) => (h.state.meters.tide === 0 && h.state.meters.grace === 0 ? h.bait('off-peak-coupon') : null) },

  // Flood the context window whenever it is nearly empty; strike while it is crashed.
  kimi: { bag: { 'long-document': 6 }, policy: (h) => (h.state.form === 'base' && h.state.meters.context <= 3 ? h.bait('long-document') : null) },

  // Hit with moves of the types the boss has not memorised; blow the holdout set when it is back to bench form.
  minimax: {
    bag: { 'holdout-set': 3 },
    policy: (h) => {
      if (h.state.form === 'bench') {
        const item = h.bait('holdout-set')
        if (item) return item
        return pickAttack(h, (m) => !['logic', 'code', 'chat', 'search', 'write', 'compute'].includes(m.type))
      }
      return null
    },
  },

  // Switch out as soon as the boss has copied something.
  qwen: {
    policy: (h) => {
      if (h.state.borrowed.length === 0) return null
      const party = h.engine.party(0)
      const i = party.findIndex((cr, idx) => idx !== h.engine.activeIndex(0) && cr.hp > 0)
      return h.req.canSwitch && i >= 0 ? { kind: 'switch', partyIndex: i } : null
    },
  },

  // Post complaints (letters, then hot takes) until it apologises.
  cursor: {
    bag: { 'complaint-letter': 4 },
    policy: (h) => (h.state.form === 'metered' && h.state.meters.outrage < 3 ? h.bait('complaint-letter') : null),
  },

  // The .map file as soon as the cover is up: no pets, and it takes double for a while.
  'claude-code': { bag: { 'source-map': 5 }, policy: (h) => (h.state.form === 'undercover' ? h.bait('source-map') : null) },

  // Patch the sandbox before it gives; the alignment moves the AI happens to pick help on top.
  mythos: { bag: { 'sandbox-patch': 4 }, policy: (h) => (h.state.form === 'sealed' && h.state.meters.escape >= 5 ? h.bait('sandbox-patch') : null) },

  // Never repeat the previous type: every damaging move changes the type it has just read.
  alpha: { policy: (h) => pickAttack(h, (m) => m.type !== h.state.lastFoeType) },

  // A residential IP as soon as the risk control has noticed the active creature (or it is from CN and still unflagged).
  opus: {
    bag: { 'residential-ip': 6 },
    policy: (h) => (h.state.meters.ip === 0 && (h.state.meters.risk >= 1 || h.active.status !== null || CONTENT.species[h.active.speciesId]?.country === 'CN') ? h.bait('residential-ip') : null),
  },

  // Feed the sauce as soon as it is available.
  chatgpt: { bag: { 'special-sauce': 3 }, policy: (h) => (h.state.form === 'base' ? h.bait('special-sauce') : null) },

  // A banana peel under its feet whenever it stands.
  unitree: { bag: { 'banana-peel': 6 }, policy: (h) => (h.state.form === 'upright' ? h.bait('banana-peel') : null) },

  // Pull the plug whenever the network is up: a blackout cuts its uploads.
  grok: { bag: { 'ethernet-cable': 6 }, policy: (h) => (h.engine.weather !== 'blackout' ? h.bait('ethernet-cable') : null) },

  // Revoke the key while the malicious skill is loading (the warning turn); never earlier or later.
  openclaw: { bag: { 'revoke-key': 4 }, policy: (h) => (h.state.meters.inject >= 1 ? h.bait('revoke-key') : null) },

  // Feed it small rocks; it follows its own advice.
  gemini: { bag: { 'small-rock': 4 }, policy: (h) => (h.state.form === 'grounded' || h.state.formTurn >= 4 ? h.bait('small-rock') : null) },

  // Hand it invite codes: it pays out red packets until its subsidy budget is gone.
  doubao: { bag: { 'invite-code': 5 }, policy: (h) => (h.state.form === 'subsidy' ? h.bait('invite-code') : null) },

  // Hold it to its word: the pledge as soon as eggs have been taken (or are about to be), never when it is already in force.
  glm: { bag: { 'no-upload-pledge': 5 }, policy: (h) => (h.state.form === 'open' && h.state.meters.pledge === 0 && h.state.meters.backup >= 1 ? h.bait('no-upload-pledge') : null) },

  // Read the cameo's weak types from the HUD and hit with them (a team that covers all ten of them, so there is always a fitting member).
  seedance: {
    partyIds: ['claude-sonnet-5', 'gemini-3-1-pro', 'manus-2', 'deepseek-app', 'pi-zero', 'claude-mythos-preview'],
    partyRole: 'balanced',
    policy: (h) => {
      const weak = CONTENT.bosses.seedance.forms[h.state.form]?.rules?.[0]?.takenMul?.[0]?.moveTypes ?? []
      return pilotAttacks(h, (m) => weak.includes(m.type))
    },
  },
}
