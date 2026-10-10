// Server-side cryptographic save signing (HMAC-SHA256) and untrusted offline import isolation.
// Server saves are signed with a server-only secret key and verified on every load; tampered saves are
// rejected and audited. Offline/portable saves cannot prove anti-cheat (client holds the code), so any
// accepted legacy import is sanitized, stripped of forged online-valuable resources, and marked untrusted.
import { createHmac, randomBytes } from 'node:crypto'
import type { Creature, SaveData, World } from '../shared/types.ts'
import { CONTENT, t } from '../shared/content/index.ts'
import { expForLevel, maxHp, sanitizeCreature } from '../shared/creature.ts'
import { canonicalJson, timingSafeEqualStr } from '../shared/net-envelope.ts'
import { verifyLocalSlotText, verifyPortableSave } from '../shared/save-provenance.ts'
import { decodeSaveCode } from '../client/core/save-codec.ts'
import { migrateSave } from '../client/core/save-migrate.ts'
import { sanitizeSaveData } from '../client/core/save-sanitize.ts'
import { isRecord } from './util.ts'

export interface SignedServerSave {
  version: number
  accountId: string
  rev: number
  trusted: boolean
  imported: boolean
  updatedAt: number
  save: SaveData
  sig: string
}

const IMPORT_ITEM_STACK_CAP = 10
const IMPORT_BASE_LEVEL_CAP = 20

let ephemeralProcessSecret: string | null = null

export function resolveServerSaveSecret(explicit?: string): string {
  if (typeof explicit === 'string' && explicit.trim().length >= 32) {
    return explicit.trim()
  }
  const fromEnv = (process.env.AP_SAVE_SECRET ?? process.env.SAVE_SECRET)?.trim()
  if (fromEnv && fromEnv.length >= 32) {
    return fromEnv
  }
  ephemeralProcessSecret ??= randomBytes(32).toString('hex')
  return ephemeralProcessSecret
}

export function loadOrCreateSaveSecretSync(_dataDir?: string): string {
  return resolveServerSaveSecret()
}

export async function loadOrCreateSaveSecret(_dataDir?: string): Promise<string> {
  return resolveServerSaveSecret()
}
export function computeServerSaveSig(record: Omit<SignedServerSave, 'sig'>, secret: string): string {
  const payload = canonicalJson({
    version: record.version,
    accountId: record.accountId,
    rev: record.rev,
    trusted: record.trusted,
    imported: record.imported,
    updatedAt: record.updatedAt,
    save: record.save,
  })
  return createHmac('sha256', secret).update(`agent-pocket/server-save-v1:${payload}`).digest('hex')
}

export function signServerSave(record: Omit<SignedServerSave, 'sig'>, secret: string): SignedServerSave {
  return {
    ...record,
    sig: computeServerSaveSig(record, secret),
  }
}

export function verifyServerSave(
  raw: unknown,
  secret: string,
): { ok: true; record: SignedServerSave } | { ok: false; reason: string; accountId?: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'not_an_object' }
  const accountId = typeof raw.accountId === 'string' ? raw.accountId : undefined
  if (
    typeof raw.version !== 'number' ||
    typeof raw.accountId !== 'string' ||
    !raw.accountId ||
    typeof raw.rev !== 'number' ||
    typeof raw.trusted !== 'boolean' ||
    typeof raw.imported !== 'boolean' ||
    typeof raw.updatedAt !== 'number' ||
    typeof raw.sig !== 'string' ||
    !raw.sig ||
    !isRecord(raw.save)
  ) {
    return { ok: false, reason: 'malformed_signed_save', accountId }
  }
  const candidate: Omit<SignedServerSave, 'sig'> = {
    version: raw.version,
    accountId: raw.accountId,
    rev: raw.rev,
    trusted: raw.trusted,
    imported: raw.imported,
    updatedAt: raw.updatedAt,
    save: raw.save as unknown as SaveData,
  }
  const expected = computeServerSaveSig(candidate, secret)
  if (!timingSafeEqualStr(raw.sig.toLowerCase(), expected)) {
    return { ok: false, reason: 'signature_mismatch', accountId }
  }
  return {
    ok: true,
    record: { ...candidate, sig: expected },
  }
}

export interface IsolateSaveOptions {
  accountId: string
  world?: World | null
  now?: number
  /** Optional local slot signature + raw text when verifying a localStorage slot before import. */
  slotSig?: string | null
  slotIndex?: number
}

export type IsolateSaveResult =
  | { ok: true; save: SaveData; stripped: string[] }
  | { ok: false; code: 'save_tampered' | 'invalid_save'; reason: string }

function detectRawSaveTampering(raw: Record<string, unknown>): string | null {
  if (typeof raw.money === 'number' && (raw.money < 0 || !Number.isFinite(raw.money) || raw.money > 10_000_000)) {
    return 'raw_money_out_of_bounds'
  }
  if (isRecord(raw.bag)) {
    for (const [id, qty] of Object.entries(raw.bag)) {
      if (!CONTENT.items[id]) return `unknown_bag_item:${id}`
      if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 0 || qty > 999) {
        return `invalid_bag_qty:${id}`
      }
    }
  }
  if (Array.isArray(raw.party)) {
    if (raw.party.length > CONTENT.config.party.maxParty) return 'party_size_exceeded'
    for (const entry of raw.party) {
      if (!isRecord(entry)) return 'invalid_party_member'
      if (typeof entry.speciesId !== 'string' || !CONTENT.species[entry.speciesId]) return 'unknown_party_species'
      if (typeof entry.level !== 'number' || entry.level < 1 || entry.level > CONTENT.config.party.maxLevel) {
        return 'party_level_out_of_bounds'
      }
      if (isRecord(entry.ivs)) {
        for (const v of Object.values(entry.ivs)) {
          if (typeof v !== 'number' || v < 0 || v > CONTENT.config.creature.ivMax) return 'party_iv_out_of_bounds'
        }
      }
    }
  }
  return null
}

function clampImportedCreature(cr: Creature, levelCap: number, now: number): { creature: Creature; clamped: boolean } {
  let clamped = false
  const out = structuredClone(cr)
  if (out.level > levelCap) {
    out.level = levelCap
    const sp = CONTENT.species[out.speciesId]
    const growth = sp?.growth ?? Object.keys(CONTENT.config.growth)[0]
    out.exp = expForLevel(growth, levelCap, CONTENT)
    out.hp = Math.min(out.hp, maxHp(out, CONTENT))
    clamped = true
  }
  if (out.heldItem && !CONTENT.items[out.heldItem]?.buyable) {
    delete out.heldItem
    clamped = true
  }
  out.origin = { kind: 'legacy', at: now }
  return { creature: out, clamped }
}

/**
 * Validates and isolates an untrusted offline/imported save before it can be bound to an online account:
 * - Verifies portable save code checksum/HMAC or local slot HMAC if provided; rejects tampered inputs.
 * - Rejects raw saves with tampered out-of-bounds money, items, levels, or IVs.
 * - Sanitizes and strips online-authoritative resources (caps money & bag stacks, strips unbuyable items,
 *   clamps creature levels, marks creatures `origin: { kind: 'legacy' }` so they cannot be traded to other accounts,
 *   and zeroes online PvP/trade/distance leaderboard counters).
 */
export function isolateUntrustedSave(rawInput: unknown, opts: IsolateSaveOptions): IsolateSaveResult {
  const now = opts.now ?? Date.now()
  let candidate: unknown = rawInput

  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim()
    if (trimmed.startsWith('{')) {
      if (opts.slotSig !== undefined) {
        const check = verifyLocalSlotText(trimmed, opts.slotSig, opts.slotIndex ?? 0)
        if (check.tampered || !check.valid) {
          return { ok: false, code: 'save_tampered', reason: check.reason ?? 'slot_tampered' }
        }
      }
      try {
        candidate = JSON.parse(trimmed)
      } catch {
        return { ok: false, code: 'save_tampered', reason: 'malformed_json' }
      }
    } else {
      const decoded = decodeSaveCode(trimmed)
      if (!decoded) return { ok: false, code: 'save_tampered', reason: 'invalid_save_code_checksum' }
      candidate = decoded.data
    }
  }

  if (isRecord(candidate) && 'sig' in candidate && 'save' in candidate) {
    const verified = verifyPortableSave(candidate)
    if (!verified.ok) return { ok: false, code: 'save_tampered', reason: verified.reason }
    candidate = verified.save
  }

  if (!isRecord(candidate)) {
    return { ok: false, code: 'invalid_save', reason: 'not_an_object' }
  }

  const tamperReason = detectRawSaveTampering(candidate)
  if (tamperReason) {
    return { ok: false, code: 'save_tampered', reason: tamperReason }
  }

  const migrated = migrateSave(candidate, CONTENT)
  const sanitized = sanitizeSaveData(migrated, {
    content: CONTENT,
    world: opts.world ?? null,
    sanitizeCreature: (r) => sanitizeCreature(r, CONTENT),
    defaultName: t('audio.save.defaultName'),
    now: () => now,
    newId: () => opts.accountId,
  })
  if (!sanitized) {
    return { ok: false, code: 'invalid_save', reason: 'sanitize_rejected' }
  }

  const stripped: string[] = []
  sanitized.playerId = opts.accountId
  sanitized.stats.pvpWins = 0
  sanitized.stats.pvpLosses = 0
  sanitized.stats.trades = 0
  sanitized.maxDistance = 0

  const maxStartMoney = CONTENT.config.economy.startMoney
  if (sanitized.money > maxStartMoney) {
    sanitized.money = maxStartMoney
    stripped.push('money_capped')
  }

  const startItems = CONTENT.config.economy.startItems
  for (const [itemId, qty] of Object.entries(sanitized.bag)) {
    const def = CONTENT.items[itemId]
    const allowedStart = startItems[itemId] ?? 0
    if (!def || (!def.buyable && allowedStart <= 0)) {
      delete sanitized.bag[itemId]
      stripped.push(`bag_removed:${itemId}`)
      continue
    }
    const cap = Math.max(IMPORT_ITEM_STACK_CAP, allowedStart)
    if (qty > cap) {
      sanitized.bag[itemId] = cap
      stripped.push(`bag_capped:${itemId}`)
    }
  }

  const levelCap = Math.min(CONTENT.config.party.maxLevel, IMPORT_BASE_LEVEL_CAP)
  sanitized.party = sanitized.party.map((cr) => {
    const res = clampImportedCreature(cr, levelCap, now)
    if (res.clamped) stripped.push(`party_clamped:${cr.uid}`)
    return res.creature
  })
  sanitized.boxes = sanitized.boxes.map((box) =>
    box.map((cr) => {
      const res = clampImportedCreature(cr, levelCap, now)
      if (res.clamped) stripped.push(`box_clamped:${cr.uid}`)
      return res.creature
    }),
  )
  sanitized.flags['auth:untrustedImport'] = true

  return { ok: true, save: sanitized, stripped }
}
