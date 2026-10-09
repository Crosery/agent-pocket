// Client side of one-for-one creature trades, plus the small multiplayer session state and waiting panel
// shared with pvp-channel.ts. Rules/timings: content/multiplayer.json (trade); texts: t('multiplayer.*').
// UI widgets are loaded lazily so the pure parts (applyTradeResult, offerability, IV stars) run under Node tests.
import type { EventBus, GameContext, GameEvents, Input, NetClient, UIPanel } from '../contracts.ts'
import type { ServerMsg } from '../../shared/protocol.ts'
import type { Creature, SaveData } from '../../shared/types.ts'
import { CONTENT, t, type Content } from '../../shared/content/index.ts'
import { STAT_KEYS, creatureName, newUid } from '../../shared/creature.ts'
import { gradeOf } from '../../shared/gameplay/quality.ts'
import { natureName } from '../ui/quality-text.ts'
import { Rng, hashString } from '../../shared/rng.ts'
import multiplayerJson from '../../../content/multiplayer.json' with { type: 'json' }
import netJson from '../../../content/net.json' with { type: 'json' }
import { UI_CONFIG } from '../ui/config.ts'

type ToastKind = 'info' | 'success' | 'warn' | 'error'
type TradeStart = Extract<ServerMsg, { t: 'trade.start' }>
type Widgets = typeof import('../ui/widgets.ts')

/** Client view of content/multiplayer.json → trade. */
export interface TradeRules {
  ivStars: number
  cardIconSize: number
  completeAnimMs: number
  completeHoldMs: number
  /** Trade window buttons, in display order. */
  buttons: TradeButton[]
  sfx: { incoming: string; offer: string; confirm: string; complete: string }
  /** Error codes that end an outgoing trade request. */
  requestAbortErrors: string[]
  /** Error codes reported while the trade window is open. */
  sessionErrors: string[]
}

export const TRADE_RULES: TradeRules = (multiplayerJson as unknown as { trade: TradeRules }).trade
const CLIENT_SLACK_SECONDS = (multiplayerJson as unknown as { pvp: { clientSlackSeconds: number } }).pvp.clientSlackSeconds
const REQUEST_SECONDS = (netJson as unknown as { server: { tradeRequestSeconds: number } }).server.tradeRequestSeconds

// ---------------------------------------------------------------------------
// Pure rules (Node-testable)
// ---------------------------------------------------------------------------

/** A creature may be offered only if the party keeps at least one other creature able to battle. */
export function canOffer(party: readonly Creature[], cr: Creature): boolean {
  return party.includes(cr) && party.some((o) => o !== cr && o.hp > 0)
}

export function offerableIndices(party: readonly Creature[]): number[] {
  return party.flatMap((cr, i) => (canOffer(party, cr) ? [i] : []))
}

/** IV quality as 0..stars (sum of IVs relative to the maximum). */
export function ivStars(cr: Pick<Creature, 'ivs'>, stars = TRADE_RULES.ivStars, c: Content = CONTENT): number {
  const max = STAT_KEYS.length * c.config.creature.ivMax
  const sum = STAT_KEYS.reduce((s, k) => s + (cr.ivs?.[k] ?? 0), 0)
  return max > 0 ? Math.max(0, Math.min(stars, Math.round((sum / max) * stars))) : 0
}

export interface TradeApplied {
  where: 'party' | 'box'
  index: number
  given: Creature | null
  newSeen: boolean
  newCaught: boolean
}

/**
 * Applies trade.complete to a save: the given creature leaves (party slot is reused so the party never
 * shrinks), the received one joins the party or the first box with room, dex and stats update.
 */
export function applyTradeResult(save: SaveData, givenUid: string, received: Creature, c: Content = CONTENT): TradeApplied {
  const cr: Creature = structuredClone(received)
  let given: Creature | null = null
  let where: TradeApplied['where'] | null = null
  let index = -1
  const pi = save.party.findIndex((x) => x.uid === givenUid)
  if (pi >= 0) {
    given = save.party[pi]
    save.party.splice(pi, 1)
  } else {
    for (const box of save.boxes) {
      const bi = box.findIndex((x) => x.uid === givenUid)
      if (bi >= 0) { given = box.splice(bi, 1)[0]; break }
    }
  }
  const owned = (uid: string) => save.party.some((x) => x.uid === uid) || save.boxes.some((b) => b.some((x) => x.uid === uid))
  if (owned(cr.uid)) cr.uid = newUid(new Rng(hashString(`${cr.uid}/${givenUid}/${save.playerId}`)))
  if (pi >= 0) {
    save.party.splice(pi, 0, cr)
    where = 'party'
    index = pi
  } else if (save.party.length < c.config.party.maxParty) {
    save.party.push(cr)
    where = 'party'
    index = save.party.length - 1
  } else {
    let bi = save.boxes.findIndex((b) => b.length < c.config.party.boxSize)
    // Storage completely full: overflow the last box rather than ever losing a creature.
    if (bi < 0) { if (!save.boxes.length) save.boxes.push([]); bi = save.boxes.length - 1 }
    save.boxes[bi].push(cr)
    where = 'box'
    index = bi
  }
  const newSeen = !save.dexSeen.includes(cr.speciesId)
  const newCaught = !save.dexCaught.includes(cr.speciesId)
  if (newSeen) save.dexSeen.push(cr.speciesId)
  if (newCaught) save.dexCaught.push(cr.speciesId)
  save.stats.trades += 1
  return { where, index, given, newSeen, newCaught }
}

// ---------------------------------------------------------------------------
// Shared multiplayer session state (per GameContext)
// ---------------------------------------------------------------------------

interface MpState {
  /** Active flows: 'trade', 'tradeRequest', 'tradeInvite', 'pvp', 'pvpRequest', 'pvpInvite'. */
  busy: Set<string>
  battleDepth: number
  /** Session promises by trade/battle id, so concurrent listeners open a session only once. */
  sessions: Map<string, Promise<void>>
  /** Peer of an invite we withdrew; a start racing with the withdrawal is cancelled. */
  withdrawn: Map<'trade' | 'pvp', { id: string; until: number }>
}

const STATES = new WeakMap<object, MpState>()

function stateOf(events: EventBus<GameEvents>): MpState {
  let st = STATES.get(events)
  if (!st) {
    const s: MpState = { busy: new Set(), battleDepth: 0, sessions: new Map(), withdrawn: new Map() }
    events.on('battle:start', () => { s.battleDepth++ })
    events.on('battle:end', () => { s.battleDepth = Math.max(0, s.battleDepth - 1) })
    STATES.set(events, s)
    st = s
  }
  return st
}

/** True while a battle, trade, pvp session or invite occupies the player (incoming invites are auto-declined). */
export function isMultiplayerBusy(ctx: Pick<GameContext, 'events'>): boolean {
  const st = stateOf(ctx.events)
  return st.busy.size > 0 || st.battleDepth > 0
}

export function setMultiplayerBusy(ctx: Pick<GameContext, 'events'>, key: string, on: boolean): void {
  const st = stateOf(ctx.events)
  if (on) st.busy.add(key)
  else st.busy.delete(key)
}

/** Remembers that we withdrew an invite to `peerId`, so a start message racing with it gets cancelled. */
export function markWithdrawn(ctx: Pick<GameContext, 'events'>, kind: 'trade' | 'pvp', peerId: string): void {
  stateOf(ctx.events).withdrawn.set(kind, { id: peerId, until: Date.now() + CLIENT_SLACK_SECONDS * 1000 })
}

/** Consumes a matching withdrawal mark. */
export function takeWithdrawn(ctx: Pick<GameContext, 'events'>, kind: 'trade' | 'pvp', peerId: string): boolean {
  const st = stateOf(ctx.events)
  const w = st.withdrawn.get(kind)
  if (!w) return false
  st.withdrawn.delete(kind)
  return w.id === peerId && Date.now() < w.until
}

/** Runs `open` once per session id even when several listeners see the same start message. */
export function onceSession(ctx: Pick<GameContext, 'events'>, id: string, open: () => Promise<void>): Promise<void> {
  const st = stateOf(ctx.events)
  const existing = st.sessions.get(id)
  if (existing) return existing
  const p = open().catch((err) => { reportError(err) }).finally(() => { st.sessions.delete(id) })
  st.sessions.set(id, p)
  return p
}

export function reportError(err: unknown): void {
  const g = globalThis as { reportError?: (e: unknown) => void }
  if (typeof g.reportError === 'function') g.reportError(err)
  else console.error(err)
}

// ---------------------------------------------------------------------------
// Online roster: the server's periodic 'online' summary, kept per NetClient
// ---------------------------------------------------------------------------

export type RosterEntry = Extract<ServerMsg, { t: 'online' }>['players'][number]
export interface Roster { players: RosterEntry[]; count: number; at: number }

const ROSTERS = new WeakMap<object, Roster>()

/** Starts recording 'online' summaries for `net` (idempotent). Installed by install*Handlers and openOnline. */
export function trackOnlineRoster(net: Pick<NetClient, 'on'>): Roster {
  let r = ROSTERS.get(net)
  if (!r) {
    const roster: Roster = { players: [], count: 0, at: 0 }
    net.on('online', (m) => { roster.players = m.players; roster.count = m.count; roster.at = Date.now() })
    ROSTERS.set(net, roster)
    r = roster
  }
  return r
}

// ---------------------------------------------------------------------------
// Lazy UI helpers (widgets + styles), also used by pvp-channel.ts
// ---------------------------------------------------------------------------

let widgetsP: Promise<Widgets> | null = null
export const loadWidgets = (): Promise<Widgets> => (widgetsP ??= import('../ui/widgets.ts'))

export function injectStyle(id: string, css: string): void {
  if (typeof document === 'undefined' || document.getElementById(id)) return
  const s = document.createElement('style')
  s.id = id
  s.textContent = css
  document.head.append(s)
}

const STYLE = `
.mp-wait, .mp-trade { background: rgba(5, 7, 13, 0.55); }
.mp-wait .ap-panel { min-width: calc(var(--u) * 200); max-width: calc(var(--u) * 300); text-align: center; }
.mp-wait-text { line-height: 1.6; margin-bottom: calc(var(--u) * 6); }
.mp-wait-dots::after { content: ''; animation: mp-dots 1.2s steps(4) infinite; }
@keyframes mp-dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }
.mp-wait .ap-btn-row { justify-content: space-between; align-items: center; gap: calc(var(--u) * 8); }
.mp-focus { outline: var(--u) solid var(--ap-gold-hi); outline-offset: var(--u); }
.ap-btn:disabled { opacity: 0.45; cursor: default; }
.mp-trade .ap-panel { width: min(96vw, calc(var(--u) * 420)); }
.mp-trade-cols { display: flex; align-items: stretch; gap: calc(var(--u) * 6); }
.mp-trade-col { flex: 1 1 0; display: flex; flex-direction: column; gap: calc(var(--u) * 3); min-width: 0; }
.mp-trade-head { color: var(--ap-gold-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mp-trade-mid { align-self: center; color: var(--ap-gold); font-size: 1.4em; }
.mp-trade-state { color: var(--ap-text-dim); min-height: 1.4em; }
.mp-trade-state.is-ok { color: var(--ap-success); }
.mp-trade-info { min-height: 1.5em; margin: calc(var(--u) * 5) 0 calc(var(--u) * 3); color: var(--ap-text-dim); display: flex; justify-content: space-between; gap: calc(var(--u) * 6); }
.mp-trade-info .is-warn { color: var(--ap-warn); }
.mp-trade-info .is-good { color: var(--ap-success); }
.mp-trade .ap-btn-row { display: flex; flex-wrap: wrap; gap: calc(var(--u) * 4); justify-content: center; }
.mp-trade-hint { margin-top: calc(var(--u) * 4); text-align: center; color: var(--ap-text-dim); }
.mp-card { display: grid; grid-template-columns: auto 1fr; gap: calc(var(--u) * 2) calc(var(--u) * 6); align-items: center;
  padding: calc(var(--u) * 4); min-height: calc(var(--u) * 64); background: rgba(5, 7, 13, 0.45); border: var(--u) solid var(--ap-gold-dk); }
.mp-trade-col .mp-card { flex: 1 1 auto; }
.mp-card.is-empty { display: flex; align-items: center; justify-content: center; color: var(--ap-text-dim); border-style: dashed; }
.mp-card-art { grid-row: span 4; display: flex; align-items: center; justify-content: center; }
.mp-card-name { line-height: 1.1; }
.mp-card-row { display: flex; flex-wrap: wrap; gap: calc(var(--u) * 2); align-items: center; }
.mp-card-stars { color: var(--ap-gold-hi); letter-spacing: calc(var(--u) * 1); }
.mp-card-ot { color: var(--ap-text-dim); grid-column: 1 / -1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Completion: the two cards arc past each other (ours over the top, theirs underneath), then the window repaints swapped. */
.mp-trade.is-complete .mp-card { position: relative; background: var(--ap-navy); }
.mp-trade.is-complete .mp-trade-col--mine .mp-card { z-index: 1; animation: mp-swap-r var(--mp-swap-ms) steps(14) both; }
.mp-trade.is-complete .mp-trade-col--theirs .mp-card { animation: mp-swap-l var(--mp-swap-ms) steps(14) both; }
.mp-trade.is-done .mp-card { animation: mp-pop 240ms steps(4) both; }
@keyframes mp-pop { 0% { transform: scale(0.85); } 100% { transform: none; } }
@keyframes mp-swap-r { 0% { transform: none; } 20% { transform: translate(0, calc(var(--u) * -14)) scale(0.92); }
  80% { transform: translate(var(--mp-swap-dx), calc(var(--u) * -14)) scale(0.92); }
  100% { transform: translate(var(--mp-swap-dx), 0); } }
@keyframes mp-swap-l { 0% { transform: none; } 20% { transform: translate(0, calc(var(--u) * 14)) scale(0.92); }
  80% { transform: translate(calc(var(--mp-swap-dx) * -1), calc(var(--u) * 14)) scale(0.92); }
  100% { transform: translate(calc(var(--mp-swap-dx) * -1), 0); } }
`

/** Creature summary card: sprite, name, Lv, types, rarity, IV stars with grade and nature, original trainer. */
export function creatureCard(w: Widgets, ctx: Pick<GameContext, 'assets'>, cr: Creature | null, iconSize = TRADE_RULES.cardIconSize): HTMLElement {
  if (!cr) return w.el('div', { class: 'mp-card is-empty', text: t('multiplayer.card.empty') })
  const sp = CONTENT.species[cr.speciesId]
  const stars = ivStars(cr)
  return w.el('div', 'mp-card', [
    w.el('div', 'mp-card-art', [w.creatureIcon(ctx.assets.creatureImageUrl(cr.speciesId), cr.shiny, iconSize)]),
    w.el('div', { class: 'mp-card-name ap-big ap-model-name', text: creatureName(cr), title: creatureName(cr) }),
    w.el('div', 'mp-card-row', [
      w.el('span', { text: t('multiplayer.card.level', { level: cr.level }) }),
      sp ? w.rarityBadge(sp.rarity) : null,
    ]),
    w.el('div', 'mp-card-row', (sp?.types ?? []).map((ty) => w.typeChip(ty))),
    w.el('div', 'mp-card-row', [
      w.el('span', { class: 'ap-dim', text: t('multiplayer.card.iv') }),
      w.el('span', { class: 'mp-card-stars', text: t('multiplayer.card.starOn').repeat(stars) + t('multiplayer.card.starOff').repeat(TRADE_RULES.ivStars - stars) }),
      w.gradeChip(gradeOf(cr.ivs).id),
      w.el('span', { class: 'mp-card-nature', text: natureName(cr.nature) }),
    ]),
    w.el('div', { class: 'mp-card-ot', text: cr.otName ? t('multiplayer.card.ot', { name: cr.otName }) : t('multiplayer.card.otUnknown') }),
  ])
}

export interface WaitHandle {
  close(): void
  setText(text: string): void
}

/** Modal "waiting for the other player" window with a countdown; cancel/confirm (or the button) calls onCancel. */
export async function showWaitPanel(
  ctx: Pick<GameContext, 'ui'>, opts: { text: string; seconds: number; onCancel: () => void },
): Promise<WaitHandle> {
  const w = await loadWidgets()
  injectStyle('mp-style', STYLE)
  let closed = false
  let left = Math.max(0, opts.seconds)
  const textEl = w.el('div', { class: 'mp-wait-text', text: opts.text })
  const timeEl = w.el('span', { class: 'ap-dim mp-wait-dots' })
  const cancel = () => { if (!closed) { handle.close(); opts.onCancel() } }
  const btn = w.button(t('multiplayer.wait.cancel'), cancel)
  btn.classList.add('mp-focus')
  const win = w.panel(null)
  win.body.append(textEl, w.el('div', 'ap-btn-row', [timeEl, btn]))
  const root = w.el('div', 'ap-modal-center mp-wait', [win.el])
  const paint = () => { timeEl.textContent = t('multiplayer.wait.seconds', { s: Math.ceil(left) }) }
  const panel: UIPanel = {
    el: root,
    onInput(input: Input) {
      if (input.pressed('cancel') || input.pressed('confirm') || input.pressed('menu')) {
        input.consume('cancel'); input.consume('confirm'); input.consume('menu')
        cancel()
      }
      return true
    },
    update(dt: number) {
      const before = Math.ceil(left)
      left = Math.max(0, left - dt)
      if (Math.ceil(left) !== before) paint()
    },
  }
  const handle: WaitHandle = {
    close() { if (!closed) { closed = true; ctx.ui.popPanel(panel) } },
    setText(text) { textEl.textContent = text },
  }
  paint()
  ctx.ui.pushPanel(panel)
  return handle
}

// ---------------------------------------------------------------------------
// Trade flows
// ---------------------------------------------------------------------------

const toastError = (ctx: Pick<GameContext, 'ui'>, msg: Extract<ServerMsg, { t: 'error' }>, kind: ToastKind = 'warn') => ctx.ui.toast(msg.message, kind)

function canStart(ctx: GameContext): boolean {
  if (ctx.net.status !== 'online') { ctx.ui.toast(t('multiplayer.status.notOnline'), 'warn'); return false }
  if (isMultiplayerBusy(ctx)) { ctx.ui.toast(t('multiplayer.trade.selfBusy'), 'warn'); return false }
  if (!offerableIndices(ctx.save.party).length) { ctx.ui.toast(t('multiplayer.trade.noOfferable'), 'warn'); return false }
  return true
}

/** Asks `targetId` to trade, waits for the answer and runs the trade window when accepted. */
export async function startTradeFlow(ctx: GameContext, targetId: string, targetName: string): Promise<void> {
  if (!canStart(ctx)) return
  void loadWidgets()
  setMultiplayerBusy(ctx, 'tradeRequest', true)
  let start: TradeStart | null = null
  try {
    start = await new Promise<TradeStart | null>((resolve) => {
      const offs: (() => void)[] = []
      let wait: WaitHandle | null = null
      let settled = false
      const done = (v: TradeStart | null) => {
        if (settled) return
        settled = true
        for (const off of offs) off()
        clearTimeout(timer)
        wait?.close()
        resolve(v)
      }
      offs.push(ctx.net.on('trade.start', (m) => { if (m.with === targetId) done(m) }))
      // One pending request per player: any cancellation now refers to ours.
      offs.push(ctx.net.on('trade.cancelled', (m) => { ctx.ui.toast(m.reason, 'info'); done(null) }))
      offs.push(ctx.net.on('error', (m) => { if (TRADE_RULES.requestAbortErrors.includes(m.code)) { toastError(ctx, m); done(null) } }))
      offs.push(ctx.events.on('net:status', ({ status }) => { if (status !== 'online') { ctx.ui.toast(t('multiplayer.trade.connectionLost'), 'warn'); done(null) } }))
      const timer = setTimeout(() => done(null), (REQUEST_SECONDS + CLIENT_SLACK_SECONDS) * 1000)
      void showWaitPanel(ctx, {
        text: t('multiplayer.trade.requesting', { name: targetName }),
        seconds: REQUEST_SECONDS,
        onCancel: () => {
          markWithdrawn(ctx, 'trade', targetId)
          ctx.net.send({ t: 'trade.cancel', tradeId: '' })
          done(null)
        },
      }).then((h) => {
        if (settled) h.close()
        else { wait = h; ctx.net.send({ t: 'trade.request', to: targetId }) }
      }, (err) => { reportError(err); done(null) })
    })
  } finally {
    setMultiplayerBusy(ctx, 'tradeRequest', false)
  }
  if (start) await openTrade(ctx, start)
}

/** trade.start handler shared by every listener: opens the window once, or cancels a start we withdrew from. */
function openTrade(ctx: GameContext, m: TradeStart): Promise<void> {
  return onceSession(ctx, `trade:${m.tradeId}`, async () => {
    if (takeWithdrawn(ctx, 'trade', m.with)) { ctx.net.send({ t: 'trade.cancel', tradeId: m.tradeId }); return }
    await runTradeWindow(ctx, m)
  })
}

/** Incoming trade requests (accept/decline, auto-decline while busy) and trade.start for accepted ones. Call once. */
export function installTradeHandlers(ctx: GameContext): () => void {
  void stateOf(ctx.events)
  trackOnlineRoster(ctx.net)
  const offs: (() => void)[] = []
  offs.push(ctx.net.on('trade.start', (m) => { void openTrade(ctx, m) }))
  offs.push(ctx.net.on('trade.requested', (m) => { void onTradeRequested(ctx, m) }))
  return () => { for (const off of offs) off() }
}

async function onTradeRequested(ctx: GameContext, m: Extract<ServerMsg, { t: 'trade.requested' }>): Promise<void> {
  if (isMultiplayerBusy(ctx)) {
    ctx.net.send({ t: 'trade.respond', from: m.from, accept: false })
    ctx.ui.toast(t('multiplayer.trade.autoDeclined', { name: m.name }), 'info')
    return
  }
  setMultiplayerBusy(ctx, 'tradeInvite', true)
  let stale = false
  const offs = [
    ctx.net.on('trade.cancelled', () => { stale = true }),
    ctx.events.on('net:status', ({ status }) => { if (status !== 'online') stale = true }),
  ]
  ctx.audio.playSfx(TRADE_RULES.sfx.incoming)
  let pick = -1
  try {
    pick = await ctx.ui.choose(t('multiplayer.trade.incoming', { name: m.name }), [t('multiplayer.trade.accept'), t('multiplayer.trade.decline')], { cancelIndex: 1 })
  } finally {
    for (const off of offs) off()
    setMultiplayerBusy(ctx, 'tradeInvite', false)
  }
  if (stale) { if (pick === 0) ctx.ui.toast(t('multiplayer.trade.inviteStale'), 'info'); return }
  if (pick === 0 && !offerableIndices(ctx.save.party).length) {
    ctx.ui.toast(t('multiplayer.trade.noOfferable'), 'warn')
    pick = 1
  }
  ctx.net.send({ t: 'trade.respond', from: m.from, accept: pick === 0 })
}

// ---------------------------------------------------------------------------
// Trade window
// ---------------------------------------------------------------------------

export type TradeButton = 'pick' | 'withdraw' | 'confirm' | 'cancel'
type ButtonId = TradeButton

async function runTradeWindow(ctx: GameContext, start: TradeStart): Promise<void> {
  const w = await loadWidgets()
  injectStyle('mp-style', STYLE)
  setMultiplayerBusy(ctx, 'trade', true)
  const tradeId = start.tradeId
  const BUTTONS = TRADE_RULES.buttons
  const deadline = performance.now() + CONTENT.config.net.tradeTimeoutSeconds * 1000

  let mine: Creature | null = null
  let theirs: Creature | null = null
  let myOk = false
  let theirOk = false
  let note: { text: string; cls: string } | null = null
  let closed = false
  let completed = false
  let picking = false
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((r) => { resolveDone = r })

  const mineCol = w.el('div', 'mp-trade-col mp-trade-col--mine')
  const theirCol = w.el('div', 'mp-trade-col mp-trade-col--theirs')
  const noteEl = w.el('span')
  const timeEl = w.el('span')
  const buttons: Record<ButtonId, HTMLButtonElement> = {
    pick: w.button(t('multiplayer.trade.pick'), () => activate('pick')),
    withdraw: w.button(t('multiplayer.trade.withdraw'), () => activate('withdraw')),
    confirm: w.button(t('multiplayer.trade.confirm'), () => activate('confirm'), { primary: true }),
    cancel: w.button(t('multiplayer.trade.cancel'), () => activate('cancel')),
  }
  const nav = w.createGridNav({ count: BUTTONS.length, cols: BUTTONS.length, audio: ctx.audio, onChange: () => paintFocus() })
  const win = w.panel(t('multiplayer.trade.with', { name: start.name }))
  win.body.append(
    w.el('div', 'mp-trade-cols', [mineCol, w.el('div', { class: 'mp-trade-mid', text: t('multiplayer.trade.swapGlyph') }), theirCol]),
    w.el('div', 'mp-trade-info', [noteEl, timeEl]),
    w.el('div', 'ap-btn-row', BUTTONS.map((b) => buttons[b])),
    w.el('div', {
      class: 'mp-trade-hint',
      text: t('multiplayer.trade.hint', { confirm: w.actionKeyLabel('confirm', ctx.input.lastDevice), cancel: w.actionKeyLabel('cancel', ctx.input.lastDevice) }),
    }),
  )
  const root = w.el('div', { class: 'ap-modal-center mp-trade', vars: { '--mp-swap-ms': `${TRADE_RULES.completeAnimMs}ms` } }, [win.el])

  const column = (head: string, cr: Creature | null, ok: boolean, waitingText: string) => [
    w.el('div', { class: 'mp-trade-head', text: head }),
    creatureCard(w, ctx, cr),
    w.el('div', { class: `mp-trade-state${ok ? ' is-ok' : ''}`, text: ok ? t('multiplayer.trade.confirmed') : cr ? t('multiplayer.trade.waitingConfirm') : waitingText }),
  ]
  const paintFocus = () => BUTTONS.forEach((b, i) => buttons[b].classList.toggle('mp-focus', i === nav.index))
  const paint = () => {
    mineCol.replaceChildren(...column(t('multiplayer.trade.you'), mine, myOk, ''))
    theirCol.replaceChildren(...column(t('multiplayer.trade.them', { name: start.name }), theirs, theirOk, t('multiplayer.trade.waitingOffer')))
    buttons.pick.textContent = mine ? t('multiplayer.trade.change') : t('multiplayer.trade.pick')
    buttons.pick.disabled = completed
    buttons.withdraw.disabled = completed || !mine
    buttons.confirm.disabled = completed || !mine || !theirs || myOk
    buttons.cancel.disabled = completed
    noteEl.textContent = note?.text ?? (!mine || !theirs ? t('multiplayer.trade.bothNeeded') : '')
    noteEl.className = note?.cls ?? ''
    paintFocus()
  }
  const paintTime = () => {
    const s = Math.max(0, Math.ceil((deadline - performance.now()) / 1000))
    timeEl.textContent = completed ? '' : t('multiplayer.trade.timeLeft', { s })
  }

  const close = () => {
    if (closed) return
    closed = true
    for (const off of offs) off()
    ctx.ui.popPanel(panel)
    setMultiplayerBusy(ctx, 'trade', false)
    resolveDone()
  }

  async function activate(id: ButtonId): Promise<void> {
    if (closed || completed || picking || buttons[id].disabled) { ctx.audio.playSfx(UI_CONFIG.sfx.error); return }
    switch (id) {
      case 'pick': {
        if (!offerableIndices(ctx.save.party).length) { ctx.ui.toast(t('multiplayer.trade.noOfferable'), 'warn'); return }
        picking = true
        let idx = -1
        try {
          idx = await ctx.screens.party('select', { title: t('multiplayer.trade.pickTitle'), filter: (c) => canOffer(ctx.save.party, c) })
        } finally { picking = false }
        if (closed || completed || idx < 0) return
        const cr = ctx.save.party[idx]
        if (!cr || !canOffer(ctx.save.party, cr)) { ctx.ui.toast(t('multiplayer.trade.notOfferable'), 'warn'); return }
        ctx.net.send({ t: 'trade.offer', tradeId, creature: structuredClone(cr) })
        return
      }
      case 'withdraw':
        ctx.net.send({ t: 'trade.offer', tradeId, creature: null })
        return
      case 'confirm':
        ctx.net.send({ t: 'trade.confirm', tradeId })
        return
      case 'cancel':
        if (ctx.net.status !== 'online') { close(); return }
        if (await ctx.ui.confirm(t('multiplayer.trade.cancelAsk')) && !closed && !completed) ctx.net.send({ t: 'trade.cancel', tradeId })
        return
    }
  }

  const panel: UIPanel = {
    el: root,
    onInput(input: Input) {
      if (completed || picking) return true
      const r = nav.handle(input)
      if (r === 'confirm') void activate(BUTTONS[nav.index])
      else if (r === 'cancel') void activate('cancel')
      else if (r === 'move') paintFocus()
      return true
    },
    update() { paintTime() },
  }

  const resetConfirms = () => {
    if (myOk || theirOk) note = { text: t('multiplayer.trade.offerChanged'), cls: 'is-warn' }
    else note = null
    myOk = false
    theirOk = false
  }

  const offs: (() => void)[] = [
    ctx.net.on('trade.offer', (m) => {
      if (m.tradeId !== tradeId) return
      resetConfirms()
      if (m.side === 'self') mine = m.creature
      else { theirs = m.creature; ctx.audio.playSfx(TRADE_RULES.sfx.offer) }
      paint()
    }),
    ctx.net.on('trade.confirmed', (m) => {
      if (m.tradeId !== tradeId) return
      if (m.side === 'self') myOk = true
      else theirOk = true
      note = null
      ctx.audio.playSfx(TRADE_RULES.sfx.confirm)
      paint()
    }),
    ctx.net.on('trade.complete', (m) => {
      if (m.tradeId !== tradeId || completed) return
      completed = true
      const applied = applyTradeResult(ctx.save, m.given, m.received)
      if (applied.newSeen) ctx.events.emit('dex:seen', { speciesId: m.received.speciesId })
      if (applied.newCaught) ctx.events.emit('dex:caught', { speciesId: m.received.speciesId })
      ctx.events.emit('party:changed', {})
      ctx.persist('trade')
      ctx.overworld?.refresh()
      note = { text: t('multiplayer.trade.completeTitle'), cls: 'is-good' }
      paint()
      root.style.setProperty('--mp-swap-dx', `${theirCol.offsetLeft - mineCol.offsetLeft}px`)
      root.classList.add('is-complete')
      ctx.audio.playSfx(TRADE_RULES.sfx.complete)
      window.setTimeout(() => {
        // Settle on the swapped state: our column now shows what we received.
        const gave = mine
        mine = m.received
        theirs = gave
        paint()
        root.classList.replace('is-complete', 'is-done')
        ctx.ui.toast(t('multiplayer.trade.complete', { name: creatureName(m.received) }), 'success')
        if (applied.given) ctx.ui.toast(t('multiplayer.trade.sentAway', { name: creatureName(applied.given) }), 'info')
        window.setTimeout(close, TRADE_RULES.completeHoldMs)
      }, TRADE_RULES.completeAnimMs)
    }),
    ctx.net.on('trade.cancelled', (m) => {
      if (m.tradeId !== tradeId || completed) return
      ctx.ui.toast(m.reason, 'info')
      close()
    }),
    ctx.net.on('error', (m) => {
      if (!closed && !completed && TRADE_RULES.sessionErrors.includes(m.code)) toastError(ctx, m)
    }),
    ctx.events.on('net:status', ({ status }) => {
      if (status === 'online' || completed) return
      ctx.ui.toast(t('multiplayer.trade.connectionLost'), 'warn')
      close()
    }),
  ]

  paint()
  paintTime()
  ctx.ui.pushPanel(panel)
  await done
}
