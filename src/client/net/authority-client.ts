// Client-side authority coordinator (#22):
// Listens for server state synchronization (welcome.save, state.sync) and forwards gameplay operations
// (shop, item use, evolutions, moves, party/box modifications, script ops) to the server when online.
import type { GameContext } from '../contracts.ts'
import type { SaveData } from '../../shared/types.ts'
import type { Slot } from '../ui/screens/logic.ts'
import type { ClientMsg } from '../../shared/protocol.ts'
import { applyAuthoritativeSave } from './pve-channel.ts'

export interface AuthorityClientState {
  active: boolean
  rev: number
  untrustedImport: boolean
}

const STATES = new WeakMap<object, AuthorityClientState>()

function stateOf(ctx: GameContext): AuthorityClientState {
  let s = STATES.get(ctx.events)
  if (!s) {
    s = { active: false, rev: 0, untrustedImport: false }
    STATES.set(ctx.events, s)
  }
  return s
}

export function isOnlineAuthorityActive(ctx: GameContext): boolean {
  return ctx.net.status === 'online' && stateOf(ctx).active
}

export function isUntrustedImportOnline(ctx: GameContext): boolean {
  return stateOf(ctx).untrustedImport
}

export function adoptServerSave(
  ctx: GameContext,
  save: SaveData,
  rev?: number,
  untrustedImport?: boolean,
  opts?: { initial?: boolean },
): void {
  const st = stateOf(ctx)
  st.active = true
  if (typeof rev === 'number') st.rev = rev
  if (untrustedImport !== undefined) st.untrustedImport = untrustedImport
  applyAuthoritativeSave(ctx, save, opts)
}

export function installAuthorityHandlers(ctx: GameContext): () => void {
  const offs = [
    ctx.net.on('welcome', (m) => {
      const st = stateOf(ctx)
      if (m.authority) st.active = true
      if (m.save) {
        adoptServerSave(ctx, m.save, m.saveRev, m.untrustedImport, { initial: true })
      }
    }),
    ctx.net.on('state.sync', (m) => {
      adoptServerSave(ctx, m.save, m.rev)
    }),
    ctx.events.on('net:status', ({ status }) => {
      if (status !== 'online') {
        stateOf(ctx).active = false
      }
    }),
  ]

  return () => {
    for (const off of offs) off()
  }
}

export function sendShopBuy(ctx: GameContext, itemId: string, qty: number, priceMul?: number): void {
  if (!isOnlineAuthorityActive(ctx)) return
  ctx.net.send({ t: 'shop.buy', itemId, qty, ...(priceMul !== undefined ? { priceMul } : {}) })
}

export function sendShopSell(ctx: GameContext, itemId: string, qty: number): void {
  if (!isOnlineAuthorityActive(ctx)) return
  ctx.net.send({ t: 'shop.sell', itemId, qty })
}

export function sendItemUse(
  ctx: GameContext,
  itemId: string,
  opts: { partyIndex?: number; moveIndex?: number; natureId?: string } = {},
): void {
  if (!isOnlineAuthorityActive(ctx)) return
  ctx.net.send({ t: 'item.use', itemId, ...opts })
}

export function sendExchangeDeal(ctx: GameContext, desk: string, offerIndex: number, qty: number): void {
  if (!isOnlineAuthorityActive(ctx)) return
  ctx.net.send({ t: 'exchange.deal', desk, offerIndex, qty })
}

export function sendCreatureEvolve(ctx: GameContext, partyIndex: number, toSpeciesId: string): void {
  if (!isOnlineAuthorityActive(ctx)) return
  ctx.net.send({ t: 'creature.evolve', partyIndex, toSpeciesId })
}

export function sendCreatureLearnMove(ctx: GameContext, partyIndex: number, moveId: string, replaceIndex?: number): void {
  if (!isOnlineAuthorityActive(ctx)) return
  ctx.net.send({ t: 'creature.learnMove', partyIndex, moveId, replaceIndex })
}

export function sendCreatureNickname(ctx: GameContext, uid: string, nickname?: string): void {
  if (!isOnlineAuthorityActive(ctx)) return
  ctx.net.send({ t: 'creature.nickname', uid, nickname })
}

export function sendPartySwap(ctx: GameContext, a: number, b: number): void {
  if (!isOnlineAuthorityActive(ctx)) return
  ctx.net.send({ t: 'party.swap', a, b })
}

export function sendBoxMove(ctx: GameContext, from: Slot, to: Slot): void {
  if (!isOnlineAuthorityActive(ctx)) return
  ctx.net.send({
    t: 'box.move',
    from: { area: from.area, box: from.box, index: from.index },
    to: { area: to.area, box: to.box, index: to.index },
  })
}

export function sendBoxRelease(ctx: GameContext, slot: Slot): void {
  if (!isOnlineAuthorityActive(ctx)) return
  ctx.net.send({
    t: 'box.release',
    slot: { area: slot.area, box: slot.box, index: slot.index },
  })
}

export function sendScriptOp(ctx: GameContext, op: Extract<ClientMsg, { t: 'script.op' }>): void {
  if (!isOnlineAuthorityActive(ctx)) return
  ctx.net.send(op)
}

export function sendSaveImport(ctx: GameContext, rawSave: unknown, slotSig?: string | null, slotIndex?: number): void {
  if (ctx.net.status !== 'online') return
  ctx.net.send({ t: 'save.import', save: rawSave, slotSig, slotIndex })
}
