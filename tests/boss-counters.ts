// Scripted counter strategies for the boss simulator: what a player who has read the hints does on top of the AI.
// Each entry is a policy (returns an action to override the AI, or null to let the AI choose), the items the player
// brought, and optionally a team that suits the boss.
import type { BattleAction, MoveDef } from '../src/shared/types.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import type { Helpers, SimOpts } from './boss-sim.ts'

export type Counter = Pick<SimOpts, 'policy' | 'bag' | 'partyIds'>

const move = (h: Helpers, index: number): BattleAction => ({ kind: 'move', moveIndex: index })

/** A damaging move of the active creature chosen by `better(a, b)` (true when a is preferred); null when none is left. */
const pickAttack = (h: Helpers, ok: (m: MoveDef) => boolean = () => true): BattleAction | null => {
  const a = h.attacks().find((x) => ok(x.move))
  return a ? move(h, a.index) : null
}

const countryOf = (h: Helpers, idx: number): string => CONTENT.species[h.engine.party(0)[idx].speciesId]?.country ?? ''

export const COUNTERS: Record<string, Counter> = {
  // Feed the sauce as soon as it is available.
  astra: { bag: { 'special-sauce': 3 }, policy: (h) => (h.state.form === 'base' ? h.bait('special-sauce') : null) },

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

  // Keep the residential IP up: no risk score builds and the boss guesses wrong.
  'claude-code': { bag: { 'residential-ip': 4 }, policy: (h) => (h.state.meters.vpn <= 1 ? h.bait('residential-ip') : null) },

  // Patch the sandbox before it gives; the alignment moves the AI happens to pick help on top.
  mythos: { bag: { 'sandbox-patch': 4 }, policy: (h) => (h.state.form === 'sealed' && h.state.meters.escape >= 5 ? h.bait('sandbox-patch') : null) },

  // Never repeat the previous type; prefer types it has not seen.
  alpha: {
    policy: (h) => {
      const seen = new Set(h.state.seenTypes)
      return pickAttack(h, (m) => !seen.has(m.type) && m.type !== h.state.lastFoeType)
        ?? pickAttack(h, (m) => m.type !== h.state.lastFoeType)
    },
  },
}
