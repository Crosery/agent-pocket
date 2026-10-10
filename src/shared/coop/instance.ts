// Pure dungeon instance state transitions (room movement, mechanisms, elites).
import type { InstanceDef } from '../types.ts'
import type { InstanceRoomState, InstanceState } from './protocol.ts'

export interface CreateInstanceStateOpts {
  id: string
  instanceId: string
  tierId: string
  def: InstanceDef
  memberIds: string[]
}

export function createDungeonInstance(opts: CreateInstanceStateOpts): InstanceState {
  const rooms: Record<string, InstanceRoomState> = {}
  const roomDefs = opts.def.rooms ?? {
    lobby: { id: 'lobby', name: '前厅', kind: 'lobby' },
    corridor: { id: 'corridor', name: '长廊', kind: 'battle' },
    boss: { id: 'boss', name: 'Boss 房', kind: 'boss' },
  }

  for (const roomId of Object.keys(roomDefs)) {
    rooms[roomId] = {
      id: roomId,
      cleared: false,
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
): { ok: true } | { ok: false; code: string; message: string } {
  const room = state.rooms[roomId]
  if (!room) return { ok: false, code: 'room_not_found', message: '房间不存在' }
  if (room.activeMechanisms.includes(mechanismId)) {
    return { ok: false, code: 'already_active', message: '机关已处于激活状态' }
  }
  room.activeMechanisms.push(mechanismId)
  return { ok: true }
}

export function markEliteDefeated(
  state: InstanceState,
  roomId: string,
  eliteId: string,
): { ok: true } | { ok: false; code: string; message: string } {
  const room = state.rooms[roomId]
  if (!room) return { ok: false, code: 'room_not_found', message: '房间不存在' }
  if (room.defeatedElites.includes(eliteId)) {
    return { ok: false, code: 'already_defeated', message: '精英已被击败' }
  }
  room.defeatedElites.push(eliteId)
  return { ok: true }
}

export function transitionRoom(
  state: InstanceState,
  targetRoomId: string,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!state.rooms[targetRoomId]) {
    return { ok: false, code: 'invalid_room', message: '目标房间不存在' }
  }
  state.currentRoom = targetRoomId
  return { ok: true }
}
