// Client side of authoritative PvE battles (#22):
// Wild encounters, trainer battles and boss instances run through this BattleChannel over the WebSocket.
// The server executes the shared BattleEngine deterministically; the client sends operations only.
import type { BattleAction, BattleEvent, BattleRequest, BattleResult, Creature, SaveData, TimeOfDay, WeatherId } from '../../shared/types.ts'
import type { BattleOutcome, BattleRunner, GameContext, NetClient } from '../contracts.ts'
import type { ServerMsg } from '../../shared/protocol.ts'

export type PveBattleKind = 'wild' | 'trainer' | 'boss'

export interface PveBattleStartRequest {
  kind: PveBattleKind
  speciesId?: string
  level?: number
  scripted?: boolean
  roamer?: boolean
  catchRateMul?: number
  flee?: { chancePerTurn: number; afterTurn: number }
  trainerId?: string
  bossId?: string
  tierId?: string
  assist?: boolean
  coach?: boolean
  skipBrief?: boolean
  captureAfterWin?: boolean
  timeOfDay?: TimeOfDay
  weather?: WeatherId
}

export interface PveChannel {
  readonly isPve: true
  readonly battleId: string
  readonly result: BattleResult | null
  readonly caught: Creature | null
  readonly moneyDelta: number
  readonly ended: boolean
  start(): Promise<{ events: BattleEvent[]; request: BattleRequest }>
  submit(action: BattleAction): Promise<{ events: BattleEvent[]; request: BattleRequest }>
  dispose(): void
}

const WAIT: BattleRequest = { kind: 'wait' }

function promiseResolvers<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

export function isPveChannel(ch: unknown): ch is PveChannel {
  return typeof ch === 'object' && ch !== null && 'isPve' in ch && ch.isPve === true
}

export function createPveChannel(
  net: NetClient,
  started: Extract<ServerMsg, { t: 'battle.started' }>,
  onEnd?: (end: Extract<ServerMsg, { t: 'battle.end' }>) => void,
): PveChannel {
  const battleId = started.battleId
  const inbox: BattleEvent[][] = [[...started.events]]
  let currentRequest: BattleRequest = started.request
  let endMsg: Extract<ServerMsg, { t: 'battle.end' }> | null = null
  let caughtCr: Creature | null = null
  let moneyDelta = 0
  let disposed = false
  let wake: (() => void) | null = null

  const poke = () => {
    const w = wake
    wake = null
    w?.()
  }

  const offEvents = net.on('battle.events', (m) => {
    if (m.battleId !== battleId) return
    inbox.push([...m.events])
    currentRequest = m.request
    poke()
  })

  const offEnd = net.on('battle.end', (m) => {
    if (m.battleId !== battleId) return
    endMsg = m
    caughtCr = m.caught ? structuredClone(m.caught) : null
    moneyDelta = m.moneyDelta
    onEnd?.(m)
    poke()
  })

  async function collect(): Promise<{ events: BattleEvent[]; request: BattleRequest }> {
    for (;;) {
      if (inbox.length > 0) {
        const batch = inbox.shift()!
        return { events: batch, request: currentRequest }
      }
      if (endMsg || disposed) {
        return { events: [], request: WAIT }
      }
      const { promise, resolve } = promiseResolvers<void>()
      wake = resolve
      await promise
    }
  }

  return {
    isPve: true,
    battleId,
    get result() { return endMsg?.result ?? null },
    get caught() { return caughtCr },
    get moneyDelta() { return moneyDelta },
    get ended() { return endMsg !== null || disposed },

    start() {
      return collect()
    },

    submit(action: BattleAction) {
      if (disposed || endMsg) return Promise.resolve({ events: [], request: WAIT })
      net.send({ t: 'battle.action', battleId, action })
      return collect()
    },

    dispose() {
      if (disposed) return
      disposed = true
      offEvents()
      offEnd()
      poke()
    },
  }
}

export async function requestOnlineBattleStart(
  net: NetClient,
  req: PveBattleStartRequest,
  timeoutMs = 5000,
): Promise<Extract<ServerMsg, { t: 'battle.started' }> | null> {
  if (net.status !== 'online') return null
  const { promise, resolve } = promiseResolvers<Extract<ServerMsg, { t: 'battle.started' }> | null>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const offErr = net.on('error', () => {
    cleanup()
    resolve(null)
  })
  const offStart = net.on('battle.started', (m) => {
    cleanup()
    resolve(m)
  })
  const cleanup = () => {
    clearTimeout(timer ?? undefined)
    offStart()
    offErr()
  }
  timer = setTimeout(() => {
    cleanup()
    resolve(null)
  }, timeoutMs)
  net.send({ t: 'battle.start', ...req })
  return promise
}

export async function runOnlineBattle(
  ctx: GameContext,
  req: PveBattleStartRequest,
  runOpts: Parameters<BattleRunner['run']>[1],
): Promise<BattleOutcome | null> {
  const started = await requestOnlineBattleStart(ctx.net, req)
  if (!started) return null

  let finalSave: SaveData | null = null
  const channel = createPveChannel(ctx.net, started, (end) => {
    finalSave = end.save
  })

  let outcome: BattleOutcome
  try {
    outcome = await ctx.battle.run(started.init, { ...runOpts, channel: channel as unknown as typeof runOpts.channel })
  } finally {
    channel.dispose()
  }

  if (finalSave) {
    applyAuthoritativeSave(ctx, finalSave)
  }

  return outcome
}

export async function signOnlineContract(
  ctx: GameContext,
  battleId: string,
  bossId: string,
  tierId: string,
  ballId: string,
  timeoutMs = 5000,
): Promise<boolean> {
  if (ctx.net.status !== 'online') return false
  const { promise, resolve } = promiseResolvers<boolean>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const offErr = ctx.net.on('error', () => {
    cleanup()
    resolve(false)
  })
  const offContract = ctx.net.on('battle.contracted', (m) => {
    if (m.battleId !== battleId) return
    cleanup()
    applyAuthoritativeSave(ctx, m.save)
    resolve(true)
  })
  const cleanup = () => {
    clearTimeout(timer ?? undefined)
    offContract()
    offErr()
  }
  timer = setTimeout(() => {
    cleanup()
    resolve(false)
  }, timeoutMs)
  ctx.net.send({ t: 'battle.contract', battleId, bossId, tierId, ballId })
  return promise
}

export function applyAuthoritativeSave(ctx: GameContext, serverSave: SaveData): void {
  const localSettings = structuredClone(ctx.save.settings)
  ctx.save = {
    ...structuredClone(serverSave),
    settings: localSettings,
  }
  ctx.events.emit('party:changed', {})
  ctx.events.emit('bag:changed', {})
  ctx.events.emit('money:changed', { money: ctx.save.money, delta: 0 })
  ctx.hud?.setMoney(ctx.save.money)
  ctx.overworld?.refresh()
}
