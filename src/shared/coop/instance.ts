// Pure dungeon instance state transitions (room movement, mechanisms, elites).
import { t } from '../content/index.ts'
import { GAMEPLAY } from '../gameplay/data.ts'
import type { InstanceDef, InstanceEliteDef, InstanceMechanismDef, InstanceRoomDef } from '../types.ts'
import type { InstanceRoomState, InstanceState } from './protocol.ts'

export interface CreateInstanceStateOpts {
  id: string
  instanceId: string
  tierId: string
  def: InstanceDef
  memberIds: string[]
}

export function normalizeRooms(def?: InstanceDef | null): Record<string, InstanceRoomDef> {
  const raw = def?.rooms
  if (Array.isArray(raw)) {
    const out: Record<string, InstanceRoomDef> = {}
    for (const r of raw) out[r.id] = r
    return out
  }
  if (raw && typeof raw === 'object') {
    return raw
  }
  return {
    lobby: { id: 'lobby', name: 'lobby', kind: 'lobby' },
    corridor: { id: 'corridor', name: 'corridor', kind: 'battle' },
    boss: { id: 'boss', name: 'boss', kind: 'boss' },
  }
}

export function getRoomDef(def: InstanceDef | undefined | null, roomId: string): InstanceRoomDef | null {
  const rooms = normalizeRooms(def)
  return rooms[roomId] ?? null
}

export function getRoomMechanismIds(def: InstanceDef | undefined | null, roomId: string): string[] {
  const room = getRoomDef(def, roomId)
  if (!room?.mechanisms) return []
  return room.mechanisms.map((m) => (typeof m === 'string' ? m : m.id))
}

export function getRoomEliteIds(def: InstanceDef | undefined | null, roomId: string): string[] {
  const room = getRoomDef(def, roomId)
  if (!room?.elites) return []
  return room.elites.map((e) => (typeof e === 'string' ? e : e.id))
}

export function getMechanismDef(def: InstanceDef | undefined | null, mechanismId: string): InstanceMechanismDef | null {
  if (!def) return null
  if (def.mechanisms?.[mechanismId]) return def.mechanisms[mechanismId]
  for (const room of Object.values(normalizeRooms(def))) {
    for (const m of room.mechanisms ?? []) {
      if (typeof m === 'object' && m.id === mechanismId) return m
    }
  }
  return null
}

export function getEliteDef(def: InstanceDef | undefined | null, eliteId: string): InstanceEliteDef | null {
  if (!def) return null
  if (def.elites?.[eliteId]) return def.elites[eliteId]
  for (const room of Object.values(normalizeRooms(def))) {
    for (const e of room.elites ?? []) {
      if (typeof e === 'object' && e.id === eliteId) return e
    }
  }
  return null
}

export function isRoomCleared(state: InstanceState, def: InstanceDef | undefined | null, roomId: string): boolean {
  const room = state.rooms[roomId]
  if (!room) return false
  const eliteIds = getRoomEliteIds(def, roomId)
  return eliteIds.every((id) => room.defeatedElites.includes(id))
}

export function createDungeonInstance(opts: CreateInstanceStateOpts): InstanceState {
  const rooms: Record<string, InstanceRoomState> = {}
  const roomDefs = normalizeRooms(opts.def)

  for (const roomId of Object.keys(roomDefs)) {
    const eliteIds = getRoomEliteIds(opts.def, roomId)
    rooms[roomId] = {
      id: roomId,
      cleared: eliteIds.length === 0,
      activeMechanisms: [],
      defeatedElites: [],
    }
  }

  const roomKeys = Object.keys(rooms)
  const initialRoom = roomKeys[0] ?? 'lobby'

  return {
    id: opts.id,
    instanceId: opts.instanceId,
    tierId: opts.tierId,
    currentRoom: initialRoom,
    rooms,
    members: [...opts.memberIds],
    completed: false,
  }
}

export function activateMechanism(
  state: InstanceState,
  roomId: string,
  mechanismId: string,
  def: InstanceDef | null = GAMEPLAY.instances[state.instanceId] ?? null,
): { ok: true } | { ok: false; code: string; message: string } {
  const room = state.rooms[roomId]
  if (!room) return { ok: false, code: 'room_not_found', message: t('multiplayer.dungeon.errRoomNotFound') }
  if (def) {
    const allowed = getRoomMechanismIds(def, roomId)
    if (!allowed.includes(mechanismId) || !getMechanismDef(def, mechanismId)) {
      return { ok: false, code: 'invalid_mechanism', message: t('multiplayer.dungeon.errInvalidMechanism') }
    }
  }
  if (room.activeMechanisms.includes(mechanismId)) {
    return { ok: false, code: 'already_active', message: t('multiplayer.dungeon.errMechanismActive') }
  }
  room.activeMechanisms.push(mechanismId)
  return { ok: true }
}

export function markEliteDefeated(
  state: InstanceState,
  roomId: string,
  eliteId: string,
  def: InstanceDef | null = GAMEPLAY.instances[state.instanceId] ?? null,
): { ok: true } | { ok: false; code: string; message: string } {
  const room = state.rooms[roomId]
  if (!room) return { ok: false, code: 'room_not_found', message: t('multiplayer.dungeon.errRoomNotFound') }
  if (def) {
    const allowed = getRoomEliteIds(def, roomId)
    if (!allowed.includes(eliteId) || !getEliteDef(def, eliteId)) {
      return { ok: false, code: 'invalid_elite', message: t('multiplayer.dungeon.errInvalidElite') }
    }
  }
  if (room.defeatedElites.includes(eliteId)) {
    return { ok: false, code: 'already_defeated', message: t('multiplayer.dungeon.errEliteDefeated') }
  }
  room.defeatedElites.push(eliteId)
  room.cleared = isRoomCleared(state, def, roomId)
  return { ok: true }
}

export function transitionRoom(
  state: InstanceState,
  targetRoomId: string,
  def: InstanceDef | null = GAMEPLAY.instances[state.instanceId] ?? null,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!state.rooms[targetRoomId]) {
    return { ok: false, code: 'invalid_room', message: t('multiplayer.dungeon.errRoomNotFound') }
  }
  const roomDefs = normalizeRooms(def)
  const targetDef = roomDefs[targetRoomId]
  if (targetRoomId !== 'lobby') {
    const currentCleared = isRoomCleared(state, def, state.currentRoom)
    if (!currentCleared) {
      return { ok: false, code: 'room_not_cleared', message: t('multiplayer.dungeon.errRoomNotCleared') }
    }
  }
  if (targetRoomId === 'boss' || targetDef?.kind === 'boss') {
    for (const rId of Object.keys(state.rooms)) {
      if (rId === targetRoomId) continue
      if (!isRoomCleared(state, def, rId)) {
        return { ok: false, code: 'room_not_cleared', message: t('multiplayer.dungeon.errRoomNotCleared') }
      }
    }
  }
  state.currentRoom = targetRoomId
  return { ok: true }
}
