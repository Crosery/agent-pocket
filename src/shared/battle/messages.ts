// Viewer-aware battle messages and the side-1 perspective transform.
// Engine events are absolute (side 0 = the local player). A message whose wording depends on the viewer
// ("对手的 X" vs "X") is rendered for both viewers; the side-1 text is kept off the event object so it never
// leaks into serialisation and is swapped in by perspective().
import type { BattleEvent, BattleResult, SideIndex } from '../types.ts'

export type Render = (viewer: SideIndex) => string

const SIDE1_TEXT = new WeakMap<BattleEvent, string>()

export function msgEvent(render: Render): BattleEvent {
  const text = render(0)
  const e: BattleEvent = { t: 'msg', text }
  const alt = render(1)
  if (alt !== text) SIDE1_TEXT.set(e, alt)
  return e
}

/** '{key}' placeholder substitution for templates stored inside content records (e.g. WeatherDef texts). */
export function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
}

const FLIPPED_RESULT: Partial<Record<BattleResult, BattleResult>> = { win: 'lose', lose: 'win' }
/** Events describing side 0's own party progression; meaningless to the other viewer. */
const SIDE0_PRIVATE: ReadonlySet<BattleEvent['t']> = new Set<BattleEvent['t']>(['exp', 'levelUp', 'learnMove', 'moveLearnable', 'evolveReady', 'money', 'loot'])

const other = (s: SideIndex): SideIndex => (s === 0 ? 1 : 0)

/** Re-express absolute events so that `side` becomes side 0. */
export function perspective(events: readonly BattleEvent[], side: SideIndex): BattleEvent[] {
  if (side === 0) return events.slice()
  const out: BattleEvent[] = []
  for (const e of events) {
    if (SIDE0_PRIVATE.has(e.t)) continue
    if (e.t === 'msg') out.push({ t: 'msg', text: SIDE1_TEXT.get(e) ?? e.text })
    else if (e.t === 'end') out.push({ t: 'end', result: FLIPPED_RESULT[e.result] ?? e.result, winner: e.winner === -1 ? -1 : other(e.winner) })
    else if ('side' in e) out.push({ ...e, side: other(e.side) } as BattleEvent)
    else out.push(e)
  }
  return out
}
