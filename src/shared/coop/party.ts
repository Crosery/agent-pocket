// Pure party management data structures and state transitions.
import type { PartyState } from './protocol.ts'

export interface CreatePartyOpts {
  id: string
  leaderId: string
  leaderName: string
  leaderAvatar: string
}

export function createParty(opts: CreatePartyOpts): PartyState {
  return {
    id: opts.id,
    leaderId: opts.leaderId,
    members: [
      {
        id: opts.leaderId,
        name: opts.leaderName,
        avatar: opts.leaderAvatar,
        ready: true,
        leader: true,
      },
    ],
  }
}

export function addPartyMember(
  party: PartyState,
  member: { id: string; name: string; avatar: string },
  maxMembers = 4,
): { ok: true } | { ok: false; code: string; message: string } {
  if (party.members.length >= maxMembers) {
    return { ok: false, code: 'party_full', message: '队伍已满' }
  }
  if (party.members.some((m) => m.id === member.id)) {
    return { ok: false, code: 'already_in_party', message: '已经在队伍中' }
  }
  party.members.push({
    id: member.id,
    name: member.name,
    avatar: member.avatar,
    ready: false,
    leader: false,
  })
  return { ok: true }
}

export function removePartyMember(
  party: PartyState,
  memberId: string,
): { party: PartyState | null; leaderChanged: boolean } {
  const idx = party.members.findIndex((m) => m.id === memberId)
  if (idx === -1) return { party, leaderChanged: false }

  const removed = party.members.splice(idx, 1)[0]
  if (party.members.length === 0) {
    return { party: null, leaderChanged: false }
  }

  let leaderChanged = false
  if (removed.leader) {
    party.members[0].leader = true
    party.members[0].ready = true
    party.leaderId = party.members[0].id
    leaderChanged = true
  }

  return { party, leaderChanged }
}

export function setMemberReady(party: PartyState, memberId: string, ready: boolean): boolean {
  const member = party.members.find((m) => m.id === memberId)
  if (!member) return false
  if (member.leader) {
    member.ready = true
    return true
  }
  member.ready = ready
  return true
}

export function canStartParty(party: PartyState, minMembers = 1): boolean {
  if (party.members.length < minMembers) return false
  return party.members.every((m) => m.ready)
}
