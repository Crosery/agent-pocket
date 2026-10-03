// Validation/repair of untrusted presence payloads (avatar, lead, public profile). Bounds come from
// CONTENT (species, statuses, characters, party limits) and content/net.json profileLimits.
import type { CreatureView } from '../shared/types.ts'
import type { PresenceLead, PublicProfile } from '../shared/protocol.ts'
import { CONTENT } from '../shared/content/index.ts'
import { NET } from './config.ts'
import { sanitizeShort } from './moderation.ts'
import { clampInt, ID_TOKEN_RE, isFiniteNumber, isRecord, stableStringArray } from './util.ts'

export function sanitizeAvatar(v: unknown): string {
  const ch = typeof v === 'string' ? CONTENT.characterById[v] : undefined
  if (ch?.playable) return ch.id
  return CONTENT.characters.find((c) => c.playable)?.id ?? CONTENT.characters[0]?.id ?? ''
}

const maxLevel = () => CONTENT.config.party.maxLevel

export function sanitizeLead(v: unknown): PresenceLead | null {
  if (!isRecord(v) || typeof v.speciesId !== 'string' || !CONTENT.species[v.speciesId]) return null
  return { speciesId: v.speciesId, shiny: v.shiny === true, level: clampInt(v.level, 1, maxLevel(), 1) }
}

export function sanitizeCreatureView(v: unknown): CreatureView | null {
  if (!isRecord(v) || typeof v.speciesId !== 'string' || !CONTENT.species[v.speciesId]) return null
  const lim = NET.server.profileLimits
  const uid = typeof v.uid === 'string' && v.uid.length <= lim.idMaxLen && ID_TOKEN_RE.test(v.uid) ? v.uid : ''
  if (!uid) return null
  const maxHp = clampInt(v.maxHp, 1, lim.maxHp, 1)
  const out: CreatureView = {
    uid,
    speciesId: v.speciesId,
    level: clampInt(v.level, 1, maxLevel(), 1),
    hp: clampInt(v.hp, 0, maxHp, maxHp),
    maxHp,
    status: typeof v.status === 'string' && CONTENT.statusById[v.status] ? v.status : null,
    shiny: v.shiny === true,
  }
  const nick = sanitizeShort(v.nickname, CONTENT.config.net.nameMaxLen)
  if (nick) out.nickname = nick
  return out
}

export interface ProfileIdentity { id: string; name: string; avatar: string }

/**
 * Rebuild a PublicProfile from client input. Identity fields are server-owned; pvp stats are filled in
 * by the store (never trusted from the client). `badgeIds`, when known from the world, filters badges.
 */
export function sanitizeProfile(v: unknown, who: ProfileIdentity, badgeIds: Set<string> | null): PublicProfile {
  const r = isRecord(v) ? v : {}
  const lim = NET.server.profileLimits
  let badges = stableStringArray(r.badges, lim.badgesMax, lim.idMaxLen, ID_TOKEN_RE)
  if (badgeIds && badgeIds.size > 0) badges = badges.filter((b) => badgeIds.has(b))
  const party: CreatureView[] = []
  const seen = new Set<string>()
  if (Array.isArray(r.party)) {
    for (const raw of r.party) {
      if (party.length >= CONTENT.config.party.maxParty) break
      const cv = sanitizeCreatureView(raw)
      if (cv && !seen.has(cv.uid)) { seen.add(cv.uid); party.push(cv) }
    }
  }
  return {
    id: who.id,
    name: who.name,
    avatar: who.avatar,
    badges,
    dexCaught: clampInt(r.dexCaught, 0, CONTENT.speciesList.length, 0),
    party,
    pvpWins: 0,
    pvpLosses: 0,
    playTimeSec: isFiniteNumber(r.playTimeSec) ? clampInt(r.playTimeSec, 0, lim.playTimeMaxSec, 0) : 0,
  }
}
