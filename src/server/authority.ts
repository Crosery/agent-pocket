// Authoritative online gameplay service (#22):
// - Server-owned SaveData per account/player, signed at rest with HMAC-SHA256 (save-sign.ts) and verified on load.
// - Authoritative PvE battles (wild / trainer / boss) executed on the server via the shared BattleEngine.
// - Authoritative captures, boss contracts, exp/level-ups, shop buy/sell, field item use, exchange, party/box moves.
// - Ownership enforcement for trades and PvP parties (prevents cross-account theft, duplication, and party fabrication).
// - Economic ledger + anti-cheat audit log + anomaly detection (encounter/step ratio, hourly exp/money rate).
import { randomInt } from 'node:crypto'
import battleUiJson from '../../content/battle-ui.json' with { type: 'json' }
import type {
  BattleAction, BattleEvent, BattleInit, BattleModifiers, BattleRequest, BattleSideInit, Creature, SaveData, SpeciesDef, TrainerDef, World,
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
import { activeEvents, eventModifiers, modifierValue } from '../shared/gameplay/events.ts'
import { instanceOfBoss, progressOf } from '../shared/gameplay/instances.ts'
import { addTaskProgress } from '../shared/gameplay/research.ts'
import { GAMEPLAY } from '../shared/gameplay/data.ts'
import {
  applyMedicine, applyTradeResult, canOffer, canSell, catchPlacement, medicineBlocker, moveCreature, releaseCreature,
  sellPrice, shopBuyPrice, teachState,
} from '../shared/gameplay/save-ops.ts'
import { STORY_CONTENT } from '../shared/world/story.ts'
import { frontierQuest, frontierTrainer } from '../shared/world/frontier/content/index.ts'
import { getMap, objectsInRect, regionAt } from '../shared/world/worldapi.ts'
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
  firstClear: boolean
  captureAfterWin: boolean
  consumedItems: Record<string, number>
  moneyEarned: number
  lootEarned: Record<string, number>
  expEarned: number
  seenSpecies: Set<string>
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
    optsIn: { imported?: boolean; trusted?: boolean; ref?: string; notify?: boolean } = {},
  ): SignedServerSave {
    const now = Date.now()
    const stored = store.putAccountSave(playerId, structuredClone(save), {
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
        b.seenSpecies.add(e.creature.speciesId)
      } else if (e.t === 'item' && e.side === 0) {
        b.consumedItems[e.itemId] = (b.consumedItems[e.itemId] ?? 0) + 1
        b.bag[e.itemId] = Math.max(0, (b.bag[e.itemId] ?? 0) - 1)
      } else if (e.t === 'money' && e.amount > 0) {
        b.moneyEarned += Math.floor(e.amount)
      } else if (e.t === 'loot' && e.qty > 0 && CONTENT.items[e.itemId]) {
        b.lootEarned[e.itemId] = (b.lootEarned[e.itemId] ?? 0) + Math.floor(e.qty)
      } else if (e.t === 'exp' && e.amount > 0) {
        b.expEarned += Math.floor(e.amount)
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
      if (b.bossId) save.flags[`bossWon:${b.bossId}`] = true
    }

    if (result === 'win') {
      save.stats.battlesWon += 1
      if (b.trainer) {
        save.flags[STORY_CONTENT.meta.flags.trainerWon + b.trainer.id] = true
        if (b.trainer.badge && !save.badges.includes(b.trainer.badge)) {
          save.badges.push(b.trainer.badge)
          const badge = world?.badges.find((bd) => bd.id === b.trainer!.badge)
          if (badge) save.flags[`badge:${badge.type}`] = true
          const cap = bossCardCap(save.badges.length, CONTENT)
          for (let i = 0; i < save.party.length; i++) {
            const cr = save.party[i]
            if (!isBossCard(cr)) continue
            const r = settleBank(cr, cap, CONTENT)
            if (r.learnable.length) {
              let set = b.learnableMoves.get(i)
              if (!set) { set = new Set(); b.learnableMoves.set(i, set) }
              for (const m of r.learnable) set.add(m)
            }
          }
          for (const box of save.boxes) {
            for (const cr of box) {
              if (isBossCard(cr)) settleBank(cr, cap, CONTENT)
            }
          }
          save.flags['ds:licenseSettled'] = true
        }
      }
      if (b.bossId) {
        save.flags[`bossWon:${b.bossId}`] = true
        if (b.tierId) {
          const inst = instanceOfBoss(b.bossId)
          const rules = inst?.def.tiers[b.tierId]
          if (inst && rules) {
            const prog = progressOf(save, inst.id)
            prog.clears[b.tierId] = (prog.clears[b.tierId] ?? 0) + 1
            prog.losses[b.tierId] = 0
            save.flags[GAMEPLAY.instanceDefaults.assistOfferFlag] = false
            const rewardMoney = b.firstClear ? (rules.reward.money ?? 0) : (rules.repeat.money ?? 0)
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
            if (b.captureAfterWin && (b.firstClear || rules.repeat.capture)) {
              pendingContracts.set(b.id, {
                battleId: b.id,
                playerId: p.id,
                bossId: b.bossId,
                tierId: b.tierId,
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
          save.flags[GAMEPLAY.instanceDefaults.assistOfferFlag] = prog.losses[b.tierId] >= GAMEPLAY.instanceDefaults.assistAfterLosses
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
    let firstClear = false
    const captureAfterWin = msg.captureAfterWin === true

    if (msg.kind === 'wild') {
      const m = playerMetrics(p.id)
      m.encountersSinceCheck += 1
      if (m.encountersSinceCheck >= 20 && m.stepsSinceCheck < 5) {
        audit(p.id, 'anomaly.encounter_step_ratio', { encounters: m.encountersSinceCheck, steps: m.stepsSinceCheck, map: p.state.map }, 2, p.ip)
      }
      let speciesId = msg.speciesId
      let level = msg.level
      if (speciesId !== undefined) {
        const sp = CONTENT.species[speciesId]
        if (!sp) {
          audit(p.id, 'battle.invalid_encounter', { reason: 'unknown_species', speciesId }, 2, p.ip)
          core.error(p, 'invalid_encounter')
          return
        }
        const bossDef = CONTENT.bossBySpecies[speciesId]
        if (bossDef?.scriptedOnly) {
          const mapHasBossScript = !world || Boolean(
            map?.npcs.some((n) => JSON.stringify(n.script ?? []).includes(speciesId!)),
          )
          if (!msg.scripted || !mapHasBossScript) {
            audit(p.id, 'battle.invalid_encounter', { reason: 'scripted_only_boss', speciesId }, 3, p.ip)
            core.error(p, 'invalid_encounter')
            return
          }
        }
        if (region && !msg.scripted && !msg.roamer && region.encounters.length > 0) {
          const inTable = region.encounters.some((s) => s.species === speciesId)
          if (!inTable) {
            audit(p.id, 'battle.invalid_encounter', { reason: 'species_not_in_region_table', speciesId, region: region.id }, 2, p.ip)
            core.error(p, 'invalid_encounter')
            return
          }
        }
      } else if (region && region.encounters.length > 0) {
        const slot = rng.pick(region.encounters)
        speciesId = slot.species
        level = rng.int(Math.min(slot.minLevel, slot.maxLevel), Math.max(slot.minLevel, slot.maxLevel))
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
      if (world && region && region.encounters.length > 0 && !msg.scripted && !msg.roamer) {
        const slots = region.encounters.filter((s) => s.species === speciesId)
        if (slots.length > 0) {
          const minLv = Math.min(...slots.map((s) => Math.min(s.minLevel, s.maxLevel)))
          const maxLv = Math.max(...slots.map((s) => Math.max(s.minLevel, s.maxLevel)))
          clampedLevel = Math.max(minLv, Math.min(maxLv, clampedLevel))
        }
      } else if (world && (msg.scripted || msg.roamer)) {
        const maxAllowed = Math.min(CONTENT.config.party.maxLevel, Math.max(25, save.badges.length * 10 + 20))
        clampedLevel = Math.min(clampedLevel, maxAllowed)
      }
      const foe = createCreature(speciesId, clampedLevel, {
        rng,
        shiny: rollShiny(rng, CONTENT),
        caughtMap: p.state.map,
      }, CONTENT)
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
      if (typeof msg.catchRateMul === 'number' && msg.catchRateMul > 0 && msg.catchRateMul <= 5 && (msg.scripted || clampedLevel <= 15)) {
        mods.catchRate = msg.catchRateMul
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
      const tr = world ? (world.trainers[trId] ?? frontierTrainer(world, trId)) : null
      if (!tr) {
        audit(p.id, 'battle.invalid_trainer', { trainerId: trId }, 2, p.ip)
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
      bossId = bId
      tierId = tId
      const prog = progressOf(save, inst.id)
      const unlock = (rules as { unlock?: { tier?: string; badges?: number; flag?: string } }).unlock
      if (unlock) {
        if (unlock.tier && (prog.clears[unlock.tier] ?? 0) <= 0) {
          audit(p.id, 'battle.locked_boss_tier', { bossId: bId, tierId: tId, needTier: unlock.tier }, 2, p.ip)
          core.error(p, 'invalid_encounter')
          return
        }
        if (typeof unlock.badges === 'number' && save.badges.length < unlock.badges) {
          audit(p.id, 'battle.locked_boss_tier', { bossId: bId, tierId: tId, needBadges: unlock.badges }, 2, p.ip)
          core.error(p, 'invalid_encounter')
          return
        }
        if (unlock.flag && !save.flags[unlock.flag]) {
          audit(p.id, 'battle.locked_boss_tier', { bossId: bId, tierId: tId, needFlag: unlock.flag }, 2, p.ip)
          core.error(p, 'invalid_encounter')
          return
        }
      }
      firstClear = (prog.clears[tId] ?? 0) === 0
      save.rollSeed ??= hashString(save.playerId) >>> 0
      prog.runSeq += 1
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
      firstClear,
      captureAfterWin,
      consumedItems: {},
      moneyEarned: 0,
      lootEarned: {},
      expEarned: 0,
      seenSpecies: new Set(),
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
      : BATTLE_CONTRACT_DEFAULT_BALL
    const heldBalls = Object.entries(save.bag).filter(([id, n]) => n > 0 && CONTENT.items[id]?.effect.kind === 'ball')
    if (heldBalls.length > 0 && (save.bag[ballId] ?? 0) <= 0) {
      audit(p.id, 'battle.contract_ball_not_owned', { battleId: msg.battleId, ballId }, 2, p.ip)
      core.error(p, 'item_not_owned')
      return
    }
    pending.signed = true
    pendingContracts.delete(msg.battleId)

    const prog = progressOf(save, inst.id)
    const first = (prog.captures[msg.tierId] ?? 0) === 0
    if (!first && !rules.repeat.capture) {
      const committed = commitSave(p.id, save, { ref: `contract:${msg.battleId}`, notify: false })
      core.send(p, { t: 'battle.contracted', battleId: msg.battleId, signed: null, save: committed.save, rev: committed.rev })
      return
    }
    save.rollSeed ??= hashString(save.playerId) >>> 0
    const seed = captureSeed(save.rollSeed, inst.id, msg.tierId, first ? 0 : prog.runSeq)
    const card = rollBossCard(new Rng(seed), msg.bossId, msg.tierId, rules, {
      first,
      run: String(prog.runSeq),
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
    if (BATTLE_CONTRACT_CONSUME_BALL && (save.bag[ballId] ?? 0) > 0) {
      if (save.bag[ballId] > 1) save.bag[ballId] -= 1
      else delete save.bag[ballId]
      addLedger(p.id, 'item', ballId, -1, save.bag[ballId] ?? 0, `contract:${msg.battleId}`)
    }
    addLedger(p.id, 'creature', card.uid, 1, save.party.length, `contract:${msg.battleId}`)
    const committed = commitSave(p.id, save, { ref: `contract:${msg.battleId}`, notify: false })
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
    const active = activeEvents(rec.save.events ?? {}, rec.save.clockMinutes)
    const evMods = eventModifiers(active, { map: p.state.map, x: p.state.x, y: p.state.y }, rec.save.clockMinutes)
    const serverMul = modifierValue(evMods, 'shopPrice', { category: item.category })
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
      if (save.repelSteps > 0) { core.error(p, 'invalid_item_use'); return }
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

  function handleCreatureEvolve(p: Player, msg: Extract<ClientMsg, { t: 'creature.evolve' }>): void {
    const rec = getRecord(p.id)
    if (!rec) { core.error(p, 'not_ready'); return }
    const idx = typeof msg.partyIndex === 'number' && Number.isInteger(msg.partyIndex) ? msg.partyIndex : -1
    const cr = rec.save.party[idx]
    const target = typeof msg.toSpeciesId === 'string' ? msg.toSpeciesId : ''
    if (!cr || !CONTENT.species[target]) {
      audit(p.id, 'creature.invalid_evolve', { partyIndex: msg.partyIndex, toSpeciesId: msg.toSpeciesId }, 2, p.ip)
      core.error(p, 'authority_violation')
      return
    }
    if (cr.speciesId === target) return
    if (evolutionTarget(cr, CONTENT) !== target) {
      audit(p.id, 'creature.invalid_evolve', { partyIndex: msg.partyIndex, toSpeciesId: msg.toSpeciesId }, 2, p.ip)
      core.error(p, 'authority_violation')
      return
    }
    const save = structuredClone(rec.save)
    evolve(save.party[idx], target, CONTENT)
    if (!save.dexSeen.includes(target)) save.dexSeen.push(target)
    if (!save.dexCaught.includes(target)) save.dexCaught.push(target)
    commitSave(p.id, save, { ref: `evolve:${cr.uid}:${target}` })
  }

  function handleCreatureLearnMove(p: Player, msg: Extract<ClientMsg, { t: 'creature.learnMove' }>): void {
    const rec = getRecord(p.id)
    if (!rec) { core.error(p, 'not_ready'); return }
    const idx = typeof msg.partyIndex === 'number' && Number.isInteger(msg.partyIndex) ? msg.partyIndex : -1
    const moveId = typeof msg.moveId === 'string' ? msg.moveId : ''
    const mv = CONTENT.moves[moveId]
    const active = activeBattles.get(p.id)
    const battleCr = active?.workingParty[idx]
    const saveCr = rec.save.party[idx]
    const cr = battleCr ?? saveCr
    const allowedInBattle = Boolean(active?.learnableMoves.get(idx)?.has(moveId))
    const allowedByLearnset = Boolean(cr && learnsetMovesAtOrBelow(cr.speciesId, cr.level).has(moveId))
    if (!cr || !mv || (!allowedInBattle && !allowedByLearnset)) {
      audit(p.id, 'creature.invalid_learn_move', { partyIndex: msg.partyIndex, moveId }, 2, p.ip)
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
    if (save.party[idx]) applySlot(save.party[idx])
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
        const options = CONTENT.speciesList.filter((sp) => sp.starter)
        const chosen = typeof msg.speciesId === 'string' && options.some((sp) => sp.id === msg.speciesId)
          ? msg.speciesId
          : (options[0]?.id ?? '')
        if (!chosen) return
        const ballId = CONTENT.itemList.find((it) => it.effect.kind === 'ball')?.id
        const clientStarter = msg.creature ? sanitizeCreature(msg.creature, CONTENT) : null
        let cr: Creature
        if (
          clientStarter &&
          clientStarter.speciesId === chosen &&
          clientStarter.level === CONTENT.config.creature.starterLevel
        ) {
          cr = {
            ...clientStarter,
            otName: save.name,
            otId: save.playerId,
            ballId: ballId ?? clientStarter.ballId,
            caughtMap: p.state.map,
            origin: { kind: 'starter' },
          }
          cr.hp = maxHp(cr, CONTENT)
        } else {
          const seed = hashString(`${p.id}:starter:${chosen}`) >>> 0
          cr = createCreature(chosen, CONTENT.config.creature.starterLevel, {
            rng: new Rng(seed || 1),
            otName: save.name,
            otId: save.playerId,
            ...(ballId ? { ballId } : {}),
            caughtMap: p.state.map,
            gradeFloor: CONTENT.quality.giftGradeFloor,
            origin: { kind: 'starter' },
          }, CONTENT)
        }
        storeCreatureInSave(save, cr)
        save.flags[STORY_CONTENT.meta.flags.starter] = chosen
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
          const ground = nearItems.find((it) => it.id === groundId) ?? map?.items.find((it) => it.id === groundId)
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
        save.bag[itemId] = (save.bag[itemId] ?? 0) + qty
        addLedger(p.id, 'item', itemId, qty, save.bag[itemId], `script:giveItem:${itemId}`)
        commitSave(p.id, save, { ref: `script:giveItem:${itemId}` })
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
        addLedger(p.id, 'item', itemId, -n, save.bag[itemId] ?? 0, `script:takeItem:${itemId}`)
        commitSave(p.id, save, { ref: `script:takeItem:${itemId}` })
        return
      }
      case 'giveMoney': {
        const amount = typeof msg.amount === 'number' && Number.isInteger(msg.amount) && msg.amount > 0 && msg.amount <= 50_000 ? msg.amount : 0
        if (amount <= 0) return
        save.money += amount
        addLedger(p.id, 'money', 'script', amount, save.money, 'script:giveMoney')
        commitSave(p.id, save, { ref: 'script:giveMoney' })
        return
      }
      case 'takeMoney': {
        const amount = typeof msg.amount === 'number' && Number.isInteger(msg.amount) && msg.amount > 0 ? msg.amount : 0
        if (amount <= 0 || save.money < amount) return
        save.money -= amount
        addLedger(p.id, 'money', 'script', -amount, save.money, 'script:takeMoney')
        commitSave(p.id, save, { ref: 'script:takeMoney' })
        return
      }
      case 'giveCreature': {
        const speciesId = typeof msg.speciesId === 'string' ? msg.speciesId : ''
        const level = typeof msg.level === 'number' && Number.isInteger(msg.level) ? Math.max(1, Math.min(35, msg.level)) : 5
        if (!CONTENT.species[speciesId]) return
        const ballId = CONTENT.itemList.find((it) => it.effect.kind === 'ball')?.id
        const clientCr = msg.creature ? sanitizeCreature(msg.creature, CONTENT) : null
        let cr: Creature
        if (clientCr && clientCr.speciesId === speciesId && clientCr.level === level) {
          cr = {
            ...clientCr,
            otName: save.name,
            otId: save.playerId,
            ballId: ballId ?? clientCr.ballId,
            caughtMap: p.state.map,
            origin: { kind: 'gift' },
          }
          cr.hp = maxHp(cr, CONTENT)
        } else {
          const seed = hashString(`${p.id}:gift:${speciesId}:${save.party.length}`) >>> 0
          cr = createCreature(speciesId, level, {
            rng: new Rng(seed || 1),
            shiny: msg.shiny === true,
            otName: save.name,
            otId: save.playerId,
            ...(ballId ? { ballId } : {}),
            caughtMap: p.state.map,
            gradeFloor: msg.gradeFloor ?? CONTENT.quality.giftGradeFloor,
            origin: { kind: 'gift' },
            ...(msg.nature ? { nature: msg.nature } : {}),
            ...(msg.moves?.length ? { moves: msg.moves } : {}),
          }, CONTENT)
          if (msg.ability && CONTENT.abilities[msg.ability]) cr.abilityId = msg.ability
        }
        storeCreatureInSave(save, cr)
        addLedger(p.id, 'creature', cr.uid, 1, save.party.length, `script:gift:${speciesId}`)
        commitSave(p.id, save, { ref: `script:gift:${speciesId}` })
        return
      }
      case 'setRespawn': {
        const mapId = typeof msg.map === 'string' && msg.map ? msg.map : p.state.map
        const rx = typeof msg.x === 'number' && Number.isFinite(msg.x) ? Math.floor(msg.x) : Math.floor(p.state.x)
        const ry = typeof msg.y === 'number' && Number.isFinite(msg.y) ? Math.floor(msg.y) : Math.floor(p.state.y)
        const facing = msg.facing && ['up', 'down', 'left', 'right'].includes(msg.facing) ? msg.facing : p.state.facing
        save.respawn = { map: mapId, x: rx, y: ry, facing }
        commitSave(p.id, save, { ref: 'script:respawn', notify: false })
        return
      }
      case 'unlockTown': {
        const townId = typeof msg.townId === 'string' ? msg.townId : ''
        if (!townId || (world && !world.towns.some((tw) => tw.id === townId))) return
        if (!save.visitedTowns.includes(townId)) {
          save.visitedTowns.push(townId)
          commitSave(p.id, save, { ref: `script:unlockTown:${townId}`, notify: false })
        }
        return
      }
      case 'teach': {
        const flag = typeof msg.flag === 'string' && msg.flag && !msg.flag.startsWith('auth:')
          ? msg.flag
          : (typeof msg.lesson === 'string' && msg.lesson ? `tutorial:lesson:${msg.lesson}` : '')
        if (!flag) return
        save.flags[flag] = true
        commitSave(p.id, save, { ref: `script:teach:${flag}`, notify: false })
        return
      }
      case 'research': {
        const spId = typeof msg.speciesId === 'string' ? msg.speciesId : ''
        const task = typeof msg.task === 'string' ? msg.task : ''
        const amount = typeof msg.amount === 'number' && Number.isFinite(msg.amount) && msg.amount > 0 ? Math.min(20, Math.floor(msg.amount)) : 1
        if (!CONTENT.species[spId] || !task) return
        const r = addTaskProgress(save.research ?? {}, spId, task, amount)
        if (r.gains.length) {
          save.research = r.state
          commitSave(p.id, save, { ref: `script:research:${spId}:${task}`, notify: false })
        }
        return
      }
      case 'settleBossCards': {
        const cap = bossCardCap(save.badges.length, CONTENT)
        for (const cr of [...save.party, ...save.boxes.flat()]) {
          if (isBossCard(cr)) settleBank(cr, cap, CONTENT)
        }
        save.flags['ds:licenseSettled'] = true
        commitSave(p.id, save, { ref: 'script:settleBossCards', notify: false })
        return
      }
      case 'setFlag': {
        if (typeof msg.flag !== 'string' || !msg.flag || msg.flag.startsWith('auth:')) return
        const v = msg.value ?? true
        if (typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) {
          save.flags[msg.flag] = v
          commitSave(p.id, save, { ref: `script:flag:${msg.flag}` })
        }
        return
      }
      case 'quest': {
        const qId = typeof msg.questId === 'string' ? msg.questId : ''
        const def = world ? (world.quests.find((q) => q.id === qId) ?? frontierQuest(world, qId)) : null
        if (!def) return
        const prev = save.quests[qId]
        const stage = typeof msg.stage === 'number' && Number.isInteger(msg.stage) ? Math.max(0, Math.min(msg.stage, Math.max(0, def.stages.length - 1))) : 0
        const done = msg.done === true
        if (prev && (prev.done || stage < prev.stage)) return
        if (done && def.stages.length > 2 && !prev) {
          audit(p.id, 'script.quest_skip_rejected', { questId: qId, stage, totalStages: def.stages.length }, 2, p.ip)
          return
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
      await store.flush()
    },

    hasSave(playerId) {
      return getRecord(playerId) !== null
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
      return commitSave(playerId, save, { ...optsIn, notify: false })
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
      switch (msg.t) {
        case 'battle.start':
          handleBattleStart(p, msg)
          return true
        case 'battle.action':
          handleBattleAction(p, msg)
          return true
        case 'battle.contract':
          handleBattleContract(p, msg)
          return true
        case 'shop.buy':
          handleShopBuy(p, msg)
          return true
        case 'shop.sell':
          handleShopSell(p, msg)
          return true
        case 'item.use':
          handleItemUse(p, msg)
          return true
        case 'exchange.deal':
          handleExchangeDeal(p, msg)
          return true
        case 'creature.evolve':
          handleCreatureEvolve(p, msg)
          return true
        case 'creature.learnMove':
          handleCreatureLearnMove(p, msg)
          return true
        case 'creature.nickname':
          handleCreatureNickname(p, msg)
          return true
        case 'party.swap':
          handlePartySwap(p, msg)
          return true
        case 'box.move':
          handleBoxMove(p, msg)
          return true
        case 'box.release':
          handleBoxRelease(p, msg)
          return true
        case 'script.op':
          handleScriptOp(p, msg)
          return true
        case 'save.import': {
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
    },
  }
}
