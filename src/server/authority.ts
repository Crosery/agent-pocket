// Authoritative online gameplay service (#22):
// - Server-owned SaveData per account/player, signed at rest with HMAC-SHA256 (save-sign.ts) and verified on load.
// - Authoritative PvE battles (wild / trainer / boss) executed on the server via the shared BattleEngine.
// - Authoritative captures, boss contracts, exp/level-ups, shop buy/sell, field item use, exchange, party/box moves.
// - Ownership enforcement for trades and PvP parties (prevents cross-account theft, duplication, and party fabrication).
// - Economic ledger + anti-cheat audit log + anomaly detection (encounter/step ratio, hourly exp/money rate).
import { randomInt } from 'node:crypto'
import battleUiJson from '../../content/battle-ui.json' with { type: 'json' }
import clientJson from '../../content/events/client.json' with { type: 'json' }
import gameJson from '../../content/game.json' with { type: 'json' }
import type {
  BattleAction, BattleEvent, BattleInit, BattleModifiers, BattleRequest, BattleSideInit, Creature, FieldWeatherKind, GameMap, GradeDef, NpcDef, RegionDef, SaveData, ScriptStep, SpeciesDef, TownDef, TrainerDef, TypeId, World,
} from '../shared/types.ts'
import type { ClientMsg, PublicProfile, ServerMsg } from '../shared/protocol.ts'
import { CONTENT, t } from '../shared/content/index.ts'
import { hashString, Rng } from '../shared/rng.ts'
import {
  createCreature, evolutionTarget, evolve, expForLevel, gainExp, maxHp, rollShiny, sanitizeCreature, toView,
} from '../shared/creature.ts'
import { BattleEngine, perspective } from '../shared/battle/engine.ts'
import { buildBossInit, createBossCreature } from '../shared/battle/boss-battle.ts'
import { bossCardCap, captureSeed, isBossCard, partyExpMods, rollBossCard, settleBank } from '../shared/gameplay/bosscard.ts'
import { offersOf, takeOffer, timesAffordable, unlocked } from '../shared/gameplay/exchange.ts'
import {
  activeEvents, dayOf, endEvent, eventAppliesAt, eventContext, eventFocus, eventModifiers, eventRng, eventSalt,
  evaluateCondition, evaluateProgress, expandFlag, modifierValue, realDateOf, resolvePlaceRef, startActions,
  tickEvents, triggerEvent, type ActiveEvent, type EventAnchor, type EventContext, type StartActions,
} from '../shared/gameplay/events.ts'
import {
  checkInstanceAchievements, contractOdds, dailyLockoutStatus, instanceOfBoss, instancePeriodKey, isOffPeakDouble,
  isTierUnlocked, pickLossHint, progressOf, recordDailyReward, recordDailyRoll, rollContractOutcome, shouldOfferAssist,
} from '../shared/gameplay/instances.ts'
import {
  addTaskProgress, applyResearch, levelRewards, researchFromBattle, researchLevel, researchPoints,
} from '../shared/gameplay/research.ts'
import { legendsNear, onLegendBattleEnd, resolveSpawnEffect, speciesBehavior } from '../shared/gameplay/spawns.ts'
import { GAMEPLAY } from '../shared/gameplay/data.ts'
import {
  applyMedicine, applyTradeResult, canOffer, canSell, catchPlacement, medicineBlocker, moveCreature, releaseCreature,
  sellPrice, shopBuyPrice, teachState,
} from '../shared/gameplay/save-ops.ts'
import { STORY_CONTENT, storyFeatures, type StepSpec } from '../shared/world/story.ts'
import { FRONTIER_PACK } from '../shared/world/frontier/content/data.ts'
import { frontierQuest, frontierTrainer, registerFrontierRefs } from '../shared/world/frontier/content/index.ts'
import { distanceFromOrigin, getMap, objectsInRect, regionAt, worldOrigin } from '../shared/world/worldapi.ts'
import type { AuditRecord, LedgerRecord } from './accounts.ts'
import type { HubCore, Player } from './core.ts'
import { maskBanned } from './moderation.ts'
import {
  isolateUntrustedSave, loadOrCreateSaveSecret, loadOrCreateSaveSecretSync, signServerSave, type SignedServerSave,
} from './save-sign.ts'
import type { ProfileStore } from './store.ts'
import { isFiniteNumber, isRecord, newSessionId } from './util.ts'

export type { AuditRecord, LedgerRecord }

export interface ExternalAccountStore {
  getAccountSave(accountId: string): { save: SaveData | null; imported: boolean; trusted: boolean; rev: number; updatedAt?: number; sig?: string } | null
  putAccountSave(accountId: string, save: SaveData, opts?: { imported?: boolean; trusted?: boolean; now?: number }): {
    accountId: string
    save: SaveData
    imported: boolean
    trusted: boolean
    rev: number
    updatedAt: number
    sig: string
  }
  recordAudit(entry: { accountId?: string | null; ip?: string | null; kind: string; severity?: number; detail?: Record<string, unknown>; at?: number }): void
  listAudit(accountId?: string, limit?: number): AuditRecord[]
  recordLedger(entry: { accountId: string; kind: LedgerRecord['kind']; subject: string; delta: number; balance: number; ref: string; at?: number }): void
  listLedger(accountId?: string, limit?: number): LedgerRecord[]
}

const BATTLE_CHANNEL_MAX_AUTO_STEPS = battleUiJson.channel.maxAutoSteps
const BATTLE_CONTRACT_DEFAULT_BALL = battleUiJson.contract.defaultBall
const BATTLE_CONTRACT_CONSUME_BALL = battleUiJson.contract.consumeBall
interface ActiveBattle {
  id: string
  playerId: string
  kind: 'wild' | 'trainer' | 'boss'
  seed: number
  init: BattleInit
  engine: BattleEngine
  workingParty: Creature[]
  bag: Record<string, number>
  trainer: TrainerDef | null
  bossId: string | null
  tierId: string | null
  runSeq: number
  firstClear: boolean
  captureAfterWin: boolean
  consumedItems: Record<string, number>
  moneyEarned: number
  lootEarned: Record<string, number>
  expEarned: number
  damageTaken: number
  seenSpecies: Set<string>
  defeatedSpecies: string[]
  foeMoves: { species: string; type: TypeId }[]
  activeFoeSpecies: string | null
  roamingLegend: boolean
  eventSpawnTag: string | null
  eventStartedAt: number | null
  learnableMoves: Map<number, Set<string>>
  evolutionsReady: Map<number, string>
  openedAt: number
  done: boolean
}

interface PendingContract {
  battleId: string
  playerId: string
  bossId: string
  tierId: string
  runSeq: number
  signed: boolean
}
interface PlayerMetrics {
  stepsSinceCheck: number
  encountersSinceCheck: number
  expWindowStart: number
  expInWindow: number
  moneyInWindow: number
}

export interface AuthorityOptions {
  dataDir: string
  core: HubCore
  store: ProfileStore
  world?: World | null
  secret?: string
  log?: (msg: string) => void
}

export interface AuthorityService {
  load(): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
  readonly secret: string
  hasSave(playerId: string): boolean
  isInBattle(playerId: string): boolean
  getSave(playerId: string): SaveData | null
  getRecord(playerId: string): SignedServerSave | null
  isUntrustedImport(playerId: string): boolean
  setSave(playerId: string, save: SaveData, opts?: { imported?: boolean; trusted?: boolean; ref?: string }): SignedServerSave
  importOfflineSave(
    playerId: string,
    rawSave: unknown,
    opts?: { ip?: string; slotSig?: string | null; slotIndex?: number },
  ): { ok: true; record: SignedServerSave; stripped: string[] } | { ok: false; code: 'save_tampered' | 'invalid_save'; reason: string }
  mutateSave<T>(playerId: string, ref: string, fn: (save: SaveData) => T): T | null
  grantReward(playerId: string, reward: { money?: number; items?: Record<string, number>; creatures?: Creature[] }, ref: string): boolean
  audit(accountId: string | null, kind: string, detail: Record<string, unknown>, severity?: number, ip?: string): void
  listAudit(accountId?: string): AuditRecord[]
  listLedger(accountId?: string): LedgerRecord[]
  noteStep(playerId: string, ip?: string): void
  validateProfileReport(p: Player, reported: PublicProfile): PublicProfile
  validateTradeOffer(
    playerId: string,
    rawCreature: unknown,
    ip?: string,
  ): { ok: true; creature: Creature | null } | { ok: false; code: string }
  completeTrade(aId: string, aUid: string, bId: string, bUid: string, tradeId: string): boolean
  validatePvpParty(playerId: string, rawParty: unknown, healParty: boolean, ip?: string): Creature[] | null | undefined
  handle(p: Player, msg: ClientMsg): boolean
  onDisconnect(playerId: string): void
}

const ANOMALY_WINDOW_MS = 3600_000
const MAX_HOURLY_EXP = 500_000
const MAX_HOURLY_MONEY = 250_000

export function createAuthority(opts: AuthorityOptions): AuthorityService {
  const { core, store } = opts
  const world = opts.world ?? null

  let secret = opts.secret ?? loadOrCreateSaveSecretSync(opts.dataDir)
  const creatureOwners = new Map<string, string>()
  const activeBattles = new Map<string, ActiveBattle>()
  const pendingContracts = new Map<string, PendingContract>()
  const metrics = new Map<string, PlayerMetrics>()
  const recentPayments = new Map<string, { kind: 'money' | 'item'; itemId?: string; amount: number; map: string; at: number }>()
  const recentFlagsSet = new Map<string, Map<string, number>>()
  const lastClockSyncMs = new Map<string, number>()

  function noteRecentFlag(playerId: string, flag: string): void {
    let m = recentFlagsSet.get(playerId)
    if (!m) {
      m = new Map()
      recentFlagsSet.set(playerId, m)
    }
    m.set(flag, Date.now())
  }

  function wasFlagRecentlySet(playerId: string, flag: string, windowMs = 30_000): boolean {
    const at = recentFlagsSet.get(playerId)?.get(flag)
    return typeof at === 'number' && Date.now() - at <= windowMs
  }
  function indexSaveCreatures(accountId: string, save: SaveData): void {
    for (const [uid, owner] of [...creatureOwners.entries()]) {
      if (owner === accountId) creatureOwners.delete(uid)
    }
    for (const cr of save.party) creatureOwners.set(cr.uid, accountId)
    for (const box of save.boxes) {
      for (const cr of box) creatureOwners.set(cr.uid, accountId)
    }
  }

  function audit(
    accountId: string | null,
    kind: string,
    detail: Record<string, unknown>,
    severity = 2,
    ip?: string,
  ): void {
    store.recordAudit({ accountId, ip: ip ?? null, kind, severity, detail, at: Date.now() })
  }

  function addLedger(
    accountId: string,
    kind: LedgerRecord['kind'],
    subject: string,
    delta: number,
    balance: number,
    ref: string,
  ): void {
    if (delta === 0) return
    const at = Date.now()
    store.recordLedger({
      accountId,
      at,
      kind,
      subject,
      delta,
      balance,
      ref,
    })
    const m = playerMetrics(accountId)
    if (at - m.expWindowStart > ANOMALY_WINDOW_MS) {
      m.expWindowStart = at
      m.expInWindow = 0
      m.moneyInWindow = 0
    }
    if (kind === 'exp' && delta > 0) {
      m.expInWindow += delta
      if (m.expInWindow > MAX_HOURLY_EXP) {
        audit(accountId, 'anomaly.exp_rate', { expInWindow: m.expInWindow, delta, ref }, 2)
      }
    }
    if (kind === 'money' && delta > 0) {
      m.moneyInWindow += delta
      if (m.moneyInWindow > MAX_HOURLY_MONEY) {
        audit(accountId, 'anomaly.money_rate', { moneyInWindow: m.moneyInWindow, delta, ref }, 2)
      }
    }
  }

  function playerMetrics(playerId: string): PlayerMetrics {
    let m = metrics.get(playerId)
    if (!m) {
      m = { stepsSinceCheck: 0, encountersSinceCheck: 0, expWindowStart: Date.now(), expInWindow: 0, moneyInWindow: 0 }
      metrics.set(playerId, m)
    }
    return m
  }

  function getRecord(playerId: string): SignedServerSave | null {
    const ext = store.getAccountSave(playerId)
    if (!ext || !ext.save) return null
    const save = structuredClone(ext.save)
    indexSaveCreatures(playerId, save)
    const updatedAt = ext.updatedAt ?? Date.now()
    if (ext.sig) {
      return {
        version: save.version,
        accountId: playerId,
        rev: ext.rev,
        trusted: ext.trusted,
        imported: ext.imported,
        updatedAt,
        save,
        sig: ext.sig,
      }
    }
    return signServerSave({
      version: save.version,
      accountId: playerId,
      rev: ext.rev,
      trusted: ext.trusted,
      imported: ext.imported,
      updatedAt,
      save,
    }, secret)
  }

  function syncPlayerPublicState(playerId: string, save: SaveData, trusted: boolean): void {
    const p = core.byId(playerId)
    if (!p) return
    p.state.badges = trusted ? save.badges.length : 0
    p.state.dexCaught = trusted ? save.dexCaught.length : 0
    const lead = save.party.find((c) => c.hp > 0) ?? null
    p.state.lead = lead ? { speciesId: lead.speciesId, shiny: lead.shiny, level: lead.level } : null
    p.profile = {
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      badges: trusted ? [...save.badges] : [],
      dexCaught: trusted ? save.dexCaught.length : 0,
      party: save.party.map((c) => toView(c, CONTENT)),
      pvpWins: p.profile.pvpWins,
      pvpLosses: p.profile.pvpLosses,
      playTimeSec: Math.floor(save.playTimeSec),
      ...(p.maxDistance ? { maxDistance: Math.floor(p.maxDistance) } : {}),
    }
    store.put(p.profile)
    core.touch(p)
  }

  function commitSave(
    playerId: string,
    save: SaveData,
    optsIn: { imported?: boolean; trusted?: boolean; ref?: string; notify?: boolean; syncPosition?: boolean } = {},
  ): SignedServerSave {
    const now = Date.now()
    const nextSave = structuredClone(save)
    if (optsIn.syncPosition !== false && optsIn.ref !== 'script:blackout' && optsIn.ref !== 'save:import') {
      const live = core.byId(playerId)
      if (live?.state) {
        nextSave.position = {
          map: live.state.map,
          x: Math.floor(live.state.x),
          y: Math.floor(live.state.y),
          facing: live.state.facing,
        }
      }
    }
    const stored = store.putAccountSave(playerId, nextSave, {
      ...(optsIn.imported !== undefined ? { imported: optsIn.imported } : {}),
      ...(optsIn.trusted !== undefined ? { trusted: optsIn.trusted } : {}),
      now,
    })
    indexSaveCreatures(playerId, stored.save)
    syncPlayerPublicState(playerId, stored.save, stored.trusted)
    if (optsIn.notify !== false) {
      const p = core.byId(playerId)
      if (p) core.send(p, { t: 'state.sync', save: stored.save, rev: stored.rev, ...(optsIn.ref ? { reason: optsIn.ref } : {}) })
    }
    return {
      version: stored.save.version,
      accountId: playerId,
      rev: stored.rev,
      trusted: stored.trusted,
      imported: stored.imported,
      updatedAt: stored.updatedAt,
      save: stored.save,
      sig: stored.sig,
    }
  }

  function recordSaveDiffLedger(playerId: string, before: SaveData, after: SaveData, ref: string): void {
    if (after.money !== before.money) {
      addLedger(playerId, 'money', 'money', after.money - before.money, after.money, ref)
    }
    const itemKeys = new Set([...Object.keys(before.bag), ...Object.keys(after.bag)])
    for (const id of itemKeys) {
      const d = (after.bag[id] ?? 0) - (before.bag[id] ?? 0)
      if (d !== 0) addLedger(playerId, 'item', id, d, after.bag[id] ?? 0, ref)
    }
    const beforeUids = new Set([...before.party, ...before.boxes.flat()].map((c) => c.uid))
    const afterAll = [...after.party, ...after.boxes.flat()]
    const afterUids = new Set(afterAll.map((c) => c.uid))
    for (const cr of afterAll) {
      if (!beforeUids.has(cr.uid)) addLedger(playerId, 'creature', cr.uid, 1, afterAll.length, ref)
    }
    for (const uid of beforeUids) {
      if (!afterUids.has(uid)) addLedger(playerId, 'creature', uid, -1, afterAll.length, ref)
    }
  }

  function storeCreatureInSave(save: SaveData, cr: Creature): { where: 'party' | 'box'; box?: number; newSeen: boolean; newCaught: boolean } | null {
    const alreadyExists = save.party.some((x) => x.uid === cr.uid) || save.boxes.some((b) => b.some((x) => x.uid === cr.uid))
    if (alreadyExists) return null
    let newSeen = false
    let newCaught = false
    if (CONTENT.species[cr.speciesId] && !save.dexSeen.includes(cr.speciesId)) {
      save.dexSeen.push(cr.speciesId)
      newSeen = true
    }
    if (CONTENT.species[cr.speciesId] && !save.dexCaught.includes(cr.speciesId)) {
      save.dexCaught.push(cr.speciesId)
      newCaught = true
    }
    if (!cr.otName) cr.otName = save.name
    if (!cr.otId) cr.otId = save.playerId
    cr.origin ??= { kind: 'wild', at: Date.now() }
    const where = catchPlacement(save, CONTENT)
    if (!where) return null
    if (where.where === 'party') {
      save.party.push(cr)
      save.stats.caught += 1
      if (cr.shiny) save.stats.shiniesFound += 1
      return { where: 'party', newSeen, newCaught }
    }
    while (save.boxes.length <= where.box) save.boxes.push([])
    save.boxes[where.box].push(cr)
    save.stats.caught += 1
    if (cr.shiny) save.stats.shiniesFound += 1
    return { where: 'box', box: where.box, newSeen, newCaught }
  }

  // ------------------------------------------------------------------ PvE battles

  function drainBattle(b: ActiveBattle, initialEvents: BattleEvent[]): { events: BattleEvent[]; request: BattleRequest } {
    const events = [...initialEvents]
    for (let i = 0; i < BATTLE_CHANNEL_MAX_AUTO_STEPS && !b.engine.finished && b.engine.request(0).kind === 'wait' && b.engine.ready(); i++) {
      events.push(...b.engine.step())
    }
    for (const e of events) {
      if (e.t === 'switch' && e.side === 1 && CONTENT.species[e.creature.speciesId]) {
        b.activeFoeSpecies = e.creature.speciesId
        b.seenSpecies.add(e.creature.speciesId)
      } else if (e.t === 'move' && e.side === 1 && b.activeFoeSpecies) {
        b.foeMoves.push({ species: b.activeFoeSpecies, type: e.type })
      } else if (e.t === 'faint' && e.side === 1 && b.activeFoeSpecies) {
        b.defeatedSpecies.push(b.activeFoeSpecies)
      } else if (e.t === 'item' && e.side === 0) {
        b.consumedItems[e.itemId] = (b.consumedItems[e.itemId] ?? 0) + 1
        b.bag[e.itemId] = Math.max(0, (b.bag[e.itemId] ?? 0) - 1)
      } else if (e.t === 'money' && e.amount > 0) {
        b.moneyEarned += Math.floor(e.amount)
      } else if (e.t === 'loot' && e.qty > 0 && CONTENT.items[e.itemId]) {
        b.lootEarned[e.itemId] = (b.lootEarned[e.itemId] ?? 0) + Math.floor(e.qty)
      } else if (e.t === 'exp' && e.amount > 0) {
        b.expEarned += Math.floor(e.amount)
      } else if (e.t === 'damage' && e.side === 0) {
        b.damageTaken += e.amount
      } else if (e.t === 'moveLearnable') {
        let set = b.learnableMoves.get(e.partyIndex)
        if (!set) { set = new Set(); b.learnableMoves.set(e.partyIndex, set) }
        set.add(e.moveId)
      } else if (e.t === 'evolveReady') {
        b.evolutionsReady.set(e.partyIndex, e.toSpeciesId)
      }
    }
    const viewEvents = perspective(events, 0)
    const request = b.engine.finished ? { kind: 'wait' as const } : b.engine.request(0)
    return { events: viewEvents, request }
  }

  function finishBattle(p: Player, b: ActiveBattle): ServerMsg {
    b.done = true
    activeBattles.delete(p.id)
    const rec = getRecord(p.id)
    if (!rec) {
      return { t: 'error', code: 'not_ready', message: t('net.error.not_ready') }
    }
    const save = structuredClone(rec.save)
    const ref = `battle:${b.id}`
    const result = b.engine.result ?? 'run'

    save.party = b.workingParty.map((cr) => structuredClone(cr))
    for (const spId of b.seenSpecies) {
      if (CONTENT.species[spId] && !save.dexSeen.includes(spId)) save.dexSeen.push(spId)
    }
    for (const [itemId, count] of Object.entries(b.consumedItems)) {
      const next = (save.bag[itemId] ?? 0) - count
      if (next > 0) save.bag[itemId] = next
      else delete save.bag[itemId]
      addLedger(p.id, 'item', itemId, -count, save.bag[itemId] ?? 0, ref)
    }
    if (b.expEarned > 0) {
      addLedger(p.id, 'exp', 'party', b.expEarned, b.expEarned, ref)
    }

    let moneyDelta = 0
    if (b.moneyEarned > 0) {
      save.money += b.moneyEarned
      moneyDelta += b.moneyEarned
      addLedger(p.id, 'money', 'battle', b.moneyEarned, save.money, ref)
    }
    for (const [itemId, qty] of Object.entries(b.lootEarned)) {
      save.bag[itemId] = (save.bag[itemId] ?? 0) + qty
      addLedger(p.id, 'item', itemId, qty, save.bag[itemId], ref)
    }

    let caught: Creature | undefined
    if (result === 'caught' && b.engine.caught) {
      caught = structuredClone(b.engine.caught)
      storeCreatureInSave(save, caught)
      addLedger(p.id, 'creature', caught.uid, 1, save.party.length, ref)
      if (b.bossId) {
        const wonFlag = `${gameJson.flags.bossWonPrefix}${b.bossId}`
        save.flags[wonFlag] = true
        noteRecentFlag(p.id, wonFlag)
      }
    }

    const researchItems = researchFromBattle({
      seen: [...b.seenSpecies],
      defeated: b.defeatedSpecies,
      result,
      caught: caught ? { speciesId: caught.speciesId, shiny: caught.shiny } : null,
      foeMoves: b.foeMoves,
      timeOfDay: b.init.timeOfDay,
      weather: (b.init.weather && b.init.weather !== 'none' ? b.init.weather : 'clear') as FieldWeatherKind,
      biome: b.init.biome || null,
      roamingLegend: b.roamingLegend,
    })
    if (researchItems.length) {
      const r = applyResearch(save.research ?? {}, researchItems)
      if (r.gains.length) save.research = r.state
    }

    if (b.roamingLegend && b.activeFoeSpecies) {
      const foeHpLeft = b.engine.state.sides[1]?.active?.hp ?? 0
      save.legends = onLegendBattleEnd(save.legends ?? {}, b.activeFoeSpecies, result, {
        hpLeft: foeHpLeft,
        minutes: save.clockMinutes,
      })
    }
    if (b.eventSpawnTag && b.eventStartedAt !== null && (result === 'win' || result === 'caught')) {
      save.flags[clientJson.flags.spawnTaken + b.eventSpawnTag] = b.eventStartedAt
    }

    if (result === 'win') {
      save.stats.battlesWon += 1
      if (b.trainer) {
        const trFlag = STORY_CONTENT.meta.flags.trainerWon + b.trainer.id
        save.flags[trFlag] = true
        noteRecentFlag(p.id, trFlag)
        if (b.trainer.badge && !save.badges.includes(b.trainer.badge)) {
          save.badges.push(b.trainer.badge)
          const badge = world?.badges.find((bd) => bd.id === b.trainer!.badge)
          if (badge) {
            const bFlag = `${gameJson.flags.badgePrefix}${badge.type}`
            save.flags[bFlag] = true
            noteRecentFlag(p.id, bFlag)
          }
        }
      }
      if (b.bossId) {
        const wonFlag = `${gameJson.flags.bossWonPrefix}${b.bossId}`
        save.flags[wonFlag] = true
        noteRecentFlag(p.id, wonFlag)
        if (b.tierId) {
          const inst = instanceOfBoss(b.bossId)
          const rules = inst?.def.tiers[b.tierId]
          if (inst && rules) {
            const prog = progressOf(save, inst.id)
            const periodKey = instancePeriodKey(inst.def.refresh ?? 'daily')
            const lockout = dailyLockoutStatus(prog, periodKey)
            const canGrantRepeatReward = b.firstClear || lockout.canReward
            if (!b.firstClear && lockout.canReward) {
              recordDailyReward(prog, periodKey)
            }
            prog.clears[b.tierId] = (prog.clears[b.tierId] ?? 0) + 1
            prog.losses[b.tierId] = 0
            save.flags[GAMEPLAY.instanceDefaults.assistOfferFlag] = false

            const offPeak = isOffPeakDouble()
            let shards = canGrantRepeatReward ? ((b.firstClear ? rules.reward.shards : rules.repeat.shards) ?? 0) : 0
            if (shards > 0 && rules.reward.jackpot) {
              const jRng = new Rng(b.seed ^ 0x3c6ef372)
              if (jRng.next() < rules.reward.jackpot.chance) {
                shards *= rules.reward.jackpot.mul
              }
            }
            if (offPeak) shards *= 2
            const shardItem = GAMEPLAY.instanceDefaults.shardItem
            if (shards > 0 && shardItem && CONTENT.items[shardItem]) {
              save.bag[shardItem] = (save.bag[shardItem] ?? 0) + Math.floor(shards)
              addLedger(p.id, 'item', shardItem, Math.floor(shards), save.bag[shardItem], ref)
            }

            const summary = b.engine.summary()
            checkInstanceAchievements(prog, inst.def, {
              tierId: b.tierId,
              win: true,
              turns: summary.turns,
              damageTaken: b.damageTaken,
              partySize: 1,
            })

            const baseMoney = canGrantRepeatReward ? (b.firstClear ? (rules.reward.money ?? 0) : (rules.repeat.money ?? 0)) : 0
            const rewardMoney = baseMoney * (offPeak ? 2 : 1)
            if (rewardMoney > 0) {
              save.money += rewardMoney
              moneyDelta += rewardMoney
              addLedger(p.id, 'money', 'boss_reward', rewardMoney, save.money, ref)
            }
            if (b.firstClear && rules.firstReward.items) {
              for (const [itemId, qty] of Object.entries(rules.firstReward.items)) {
                if (CONTENT.items[itemId] && qty > 0) {
                  save.bag[itemId] = (save.bag[itemId] ?? 0) + Math.floor(qty)
                  addLedger(p.id, 'item', itemId, Math.floor(qty), save.bag[itemId], ref)
                }
              }
            }
            if (b.captureAfterWin && (b.firstClear || (rules.repeat.capture && lockout.canRoll))) {
              pendingContracts.set(b.id, {
                battleId: b.id,
                playerId: p.id,
                bossId: b.bossId,
                tierId: b.tierId,
                runSeq: b.runSeq,
                signed: false,
              })
            }
          }
        }
      }
    } else if (result === 'lose' || result === 'draw') {
      if (b.bossId && b.tierId) {
        const inst = instanceOfBoss(b.bossId)
        if (inst) {
          const prog = progressOf(save, inst.id)
          prog.losses[b.tierId] = (prog.losses[b.tierId] ?? 0) + 1
          const summary = b.engine.summary()
          const startBaits = b.init.sides[0].items ?? {}
          const hintKey = pickLossHint(inst.def, summary, startBaits, CONTENT)
          if (GAMEPLAY.instanceDefaults.lossHintFlag) {
            save.flags[GAMEPLAY.instanceDefaults.lossHintFlag] = hintKey.slice(hintKey.lastIndexOf('.') + 1)
          }
          save.flags[GAMEPLAY.instanceDefaults.assistOfferFlag] = shouldOfferAssist(
            GAMEPLAY.instanceDefaults,
            prog.losses[b.tierId],
            summary,
          )
        }
      }
    }
    const committed = commitSave(p.id, save, { ref, notify: false })
    return {
      t: 'battle.end',
      battleId: b.id,
      result,
      moneyDelta,
      ...(caught ? { caught } : {}),
      save: committed.save,
      rev: committed.rev,
    }
  }
  function handleBattleStart(p: Player, msg: Extract<ClientMsg, { t: 'battle.start' }>): void {
    for (const [cid, pc] of [...pendingContracts.entries()]) {
      if (pc.playerId === p.id) pendingContracts.delete(cid)
    }
    const rec = getRecord(p.id)
    if (!rec) {
      core.error(p, 'not_ready')
      return
    }
    const save = structuredClone(rec.save)
    if (!save.party.some((c) => c.hp > 0)) {
      core.error(p, 'invalid_encounter')
      return
    }
    const seed = randomInt(1, 0x7fffffff)
    const rng = new Rng(seed ^ 0x5bd1e995)
    const map = world ? getMap(world, p.state.map) : null
    const region = map ? regionAt(map, p.state.x, p.state.y) : null
    const biome = region?.biome ?? CONTENT.biomes[0]?.id ?? ''
    const timeOfDay = msg.timeOfDay && ['dawn', 'day', 'dusk', 'night'].includes(msg.timeOfDay) ? msg.timeOfDay : 'day'
    const weather = msg.weather && CONTENT.weatherById[msg.weather] ? msg.weather : undefined
    const workingParty = structuredClone(save.party)
    const playerSide: BattleSideInit = {
      kind: 'player',
      name: save.name,
      party: workingParty,
      sprite: save.avatar,
      items: structuredClone(save.bag),
    }

    let init: BattleInit
    let trainer: TrainerDef | null = null
    let bossId: string | null = null
    let tierId: string | null = null
    let battleRunSeq = 0
    let firstClear = false
    const captureAfterWin = msg.captureAfterWin === true
    let roamingLegend = false
    let eventSpawnTag: string | null = null
    let eventStartedAt: number | null = null

    if (msg.kind === 'wild') {
      const m = playerMetrics(p.id)
      m.encountersSinceCheck += 1
      if (m.encountersSinceCheck >= 20 && m.stepsSinceCheck < 5) {
        audit(p.id, 'anomaly.encounter_step_ratio', { encounters: m.encountersSinceCheck, steps: m.stepsSinceCheck, map: p.state.map }, 2, p.ip)
      }
      let speciesId = msg.speciesId
      let level = msg.level
      let legendCarriedHp: number | undefined
      let scriptedMoves: string[] | undefined
      let scriptedGradeFloor: GradeDef['id'] | undefined
      let scriptedCatchRateMul: number | undefined

      if (speciesId !== undefined) {
        const sp = CONTENT.species[speciesId]
        if (!sp) {
          audit(p.id, 'battle.invalid_encounter', { reason: 'unknown_species', speciesId }, 2, p.ip)
          core.error(p, 'invalid_encounter')
          return
        }
        const bossDef = CONTENT.bossBySpecies[speciesId]
        if (bossDef?.scriptedOnly) {
          const wildStep = findWildBattleStepOnMap(p, save, speciesId)
          if (!msg.scripted || (world && !wildStep)) {
            audit(p.id, 'battle.invalid_encounter', { reason: 'scripted_only_boss', speciesId }, 3, p.ip)
            core.error(p, 'invalid_encounter')
            return
          }
        }
        if (msg.scripted) {
          const wildStep = findWildBattleStepOnMap(p, save, speciesId)
          if (world && !wildStep) {
            audit(p.id, 'battle.invalid_encounter', { reason: 'unverified_scripted_encounter', speciesId, map: p.state.map }, 3, p.ip)
            core.error(p, 'invalid_encounter')
            return
          }
          if (wildStep) {
            level = wildStep.level
            scriptedMoves = wildStep.moves
            scriptedGradeFloor = wildStep.gradeFloor
            scriptedCatchRateMul = wildStep.catchRateMul
          } else {
            if (Array.isArray(msg.moves) && msg.moves.every((mv) => typeof mv === 'string' && CONTENT.moves[mv])) {
              scriptedMoves = msg.moves
            }
            if (typeof msg.gradeFloor === 'string' && CONTENT.quality.grades.some((g) => g.id === msg.gradeFloor)) {
              scriptedGradeFloor = msg.gradeFloor as GradeDef['id']
            }
            scriptedCatchRateMul = msg.catchRateMul
          }
        } else {
          const legDef = GAMEPLAY.legendBySpecies[speciesId]
          const inTable = Boolean(region && region.encounters.length > 0 && region.encounters.some((s) => s.species === speciesId))
          const evSpawn = findActiveEventWildForPlayer(p, save, speciesId, map, region)
          if (legDef && !inTable && !evSpawn) {
            if (!msg.roamer) {
              audit(p.id, 'battle.invalid_encounter', { reason: 'legend_requires_roamer', speciesId, map: p.state.map }, 3, p.ip)
              core.error(p, 'invalid_encounter')
              return
            }
            const ectx = buildServerEventContext(p, save, (weather && weather !== 'none' ? weather : 'clear') as FieldWeatherKind)
            const condOk = world ? evaluateCondition(legDef.when, ectx) : evaluateProgress(legDef.when, ectx)
            if (!condOk) {
              audit(p.id, 'battle.invalid_encounter', { reason: 'legend_condition_not_met', speciesId, map: p.state.map }, 3, p.ip)
              core.error(p, 'invalid_encounter')
              return
            }
            if (world) {
              if (!map || !clientJson.legends.mapKinds.includes(map.kind)) {
                audit(p.id, 'battle.invalid_encounter', { reason: 'legend_invalid_map', speciesId, map: p.state.map }, 3, p.ip)
                core.error(p, 'invalid_encounter')
                return
              }
              const near = legendsNear(worldOrigin(world), { x: p.state.x, y: p.state.y }, save.clockMinutes, serverEventSeed(save), save.legends ?? {})
              const hit = near.find((n) => n.legend.species === speciesId && n.proximity === 'appear')
              if (!hit) {
                audit(p.id, 'battle.invalid_encounter', { reason: 'legend_not_near', speciesId, map: p.state.map }, 3, p.ip)
                core.error(p, 'invalid_encounter')
                return
              }
              level = hit.legend.level
              legendCarriedHp = hit.legend.hp
            }
            roamingLegend = true
          } else if (world) {
            if (!inTable && !evSpawn) {
              audit(p.id, 'battle.invalid_encounter', {
                reason: (!region || region.encounters.length === 0) ? 'no_encounters_in_region' : 'species_not_in_region_table',
                speciesId,
                map: p.state.map,
                region: region?.id ?? null,
              }, 2, p.ip)
              core.error(p, 'invalid_encounter')
              return
            }
            if (evSpawn && !inTable) {
              level = evSpawn.level
              eventSpawnTag = evSpawn.tag
              eventStartedAt = evSpawn.startedAt
            }
          }
        }
      } else if (region && region.encounters.length > 0) {
        const slot = rng.pick(region.encounters)
        speciesId = slot.species
        level = rng.int(Math.min(slot.minLevel, slot.maxLevel), Math.max(slot.minLevel, slot.maxLevel))
      } else if (world) {
        audit(p.id, 'battle.invalid_encounter', { reason: 'no_encounters_in_region', map: p.state.map }, 2, p.ip)
        core.error(p, 'invalid_encounter')
        return
      } else {
        speciesId = CONTENT.speciesList[0]?.id ?? ''
        level = 3
      }
      let clampedLevel = typeof level === 'number' && Number.isInteger(level) ? level : 3
      if (clampedLevel < 1 || clampedLevel > CONTENT.config.party.maxLevel) {
        audit(p.id, 'battle.invalid_encounter', { reason: 'level_out_of_bounds', level }, 3, p.ip)
        core.error(p, 'invalid_encounter')
        return
      }
      if (world && !msg.scripted && !roamingLegend && !eventSpawnTag) {
        const slots = (region?.encounters ?? []).filter((s) => s.species === speciesId)
        if (slots.length > 0) {
          const bonus = speciesBehavior(speciesId, CONTENT).levelBonus
          const minLv = Math.min(...slots.map((s) => Math.min(s.minLevel, s.maxLevel)))
          const maxLv = Math.max(...slots.map((s) => Math.max(s.minLevel, s.maxLevel))) + bonus
          clampedLevel = Math.max(minLv, Math.min(maxLv, clampedLevel))
        }
      }
      const foe = createCreature(speciesId, clampedLevel, {
        rng,
        shiny: rollShiny(rng, CONTENT),
        caughtMap: p.state.map,
        ...(scriptedMoves?.length ? { moves: scriptedMoves } : {}),
        ...(scriptedGradeFloor ? { gradeFloor: scriptedGradeFloor } : {}),
      }, CONTENT)
      if (legendCarriedHp !== undefined) {
        foe.hp = Math.max(1, Math.min(foe.hp, legendCarriedHp))
      }
      const wildBoss = CONTENT.bossBySpecies[speciesId]
      if (wildBoss) {
        bossId = wildBoss.id
        foe.hp = maxHp(foe, CONTENT)
      }
      const card = partyExpMods(workingParty, save.badges.length, CONTENT)
      const mods: BattleModifiers = {}
      if (card.expByParty.some((v) => v !== 1)) mods.expByParty = card.expByParty
      if (card.benchExp.some((v) => v > 0)) mods.benchExp = card.benchExp
      if (card.levelCapByParty.some((v) => v > 0)) {
        mods.levelCapByParty = card.levelCapByParty
        mods.expCapByParty = card.expCapByParty
      }
      const effCatchMul = msg.scripted ? scriptedCatchRateMul : (clampedLevel <= 15 && !msg.roamer ? msg.catchRateMul : undefined)
      if (typeof effCatchMul === 'number' && effCatchMul > 0 && effCatchMul <= 5) {
        mods.catchRate = effCatchMul
      }
      init = {
        seed,
        sides: [
          playerSide,
          wildBoss
            ? { kind: 'wild', name: CONTENT.species[speciesId]?.nameZh ?? speciesId, party: [foe], aiLevel: 3, boss: wildBoss.id }
            : { kind: 'wild', name: CONTENT.species[speciesId]?.nameZh ?? speciesId, party: [foe], ...(msg.flee ? { flee: msg.flee } : {}) },
        ],
        isWild: true,
        canRun: wildBoss?.canRun ?? true,
        canCatch: true,
        expGain: true,
        biome,
        timeOfDay,
        ...(weather ? { weather } : {}),
        ...(Object.keys(mods).length ? { mods } : {}),
      }
    } else if (msg.kind === 'trainer') {
      const trId = typeof msg.trainerId === 'string' ? msg.trainerId : ''
      if (world && map?.infinite) {
        const near = objectsInRect(map, Math.floor(p.state.x) - 24, Math.floor(p.state.y) - 24, Math.floor(p.state.x) + 25, Math.floor(p.state.y) + 25)
        registerFrontierRefs(world, near.npcs)
      }
      const tr = resolveTrainerDef(p, save, trId, map)
      if (!tr) {
        audit(p.id, 'battle.invalid_trainer', { trainerId: trId }, 2, p.ip)
        core.error(p, 'invalid_encounter')
        return
      }
      if (world && !isTrainerOnPlayerMap(p, save, tr.id)) {
        audit(p.id, 'battle.invalid_trainer', { trainerId: tr.id, map: p.state.map, reason: 'trainer_not_on_map' }, 3, p.ip)
        core.error(p, 'invalid_encounter')
        return
      }
      if (save.flags[STORY_CONTENT.meta.flags.trainerWon + tr.id] && !tr.rematchable) {
        audit(p.id, 'battle.trainer_replay', { trainerId: tr.id }, 2, p.ip)
        core.error(p, 'trainer_already_defeated')
        return
      }
      trainer = tr
      const foeParty: Creature[] = []
      for (const e of tr.party) {
        if (!e.species || !CONTENT.species[e.species]) continue
        foeParty.push(createCreature(e.species, e.level, {
          rng,
          otName: tr.nameZh,
          otId: tr.id,
          nature: CONTENT.quality.npcNature,
          ...(e.moves?.length ? { moves: e.moves } : {}),
        }, CONTENT))
      }
      if (!foeParty.length) {
        core.error(p, 'invalid_encounter')
        return
      }
      const card = partyExpMods(workingParty, save.badges.length, CONTENT)
      const mods: BattleModifiers = {}
      if (card.expByParty.some((v) => v !== 1)) mods.expByParty = card.expByParty
      if (card.benchExp.some((v) => v > 0)) mods.benchExp = card.benchExp
      if (card.levelCapByParty.some((v) => v > 0)) {
        mods.levelCapByParty = card.levelCapByParty
        mods.expCapByParty = card.expCapByParty
      }
      init = {
        seed,
        sides: [
          playerSide,
          {
            kind: 'trainer',
            name: tr.nameZh,
            party: foeParty,
            trainerClass: tr.classZh,
            sprite: tr.sprite,
            aiLevel: tr.aiLevel,
            ...(tr.items ? { items: { ...tr.items } } : {}),
          },
        ],
        isWild: false,
        canRun: false,
        canCatch: false,
        expGain: true,
        rewardMoney: tr.reward,
        biome,
        timeOfDay,
        ...(weather ? { weather } : {}),
        ...(Object.keys(mods).length ? { mods } : {}),
      }
    } else if (msg.kind === 'boss') {
      const bId = typeof msg.bossId === 'string' ? msg.bossId : ''
      const tId = typeof msg.tierId === 'string' ? msg.tierId : ''
      const def = CONTENT.bosses[bId]
      const tier = def?.tiers?.[tId]
      const inst = instanceOfBoss(bId)
      const rules = inst?.def.tiers[tId]
      if (!def || !tier || !inst || !rules) {
        audit(p.id, 'battle.invalid_boss', { bossId: bId, tierId: tId }, 2, p.ip)
        core.error(p, 'invalid_encounter')
        return
      }
      if (world && !isBossAccessibleOnPlayerMap(p, save, bId, inst.id, inst.def.entry?.map)) {
        audit(p.id, 'battle.invalid_boss', { bossId: bId, tierId: tId, map: p.state.map, reason: 'not_at_boss_entry' }, 3, p.ip)
        core.error(p, 'invalid_encounter')
        return
      }
      bossId = bId
      tierId = tId
      const prog = progressOf(save, inst.id)
      const boolFlags: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(save.flags)) {
        if (v !== undefined && v !== false && v !== 0 && v !== '') boolFlags[k] = true
      }
      const unlockCheck = isTierUnlocked(rules, save.badges, boolFlags, 1)
      const unlockTier = rules.unlock && 'tier' in rules.unlock && typeof rules.unlock.tier === 'string' ? rules.unlock.tier : undefined
      if (!unlockCheck.unlocked || (unlockTier && (prog.clears[unlockTier] ?? 0) <= 0)) {
        audit(p.id, 'battle.boss_tier_locked', {
          bossId: bId,
          tierId: tId,
          reason: unlockCheck.reason ?? unlockTier,
          badges: save.badges.length,
        }, 2, p.ip)
        core.error(p, 'invalid_encounter')
        return
      }
      firstClear = (prog.clears[tId] ?? 0) === 0
      const periodKey = instancePeriodKey(inst.def.refresh ?? 'daily')
      const lockout = dailyLockoutStatus(prog, periodKey)
      if (!firstClear && !lockout.canReward && (!captureAfterWin || !rules.repeat.capture || !lockout.canRoll)) {
        audit(p.id, 'battle.boss_daily_lockout', { bossId: bId, tierId: tId, periodKey }, 2, p.ip)
        core.error(p, 'invalid_encounter')
        return
      }
      save.rollSeed ??= hashString(save.playerId) >>> 0
      prog.runSeq += 1
      battleRunSeq = prog.runSeq
      commitSave(p.id, save, { ref: `boss_enter:${bId}:${tId}`, notify: false })

      const foe = createBossCreature(bId, tier.level, new Rng(seed ^ 0x5bd1e995), CONTENT)
      const baitItems = Object.fromEntries(
        Object.entries(save.bag).filter(([id]) => CONTENT.items[id]?.effect.kind === 'bait'),
      )
      init = buildBossInit(bId, workingParty, {
        seed,
        tier: tId,
        boss: foe,
        c: CONTENT,
        expGain: true,
        playerName: save.name,
        ...(save.avatar ? { playerSprite: save.avatar } : {}),
        biome,
        timeOfDay,
        ...(weather ? { weather } : {}),
        ...(msg.assist || (msg.assist === undefined && save.flags[GAMEPLAY.instanceDefaults.assistFlag]) ? { assist: true } : {}),
        ...(msg.coach ? { coach: true, skipBrief: !!save.flags['ds:skipBrief'], items: baitItems } : {}),
      })
      if (captureAfterWin && (firstClear || rules.repeat.capture)) init.captureAfterWin = true
      const card = partyExpMods(workingParty, save.badges.length, CONTENT)
      const mods: BattleModifiers = {}
      if (card.expByParty.some((v) => v !== 1)) mods.expByParty = card.expByParty
      if (!firstClear && rules.repeat.expMul !== 1) {
        mods.expByParty = workingParty.map((_, i) => (mods.expByParty?.[i] ?? 1) * rules.repeat.expMul)
      }
      if (card.benchExp.some((v) => v > 0)) mods.benchExp = card.benchExp
      if (card.levelCapByParty.some((v) => v > 0)) {
        mods.levelCapByParty = card.levelCapByParty
        mods.expCapByParty = card.expCapByParty
      }
      if (Object.keys(mods).length) init.mods = mods
    } else {
      core.error(p, 'bad_message')
      return
    }
    const clientInit = structuredClone(init)
    const engine = new BattleEngine(init, CONTENT)
    const active: ActiveBattle = {
      id: newSessionId(),
      playerId: p.id,
      kind: msg.kind,
      seed,
      init: clientInit,
      engine,
      workingParty,
      bag: structuredClone(save.bag),
      trainer,
      bossId,
      tierId,
      runSeq: battleRunSeq,
      firstClear,
      captureAfterWin,
      consumedItems: {},
      moneyEarned: 0,
      lootEarned: {},
      expEarned: 0,
      damageTaken: 0,
      seenSpecies: new Set(),
      defeatedSpecies: [],
      foeMoves: [],
      activeFoeSpecies: null,
      roamingLegend,
      eventSpawnTag,
      eventStartedAt,
      learnableMoves: new Map(),
      evolutionsReady: new Map(),
      openedAt: Date.now(),
      done: false,
    }
    activeBattles.set(p.id, active)
    const batch = drainBattle(active, engine.start())
    core.send(p, {
      t: 'battle.started',
      battleId: active.id,
      seed,
      init: clientInit,
      events: batch.events,
      request: batch.request,
    })
    if (engine.finished) {
      core.send(p, finishBattle(p, active))
    }
  }

  function parseBattleAction(raw: unknown): BattleAction | null {
    if (!isRecord(raw)) return null
    switch (raw.kind) {
      case 'move':
        return typeof raw.moveIndex === 'number' && Number.isInteger(raw.moveIndex) ? { kind: 'move', moveIndex: raw.moveIndex } : null
      case 'switch':
        return typeof raw.partyIndex === 'number' && Number.isInteger(raw.partyIndex) ? { kind: 'switch', partyIndex: raw.partyIndex } : null
      case 'item': {
        if (typeof raw.itemId !== 'string' || !raw.itemId) return null
        return typeof raw.partyIndex === 'number' && Number.isInteger(raw.partyIndex)
          ? { kind: 'item', itemId: raw.itemId, partyIndex: raw.partyIndex }
          : { kind: 'item', itemId: raw.itemId }
      }
      case 'run':
        return { kind: 'run' }
      case 'forfeit':
        return { kind: 'forfeit' }
      default:
        return null
    }
  }

  function handleBattleAction(p: Player, msg: Extract<ClientMsg, { t: 'battle.action' }>): void {
    for (const forbidden of ['result', 'exp', 'money', 'items', 'loot', 'caught', 'winner', 'reward']) {
      if (forbidden in msg) {
        audit(p.id, 'battle.tampered_action', { forbidden, battleId: msg.battleId }, 3, p.ip)
        core.error(p, 'authority_violation')
        const rec = getRecord(p.id)
        if (rec) core.send(p, { t: 'state.sync', save: rec.save, rev: rec.rev, reason: 'authority_violation' })
        return
      }
    }
    const b = activeBattles.get(p.id)
    if (!b || b.done || b.id !== msg.battleId) {
      core.error(p, 'battle_not_found')
      return
    }
    const act = parseBattleAction(msg.action)
    if (!act) {
      audit(p.id, 'battle.invalid_action', { battleId: b.id }, 2, p.ip)
      core.error(p, 'bad_message')
      return
    }
    if (act.kind === 'item') {
      if ((b.bag[act.itemId] ?? 0) <= 0) {
        audit(p.id, 'battle.item_not_owned', { battleId: b.id, itemId: act.itemId }, 2, p.ip)
        core.error(p, 'item_not_owned')
        core.send(p, {
          t: 'battle.events',
          battleId: b.id,
          events: [{ t: 'msg', text: t('battle.err.noItem') }],
          request: b.engine.request(0),
        })
        return
      }
    }
    const err = b.engine.choose(0, act)
    if (err !== null) {
      core.send(p, {
        t: 'battle.events',
        battleId: b.id,
        events: [{ t: 'msg', text: err }],
        request: b.engine.request(0),
      })
      return
    }
    const stepped = b.engine.ready() ? b.engine.step() : []
    const batch = drainBattle(b, stepped)
    core.send(p, {
      t: 'battle.events',
      battleId: b.id,
      events: batch.events,
      request: batch.request,
    })
    if (b.engine.finished) {
      core.send(p, finishBattle(p, b))
    }
  }

  function handleBattleContract(p: Player, msg: Extract<ClientMsg, { t: 'battle.contract' }>): void {
    const pending = pendingContracts.get(msg.battleId)
    if (!pending || pending.playerId !== p.id || pending.signed || pending.bossId !== msg.bossId || pending.tierId !== msg.tierId) {
      audit(p.id, 'battle.invalid_contract', { battleId: msg.battleId, bossId: msg.bossId, tierId: msg.tierId }, 3, p.ip)
      core.error(p, 'invalid_contract')
      return
    }
    const inst = instanceOfBoss(msg.bossId)
    const rules = inst?.def.tiers[msg.tierId]
    const rec = getRecord(p.id)
    if (!inst || !rules || !rec) {
      core.error(p, 'invalid_contract')
      return
    }
    const save = structuredClone(rec.save)
    const ballId = typeof msg.ballId === 'string' && CONTENT.items[msg.ballId]?.effect.kind === 'ball'
      ? msg.ballId
      : ''
    if (!ballId) {
      audit(p.id, 'battle.contract_ball_not_owned', { battleId: msg.battleId, ballId: msg.ballId }, 2, p.ip)
      core.error(p, 'item_not_owned')
      return
    }
    const heldBalls = Object.entries(save.bag).filter(([id, n]) => n > 0 && CONTENT.items[id]?.effect.kind === 'ball')
    if (heldBalls.length > 0 ? (save.bag[ballId] ?? 0) <= 0 : ballId !== BATTLE_CONTRACT_DEFAULT_BALL) {
      audit(p.id, 'battle.contract_ball_not_owned', { battleId: msg.battleId, ballId }, 2, p.ip)
      core.error(p, 'item_not_owned')
      return
    }
    pending.signed = true
    pendingContracts.delete(msg.battleId)

    const prog = progressOf(save, inst.id)
    const periodKey = instancePeriodKey(inst.def.refresh ?? 'daily')
    const lockout = dailyLockoutStatus(prog, periodKey)
    const boundRunSeq = pending.runSeq
    const first = (prog.captures[msg.tierId] ?? 0) === 0
    if (
      (!first && (!rules.repeat.capture || !lockout.canRoll)) ||
      (prog.lastRollRun?.[msg.tierId] !== undefined && prog.lastRollRun[msg.tierId] >= boundRunSeq)
    ) {
      const committed = commitSave(p.id, save, { ref: `contract:${msg.battleId}` })
      core.send(p, { t: 'battle.contracted', battleId: msg.battleId, signed: null, save: committed.save, rev: committed.rev })
      return
    }
    if (!first) {
      recordDailyRoll(prog, periodKey)
    }
    save.rollSeed ??= hashString(save.playerId) >>> 0
    const seed = captureSeed(save.rollSeed, inst.id, msg.tierId, first ? 0 : boundRunSeq)
    const ballBonus = CONTENT.quality.capture.ballBonus?.[ballId] ?? 0
    const isMaster = ballId === CONTENT.quality.capture.masterBall && (save.bag[ballId] ?? 0) > 0
    const curPity = prog.pity?.[msg.tierId] ?? 0
    const odds = contractOdds(rules, ballBonus, !first, curPity)
    const rollRng = new Rng(seed)
    const success = isMaster || odds.guaranteed || rollContractOutcome(rollRng, odds.chance)
    prog.lastRollRun ??= {}
    prog.lastRollRun[msg.tierId] = boundRunSeq
    prog.pity ??= {}

    if (BATTLE_CONTRACT_CONSUME_BALL && (save.bag[ballId] ?? 0) > 0) {
      if (save.bag[ballId] > 1) save.bag[ballId] -= 1
      else delete save.bag[ballId]
      addLedger(p.id, 'item', ballId, -1, save.bag[ballId] ?? 0, `contract:${msg.battleId}`)
    }

    if (!success) {
      prog.pity[msg.tierId] = curPity + 1
      const failShard = rules.repeat.shards ?? GAMEPLAY.instanceDefaults.failShardQty
      const shardItem = GAMEPLAY.instanceDefaults.shardItem
      if (failShard && failShard > 0 && shardItem && CONTENT.items[shardItem]) {
        save.bag[shardItem] = (save.bag[shardItem] ?? 0) + failShard
        addLedger(p.id, 'item', shardItem, failShard, save.bag[shardItem], `contract_fail:${msg.battleId}`)
      }
      const committed = commitSave(p.id, save, { ref: `contract_fail:${msg.battleId}` })
      core.send(p, {
        t: 'battle.contracted',
        battleId: msg.battleId,
        signed: null,
        save: committed.save,
        rev: committed.rev,
      })
      return
    }

    prog.pity[msg.tierId] = 0
    const card = rollBossCard(new Rng(seed), msg.bossId, msg.tierId, rules, {
      first,
      run: String(boundRunSeq),
      at: Date.now(),
      otName: save.name,
      otId: save.playerId,
      ballId,
      caughtMap: p.state.map,
    }, CONTENT)
    const stored = storeCreatureInSave(save, card)
    let filed: 'party' | 'box' = stored?.where ?? 'box'
    if (!stored) {
      if (!save.boxes.length) save.boxes.push([])
      save.boxes[save.boxes.length - 1].push(card)
      save.stats.caught += 1
      filed = 'box'
    }
    prog.captures[msg.tierId] = (prog.captures[msg.tierId] ?? 0) + 1
    addLedger(p.id, 'creature', card.uid, 1, save.party.length, `contract:${msg.battleId}`)
    const committed = commitSave(p.id, save, { ref: `contract:${msg.battleId}` })
    core.send(p, {
      t: 'battle.contracted',
      battleId: msg.battleId,
      signed: { card, where: filed, newEntry: stored?.newCaught ?? false },
      save: committed.save,
      rev: committed.rev,
    })
  }

  // ------------------------------------------------------------------ Economy & Progression

  function handleShopBuy(p: Player, msg: Extract<ClientMsg, { t: 'shop.buy' }>): void {
    const rec = getRecord(p.id)
    if (!rec) { core.error(p, 'not_ready'); return }
    const item = typeof msg.itemId === 'string' ? CONTENT.items[msg.itemId] : undefined
    const qty = typeof msg.qty === 'number' && Number.isInteger(msg.qty) ? msg.qty : 0
    if (!item || !item.buyable || item.price <= 0 || qty <= 0 || qty > 99) {
      audit(p.id, 'shop.invalid_buy', { itemId: msg.itemId, qty: msg.qty }, 2, p.ip)
      core.error(p, 'shop_invalid')
      return
    }
    if (!isShopItemUnlockedForPlayer(p, rec.save, item.id)) {
      audit(p.id, 'shop.locked_tier_item', { itemId: item.id, badges: rec.save.badges.length, map: p.state.map }, 2, p.ip)
      core.error(p, 'shop_invalid')
      return
    }
    const active = activeEvents(rec.save.events ?? {}, rec.save.clockMinutes)
    const evModsHere = eventModifiers(active, { map: p.state.map, x: p.state.x, y: p.state.y }, rec.save.clockMinutes)
    let serverMul = modifierValue(evModsHere, 'shopPrice', { category: item.category })
    if (world && p.state.map !== world.startMap && p.lastOverworld) {
      const ow = world.maps[world.startMap]
      const r = ow ? regionAt(ow, p.lastOverworld.x, p.lastOverworld.y) : null
      const evModsOw = eventModifiers(
        active,
        { map: world.startMap, x: Math.floor(p.lastOverworld.x), y: Math.floor(p.lastOverworld.y), ...(r ? { region: r.id } : {}) },
        rec.save.clockMinutes,
      )
      serverMul = Math.min(serverMul, modifierValue(evModsOw, 'shopPrice', { category: item.category }))
    }
    const reqMul = typeof msg.priceMul === 'number' && isFiniteNumber(msg.priceMul) && msg.priceMul >= 0.5 && msg.priceMul <= 2 ? msg.priceMul : 1
    const mul = reqMul < 1 ? Math.max(reqMul, serverMul) : reqMul
    const unitPrice = shopBuyPrice(item, mul)
    const total = unitPrice * qty
    if (rec.save.money < total) {
      audit(p.id, 'shop.insufficient_money', { itemId: item.id, qty, total, have: rec.save.money }, 2, p.ip)
      core.error(p, 'insufficient_money')
      return
    }
    const save = structuredClone(rec.save)
    save.money -= total
    save.bag[item.id] = (save.bag[item.id] ?? 0) + qty
    const ref = `shop:buy:${item.id}`
    addLedger(p.id, 'money', item.id, -total, save.money, ref)
    addLedger(p.id, 'item', item.id, qty, save.bag[item.id], ref)
    commitSave(p.id, save, { ref })
  }

  function handleShopSell(p: Player, msg: Extract<ClientMsg, { t: 'shop.sell' }>): void {
    const rec = getRecord(p.id)
    if (!rec) { core.error(p, 'not_ready'); return }
    const item = typeof msg.itemId === 'string' ? CONTENT.items[msg.itemId] : undefined
    const qty = typeof msg.qty === 'number' && Number.isInteger(msg.qty) ? msg.qty : 0
    if (!item || !canSell(item) || qty <= 0 || qty > 999) {
      audit(p.id, 'shop.invalid_sell', { itemId: msg.itemId, qty: msg.qty }, 2, p.ip)
      core.error(p, 'shop_invalid')
      return
    }
    const have = rec.save.bag[item.id] ?? 0
    if (have < qty) {
      audit(p.id, 'shop.sell_not_owned', { itemId: item.id, qty, have }, 3, p.ip)
      core.error(p, 'item_not_owned')
      return
    }
    const save = structuredClone(rec.save)
    const next = have - qty
    if (next > 0) save.bag[item.id] = next
    else delete save.bag[item.id]
    const total = sellPrice(item, CONTENT) * qty
    save.money += total
    const ref = `shop:sell:${item.id}`
    addLedger(p.id, 'item', item.id, -qty, save.bag[item.id] ?? 0, ref)
    addLedger(p.id, 'money', item.id, total, save.money, ref)
    commitSave(p.id, save, { ref })
  }

  function handleItemUse(p: Player, msg: Extract<ClientMsg, { t: 'item.use' }>): void {
    const rec = getRecord(p.id)
    if (!rec) { core.error(p, 'not_ready'); return }
    const item = typeof msg.itemId === 'string' ? CONTENT.items[msg.itemId] : undefined
    const have = rec.save.bag[msg.itemId] ?? 0
    if (!item || have <= 0) {
      audit(p.id, 'item.not_owned', { itemId: msg.itemId, have }, 3, p.ip)
      core.error(p, 'item_not_owned')
      return
    }
    const save = structuredClone(rec.save)
    const e = item.effect
    let consumed = true
    if (e.kind === 'repel') {
      save.repelSteps = e.steps
    } else if (e.kind === 'escape') {
      // Consumes the escape rope; overworld warp follows on the client.
    } else {
      const idx = typeof msg.partyIndex === 'number' && Number.isInteger(msg.partyIndex) ? msg.partyIndex : -1
      const cr = save.party[idx]
      if (!cr || medicineBlocker(cr, item, CONTENT) !== null) {
        audit(p.id, 'item.invalid_use', { itemId: item.id, partyIndex: msg.partyIndex }, 2, p.ip)
        core.error(p, 'invalid_item_use')
        return
      }
      switch (e.kind) {
        case 'heal':
        case 'cure':
        case 'healCure':
        case 'revive':
        case 'pp':
          applyMedicine(cr, item, typeof msg.moveIndex === 'number' ? msg.moveIndex : -1, CONTENT)
          break
        case 'levelUp': {
          const sp = CONTENT.species[cr.speciesId]
          if (!sp) { core.error(p, 'invalid_item_use'); return }
          const deltaExp = expForLevel(sp.growth, cr.level + 1, CONTENT) - cr.exp
          gainExp(cr, deltaExp, CONTENT)
          if (cr.hp > 0) cr.hp = Math.min(maxHp(cr, CONTENT), cr.hp)
          addLedger(p.id, 'exp', cr.uid, deltaExp, cr.exp, `item:${item.id}`)
          break
        }
        case 'evolve': {
          const to = CONTENT.species[cr.speciesId]?.evolvesTo?.id
          if (!to || !CONTENT.species[to]) { core.error(p, 'invalid_item_use'); return }
          evolve(cr, to, CONTENT)
          if (!save.dexSeen.includes(to)) save.dexSeen.push(to)
          if (!save.dexCaught.includes(to)) save.dexCaught.push(to)
          break
        }
        case 'chip': {
          if (teachState(cr, e.move, CONTENT) !== 'ok') { core.error(p, 'invalid_item_use'); return }
          const mv = CONTENT.moves[e.move]
          if (!mv) { core.error(p, 'invalid_item_use'); return }
          const slot = { id: e.move, pp: mv.pp, ppMax: mv.pp }
          if (cr.moves.length < CONTENT.config.party.maxMoves) cr.moves.push(slot)
          else if (typeof msg.moveIndex === 'number' && msg.moveIndex >= 0 && msg.moveIndex < cr.moves.length) cr.moves[msg.moveIndex] = slot
          else { core.error(p, 'invalid_item_use'); return }
          consumed = true
          break
        }
        case 'nature': {
          const nat = typeof msg.natureId === 'string' ? CONTENT.quality.natures.find((n) => n.id === msg.natureId) : undefined
          if (!nat || nat.id === cr.nature) { core.error(p, 'invalid_item_use'); return }
          cr.nature = nat.id
          cr.hp = Math.min(cr.hp, maxHp(cr, CONTENT))
          break
        }
        default:
          core.error(p, 'invalid_item_use')
          return
      }
    }
    if (consumed) {
      if (have > 1) save.bag[item.id] = have - 1
      else delete save.bag[item.id]
      addLedger(p.id, 'item', item.id, -1, save.bag[item.id] ?? 0, `item:use:${item.id}`)
    }
    commitSave(p.id, save, { ref: `item:use:${item.id}` })
  }

  function handleExchangeDeal(p: Player, msg: Extract<ClientMsg, { t: 'exchange.deal' }>): void {
    const rec = getRecord(p.id)
    if (!rec) { core.error(p, 'not_ready'); return }
    const offers = typeof msg.desk === 'string' ? offersOf(msg.desk) : []
    const offer = typeof msg.offerIndex === 'number' ? offers[msg.offerIndex] : undefined
    const qty = typeof msg.qty === 'number' && Number.isInteger(msg.qty) ? msg.qty : 0
    if (!offer || qty <= 0 || !unlocked(offer, rec.save) || timesAffordable(offer, rec.save) < qty) {
      audit(p.id, 'exchange.invalid_deal', { desk: msg.desk, offerIndex: msg.offerIndex, qty }, 2, p.ip)
      core.error(p, 'shop_invalid')
      return
    }
    const save = structuredClone(rec.save)
    if (!takeOffer(offer, save, qty)) { core.error(p, 'shop_invalid'); return }
    const ref = `exchange:${msg.desk}:${msg.offerIndex}`
    recordSaveDiffLedger(p.id, rec.save, save, ref)
    commitSave(p.id, save, { ref })
  }

  function learnsetMovesAtOrBelow(speciesId: string, level: number): Set<string> {
    const out = new Set<string>()
    const seen = new Set<string>()
    let sp: SpeciesDef | undefined = CONTENT.species[speciesId]
    while (sp && !seen.has(sp.id)) {
      seen.add(sp.id)
      for (const e of sp.learnset) {
        if (e.level <= level) out.add(e.move)
      }
      sp = sp.evolvesFrom ? CONTENT.species[sp.evolvesFrom] : undefined
    }
    return out
  }

  function resolvePartyIndex(party: readonly Creature[], uid?: string, partyIndex?: number): number {
    if (typeof uid === 'string' && uid) {
      const byUid = party.findIndex((c) => c.uid === uid)
      if (byUid >= 0) return byUid
    }
    return typeof partyIndex === 'number' && Number.isInteger(partyIndex) && partyIndex >= 0 && partyIndex < party.length
      ? partyIndex
      : -1
  }

  function handleCreatureEvolve(p: Player, msg: Extract<ClientMsg, { t: 'creature.evolve' }>): void {
    const rec = getRecord(p.id)
    if (!rec) { core.error(p, 'not_ready'); return }
    const active = activeBattles.get(p.id)
    const saveIdx = resolvePartyIndex(rec.save.party, msg.uid, msg.partyIndex)
    const battleIdx = active ? resolvePartyIndex(active.workingParty, msg.uid, msg.partyIndex) : -1
    const cr = (battleIdx >= 0 ? active?.workingParty[battleIdx] : undefined) ?? (saveIdx >= 0 ? rec.save.party[saveIdx] : undefined)
    const target = typeof msg.toSpeciesId === 'string' ? msg.toSpeciesId : ''
    if (!cr || !CONTENT.species[target]) {
      audit(p.id, 'creature.invalid_evolve', { partyIndex: msg.partyIndex, uid: msg.uid, toSpeciesId: msg.toSpeciesId }, 2, p.ip)
      core.error(p, 'authority_violation')
      return
    }
    if (cr.speciesId === target) return
    const readyTarget = battleIdx >= 0 ? active?.evolutionsReady.get(battleIdx) : undefined
    if (evolutionTarget(cr, CONTENT) !== target && readyTarget !== target) {
      audit(p.id, 'creature.invalid_evolve', { partyIndex: msg.partyIndex, uid: msg.uid, toSpeciesId: msg.toSpeciesId }, 2, p.ip)
      core.error(p, 'authority_violation')
      return
    }
    if (active && battleIdx >= 0 && active.workingParty[battleIdx]) {
      evolve(active.workingParty[battleIdx], target, CONTENT)
    }
    const save = structuredClone(rec.save)
    if (saveIdx >= 0 && save.party[saveIdx]) {
      evolve(save.party[saveIdx], target, CONTENT)
    }
    if (!save.dexSeen.includes(target)) save.dexSeen.push(target)
    if (!save.dexCaught.includes(target)) save.dexCaught.push(target)
    const r = applyResearch(save.research ?? {}, [{ species: target, event: { kind: 'evolve' } }])
    if (r.gains.length) save.research = r.state
    commitSave(p.id, save, { ref: `evolve:${cr.uid}:${target}`, notify: !active })
  }

  function handleCreatureLearnMove(p: Player, msg: Extract<ClientMsg, { t: 'creature.learnMove' }>): void {
    const rec = getRecord(p.id)
    if (!rec) { core.error(p, 'not_ready'); return }
    const moveId = typeof msg.moveId === 'string' ? msg.moveId : ''
    const mv = CONTENT.moves[moveId]
    const active = activeBattles.get(p.id)
    const battleIdx = active ? resolvePartyIndex(active.workingParty, msg.uid, msg.partyIndex) : -1
    const saveIdx = resolvePartyIndex(rec.save.party, msg.uid, msg.partyIndex)
    const battleCr = battleIdx >= 0 ? active?.workingParty[battleIdx] : undefined
    const saveCr = saveIdx >= 0 ? rec.save.party[saveIdx] : undefined
    const cr = battleCr ?? saveCr
    const allowedInBattle = Boolean(
      (battleIdx >= 0 && active?.learnableMoves.get(battleIdx)?.has(moveId)) ||
      (typeof msg.partyIndex === 'number' && active?.learnableMoves.get(msg.partyIndex)?.has(moveId)),
    )
    const allowedByLearnset = Boolean(
      (cr && learnsetMovesAtOrBelow(cr.speciesId, cr.level).has(moveId)) ||
      (saveCr && learnsetMovesAtOrBelow(saveCr.speciesId, saveCr.level).has(moveId)),
    )
    if (!cr || !mv || (!allowedInBattle && !allowedByLearnset)) {
      audit(p.id, 'creature.invalid_learn_move', { partyIndex: msg.partyIndex, uid: msg.uid, moveId }, 2, p.ip)
      core.error(p, 'authority_violation')
      return
    }
    const applySlot = (targetCr: Creature) => {
      if (targetCr.moves.some((m) => m.id === moveId)) return
      const slot = { id: moveId, pp: mv.pp, ppMax: mv.pp }
      if (targetCr.moves.length < CONTENT.config.party.maxMoves) targetCr.moves.push(slot)
      else if (typeof msg.replaceIndex === 'number' && msg.replaceIndex >= 0 && msg.replaceIndex < targetCr.moves.length) {
        targetCr.moves[msg.replaceIndex] = slot
      }
    }
    if (battleCr) applySlot(battleCr)
    const save = structuredClone(rec.save)
    const targetSaveIdx = resolvePartyIndex(save.party, cr.uid, saveIdx >= 0 ? saveIdx : msg.partyIndex)
    if (targetSaveIdx >= 0 && save.party[targetSaveIdx]) applySlot(save.party[targetSaveIdx])
    commitSave(p.id, save, { ref: `learnMove:${cr.uid}:${moveId}`, notify: !active })
  }

  function handleCreatureNickname(p: Player, msg: Extract<ClientMsg, { t: 'creature.nickname' }>): void {
    const rec = getRecord(p.id)
    if (!rec || typeof msg.uid !== 'string') return
    const save = structuredClone(rec.save)
    const cr = save.party.find((c) => c.uid === msg.uid) ?? save.boxes.flat().find((c) => c.uid === msg.uid)
    if (!cr) return
    const rawNick = typeof msg.nickname === 'string' ? maskBanned(msg.nickname.trim()).slice(0, CONTENT.config.net.nameMaxLen) : ''
    const spName = CONTENT.species[cr.speciesId]?.nameZh ?? ''
    if (!rawNick || rawNick === spName) delete cr.nickname
    else cr.nickname = rawNick
    commitSave(p.id, save, { ref: `nickname:${cr.uid}` })
  }

  function handlePartySwap(p: Player, msg: Extract<ClientMsg, { t: 'party.swap' }>): void {
    const rec = getRecord(p.id)
    if (!rec) return
    const a = msg.a, b = msg.b
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= rec.save.party.length || b >= rec.save.party.length || a === b) return
    const save = structuredClone(rec.save)
    ;[save.party[a], save.party[b]] = [save.party[b], save.party[a]]
    commitSave(p.id, save, { ref: 'party:swap' })
  }

  function handleBoxMove(p: Player, msg: Extract<ClientMsg, { t: 'box.move' }>): void {
    const rec = getRecord(p.id)
    if (!rec || !isRecord(msg.from) || !isRecord(msg.to)) return
    const save = structuredClone(rec.save)
    if (moveCreature(save, msg.from, msg.to, CONTENT) !== null) return
    commitSave(p.id, save, { ref: 'box:move' })
  }

  function handleBoxRelease(p: Player, msg: Extract<ClientMsg, { t: 'box.release' }>): void {
    const rec = getRecord(p.id)
    if (!rec || !isRecord(msg.slot)) return
    const save = structuredClone(rec.save)
    if (releaseCreature(save, msg.slot) !== null) return
    recordSaveDiffLedger(p.id, rec.save, save, 'box:release')
    commitSave(p.id, save, { ref: 'box:release' })
  }

  // ------------------------------------------------------------------ World Event Runtime & Script Verification

  function serverEventSeed(save: SaveData): number {
    const wSeed = world ? world.seed : 0
    return hashString(`${clientJson.scheduler.seedSalt}:${wSeed >>> 0}:${save.playerId}`)
  }

  function advanceServerClock(playerId: string, save: SaveData, hintClockMinutes?: number): void {
    const nowMs = Date.now()
    const prevMs = lastClockSyncMs.get(playerId)
    lastClockSyncMs.set(playerId, nowMs)
    const daySec = Math.max(1, CONTENT.config.time.dayRealSeconds)
    const minPerSec = (24 * 60) / daySec
    const elapsedSec = prevMs !== undefined ? Math.max(0, (nowMs - prevMs) / 1000) : 15
    const maxAdvance = elapsedSec * minPerSec + GAMEPLAY.spawn.scheduler.checkEveryMinutes * 2
    if (typeof hintClockMinutes === 'number' && Number.isFinite(hintClockMinutes) && hintClockMinutes >= save.clockMinutes) {
      save.clockMinutes = Math.min(hintClockMinutes, save.clockMinutes + maxAdvance)
    } else if (prevMs !== undefined && elapsedSec > 0) {
      save.clockMinutes += elapsedSec * minPerSec
    }
  }

  function serverPlacesNear(map: GameMap, x: number, y: number, r: number): TownDef[] {
    if (!world) return []
    const prov = map.infinite as unknown as {
      placesIn?(x0: number, y0: number, x1: number, y1: number): TownDef[]
      siteOf?(id: string): { site: { template: string } } | null
    } | undefined
    if (prov?.placesIn) {
      return prov.placesIn(Math.floor(x - r), Math.floor(y - r), Math.ceil(x + r), Math.ceil(y + r)).flatMap((pl) => {
        const tpl = prov.siteOf?.(pl.id)?.site.template
        if (!tpl || pl.id.startsWith(`${tpl}-`)) return [pl]
        return [tpl, ...(FRONTIER_PACK.common.templateAliases[tpl] ?? [])].map((a) => ({ ...pl, id: `${a}-@${pl.id}` }))
      })
    }
    return world.towns.filter((tw) => tw.map === map.id && Math.abs(tw.x - x) <= r && Math.abs(tw.y - y) <= r)
  }

  function buildServerEventContext(p: Player, save: SaveData, weather: FieldWeatherKind = 'clear'): EventContext {
    const map = world ? getMap(world, p.state.map) : null
    const region = map ? regionAt(map, p.state.x, p.state.y) : null
    const near = map ? serverPlacesNear(map, p.state.x, p.state.y, GAMEPLAY.spawn.scheduler.localRadius) : []
    const dist = world
      ? (map?.id === world.startMap
        ? distanceFromOrigin(world, p.state.x, p.state.y)
        : (p.lastOverworld ? distanceFromOrigin(world, p.lastOverworld.x, p.lastOverworld.y) : 0))
      : 0
    return eventContext(save, {
      real: realDateOf(new Date()),
      weather,
      biome: region?.biome ?? null,
      regionId: region?.id ?? null,
      regionDanger: region?.danger ?? 0,
      distance: dist,
      outdoor: map ? map.outdoor : true,
      nearPlaces: near.map((pl) => pl.id),
      researchLevel: researchLevel(researchPoints(save.research ?? {})).level,
    })
  }

  function serverFocusOfEvent(ev: ActiveEvent, map: GameMap | null): { x: number; y: number } {
    const a = ev.anchor ?? { map: map?.id ?? '', x: 0, y: 0 }
    if (!world || !map) return { x: a.x, y: a.y }
    const near = serverPlacesNear(map, a.x, a.y, GAMEPLAY.spawn.scheduler.localRadius)
    const f = eventFocus(ev.def, near, a)
    return f ? { x: f.x, y: f.y } : { x: a.x, y: a.y }
  }

  function serverActionsForEvent(ev: ActiveEvent, p: Player, save: SaveData): StartActions {
    const map = world ? getMap(world, ev.anchor?.map ?? p.state.map) : null
    const at = serverFocusOfEvent(ev, map)
    const areaLevel = (map ? regionAt(map, at.x, at.y)?.levelRange : undefined)
      ?? (clientJson.scheduler.fallbackAreaLevel as [number, number])
    return startActions(ev, {
      areaLevel,
      rng: new Rng(eventSalt(serverEventSeed(save), ev)),
      at,
    })
  }

  function applyEventStartToSave(ev: ActiveEvent, p: Player, save: SaveData): void {
    const a = serverActionsForEvent(ev, p, save)
    const vars = { year: realDateOf(new Date()).year, day: dayOf(save.clockMinutes) }
    for (const f of a.flags) {
      const fname = f.flag.includes('{') ? expandFlag(f.flag, vars) : f.flag
      save.flags[fname] = f.value
      noteRecentFlag(p.id, fname)
    }
    save.flags[clientJson.flags.news + ev.id] = Math.max(1, Math.floor(save.clockMinutes))
    if (world) {
      const ow = world.maps[world.startMap]
      const from = p.state.map === world.startMap ? { x: p.state.x, y: p.state.y } : (p.lastOverworld ?? ow?.spawn)
      if (ow && from) {
        const places = serverPlacesNear(ow, from.x, from.y, clientJson.places.revealSearchRadius)
        for (const ref of a.reveals) {
          const hit = resolvePlaceRef(ref, places, from, save.visitedTowns)
          if (hit) {
            const realId = hit.id.includes('-@') ? hit.id.slice(hit.id.indexOf('-@') + 2) : hit.id
            save.flags[clientJson.flags.revealed + realId] = Math.max(1, Math.floor(save.clockMinutes))
          }
        }
      }
    }
  }

  function cleanEndedEventFlags(ev: ActiveEvent, save: SaveData): void {
    const spPrefix = `${clientJson.flags.spawnTaken}ev:${ev.id}:`
    const itPrefix = `${clientJson.flags.itemTaken}ev:${ev.id}:`
    for (const k of Object.keys(save.flags)) {
      if (k.startsWith(spPrefix) || k.startsWith(itPrefix)) delete save.flags[k]
    }
  }

  function findActiveEventWildForPlayer(
    p: Player,
    save: SaveData,
    speciesId: string,
    map: GameMap | null,
    region: RegionDef | null,
  ): { level: number; tag: string | null; startedAt: number | null } | null {
    const active = activeEvents(save.events ?? {}, save.clockMinutes)
    const at: EventAnchor = {
      map: p.state.map,
      x: Math.floor(p.state.x),
      y: Math.floor(p.state.y),
      ...(region ? { region: region.id } : {}),
    }
    const mods = eventModifiers(active, at, save.clockMinutes)
    for (const ev of active) {
      if (ev.anchor && ev.anchor.map !== p.state.map) continue
      const a = serverActionsForEvent(ev, p, save)
      const origin = serverFocusOfEvent(ev, map)
      const areaLevel = (map ? regionAt(map, origin.x, origin.y)?.levelRange : undefined)
        ?? (clientJson.scheduler.fallbackAreaLevel as [number, number])
      for (let k = 0; k < a.spawns.length; k++) {
        const eff = a.spawns[k]
        const r = new Rng(eventSalt(serverEventSeed(save), ev) ^ Math.imul(k + 1, 0x9e3779b1))
        const list = resolveSpawnEffect(eff, areaLevel, r, { mods, research: save.research ?? {} })
        for (let i = 0; i < list.length; i++) {
          const v = list[i]
          const tag = `ev:${ev.id}:${k}.${i}`
          if (v.speciesId === speciesId && save.flags[clientJson.flags.spawnTaken + tag] !== ev.startedAt) {
            return { level: v.level, tag, startedAt: ev.startedAt }
          }
        }
      }
    }
    if (region && region.encounters.length > 0) {
      for (const b of mods.encounterBoosts) {
        if (b.species?.includes(speciesId)) {
          const lo = Math.min(...region.encounters.map((s) => Math.min(s.minLevel, s.maxLevel)))
          const hi = Math.max(...region.encounters.map((s) => Math.max(s.minLevel, s.maxLevel)))
          return { level: Math.round((lo + hi) / 2), tag: null, startedAt: null }
        }
      }
    }
    return null
  }

  function resolveTrainerDef(p: Player, save: SaveData, trId: string, map: GameMap | null): TrainerDef | null {
    if (world) {
      const base = world.trainers[trId] ?? frontierTrainer(world, trId)
      if (base) return base
    } else {
      for (const g of Object.values(STORY_CONTENT.trainerGroups)) {
        const spec = g.trainers.find((t) => t.id === trId)
        if (spec) {
          return {
            id: spec.id,
            nameZh: spec.nameZh,
            classZh: spec.classZh,
            sprite: spec.sprite,
            party: spec.party.map((e) => ({ species: e.species ?? CONTENT.speciesList[0].id, level: e.level, ...(e.moves ? { moves: e.moves } : {}) })),
            reward: spec.reward ?? 200,
            introText: spec.introText,
            defeatText: spec.defeatText,
            aiLevel: spec.aiLevel ?? g.defaults?.aiLevel ?? 1,
            ...(spec.badge ? { badge: spec.badge } : {}),
            ...(spec.rematchable !== undefined ? { rematchable: spec.rematchable } : {}),
          }
        }
      }
    }
    if (trId.startsWith('ev:')) {
      for (const ev of activeEvents(save.events ?? {}, save.clockMinutes)) {
        if (ev.anchor && ev.anchor.map !== (map?.id ?? p.state.map)) continue
        const a = serverActionsForEvent(ev, p, save)
        const hit = a.trainers.find((t) => t.trainer.id === trId)
        if (hit) return hit.trainer
      }
    }
    return null
  }

  function expandRawSteps(raw: readonly StepSpec[], depth = 0, params: Record<string, string> = {}): ScriptStep[] {
    if (depth > 8) return []
    const out: ScriptStep[] = []
    const starters = CONTENT.speciesList.filter((sp) => sp.starter).map((sp) => sp.id)
    const substStr = (v: unknown): unknown => {
      if (typeof v === 'string') return v.replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m)
      if (Array.isArray(v)) return v.map(substStr)
      if (isRecord(v)) {
        const o: Record<string, unknown> = {}
        for (const [k, val] of Object.entries(v)) o[k] = substStr(val)
        return o
      }
      return v
    }
    const tierChain = (tiers: { atLeast: number; steps: ScriptStep[] }[]): ScriptStep[] => {
      const sorted = tiers.slice().sort((a, b) => b.atLeast - a.atLeast)
      let chain: ScriptStep[] | null = null
      for (let k = sorted.length - 1; k >= 0; k--) {
        const t = sorted[k]
        if (t.atLeast <= 0 && chain === null) { chain = t.steps; continue }
        const st: ScriptStep = { op: 'ifBadges', atLeast: t.atLeast, then: t.steps }
        if (chain) st.else = chain
        chain = [st]
      }
      return chain ?? []
    }
    for (const rawStep of raw) {
      const s = substStr(rawStep) as StepSpec
      if (s.op === 'include' && typeof s.script === 'string') {
        const target = STORY_CONTENT.scripts[s.script]
        const extra = isRecord(s.params) ? Object.fromEntries(Object.entries(s.params).map(([k, v]) => [k, String(v)])) : {}
        if (target) out.push(...expandRawSteps(target, depth + 1, { ...params, ...extra }))
        continue
      }
      if (s.op === 'byStarter' && isRecord(s.cases)) {
        let chain: ScriptStep[] = []
        for (let k = starters.length - 1; k >= 0; k--) {
          const st = starters[k]
          const br = s.cases[st]
          if (!Array.isArray(br)) continue
          const step: ScriptStep = {
            op: 'ifFlag',
            flag: STORY_CONTENT.meta.flags.starter,
            equals: st,
            then: expandRawSteps(br as StepSpec[], depth + 1, params),
            ...(chain.length ? { else: chain } : {}),
          }
          chain = [step]
        }
        out.push(...chain)
        continue
      }
      if (s.op === 'rivalBattle' && typeof s.battle === 'string') {
        let chain: ScriptStep[] = []
        for (let k = starters.length - 1; k >= 0; k--) {
          const st = starters[k]
          const step: ScriptStep = {
            op: 'ifFlag',
            flag: STORY_CONTENT.meta.flags.starter,
            equals: st,
            then: [{
              op: 'battle',
              trainer: `rival-${s.battle}-${st}`,
              ...(s.lossContinues ? { lossContinues: true } : {}),
              ...(typeof s.lossFlag === 'string' ? { lossFlag: s.lossFlag } : {}),
            } as ScriptStep],
            ...(chain.length ? { else: chain } : {}),
          }
          chain = [step]
        }
        out.push(...chain)
        continue
      }
      if (s.op === 'starterBattle' && typeof s.trainer === 'string') {
        let chain: ScriptStep[] = []
        for (let k = starters.length - 1; k >= 0; k--) {
          const st = starters[k]
          const step: ScriptStep = {
            op: 'ifFlag',
            flag: STORY_CONTENT.meta.flags.starter,
            equals: st,
            then: [{
              op: 'battle',
              trainer: `${s.trainer}-${st}`,
              ...(s.lossContinues ? { lossContinues: true } : {}),
              ...(typeof s.lossFlag === 'string' ? { lossFlag: s.lossFlag } : {}),
            } as ScriptStep],
            ...(chain.length ? { else: chain } : {}),
          }
          chain = [step]
        }
        out.push(...chain)
        continue
      }
      if (s.op === 'badgeTiers' && Array.isArray(s.tiers)) {
        const tiers = s.tiers.filter(isRecord).map((t) => ({
          atLeast: Number(t.atLeast),
          steps: Array.isArray(t.then) ? expandRawSteps(t.then as StepSpec[], depth + 1, params) : [],
        }))
        out.push(...tierChain(tiers))
        continue
      }
      if (s.op === 'tieredShop' && typeof s.town === 'string') {
        const town = s.town
        const extra = STORY_CONTENT.services.shop.extra[town] ?? []
        const acc: string[] = []
        const tiers = STORY_CONTENT.services.shop.tiers.map((t) => {
          for (const it of t.items) if (!acc.includes(it)) acc.push(it)
          const items = [...acc, ...extra.filter((x) => !acc.includes(x))]
          return { atLeast: t.atLeast, steps: [{ op: 'shop', items } as ScriptStep] }
        })
        out.push(...tierChain(tiers))
        continue
      }
      if (s.op === 'choice' && Array.isArray(s.branches)) {
        out.push({
          ...s,
          branches: (s.branches as StepSpec[][]).map((b) => expandRawSteps(b, depth + 1, params)),
        } as unknown as ScriptStep)
        continue
      }
      if (
        s.op === 'ifFlag' ||
        s.op === 'ifBadges' ||
        s.op === 'ifItem' ||
        s.op === 'ifCaught' ||
        s.op === 'ifDex' ||
        s.op === 'ifInstance' ||
        s.op === 'random' ||
        s.op === 'ifTime' ||
        s.op === 'ifWeather'
      ) {
        out.push({
          ...s,
          then: Array.isArray(s.then) ? expandRawSteps(s.then as StepSpec[], depth + 1, params) : [],
          ...(Array.isArray(s.else) ? { else: expandRawSteps(s.else as StepSpec[], depth + 1, params) } : {}),
        } as unknown as ScriptStep)
        continue
      }
      if (s.op === 'bossBattle' && typeof s.lossWarp === 'string') {
        const lf = typeof s.lossFlag === 'string' ? s.lossFlag : 'ds:lostNow'
        const copy = { ...s, lossContinues: true, lossFlag: lf }
        delete copy.lossWarp
        out.push(copy as unknown as ScriptStep)
        const lw = STORY_CONTENT.meta.lossWarp
        out.push({
          op: 'ifFlag',
          flag: lf,
          equals: true,
          then: [
            { op: 'fade', out: true },
            { op: 'warp', map: 'origin-lab-b1', x: 8, y: 4, facing: lw.facing },
            { op: 'heal' },
            { op: 'fade', out: false },
            ...expandRawSteps([{ op: 'include', script: lw.script }], depth + 1, params),
            { op: 'end' },
          ],
        } as ScriptStep)
        continue
      }
      out.push(s as unknown as ScriptStep)
    }
    return out
  }

  function collectMapScripts(p: Player, save: SaveData): ScriptStep[][] {
    const lists: ScriptStep[][] = []
    if (world) {
      const map = getMap(world, p.state.map)
      if (map) {
        const npcs: readonly NpcDef[] = map.infinite
          ? (() => {
            const near = objectsInRect(map, Math.floor(p.state.x) - 24, Math.floor(p.state.y) - 24, Math.floor(p.state.x) + 25, Math.floor(p.state.y) + 25)
            registerFrontierRefs(world, near.npcs)
            return near.npcs
          })()
          : map.npcs
        for (const n of npcs) {
          if (n.hiddenUnlessFlag && !save.flags[n.hiddenUnlessFlag] && !wasFlagRecentlySet(p.id, n.hiddenUnlessFlag)) continue
          if (n.hiddenIfFlag && save.flags[n.hiddenIfFlag] && !wasFlagRecentlySet(p.id, n.hiddenIfFlag)) continue
          if (n.script?.length) lists.push(n.script)
        }
      }
      for (const trig of storyFeatures(world).triggers) {
        if (trig.match?.map && trig.match.map !== p.state.map) continue
        lists.push(trig.steps)
      }
    } else {
      for (const list of Object.values(STORY_CONTENT.npcGroups)) {
        for (const spec of list) {
          if (spec.at === p.state.map || spec.at.startsWith(`${p.state.map}:`)) {
            const say = (spec.lines ?? []).map((text): StepSpec => ({ op: 'say', text }))
            lists.push(expandRawSteps([...say, ...(spec.script ?? [])]))
          }
        }
      }
      for (const trig of STORY_CONTENT.triggers) {
        if (trig.match?.map && trig.match.map !== p.state.map) continue
        if (STORY_CONTENT.scripts[trig.script]) lists.push(expandRawSteps(STORY_CONTENT.scripts[trig.script]))
      }
    }
    for (const ev of activeEvents(save.events ?? {}, save.clockMinutes)) {
      if (ev.anchor && ev.anchor.map !== p.state.map) continue
      const a = serverActionsForEvent(ev, p, save)
      for (const sc of a.scripts) lists.push(sc)
      for (const n of a.npcs) {
        if (n.script?.length) lists.push(n.script)
      }
    }
    return lists
  }

  function walkAllSteps(steps: readonly ScriptStep[], visit: (s: ScriptStep) => void): void {
    for (const s of steps) {
      visit(s)
      if (s.op === 'choice') {
        for (const b of s.branches) walkAllSteps(b, visit)
      } else if (
        s.op === 'ifFlag' ||
        s.op === 'ifBadges' ||
        s.op === 'ifItem' ||
        s.op === 'ifCaught' ||
        s.op === 'ifDex' ||
        s.op === 'ifInstance' ||
        s.op === 'random' ||
        s.op === 'ifTime' ||
        s.op === 'ifWeather'
      ) {
        walkAllSteps(s.then, visit)
        if (s.else) walkAllSteps(s.else, visit)
      }
    }
  }

  function findWildBattleStepOnMap(
    p: Player,
    save: SaveData,
    speciesId: string,
  ): Extract<ScriptStep, { op: 'wildBattle' }> | null {
    let found: Extract<ScriptStep, { op: 'wildBattle' }> | null = null
    for (const script of collectMapScripts(p, save)) {
      walkAllSteps(script, (s) => {
        if (!found && s.op === 'wildBattle' && s.species === speciesId) {
          found = s
        }
      })
      if (found) return found
    }
    return null
  }

  function isBossAccessibleOnPlayerMap(
    p: Player,
    save: SaveData,
    bossId: string,
    instanceId: string,
    entryMap?: string,
  ): boolean {
    if (entryMap && p.state.map === entryMap) return true
    let found = false
    for (const script of collectMapScripts(p, save)) {
      walkAllSteps(script, (s) => {
        if (s.op === 'bossBattle' && s.boss === bossId) found = true
        if (s.op === 'instance' && s.id === instanceId) found = true
      })
      if (found) return true
    }
    return false
  }

  function isTrainerOnPlayerMap(p: Player, save: SaveData, trainerId: string): boolean {
    if (!world) return true
    const map = getMap(world, p.state.map)
    if (map) {
      const npcs = map.infinite
        ? objectsInRect(map, Math.floor(p.state.x) - 24, Math.floor(p.state.y) - 24, Math.floor(p.state.x) + 25, Math.floor(p.state.y) + 25).npcs
        : map.npcs
      if (npcs.some((n) => n.trainer === trainerId)) return true
    }
    let found = false
    for (const script of collectMapScripts(p, save)) {
      walkAllSteps(script, (s) => {
        if (s.op === 'battle' && s.trainer === trainerId) found = true
      })
      if (found) return true
    }
    for (const ev of activeEvents(save.events ?? {}, save.clockMinutes)) {
      if (ev.anchor && ev.anchor.map !== p.state.map) continue
      const a = serverActionsForEvent(ev, p, save)
      if (a.trainers.some((t) => t.trainer.id === trainerId)) return true
    }
    return false
  }

  function flagMatches(save: SaveData, flag: string, equals: boolean | number | string | undefined): boolean {
    const v = save.flags[flag]
    return equals === undefined ? (v !== undefined && v !== false && v !== 0 && v !== '') : v === equals
  }

  function isShopItemOfferedInSteps(steps: readonly ScriptStep[], p: Player, save: SaveData, itemId: string): boolean {
    for (const s of steps) {
      if (s.op === 'shop' && s.items.includes(itemId)) return true
      switch (s.op) {
        case 'ifBadges':
          if (isShopItemOfferedInSteps(save.badges.length >= s.atLeast ? s.then : (s.else ?? []), p, save, itemId)) return true
          break
        case 'ifFlag': {
          const holds = flagMatches(save, s.flag, s.equals) || wasFlagRecentlySet(p.id, s.flag)
          if (isShopItemOfferedInSteps(holds ? s.then : (s.else ?? []), p, save, itemId)) return true
          break
        }
        case 'ifDex':
          if (isShopItemOfferedInSteps(save.dexCaught.length >= s.caughtAtLeast ? s.then : (s.else ?? []), p, save, itemId)) return true
          break
        case 'ifCaught': {
          const n = save.dexCaught.filter((id) => {
            const sp = CONTENT.species[id]
            if (!sp) return false
            if (s.species && id !== s.species) return false
            if (s.type && !sp.types.includes(s.type)) return false
            return true
          }).length
          if (isShopItemOfferedInSteps(n >= (s.atLeast ?? 1) ? s.then : (s.else ?? []), p, save, itemId)) return true
          break
        }
        case 'ifItem':
          if (isShopItemOfferedInSteps((save.bag[s.item] ?? 0) >= (s.atLeast ?? 1) ? s.then : (s.else ?? []), p, save, itemId)) return true
          break
        case 'ifInstance': {
          const prog = progressOf(save, s.id)
          const tier = s.tier ?? 'story'
          const ok = (s.clearedAtLeast === undefined || (prog.clears[tier] ?? 0) >= s.clearedAtLeast)
            && (s.capturedAtLeast === undefined || (prog.captures[tier] ?? 0) >= s.capturedAtLeast)
          if (isShopItemOfferedInSteps(ok ? s.then : (s.else ?? []), p, save, itemId)) return true
          break
        }
        case 'choice':
          if (s.branches.some((b) => isShopItemOfferedInSteps(b, p, save, itemId))) return true
          break
        case 'random':
        case 'ifTime':
        case 'ifWeather':
          if (isShopItemOfferedInSteps(s.then, p, save, itemId) || isShopItemOfferedInSteps(s.else ?? [], p, save, itemId)) return true
          break
        default:
          break
      }
    }
    return false
  }

  function isShopItemUnlockedForPlayer(p: Player, save: SaveData, itemId: string): boolean {
    for (const script of collectMapScripts(p, save)) {
      if (isShopItemOfferedInSteps(script, p, save, itemId)) return true
    }
    const tiers = STORY_CONTENT.services.shop.tiers
    const inTiers = tiers.filter((t) => t.items.includes(itemId))
    if (inTiers.length > 0) {
      const minBadges = Math.min(...inTiers.map((t) => t.atLeast))
      if (save.badges.length < minBadges) return false
      if (!world || p.state.map.endsWith('-shop')) return true
      return false
    }
    for (const [town, extraItems] of Object.entries(STORY_CONTENT.services.shop.extra)) {
      if (extraItems.includes(itemId)) {
        if (p.state.map === `${town}-shop` || p.state.map === town) return true
        return false
      }
    }
    return false
  }

  function resolveScriptSource(
    p: Player,
    save: SaveData,
    rawSourceId?: string,
    rawNpcId?: string,
    rawStepPath?: string,
  ): { canonicalSourceId: string; canonicalStepPath: string; steps: readonly ScriptStep[] } | null {
    if (typeof rawStepPath !== 'string' || !rawStepPath.trim()) return null
    let sourceId = typeof rawSourceId === 'string' && rawSourceId.trim()
      ? rawSourceId.trim()
      : (typeof rawNpcId === 'string' && rawNpcId.trim() ? `npc:${rawNpcId.trim()}` : '')
    if (!sourceId) return null
    let stepPath = rawStepPath.trim()

    if (sourceId === 'script:ds-professor' || sourceId === 'ds-professor') {
      sourceId = 'npc:professor'
      stepPath = `0.else.${stepPath}`
    } else if (sourceId === 'script:ds-aide' || sourceId === 'ds-aide') {
      sourceId = 'npc:aide-types'
      stepPath = `0.else.${stepPath}`
    } else if (sourceId === 'script:ds-r1' || sourceId === 'ds-r1') {
      sourceId = 'npc:ds-r1'
    } else if (sourceId === 'script:ds-supply' || sourceId === 'ds-supply') {
      sourceId = 'npc:ds-supply'
    } else if (sourceId === 'script:ds-heal' || sourceId === 'ds-heal') {
      sourceId = 'npc:ds-heal'
    } else if (sourceId === 'script:ds-relay' || sourceId === 'ds-relay') {
      sourceId = 'npc:ds-relay'
    } else if (sourceId === 'script:ds-core' || sourceId === 'ds-core') {
      sourceId = 'npc:ds-v4'
    }

    if (sourceId.startsWith('npc:')) {
      const npcId = sourceId.slice(4)
      if (!npcId) return null
      if (npcId.startsWith('ev:')) {
        for (const ev of activeEvents(save.events ?? {}, save.clockMinutes)) {
          if (ev.anchor && ev.anchor.map !== p.state.map) continue
          const a = serverActionsForEvent(ev, p, save)
          const n = a.npcs.find((x) => x.id === npcId)
          if (n?.script?.length) return { canonicalSourceId: `npc:${n.id}`, canonicalStepPath: stepPath, steps: n.script }
        }
        return null
      }
      if (world) {
        const map = getMap(world, p.state.map)
        const findOnMap = (m: GameMap | null): NpcDef | undefined => {
          if (!m) return undefined
          const list = m.infinite
            ? (() => {
              const near = objectsInRect(m, Math.floor(p.state.x) - 24, Math.floor(p.state.y) - 24, Math.floor(p.state.x) + 25, Math.floor(p.state.y) + 25)
              registerFrontierRefs(world, near.npcs)
              return near.npcs
            })()
            : m.npcs
          return list.find((x) => x.id === npcId)
        }
        let npc = findOnMap(map)
        if (!npc && p.state.map === 'origin-lab-b1' && npcId === 'ds-v4') {
          npc = findOnMap(getMap(world, 'origin-lab-b2'))
        }
        if (npc) {
          if (npc.hiddenUnlessFlag && !save.flags[npc.hiddenUnlessFlag] && !wasFlagRecentlySet(p.id, npc.hiddenUnlessFlag)) return null
          if (npc.hiddenIfFlag && save.flags[npc.hiddenIfFlag] && !wasFlagRecentlySet(p.id, npc.hiddenIfFlag)) return null
          if (npcId === 'ds-r1' && p.state.map === 'origin-lab-b1' && STORY_CONTENT.scripts['ds-loss']) {
            const lossSteps = expandRawSteps(STORY_CONTENT.scripts['ds-loss'])
            const testIdx = Number(stepPath.split('.')[0])
            if (Number.isInteger(testIdx) && testIdx >= 0 && testIdx < lossSteps.length && lossSteps[testIdx]?.op === 'ifItem') {
              return { canonicalSourceId: 'script:ds-loss', canonicalStepPath: stepPath, steps: lossSteps }
            }
          }
          return { canonicalSourceId: `npc:${npc.id}`, canonicalStepPath: stepPath, steps: npc.script }
        }
        for (const ev of activeEvents(save.events ?? {}, save.clockMinutes)) {
          if (ev.anchor && ev.anchor.map !== p.state.map) continue
          const a = serverActionsForEvent(ev, p, save)
          const evNpc = a.npcs.find((x) => x.id === npcId || x.id === `ev:${ev.id}:${npcId}`)
          if (evNpc?.script?.length) {
            return { canonicalSourceId: `npc:${evNpc.id}`, canonicalStepPath: stepPath, steps: evNpc.script }
          }
        }
        return null
      }
      for (const list of Object.values(STORY_CONTENT.npcGroups)) {
        const spec = list.find((x) => x.id === npcId)
        if (spec) {
          if (spec.hiddenUnlessFlag && !save.flags[spec.hiddenUnlessFlag] && !wasFlagRecentlySet(p.id, spec.hiddenUnlessFlag)) return null
          if (spec.hiddenIfFlag && save.flags[spec.hiddenIfFlag] && !wasFlagRecentlySet(p.id, spec.hiddenIfFlag)) return null
          const say = (spec.lines ?? []).map((text): StepSpec => ({ op: 'say', text }))
          return {
            canonicalSourceId: `npc:${spec.id}`,
            canonicalStepPath: stepPath,
            steps: expandRawSteps([...say, ...(spec.script ?? [])]),
          }
        }
      }
      for (const spec of STORY_CONTENT.services.npcs) {
        for (const tw of ['origin', 'opensource', 'pixelport', 'chord', 'retrieval', 'forge', 'frostshield', 'hub', 'balance', 'agi']) {
          const id = spec.id.replace('{town}', tw)
          if (id === npcId) {
            const say = (spec.lines ?? []).map((text): StepSpec => ({ op: 'say', text }))
            return {
              canonicalSourceId: `npc:${id}`,
              canonicalStepPath: stepPath,
              steps: expandRawSteps([...say, ...(spec.script ?? [])], 0, { town: tw, townName: tw }),
            }
          }
        }
      }
      return null
    }

    if (sourceId.startsWith('trig:')) {
      const trigId = sourceId.slice(5)
      if (world) {
        const trig = storyFeatures(world).triggers.find((t) => t.id === trigId)
        if (!trig || (trig.match?.map && trig.match.map !== p.state.map)) return null
        if (trig.when?.flag?.some((f) => !save.flags[f] && !wasFlagRecentlySet(p.id, f))) return null
        if (trig.when?.noFlag?.some((f) => save.flags[f] && !wasFlagRecentlySet(p.id, f))) return null
        return { canonicalSourceId: `trig:${trig.id}`, canonicalStepPath: stepPath, steps: trig.steps }
      }
      const rawTrig = STORY_CONTENT.triggers.find((t) => t.id === trigId)
      if (!rawTrig || !STORY_CONTENT.scripts[rawTrig.script]) return null
      if (rawTrig.when?.flag?.some((f) => !save.flags[f] && !wasFlagRecentlySet(p.id, f))) return null
      if (rawTrig.when?.noFlag?.some((f) => save.flags[f] && !wasFlagRecentlySet(p.id, f))) return null
      return {
        canonicalSourceId: `trig:${rawTrig.id}`,
        canonicalStepPath: stepPath,
        steps: expandRawSteps(STORY_CONTENT.scripts[rawTrig.script]),
      }
    }

    if (sourceId.startsWith('ev:')) {
      const m = /^ev:([^:]+):script:(\d+)$/.exec(sourceId)
      if (!m) return null
      const [, evId, idxStr] = m
      const idx = Number(idxStr)
      const ev = activeEvents(save.events ?? {}, save.clockMinutes).find((a) => a.id === evId)
      if (!ev || (ev.anchor && ev.anchor.map !== p.state.map)) return null
      const a = serverActionsForEvent(ev, p, save)
      const steps = a.scripts[idx]
      if (!steps) return null
      return { canonicalSourceId: `ev:${ev.id}:script:${idx}`, canonicalStepPath: stepPath, steps }
    }

    if (sourceId === 'script:ds-loss' && p.state.map === 'origin-lab-b1' && STORY_CONTENT.scripts['ds-loss']) {
      return {
        canonicalSourceId: 'script:ds-loss',
        canonicalStepPath: stepPath,
        steps: expandRawSteps(STORY_CONTENT.scripts['ds-loss']),
      }
    }

    return null
  }

  function hasUnpaidGrantInBranch(steps: readonly ScriptStep[]): boolean {
    if (steps.some((st) => st.op === 'takeMoney' || st.op === 'takeItem')) return false
    let hit = false
    walkAllSteps(steps, (s) => {
      if (s.op === 'giveItem' || s.op === 'giveMoney' || s.op === 'giveCreature' || s.op === 'research') {
        hit = true
      }
    })
    return hit
  }

  function resolveAuthorizedScriptStep(
    p: Player,
    save: SaveData,
    msg: Extract<ClientMsg, { t: 'script.op' }>,
    matcher: (s: ScriptStep) => boolean,
  ): {
    step: ScriptStep
    canonicalSourceId: string
    canonicalStepPath: string
    grantFlag: string
    paid: boolean
    choiceLocks: { key: string; branchIdx: number }[]
  } | null {
    const src = resolveScriptSource(p, save, msg.sourceId, msg.npcId, msg.stepPath)
    if (!src) return null
    const parts = src.canonicalStepPath.split('.')
    let curSteps: readonly ScriptStep[] = src.steps
    let pathPrefix = ''
    const preceding: ScriptStep[] = []
    let dynamicSuffix = ''
    const choiceLocks: { key: string; branchIdx: number }[] = []
    const vars = { year: realDateOf(new Date()).year, day: dayOf(save.clockMinutes) }

    for (let i = 0; i < parts.length;) {
      const idx = Number(parts[i])
      if (!Number.isInteger(idx) || idx < 0 || idx >= curSteps.length) return null
      for (let k = 0; k < idx; k++) preceding.push(curSteps[k])
      const step = curSteps[idx]
      const stepKey = pathPrefix ? `${pathPrefix}.${idx}` : String(idx)
      if (i === parts.length - 1) {
        if (!matcher(step)) return null
        const payStep = preceding.find((st) => st.op === 'takeMoney' || st.op === 'takeItem')
        let paid = false
        if (payStep) {
          const recent = recentPayments.get(p.id)
          if (!recent || recent.map !== p.state.map || Date.now() - recent.at > 30_000) return null
          if (payStep.op === 'takeMoney' && (recent.kind !== 'money' || recent.amount !== payStep.amount)) return null
          if (payStep.op === 'takeItem' && (recent.kind !== 'item' || recent.itemId !== payStep.item || recent.amount !== payStep.qty)) return null
          recentPayments.delete(p.id)
          paid = true
        }
        return {
          step,
          canonicalSourceId: src.canonicalSourceId,
          canonicalStepPath: src.canonicalStepPath,
          grantFlag: `auth:grant:${src.canonicalSourceId}:${src.canonicalStepPath}${dynamicSuffix}`,
          paid,
          choiceLocks,
        }
      }
      const branchToken = parts[i + 1]
      i += 2
      switch (step.op) {
        case 'choice': {
          const m = /^b(\d+)$/.exec(branchToken)
          if (!m) return null
          const bIdx = Number(m[1])
          if (bIdx < 0 || bIdx >= step.branches.length) return null
          if (msg.choiceIndex !== undefined && msg.choiceIndex !== bIdx) return null
          const grantBranches = step.branches.filter((b) => hasUnpaidGrantInBranch(b)).length
          if (grantBranches > 0 && hasUnpaidGrantInBranch(step.branches[bIdx])) {
            const choiceKey = `auth:choice:${src.canonicalSourceId}:${stepKey}${dynamicSuffix}`
            const prevChoice = save.flags[choiceKey]
            if (prevChoice !== undefined && prevChoice !== bIdx) return null
            choiceLocks.push({ key: choiceKey, branchIdx: bIdx })
          }
          curSteps = step.branches[bIdx]
          pathPrefix = `${stepKey}.b${bIdx}`
          break
        }
        case 'ifFlag': {
          if (branchToken !== 'then' && branchToken !== 'else') return null
          const expFlag = step.flag.includes('{') ? expandFlag(step.flag, vars) : step.flag
          if (step.flag.includes('{')) dynamicSuffix += `:${expFlag}`
          const holds = flagMatches(save, expFlag, step.equals)
          const recent = wasFlagRecentlySet(p.id, expFlag)
          if (branchToken === 'then') {
            if (!holds && !recent) return null
            curSteps = step.then
          } else {
            const starterOpening = expFlag === STORY_CONTENT.meta.flags.starter && step.equals === undefined
            if (holds && !recent && !starterOpening) return null
            curSteps = step.else ?? []
          }
          pathPrefix = `${stepKey}.${branchToken}`
          break
        }
        case 'ifBadges': {
          if (branchToken !== 'then' && branchToken !== 'else') return null
          const holds = save.badges.length >= step.atLeast
          if (branchToken === 'then' ? !holds : holds) return null
          curSteps = branchToken === 'then' ? step.then : (step.else ?? [])
          pathPrefix = `${stepKey}.${branchToken}`
          break
        }
        case 'ifDex': {
          if (branchToken !== 'then' && branchToken !== 'else') return null
          const holds = save.dexCaught.length >= step.caughtAtLeast
          if (branchToken === 'then' ? !holds : holds) return null
          curSteps = branchToken === 'then' ? step.then : (step.else ?? [])
          pathPrefix = `${stepKey}.${branchToken}`
          break
        }
        case 'ifCaught': {
          if (branchToken !== 'then' && branchToken !== 'else') return null
          const n = save.dexCaught.filter((id) => {
            const sp = CONTENT.species[id]
            if (!sp) return false
            if (step.species && id !== step.species) return false
            if (step.type && !sp.types.includes(step.type)) return false
            return true
          }).length
          const holds = n >= (step.atLeast ?? 1)
          if (branchToken === 'then' ? !holds : holds) return null
          curSteps = branchToken === 'then' ? step.then : (step.else ?? [])
          pathPrefix = `${stepKey}.${branchToken}`
          break
        }
        case 'ifItem': {
          if (branchToken !== 'then' && branchToken !== 'else') return null
          const have = save.bag[step.item] ?? 0
          const need = step.atLeast ?? 1
          const recent = recentPayments.get(p.id)
          const paidItem = Boolean(recent && recent.kind === 'item' && recent.itemId === step.item && recent.amount >= need)
          if (branchToken === 'then') {
            if (have < need && !paidItem) return null
            curSteps = step.then
          } else {
            if (have >= need) return null
            curSteps = step.else ?? []
          }
          pathPrefix = `${stepKey}.${branchToken}`
          break
        }
        case 'ifInstance': {
          if (branchToken !== 'then' && branchToken !== 'else') return null
          const prog = progressOf(save, step.id)
          const tier = step.tier ?? 'story'
          const cleared = prog.clears[tier] ?? 0
          const captured = prog.captures[tier] ?? 0
          const holds = (step.clearedAtLeast === undefined || cleared >= step.clearedAtLeast)
            && (step.capturedAtLeast === undefined || captured >= step.capturedAtLeast)
          if (branchToken === 'then' ? !holds : holds) return null
          curSteps = branchToken === 'then' ? step.then : (step.else ?? [])
          pathPrefix = `${stepKey}.${branchToken}`
          break
        }
        case 'random':
        case 'ifTime':
        case 'ifWeather': {
          if (branchToken !== 'then' && branchToken !== 'else') return null
          if (step.op === 'random' && (step.else?.length ?? 0) > 0) {
            const randKey = `auth:choice:${src.canonicalSourceId}:${stepKey}:day${vars.day}`
            const bIdx = branchToken === 'then' ? 0 : 1
            if (save.flags[randKey] !== undefined && save.flags[randKey] !== bIdx) return null
            choiceLocks.push({ key: randKey, branchIdx: bIdx })
          }
          curSteps = branchToken === 'then' ? step.then : (step.else ?? [])
          pathPrefix = `${stepKey}.${branchToken}`
          break
        }
        default:
          return null
      }
    }
    return null
  }

  function isQuestCompletionAuthorized(p: Player, save: SaveData, qId: string): boolean {
    if (world) {
      let onMap = false
      for (const script of collectMapScripts(p, save)) {
        walkAllSteps(script, (s) => {
          if (s.op === 'quest' && s.quest === qId && s.done === true) onMap = true
        })
        if (onMap) break
      }
      if (!onMap) return false
    }
    switch (qId) {
      case 'sq-dex':
        return save.dexCaught.length >= 30
      case 'sq-photo':
        return save.dexCaught.filter((id) => CONTENT.species[id]?.types.includes('vision')).length >= 2
      case 'sq-chorus':
        return save.dexCaught.filter((id) => CONTENT.species[id]?.types.includes('sound')).length >= 1
      case 'sq-chaos':
        return save.dexCaught.filter((id) => CONTENT.species[id]?.types.includes('chaos')).length >= 1
      case 'sq-badges':
        return save.badges.length >= 8
      case 'sq-arena':
        return Boolean(save.flags['trainer:sq-arena'])
      case 'sq-floppy':
        return Boolean(save.flags['sq-floppy:given'])
      case 'sq-antivirus':
        return Boolean(save.flags['sq-antivirus:started'])
      case 'sq-fan':
        return Boolean(save.flags['sq-fan:given'])
      case 'sq-snow':
        return Boolean(save.flags['sq-snow:found'])
      case 'sq-castaway':
        return Boolean(save.flags['sq-castaway:rescued'])
      case 'sq-lostkid':
        return Boolean(save.flags['sq-lostkid:found'])
      case 'sq-ruins':
        return Boolean(save.flags['sq-ruins:a']) && Boolean(save.flags['sq-ruins:b'])
      case 'hq-zero':
        return Boolean(save.flags['zero:t1']) && Boolean(save.flags['zero:t2']) && Boolean(save.flags['zero:ending'])
      default:
        if (qId.startsWith('bounty-') || qId.includes(':bounty-')) {
          return Boolean(save.flags[`${qId}:given`]) || Boolean(save.flags[`${qId}:started`])
        }
        return true
    }
  }

  function handleScriptOp(p: Player, msg: Extract<ClientMsg, { t: 'script.op' }>): void {
    const rec = getRecord(p.id)
    if (!rec) { core.error(p, 'not_ready'); return }
    const save = structuredClone(rec.save)
    switch (msg.op) {
      case 'chooseStarter': {
        if (save.party.length > 0 || save.flags[STORY_CONTENT.meta.flags.starter]) {
          audit(p.id, 'script.duplicate_starter', { speciesId: msg.speciesId }, 2, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        if (world && p.state.map !== 'origin-lab') {
          audit(p.id, 'script.invalid_starter_map', { map: p.state.map, speciesId: msg.speciesId }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        const options = CONTENT.speciesList.filter((sp) => sp.starter)
        const chosen = typeof msg.speciesId === 'string' && options.some((sp) => sp.id === msg.speciesId)
          ? msg.speciesId
          : ''
        if (!chosen) {
          audit(p.id, 'script.invalid_starter_species', { speciesId: msg.speciesId }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        const ballId = CONTENT.itemList.find((it) => it.effect.kind === 'ball')?.id
        const seed = hashString(`${p.id}:starter:${chosen}`) >>> 0
        const cr = createCreature(chosen, CONTENT.config.creature.starterLevel, {
          rng: new Rng(seed || 1),
          otName: save.name,
          otId: save.playerId,
          ...(ballId ? { ballId } : {}),
          caughtMap: p.state.map,
          gradeFloor: CONTENT.quality.giftGradeFloor,
          origin: { kind: 'starter' },
        }, CONTENT)
        storeCreatureInSave(save, cr)
        save.flags[STORY_CONTENT.meta.flags.starter] = chosen
        noteRecentFlag(p.id, STORY_CONTENT.meta.flags.starter)
        addLedger(p.id, 'creature', cr.uid, 1, save.party.length, `script:starter:${chosen}`)
        commitSave(p.id, save, { ref: `script:starter:${chosen}` })
        return
      }
      case 'heal': {
        for (const cr of save.party) {
          cr.hp = maxHp(cr, CONTENT)
          cr.status = null
          cr.statusTurns = 0
          for (const m of cr.moves) m.pp = m.ppMax
        }
        commitSave(p.id, save, { ref: 'script:heal' })
        return
      }
      case 'blackout': {
        const loss = Math.floor(save.money * CONTENT.config.economy.blackoutMoneyLoss)
        if (loss > 0) {
          save.money = Math.max(0, save.money - loss)
          addLedger(p.id, 'money', 'blackout', -loss, save.money, 'script:blackout')
        }
        for (const cr of save.party) {
          cr.hp = maxHp(cr, CONTENT)
          cr.status = null
          cr.statusTurns = 0
          for (const m of cr.moves) m.pp = m.ppMax
        }
        if (save.respawn) {
          save.position = structuredClone(save.respawn)
          p.state.map = save.respawn.map
          p.state.x = save.respawn.x
          p.state.y = save.respawn.y
          p.state.facing = save.respawn.facing
        }
        commitSave(p.id, save, { ref: 'script:blackout' })
        return
      }
      case 'pickup': {
        const groundId = typeof msg.groundId === 'string' ? msg.groundId : ''
        const flagKey = STORY_CONTENT.meta.flags.groundItem + groundId
        if (!groundId || save.flags[flagKey]) {
          audit(p.id, 'script.duplicate_pickup', { groundId }, 2, p.ip)
          return
        }
        let itemId = ''
        let qty = 1
        if (world) {
          const map = getMap(world, p.state.map)
          const nearItems = map
            ? objectsInRect(map, Math.floor(p.state.x) - 6, Math.floor(p.state.y) - 6, Math.floor(p.state.x) + 7, Math.floor(p.state.y) + 7).items
            : []
          const ground = nearItems.find((it) => it.id === groundId)
          if (!ground) {
            audit(p.id, 'script.invalid_pickup', { groundId, map: p.state.map, x: p.state.x, y: p.state.y }, 3, p.ip)
            core.error(p, 'authority_violation')
            return
          }
          itemId = ground.item
          qty = ground.qty
        } else {
          itemId = typeof msg.itemId === 'string' ? msg.itemId : ''
          qty = typeof msg.qty === 'number' && msg.qty > 0 && msg.qty <= 5 ? Math.floor(msg.qty) : 1
        }
        const itemDef = CONTENT.items[itemId]
        if (!itemDef || (itemDef.effect.kind === 'ball' && itemDef.effect.bonus === 'master')) {
          audit(p.id, 'script.invalid_pickup', { groundId, itemId, qty }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        save.flags[flagKey] = true
        save.bag[itemId] = (save.bag[itemId] ?? 0) + qty
        addLedger(p.id, 'item', itemId, qty, save.bag[itemId], `script:pickup:${groundId}`)
        commitSave(p.id, save, { ref: `script:pickup:${groundId}` })
        return
      }
      case 'giveItem': {
        const itemId = typeof msg.itemId === 'string' ? msg.itemId : ''
        const qty = typeof msg.qty === 'number' && Number.isInteger(msg.qty) && msg.qty > 0 && msg.qty <= 20 ? msg.qty : 0
        const itemDef = CONTENT.items[itemId]
        if (!itemDef || qty <= 0 || (itemDef.effect.kind === 'ball' && itemDef.effect.bonus === 'master')) {
          audit(p.id, 'script.invalid_give_item', { itemId, qty }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }

        // 1. Active event scatter item pickup (deterministic server verification)
        if (typeof msg.groundId === 'string' && msg.groundId.startsWith('ev:')) {
          let matchedEvent: ActiveEvent | null = null
          let matchedItem: { id: string; x: number; y: number; item: string; qty: number; hidden: boolean } | null = null
          for (const ev of activeEvents(save.events ?? {}, save.clockMinutes)) {
            if (ev.anchor && ev.anchor.map !== p.state.map) continue
            const a = serverActionsForEvent(ev, p, save)
            const it = a.items.find((x) => x.id === msg.groundId)
            if (it) {
              matchedEvent = ev
              matchedItem = it
              break
            }
          }
          const takenKey = clientJson.flags.itemTaken + msg.groundId
          const maxDist = clientJson.items.snapRadius + clientJson.items.pickupRadius + 6
          if (
            !matchedEvent ||
            !matchedItem ||
            matchedItem.item !== itemId ||
            matchedItem.qty !== qty ||
            save.flags[takenKey] === matchedEvent.startedAt ||
            (world && Math.hypot(p.state.x - matchedItem.x, p.state.y - matchedItem.y) > maxDist)
          ) {
            audit(p.id, 'script.invalid_give_item', { itemId, qty, groundId: msg.groundId, map: p.state.map }, 3, p.ip)
            core.error(p, 'authority_violation')
            return
          }
          save.flags[takenKey] = matchedEvent.startedAt
          save.bag[itemId] = (save.bag[itemId] ?? 0) + qty
          const ref = `script:evitem:${msg.groundId}@${matchedEvent.startedAt}`
          addLedger(p.id, 'item', itemId, qty, save.bag[itemId], ref)
          commitSave(p.id, save, { ref })
          return
        }

        // 2. Contextualized script step grant
        if (
          p.state.map === 'origin-lab' &&
          ['dex-device', 'town-map', 'prompt-ball', 'cache-potion', 'work-permit'].includes(itemId) &&
          !save.flags[STORY_CONTENT.meta.flags.starter]
        ) {
          audit(p.id, 'script.invalid_give_item', { itemId, qty, map: p.state.map, reason: 'no_starter' }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }

        const resolved = resolveAuthorizedScriptStep(
          p,
          save,
          msg,
          (s) => s.op === 'giveItem' && s.item === itemId && s.qty === qty,
        )
        if (!resolved) {
          audit(p.id, 'script.invalid_give_item', { itemId, qty, map: p.state.map, sourceId: msg.sourceId, stepPath: msg.stepPath }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }

        const isLossRefill =
          (p.state.map === 'origin-lab-b1' || p.state.map === 'origin-lab-b2') &&
          Boolean(save.flags['ds:briefed']) &&
          !save.flags['ds:done'] &&
          (itemId === 'off-peak-coupon' || itemId === 'cache-potion') &&
          (resolved.canonicalSourceId === 'npc:ds-v4' || resolved.canonicalSourceId === 'script:ds-loss') &&
          (save.bag[itemId] ?? 0) + qty <= 2

        if (!resolved.paid && !isLossRefill && save.flags[resolved.grantFlag]) {
          audit(p.id, 'script.invalid_give_item', { itemId, qty, map: p.state.map, grantFlag: resolved.grantFlag, reason: 'already_claimed' }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        if (!resolved.paid && !isLossRefill) {
          save.flags[resolved.grantFlag] = true
          for (const lock of resolved.choiceLocks) save.flags[lock.key] = lock.branchIdx
        }
        save.bag[itemId] = (save.bag[itemId] ?? 0) + qty
        const ref = `script:giveItem:${resolved.canonicalSourceId}:${resolved.canonicalStepPath}:${itemId}:${qty}`
        addLedger(p.id, 'item', itemId, qty, save.bag[itemId], ref)
        commitSave(p.id, save, { ref })
        return
      }
      case 'takeItem': {
        const itemId = typeof msg.itemId === 'string' ? msg.itemId : ''
        const qty = typeof msg.qty === 'number' && Number.isInteger(msg.qty) && msg.qty > 0 ? msg.qty : 0
        const have = save.bag[itemId] ?? 0
        const n = Math.min(have, qty)
        if (n <= 0) return
        if (have - n > 0) save.bag[itemId] = have - n
        else delete save.bag[itemId]
        if (n === qty) {
          recentPayments.set(p.id, { kind: 'item', itemId, amount: n, map: p.state.map, at: Date.now() })
        }
        addLedger(p.id, 'item', itemId, -n, save.bag[itemId] ?? 0, `script:takeItem:${itemId}`)
        commitSave(p.id, save, { ref: `script:takeItem:${itemId}` })
        return
      }
      case 'giveMoney': {
        const amount = typeof msg.amount === 'number' && Number.isInteger(msg.amount) && msg.amount > 0 && msg.amount <= 50_000 ? msg.amount : 0
        if (amount <= 0) {
          audit(p.id, 'script.invalid_give_money', { amount: msg.amount, map: p.state.map }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        const resolved = resolveAuthorizedScriptStep(
          p,
          save,
          msg,
          (s) => s.op === 'giveMoney' && s.amount === amount,
        )
        if (!resolved || (!resolved.paid && save.flags[resolved.grantFlag])) {
          audit(p.id, 'script.invalid_give_money', { amount, map: p.state.map, sourceId: msg.sourceId, stepPath: msg.stepPath }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        if (!resolved.paid) {
          save.flags[resolved.grantFlag] = true
          for (const lock of resolved.choiceLocks) save.flags[lock.key] = lock.branchIdx
        }
        save.money += amount
        const ref = `script:giveMoney:${resolved.canonicalSourceId}:${resolved.canonicalStepPath}:${amount}`
        addLedger(p.id, 'money', 'script', amount, save.money, ref)
        commitSave(p.id, save, { ref })
        return
      }
      case 'takeMoney': {
        const amount = typeof msg.amount === 'number' && Number.isInteger(msg.amount) && msg.amount > 0 ? msg.amount : 0
        if (amount <= 0 || save.money < amount) return
        save.money -= amount
        recentPayments.set(p.id, { kind: 'money', amount, map: p.state.map, at: Date.now() })
        addLedger(p.id, 'money', 'script', -amount, save.money, 'script:takeMoney')
        commitSave(p.id, save, { ref: 'script:takeMoney' })
        return
      }
      case 'giveCreature': {
        const speciesId = typeof msg.speciesId === 'string' ? msg.speciesId : ''
        if (!CONTENT.species[speciesId]) {
          audit(p.id, 'script.invalid_give_creature', { speciesId, map: p.state.map }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        if (
          speciesId === 'phi-3' &&
          (!save.flags[STORY_CONTENT.meta.flags.starter] || save.flags['ds:stamp:types'])
        ) {
          audit(p.id, 'script.invalid_give_creature', { speciesId, reason: 'prereq_or_already_stamped' }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        const resolved = resolveAuthorizedScriptStep(
          p,
          save,
          msg,
          (s) => s.op === 'giveCreature' && s.species === speciesId,
        )
        if (!resolved || (!resolved.paid && save.flags[resolved.grantFlag])) {
          audit(p.id, 'script.invalid_give_creature', { speciesId, map: p.state.map, sourceId: msg.sourceId, stepPath: msg.stepPath }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        if (!resolved.paid) {
          save.flags[resolved.grantFlag] = true
          for (const lock of resolved.choiceLocks) save.flags[lock.key] = lock.branchIdx
        }
        const stepDef = resolved.step as Extract<ScriptStep, { op: 'giveCreature' }>
        const level = stepDef.level
        const ballId = CONTENT.itemList.find((it) => it.effect.kind === 'ball')?.id
        const seed = hashString(`${p.id}:gift:${speciesId}:${save.party.length}`) >>> 0
        const cr = createCreature(speciesId, level, {
          rng: new Rng(seed || 1),
          shiny: stepDef.shiny === true,
          otName: save.name,
          otId: save.playerId,
          ...(ballId ? { ballId } : {}),
          caughtMap: p.state.map,
          gradeFloor: stepDef.gradeFloor ?? CONTENT.quality.giftGradeFloor,
          origin: { kind: 'gift' },
          ...(stepDef.nature ? { nature: stepDef.nature } : {}),
          ...(stepDef.moves?.length ? { moves: stepDef.moves } : {}),
        }, CONTENT)
        if (stepDef.ability && CONTENT.abilities[stepDef.ability]) cr.abilityId = stepDef.ability
        storeCreatureInSave(save, cr)
        const ref = `script:gift:${resolved.canonicalSourceId}:${resolved.canonicalStepPath}:${speciesId}`
        addLedger(p.id, 'creature', cr.uid, 1, save.party.length, ref)
        commitSave(p.id, save, { ref })
        return
      }
      case 'setRespawn': {
        if (world && typeof msg.map === 'string' && msg.map && msg.map !== p.state.map) {
          audit(p.id, 'script.invalid_respawn', { requestedMap: msg.map, actualMap: p.state.map }, 2, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        const mapId = world ? p.state.map : (typeof msg.map === 'string' && msg.map ? msg.map : p.state.map)
        const rx = world ? Math.floor(p.state.x) : (typeof msg.x === 'number' && Number.isFinite(msg.x) ? Math.floor(msg.x) : Math.floor(p.state.x))
        const ry = world ? Math.floor(p.state.y) : (typeof msg.y === 'number' && Number.isFinite(msg.y) ? Math.floor(msg.y) : Math.floor(p.state.y))
        const facing = msg.facing && ['up', 'down', 'left', 'right'].includes(msg.facing) ? msg.facing : p.state.facing
        save.respawn = { map: mapId, x: rx, y: ry, facing }
        commitSave(p.id, save, { ref: 'script:respawn' })
        return
      }
      case 'unlockTown': {
        const townId = typeof msg.townId === 'string' ? msg.townId : ''
        if (!townId || (world && !world.towns.some((tw) => tw.id === townId))) return
        if (!save.visitedTowns.includes(townId)) {
          save.visitedTowns.push(townId)
          commitSave(p.id, save, { ref: `script:unlockTown:${townId}` })
        }
        return
      }
      case 'teach': {
        const flag = typeof msg.flag === 'string' && msg.flag && !msg.flag.startsWith('auth:')
          ? msg.flag
          : (typeof msg.lesson === 'string' && msg.lesson ? `lesson:${msg.lesson}` : '')
        if (!flag || (!flag.startsWith('lesson:') && !flag.startsWith('tutorial:'))) return
        save.flags[flag] = true
        noteRecentFlag(p.id, flag)
        commitSave(p.id, save, { ref: `script:teach:${flag}` })
        return
      }
      case 'research': {
        const spId = typeof msg.speciesId === 'string' ? msg.speciesId : ''
        const task = typeof msg.task === 'string' ? msg.task : ''
        const amount = typeof msg.amount === 'number' && Number.isInteger(msg.amount) ? msg.amount : 1
        if (!CONTENT.species[spId] || !task || amount <= 0 || amount > 10) {
          audit(p.id, 'script.invalid_research', { speciesId: spId, task, amount }, 2, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        const resolved = resolveAuthorizedScriptStep(
          p,
          save,
          msg,
          (s) => s.op === 'research' && s.species === spId && s.task === task && s.amount === amount,
        )
        if (!resolved || save.flags[resolved.grantFlag]) {
          audit(p.id, 'script.invalid_research', { speciesId: spId, task, amount, sourceId: msg.sourceId, stepPath: msg.stepPath }, 2, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        save.flags[resolved.grantFlag] = true
        for (const lock of resolved.choiceLocks) save.flags[lock.key] = lock.branchIdx
        const r = addTaskProgress(save.research ?? {}, spId, task, amount)
        save.research = r.state
        commitSave(p.id, save, { ref: `script:research:${spId}:${task}` })
        return
      }
      case 'claimResearch': {
        const claimFlag = clientJson.research.claimFlag
        const curLv = researchLevel(researchPoints(save.research ?? {})).level
        const rawClaimed = save.flags[claimFlag]
        const rClaimed = typeof rawClaimed === 'number' && Number.isFinite(rawClaimed) ? Math.max(0, Math.floor(rawClaimed)) : 0
        const targetLv = typeof msg.level === 'number' && Number.isInteger(msg.level) ? msg.level : curLv
        if (targetLv <= rClaimed || targetLv > curLv || curLv <= rClaimed) {
          audit(p.id, 'script.invalid_claim_research', { targetLv, rClaimed, curLv }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        for (let l = rClaimed + 1; l <= targetLv; l++) {
          if (save.flags[`auth:researchClaimed:${l}`]) {
            audit(p.id, 'script.invalid_claim_research', { level: l, rClaimed, targetLv, reason: 'level_already_claimed' }, 3, p.ip)
            core.error(p, 'authority_violation')
            return
          }
        }
        for (let l = rClaimed + 1; l <= targetLv; l++) {
          save.flags[`auth:researchClaimed:${l}`] = true
          const rew = levelRewards(l - 1, l)
          const ref = `script:claimResearch:${l}`
          if (rew.money > 0) {
            save.money += rew.money
            addLedger(p.id, 'money', 'research', rew.money, save.money, ref)
          }
          for (const [itemId, qty] of Object.entries(rew.items)) {
            if (CONTENT.items[itemId] && qty > 0) {
              save.bag[itemId] = (save.bag[itemId] ?? 0) + qty
              addLedger(p.id, 'item', itemId, qty, save.bag[itemId], ref)
            }
          }
        }
        save.flags[claimFlag] = targetLv
        commitSave(p.id, save, { ref: `script:claimResearch:${targetLv}` })
        return
      }
      case 'tickEvents': {
        advanceServerClock(p.id, save, msg.clockMinutes)
        if (clientJson.scheduler.requireFlag && !save.flags[clientJson.scheduler.requireFlag]) return
        const map = world ? getMap(world, p.state.map) : null
        if (map && !(clientJson.scheduler.mapKinds as string[]).includes(map.kind)) return
        const region = map ? regionAt(map, p.state.x, p.state.y) : null
        const anchor: EventAnchor = {
          map: p.state.map,
          x: Math.floor(p.state.x),
          y: Math.floor(p.state.y),
          ...(region ? { region: region.id } : {}),
        }
        const ectx = buildServerEventContext(p, save)
        const r = tickEvents(save.events ?? {}, ectx, eventRng(serverEventSeed(save), save.clockMinutes), { anchor })
        let state = r.state
        for (const ev of r.ended) cleanEndedEventFlags(ev, save)
        for (const ev of r.started) applyEventStartToSave(ev, p, save)
        for (const ev of r.active) {
          if (ev.def.scope !== 'local' || ev.def.trigger === 'legend' || !ev.anchor || ev.anchor.map !== p.state.map) continue
          if (Math.hypot(ev.anchor.x - p.state.x, ev.anchor.y - p.state.y) > clientJson.scheduler.localEndDistance) {
            state = endEvent(ev.id, state, save.clockMinutes)
          }
        }
        save.events = state
        commitSave(p.id, save, { ref: 'script:tickEvents' })
        return
      }
      case 'triggerEvent': {
        const evId = typeof msg.eventId === 'string' ? msg.eventId : ''
        const def = GAMEPLAY.eventById[evId]
        if (!def) {
          audit(p.id, 'script.invalid_trigger_event', { eventId: evId }, 2, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        advanceServerClock(p.id, save, msg.clockMinutes)
        const map = world ? getMap(world, p.state.map) : null
        const region = map ? regionAt(map, p.state.x, p.state.y) : null
        const anchor: EventAnchor = {
          map: p.state.map,
          x: Math.floor(p.state.x),
          y: Math.floor(p.state.y),
          ...(region ? { region: region.id } : {}),
        }
        const ectx = buildServerEventContext(p, save)
        let checkMode: 'progress' | 'all' = 'progress'
        if (def.trigger === 'legend' || evId.startsWith('legend-')) {
          checkMode = 'all'
          const lgSpecies = def.legend ?? evId.slice('legend-'.length)
          if (world) {
            const near = legendsNear(worldOrigin(world), { x: p.state.x, y: p.state.y }, save.clockMinutes, serverEventSeed(save), save.legends ?? {})
            if (!near.some((n) => n.legend.species === lgSpecies && n.proximity === 'appear')) {
              audit(p.id, 'script.invalid_trigger_event', { eventId: evId, reason: 'legend_not_near' }, 3, p.ip)
              core.error(p, 'authority_violation')
              return
            }
          }
        } else if (world) {
          let hasTriggerStep = false
          for (const script of collectMapScripts(p, save)) {
            walkAllSteps(script, (s) => {
              if (s.op === 'triggerEvent' && s.event === evId) hasTriggerStep = true
            })
            if (hasTriggerStep) break
          }
          if (!hasTriggerStep) {
            audit(p.id, 'script.invalid_trigger_event', { eventId: evId, map: p.state.map, reason: 'not_on_map' }, 3, p.ip)
            core.error(p, 'authority_violation')
            return
          }
        }
        const r = triggerEvent(evId, save.events ?? {}, ectx, { check: checkMode, anchor })
        if (!r.started) {
          if (r.reason === 'gated' || r.reason === 'spent') {
            audit(p.id, 'script.invalid_trigger_event', { eventId: evId, reason: r.reason }, 2, p.ip)
            core.error(p, 'authority_violation')
          }
          return
        }
        save.events = r.state
        applyEventStartToSave(r.started, p, save)
        commitSave(p.id, save, { ref: `script:triggerEvent:${evId}` })
        return
      }
      case 'settleBossCards': {
        const cap = bossCardCap(save.badges.length, CONTENT)
        for (const cr of [...save.party, ...save.boxes.flat()]) {
          if (isBossCard(cr)) settleBank(cr, cap, CONTENT)
        }
        save.flags[gameJson.flags.licenseSettled] = true
        commitSave(p.id, save, { ref: 'script:settleBossCards' })
        return
      }
      case 'setFlag': {
        const flag = typeof msg.flag === 'string' ? msg.flag : ''
        if (!flag) return
        if (
          flag.startsWith('auth:') ||
          flag.startsWith(STORY_CONTENT.meta.flags.trainerWon) ||
          flag.startsWith(gameJson.flags.bossWonPrefix) ||
          flag.startsWith('boss:won:') ||
          flag.startsWith(STORY_CONTENT.meta.flags.groundItem) ||
          flag.startsWith(clientJson.flags.itemTaken) ||
          flag.startsWith(clientJson.flags.spawnTaken) ||
          flag.startsWith('quest:reward:') ||
          flag === STORY_CONTENT.meta.flags.starter ||
          flag === clientJson.research.claimFlag ||
          flag === 'research:claimedLevel'
        ) {
          audit(p.id, 'script.forged_flag', { flag, value: msg.value }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        const v = msg.value ?? true
        if (typeof v !== 'boolean' && typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) {
          return
        }
        const clearableFlags = new Set(['ds:healUsed', 'ds:assist', 'rival:lab-lost', 'lesson:types-lost', 'ds:drillLost', 'ds:lost', 'ds:lostNow'])
        if ((v === false || v === 0 || v === '') && save.flags[flag] && !clearableFlags.has(flag)) {
          audit(p.id, 'script.forged_flag', { flag, value: v, reason: 'cannot_clear_progression_flag' }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        if (flag.startsWith(gameJson.flags.badgePrefix)) {
          const badgeType = flag.slice(gameJson.flags.badgePrefix.length)
          const ownsBadge = world
            ? world.badges.some((bd) => bd.type === badgeType && save.badges.includes(bd.id))
            : save.badges.some((b) => b.endsWith(badgeType))
          if (!ownsBadge && !save.flags[flag]) {
            audit(p.id, 'script.forged_flag', { flag, reason: 'badge_not_earned' }, 3, p.ip)
            core.error(p, 'authority_violation')
            return
          }
        } else if (flag === 'villain:swamp' && !save.flags['trainer:hx-admin-wangyan']) {
          audit(p.id, 'script.forged_flag', { flag, reason: 'missing_trainer_win' }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        } else if (flag === 'villain:boss' && !save.flags['trainer:hx-boss']) {
          audit(p.id, 'script.forged_flag', { flag, reason: 'missing_trainer_win' }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        } else if (flag === 'champion' && !save.flags['trainer:champion']) {
          audit(p.id, 'script.forged_flag', { flag, reason: 'missing_trainer_win' }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        } else if (flag === 'gate:ruins' && save.badges.length < 8) {
          audit(p.id, 'script.forged_flag', { flag, reason: 'insufficient_badges' }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        } else if (
          (flag === 'ds:done' || flag === 'ds:gateOpen') &&
          !save.flags[`${gameJson.flags.bossWonPrefix}deepseek`] &&
          (progressOf(save, 'deepseek-tide').clears.story ?? 0) <= 0
        ) {
          audit(p.id, 'script.forged_flag', { flag, reason: 'deepseek_not_cleared' }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        } else if (flag === 'ds:drill' && !save.flags[`${gameJson.flags.bossWonPrefix}deepseek-drill`]) {
          audit(p.id, 'script.forged_flag', { flag, reason: 'drill_not_cleared' }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        } else if (
          flag === 'ds:relay' &&
          !Object.keys(save.flags).some((k) => k.startsWith('trainer:ds-relay') && save.flags[k])
        ) {
          audit(p.id, 'script.forged_flag', { flag, reason: 'relay_not_defeated' }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        } else if (
          (flag === 'ds:stamp:starter' || flag === 'ds:stamp:types') &&
          !save.flags[STORY_CONTENT.meta.flags.starter]
        ) {
          audit(p.id, 'script.forged_flag', { flag, reason: 'no_starter' }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        } else if (
          (flag === 'ds:stamp:catch' || flag === 'ds:certFull') &&
          (!save.flags['ds:stamp:types'] || save.stats.caught <= 0)
        ) {
          audit(p.id, 'script.forged_flag', { flag, reason: 'catch_prereq_not_met' }, 3, p.ip)
          core.error(p, 'authority_violation')
          return
        }
        save.flags[flag] = v
        noteRecentFlag(p.id, flag)
        commitSave(p.id, save, { ref: `script:flag:${flag}` })
        return
      }
      case 'quest': {
        const qId = typeof msg.questId === 'string' ? msg.questId : ''
        const def = world
          ? (world.quests.find((q) => q.id === qId) ?? frontierQuest(world, qId))
          : (STORY_CONTENT.quests.find((q) => q.id === qId) ?? null)
        if (!def) return
        const prev = save.quests[qId]
        const stage = typeof msg.stage === 'number' && Number.isInteger(msg.stage) ? Math.max(0, Math.min(msg.stage, Math.max(0, def.stages.length - 1))) : 0
        const done = msg.done === true
        if (prev && (prev.done || stage < prev.stage)) return
        if (done) {
          if ((def.stages.length > 1 && !prev && qId !== 'ds-legacy') || (def.reward && !isQuestCompletionAuthorized(p, save, qId))) {
            audit(p.id, 'script.quest_skip_rejected', { questId: qId, stage, totalStages: def.stages.length }, 3, p.ip)
            core.error(p, 'authority_violation')
            return
          }
        }
        const justFinished = done && !prev?.done
        save.quests[qId] = { stage, done }
        if (justFinished && def.reward) {
          if (def.reward.money && def.reward.money > 0) {
            save.money += def.reward.money
            addLedger(p.id, 'money', qId, def.reward.money, save.money, `quest:${qId}`)
          }
          for (const [itemId, qty] of Object.entries(def.reward.items ?? {})) {
            if (CONTENT.items[itemId] && qty > 0) {
              save.bag[itemId] = (save.bag[itemId] ?? 0) + Math.floor(qty)
              addLedger(p.id, 'item', itemId, Math.floor(qty), save.bag[itemId], `quest:${qId}`)
            }
          }
        }
        commitSave(p.id, save, { ref: `quest:${qId}` })
        return
      }
    }
  }

  return {
    get secret() { return secret },

    async load() {
      if (!opts.secret) {
        secret = await loadOrCreateSaveSecret(opts.dataDir)
      }
    },

    async flush() {
      await store.flush()
    },

    async close() {
      activeBattles.clear()
      pendingContracts.clear()
      recentPayments.clear()
      recentFlagsSet.clear()
      lastClockSyncMs.clear()
      await store.flush()
    },

    hasSave(playerId) {
      return getRecord(playerId) !== null
    },

    isInBattle(playerId) {
      const b = activeBattles.get(playerId)
      return Boolean(b && !b.done)
    },

    getSave(playerId) {
      const rec = getRecord(playerId)
      return rec ? structuredClone(rec.save) : null
    },

    getRecord(playerId) {
      const rec = getRecord(playerId)
      return rec ? structuredClone(rec) : null
    },

    isUntrustedImport(playerId) {
      const rec = getRecord(playerId)
      return !!rec && (rec.imported || !rec.trusted || !!rec.save.flags['auth:untrustedImport'])
    },

    setSave(playerId, save, optsIn = {}) {
      lastClockSyncMs.set(playerId, Date.now())
      return commitSave(playerId, save, { ...optsIn, notify: false, syncPosition: false })
    },

    importOfflineSave(playerId, rawSave, optsIn = {}) {
      const isolated = isolateUntrustedSave(rawSave, {
        accountId: playerId,
        world,
        slotSig: optsIn.slotSig,
        slotIndex: optsIn.slotIndex,
      })
      if (!isolated.ok) {
        audit(playerId, 'save.import_rejected', { code: isolated.code, reason: isolated.reason }, 3, optsIn.ip)
        return isolated
      }
      const record = commitSave(playerId, isolated.save, {
        imported: true,
        trusted: false,
        ref: 'save:import',
      })
      audit(playerId, 'save.untrusted_import', { stripped: isolated.stripped, rev: record.rev }, 1, optsIn.ip)
      return { ok: true, record, stripped: isolated.stripped }
    },

    mutateSave(playerId, ref, fn) {
      const rec = getRecord(playerId)
      if (!rec) return null
      const working = structuredClone(rec.save)
      const out = fn(working)
      recordSaveDiffLedger(playerId, rec.save, working, ref)
      commitSave(playerId, working, { ref })
      return out
    },

    grantReward(playerId, reward, ref) {
      const rec = getRecord(playerId)
      if (!rec) return false
      const working = structuredClone(rec.save)
      if (reward.money && reward.money > 0) {
        working.money += Math.floor(reward.money)
      }
      for (const [itemId, qty] of Object.entries(reward.items ?? {})) {
        if (CONTENT.items[itemId] && qty > 0) {
          working.bag[itemId] = (working.bag[itemId] ?? 0) + Math.floor(qty)
        }
      }
      for (const cr of reward.creatures ?? []) {
        storeCreatureInSave(working, structuredClone(cr))
      }
      recordSaveDiffLedger(playerId, rec.save, working, ref)
      commitSave(playerId, working, { ref })
      return true
    },

    audit,

    listAudit(accountId) {
      return store.listAudit(accountId, 500)
    },

    listLedger(accountId) {
      return store.listLedger(accountId, 500)
    },

    noteStep(playerId) {
      playerMetrics(playerId).stepsSinceCheck += 1
    },

    validateProfileReport(p, reported) {
      const rec = getRecord(p.id)
      if (!rec) return reported
      const save = rec.save
      if (
        reported.badges.length > save.badges.length ||
        reported.dexCaught > save.dexCaught.length ||
        reported.party.some((v) => !save.party.some((c) => c.uid === v.uid && c.speciesId === v.speciesId && c.level === v.level))
      ) {
        audit(p.id, 'profile.tamper_rejected', {
          reportedBadges: reported.badges.length,
          actualBadges: save.badges.length,
          reportedDex: reported.dexCaught,
          actualDex: save.dexCaught.length,
        }, 2, p.ip)
      }
      const untrusted = rec.imported || !rec.trusted || Boolean(save.flags['auth:untrustedImport'])
      return {
        ...reported,
        badges: untrusted ? [] : [...save.badges],
        dexCaught: untrusted ? 0 : save.dexCaught.length,
        party: save.party.map((c) => toView(c, CONTENT)),
        playTimeSec: Math.floor(save.playTimeSec),
      }
    },

    validateTradeOffer(playerId, rawCreature, ip) {
      if (rawCreature === null) return { ok: true, creature: null }
      const cleaned = sanitizeCreature(rawCreature, CONTENT)
      if (!cleaned || !CONTENT.species[cleaned.speciesId]) {
        return { ok: false, code: 'trade_invalid_creature' }
      }
      if (cleaned.origin?.kind === 'boss') {
        return { ok: false, code: 'trade_bound_boss' }
      }
      const registeredOwner = creatureOwners.get(cleaned.uid)
      if (registeredOwner && registeredOwner !== playerId) {
        audit(playerId, 'trade.ownership_violation', { uid: cleaned.uid, owner: registeredOwner }, 3, ip)
        return { ok: false, code: 'trade_not_owned' }
      }
      const rec = getRecord(playerId)
      if (!rec) {
        if (cleaned.nickname) cleaned.nickname = maskBanned(cleaned.nickname)
        cleaned.otName = maskBanned(cleaned.otName)
        return { ok: true, creature: cleaned }
      }
      if (rec.imported || !rec.trusted || rec.save.flags['auth:untrustedImport']) {
        audit(playerId, 'trade.untrusted_account_offer', { uid: cleaned.uid }, 2, ip)
        return { ok: false, code: 'trade_untrusted_creature' }
      }
      const owned = rec.save.party.find((c) => c.uid === cleaned.uid)
      if (!owned) {
        audit(playerId, 'trade.ownership_violation', { uid: cleaned.uid, reason: 'not_in_party' }, 3, ip)
        return { ok: false, code: 'trade_not_owned' }
      }
      if (owned.origin?.kind === 'boss') {
        return { ok: false, code: 'trade_bound_boss' }
      }
      if (owned.origin?.kind === 'legacy') {
        audit(playerId, 'trade.untrusted_creature_offer', { uid: cleaned.uid }, 2, ip)
        return { ok: false, code: 'trade_untrusted_creature' }
      }
      if (!canOffer(rec.save.party, owned)) {
        return { ok: false, code: 'trade_invalid_creature' }
      }
      if (
        cleaned.speciesId !== owned.speciesId ||
        cleaned.level !== owned.level ||
        cleaned.shiny !== owned.shiny ||
        cleaned.abilityId !== owned.abilityId ||
        cleaned.ivs.hp !== owned.ivs.hp ||
        cleaned.ivs.atk !== owned.ivs.atk ||
        cleaned.ivs.def !== owned.ivs.def ||
        cleaned.ivs.spa !== owned.ivs.spa ||
        cleaned.ivs.spd !== owned.ivs.spd ||
        cleaned.ivs.spe !== owned.ivs.spe
      ) {
        audit(playerId, 'trade.offer_tamper', { uid: cleaned.uid, claimedLevel: cleaned.level, actualLevel: owned.level }, 3, ip)
        return { ok: false, code: 'trade_invalid_creature' }
      }
      const authoritative = structuredClone(owned)
      if (authoritative.nickname) authoritative.nickname = maskBanned(authoritative.nickname)
      authoritative.otName = maskBanned(authoritative.otName)
      return { ok: true, creature: authoritative }
    },

    completeTrade(aId, aUid, bId, bUid, tradeId) {
      const recA = getRecord(aId)
      const recB = getRecord(bId)
      if (!recA && !recB) return true
      if (!recA || !recB) {
        audit(aId, 'trade.mismatched_authority', { aId, bId, tradeId }, 3)
        return false
      }
      const giveA = recA.save.party.find((c) => c.uid === aUid)
      const giveB = recB.save.party.find((c) => c.uid === bUid)
      if (!giveA || !giveB || giveA.uid === giveB.uid) {
        audit(aId, 'trade.missing_creature_at_commit', { aId, aUid, bId, bUid, tradeId }, 3)
        return false
      }
      const saveA = structuredClone(recA.save)
      const saveB = structuredClone(recB.save)
      const resA = applyTradeResult(saveA, aUid, structuredClone(giveB), CONTENT)
      const resB = applyTradeResult(saveB, bUid, structuredClone(giveA), CONTENT)
      if (!resA.given || !resB.given) {
        audit(aId, 'trade.commit_failed', { aId, bId, tradeId }, 3)
        return false
      }
      const rA = applyResearch(saveA.research ?? {}, [{ species: giveB.speciesId, event: { kind: 'trade' } }])
      if (rA.gains.length) saveA.research = rA.state
      const rB = applyResearch(saveB.research ?? {}, [{ species: giveA.speciesId, event: { kind: 'trade' } }])
      if (rB.gains.length) saveB.research = rB.state
      const ref = `trade:${tradeId}`
      addLedger(aId, 'creature', aUid, -1, saveA.party.length, ref)
      addLedger(aId, 'creature', bUid, 1, saveA.party.length, ref)
      addLedger(bId, 'creature', bUid, -1, saveB.party.length, ref)
      addLedger(bId, 'creature', aUid, 1, saveB.party.length, ref)
      commitSave(aId, saveA, { ref })
      commitSave(bId, saveB, { ref })
      return true
    },

    validatePvpParty(playerId, rawParty, healParty, ip) {
      if (!Array.isArray(rawParty)) return null
      for (const item of rawParty) {
        if (isRecord(item) && typeof item.uid === 'string') {
          const owner = creatureOwners.get(item.uid)
          if (owner && owner !== playerId) {
            audit(playerId, 'pvp.party_tamper', { reason: 'cross_account_uid', uid: item.uid, owner }, 3, ip)
            return null
          }
        }
      }
      const rec = getRecord(playerId)
      if (!rec) return undefined
      if (rec.imported || !rec.trusted || rec.save.flags['auth:untrustedImport']) {
        audit(playerId, 'pvp.untrusted_party', {}, 2, ip)
        return null
      }
      if (rawParty.length < 1 || rawParty.length > CONTENT.config.party.maxParty) {
        audit(playerId, 'pvp.party_tamper', { reason: 'invalid_party_length', length: rawParty.length }, 2, ip)
        return null
      }
      const out: Creature[] = []
      const seen = new Set<string>()
      for (const rawCr of rawParty) {
        if (!isRecord(rawCr) || typeof rawCr.uid !== 'string') {
          audit(playerId, 'pvp.party_tamper', { reason: 'malformed_creature' }, 3, ip)
          return null
        }
        if (seen.has(rawCr.uid)) {
          audit(playerId, 'pvp.party_tamper', { reason: 'duplicate_uid', uid: rawCr.uid }, 3, ip)
          return null
        }
        seen.add(rawCr.uid)
        const owned = rec.save.party.find((c) => c.uid === rawCr.uid)
        if (!owned) {
          audit(playerId, 'pvp.party_tamper', { reason: 'uid_not_in_party', uid: rawCr.uid }, 3, ip)
          return null
        }
        if (owned.origin?.kind === 'legacy') {
          audit(playerId, 'pvp.untrusted_party', { reason: 'legacy_creature', uid: rawCr.uid }, 2, ip)
          return null
        }
        if (
          rawCr.speciesId !== owned.speciesId ||
          rawCr.level !== owned.level ||
          rawCr.abilityId !== owned.abilityId ||
          !isRecord(rawCr.ivs) ||
          rawCr.ivs.hp !== owned.ivs.hp ||
          rawCr.ivs.atk !== owned.ivs.atk ||
          rawCr.ivs.def !== owned.ivs.def ||
          rawCr.ivs.spa !== owned.ivs.spa ||
          rawCr.ivs.spd !== owned.ivs.spd ||
          rawCr.ivs.spe !== owned.ivs.spe
        ) {
          audit(playerId, 'pvp.party_tamper', { reason: 'stats_or_species_tampered', uid: rawCr.uid }, 3, ip)
          return null
        }
        const clone = structuredClone(owned)
        if (clone.nickname) clone.nickname = maskBanned(clone.nickname)
        clone.otName = maskBanned(clone.otName)
        if (healParty) {
          clone.hp = maxHp(clone, CONTENT)
          clone.status = null
          clone.statusTurns = 0
          for (const m of clone.moves) m.pp = m.ppMax
        }
        out.push(clone)
      }
      if (!out.some((c) => c.hp > 0)) return null
      return out
    },

    handle(p, msg) {
      const isDungeonBusy = 'dungeonBusy' in p && p.dungeonBusy === true
      switch (msg.t) {
        case 'battle.start':
          if (isDungeonBusy || this.isInBattle(p.id)) { core.error(p, 'self_busy'); return true }
          handleBattleStart(p, msg)
          return true
        case 'battle.action':
          if (isDungeonBusy) { core.error(p, 'self_busy'); return true }
          handleBattleAction(p, msg)
          return true
        case 'battle.contract':
          if (isDungeonBusy) { core.error(p, 'self_busy'); return true }
          handleBattleContract(p, msg)
          return true
        case 'shop.buy':
          if (isDungeonBusy || this.isInBattle(p.id)) { core.error(p, 'self_busy'); return true }
          handleShopBuy(p, msg)
          return true
        case 'shop.sell':
          if (isDungeonBusy || this.isInBattle(p.id)) { core.error(p, 'self_busy'); return true }
          handleShopSell(p, msg)
          return true
        case 'item.use':
          if (isDungeonBusy || this.isInBattle(p.id)) { core.error(p, 'self_busy'); return true }
          handleItemUse(p, msg)
          return true
        case 'exchange.deal':
          if (isDungeonBusy || this.isInBattle(p.id)) { core.error(p, 'self_busy'); return true }
          handleExchangeDeal(p, msg)
          return true
        case 'creature.evolve':
          if (isDungeonBusy) { core.error(p, 'self_busy'); return true }
          handleCreatureEvolve(p, msg)
          return true
        case 'creature.learnMove':
          if (isDungeonBusy) { core.error(p, 'self_busy'); return true }
          handleCreatureLearnMove(p, msg)
          return true
        case 'creature.nickname':
          if (isDungeonBusy) { core.error(p, 'self_busy'); return true }
          handleCreatureNickname(p, msg)
          return true
        case 'party.swap':
          if (isDungeonBusy || this.isInBattle(p.id)) { core.error(p, 'self_busy'); return true }
          handlePartySwap(p, msg)
          return true
        case 'box.move':
          if (isDungeonBusy || this.isInBattle(p.id)) { core.error(p, 'self_busy'); return true }
          handleBoxMove(p, msg)
          return true
        case 'box.release':
          if (isDungeonBusy || this.isInBattle(p.id)) { core.error(p, 'self_busy'); return true }
          handleBoxRelease(p, msg)
          return true
        case 'script.op':
          if (isDungeonBusy) { core.error(p, 'self_busy'); return true }
          handleScriptOp(p, msg)
          return true
        case 'save.import': {
          if (isDungeonBusy || this.isInBattle(p.id)) { core.error(p, 'self_busy'); return true }
          if (this.hasSave(p.id)) {
            audit(p.id, 'save.import_already_bound', {}, 2, p.ip)
            core.error(p, 'authority_violation')
            return true
          }
          const res = this.importOfflineSave(p.id, msg.save, { ip: p.ip, slotSig: msg.slotSig, slotIndex: msg.slotIndex })
          if (!res.ok) {
            core.error(p, res.code)
            return true
          }
          return true
        }
        default: {
          const kind: string = msg.t
          if (
            kind.startsWith('battle.') ||
            kind.startsWith('shop.') ||
            kind.startsWith('item.') ||
            kind.startsWith('save.') ||
            kind.startsWith('reward.') ||
            kind.startsWith('exp.') ||
            kind.startsWith('money.')
          ) {
            audit(p.id, 'authority.forged_message', { t: kind }, 3, p.ip)
            core.error(p, 'authority_violation')
            const rec = getRecord(p.id)
            if (rec) core.send(p, { t: 'state.sync', save: rec.save, rev: rec.rev, reason: 'authority_violation' })
            return true
          }
          return false
        }
      }
    },

    onDisconnect(playerId) {
      activeBattles.delete(playerId)
      recentPayments.delete(playerId)
      recentFlagsSet.delete(playerId)
      lastClockSyncMs.delete(playerId)
    },
  }
}
