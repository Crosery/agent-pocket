// Client-side coop channel: party coordination, dungeon room/mechanism sync, and multiplayer Boss Raid flow.
import type { BattleAction, BattleEvent, BattleInit, BattleRequest, BattleResult } from '../../shared/types.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { creatureName } from '../../shared/creature.ts'
import {
  getEliteDef,
  getMechanismDef,
  getRoomDef,
  getRoomEliteIds,
  getRoomMechanismIds,
  isRoomCleared,
  normalizeRooms,
} from '../../shared/coop/instance.ts'
import type {
  BossRaidState,
  CoopClientMsg,
  InstanceState,
  PartyState,
  RaidMemberState,
  RaidSummary,
} from '../../shared/coop/protocol.ts'
import { GAMEPLAY } from '../../shared/gameplay/data.ts'
import {
  contractOdds,
  dailyLockoutStatus,
  instancePeriodKey,
  isTierUnlocked,
  progressOf,
  getActualDungeons,
} from '../../shared/gameplay/instances.ts'
import type { BattleChannel, GameContext, Input, NetClient, UIPanel } from '../contracts.ts'
import { showReveal } from '../ui/reveal.ts'
import { button, el, panel } from '../ui/widgets.ts'
import { adoptServerSave } from './authority-client.ts'

export interface CoopChannel {
  getParty(): PartyState | null
  getInstance(): InstanceState | null
  getRaid(): { raidId: string; boss: BossRaidState; members: RaidMemberState[] } | null
  createParty(): void
  inviteParty(to: string): void
  respondParty(from: string, accept: boolean): void
  leaveParty(): void
  kickParty(targetId: string): void
  readyParty(ready: boolean): void
  startParty(instanceId: string, tierId: string): void
  disbandParty(): void
  enterDungeon(instanceId: string, tierId: string): void
  moveRoom(roomId: string): void
  activateMechanism(mechanismId: string): void
  fightElite(eliteId: string): Promise<BattleResult | null>
  actionElite(battleId: string, action: BattleAction): void
  leaveDungeon(): void
  joinRaid(raidId: string): void
  actionRaid(action: BattleAction): void
  rollContract(ballId: string): void
}

const WAIT_REQ: BattleRequest = { kind: 'wait' }

let activeCoopChannel: CoopChannel | null = null

export function getCoopChannel(): CoopChannel | null {
  return activeCoopChannel
}

function safePushPanel(ctx: GameContext, p: UIPanel): void {
  ctx.ui.pushPanel?.(p)
}

function safePopPanel(ctx: GameContext, p: UIPanel): void {
  ctx.ui.popPanel?.(p)
}

export function installCoopChannel(net: NetClient, ctx: GameContext): CoopChannel {
  let currentParty: PartyState | null = null
  let currentInstance: InstanceState | null = null
  let currentRaid: { raidId: string; boss: BossRaidState; members: RaidMemberState[] } | null = null
  let roomModal: { panel: UIPanel; refresh: () => void; close: () => void } | null = null
  let raidModal: { panel: UIPanel; refresh: () => void; close: () => void } | null = null
  const partyListeners = new Set<() => void>()

  const ensureRoomModal = () => {
    if (!currentInstance || currentRaid) {
      if (roomModal) {
        roomModal.close()
        roomModal = null
      }
      return
    }
    if (!ctx.ui.pushPanel || typeof document === 'undefined') return
    if (!roomModal) {
      roomModal = mountDungeonRoomModal(ctx, channel, () => {
        roomModal = null
      })
    } else {
      roomModal.refresh()
    }
  }

  const runAuthoritativeEliteBattle = async (eliteId: string): Promise<BattleResult | null> => {
    return new Promise<BattleResult | null>((resolve) => {
      let settled = false
      let battleId: string | null = null
      const inbox: Array<{ events: BattleEvent[]; request: BattleRequest }> = []
      let endResult: BattleResult | null = null
      let wake: (() => void) | null = null

      const poke = () => {
        const w = wake
        wake = null
        w?.()
      }

      const cleanup = () => {
        offStarted()
        offEvents()
        offEnd()
        offErr()
      }

      const finish = (res: BattleResult | null) => {
        if (settled) return
        settled = true
        cleanup()
        poke()
        resolve(res)
      }

      const offErr = net.on('dungeon.error', () => {
        if (!battleId) finish(null)
      })

      const offEvents = net.on('dungeon.eliteEvents', (msg) => {
        if (!battleId || msg.battleId !== battleId) return
        inbox.push({ events: [...msg.events], request: msg.request })
        poke()
      })

      const offEnd = net.on('dungeon.eliteEnd', (msg) => {
        if (!battleId || msg.battleId !== battleId) return
        endResult = msg.result
        poke()
      })

      const offStarted = net.on('dungeon.eliteStarted', (started) => {
        if (started.eliteId !== eliteId || battleId !== null) return
        battleId = started.battleId
        inbox.push({ events: [...started.events], request: started.request })


        const collect = async (): Promise<{ events: BattleEvent[]; request: BattleRequest }> => {
          for (;;) {
            if (inbox.length > 0) {
              return inbox.shift()!
            }
            if (endResult !== null || settled) {
              return {
                events: [{ t: 'end', result: endResult ?? 'lose', winner: endResult === 'win' ? 0 : 1 }],
                request: WAIT_REQ,
              }
            }
            await new Promise<void>((r) => { wake = r })
          }
        }

        const battleChannel: BattleChannel = {
          start: () => collect(),
          submit(action: BattleAction) {
            if (endResult !== null || settled) return collect()
            net.send({ t: 'dungeon.eliteAction', battleId: started.battleId, action })
            return collect()
          },
          dispose() {
            if (endResult === null && !settled) net.send({ t: 'dungeon.leave' })
            finish(endResult)
          },
        }

        if (roomModal) roomModal.panel.el.style.display = 'none'
        void ctx.battle.run(started.init, { kind: 'wild', channel: battleChannel }).then(
          (outcome) => {
            if (roomModal) {
              roomModal.panel.el.style.display = ''
              roomModal.refresh()
            }
            finish(endResult ?? outcome.result)
          },
          () => {
            if (roomModal) roomModal.panel.el.style.display = ''
            finish(endResult)
          },
        )
      })

      net.send({ t: 'dungeon.eliteFight', eliteId })
    })
  }

  const channel: CoopChannel = {
    getParty: () => currentParty,
    getInstance: () => currentInstance,
    getRaid: () => currentRaid,
    createParty: () => net.send({ t: 'party.create' }),
    inviteParty: (to: string) => net.send({ t: 'party.invite', to }),
    respondParty: (from: string, accept: boolean) => net.send({ t: 'party.respond', from, accept }),
    leaveParty: () => net.send({ t: 'party.leave' }),
    kickParty: (targetId: string) => net.send({ t: 'party.kick', targetId }),
    readyParty: (ready: boolean) => net.send({ t: 'party.ready', ready }),
    startParty: (instanceId: string, tierId: string) => net.send({ t: 'party.start', instanceId, tierId }),
    disbandParty: () => net.send({ t: 'party.disband' }),
    enterDungeon: (instanceId: string, tierId: string) => net.send({ t: 'dungeon.enter', instanceId, tierId }),
    moveRoom: (roomId: string) => net.send({ t: 'dungeon.roomMove', roomId }),
    activateMechanism: (mechanismId: string) => net.send({ t: 'dungeon.mechanism', mechanismId }),
    fightElite: (eliteId: string) => runAuthoritativeEliteBattle(eliteId),
    actionElite: (battleId: string, action: BattleAction) => net.send({ t: 'dungeon.eliteAction', battleId, action }),
    leaveDungeon: () => net.send({ t: 'dungeon.leave' }),
    joinRaid: (raidId: string) => net.send({ t: 'raid.join', raidId }),
    actionRaid: (action: BattleAction) => {
      if (currentRaid) net.send({ t: 'raid.action', raidId: currentRaid.raidId, action })
    },
    rollContract: (ballId: string) => {
      if (currentRaid) net.send({ t: 'raid.rollContract', raidId: currentRaid.raidId, ballId })
    },
  }

  activeCoopChannel = channel

  // -------------------------------------------------------------
  // Server message subscriptions
  // -------------------------------------------------------------

  net.on('state.sync', (msg) => {
    adoptServerSave(ctx, msg.save, msg.rev)
  })

  net.on('party.update', (msg) => {
    const hadParty = currentParty !== null
    currentParty = msg.party
    if (!currentParty && hadParty) {
      ctx.ui.toast(t('multiplayer.party.left', { name: ctx.save.name }), 'info')
    }
    for (const fn of partyListeners) fn()
  })

  net.on('party.invited', (msg) => {
    ctx.audio.playSfx('notify')
    showInvitePrompt(ctx, msg.from, msg.name, (accept) => {
      channel.respondParty(msg.from, accept)
    })
  })

  net.on('party.error', (msg) => {
    ctx.ui.toast(msg.message, 'warn')
  })

  net.on('dungeon.update', (msg) => {
    currentInstance = msg.instance
    if (!currentInstance) {
      currentRaid = null
      if (raidModal) {
        raidModal.close()
        raidModal = null
      }
    }
    ensureRoomModal()
  })

  net.on('dungeon.roomChanged', (msg) => {
    const instDef = currentInstance ? GAMEPLAY.instances[currentInstance.instanceId] : null
    const roomDef = getRoomDef(instDef, msg.roomId)
    ctx.ui.toast(t('multiplayer.dungeon.roomEntered', { room: roomDef?.name ?? msg.roomId }), 'info')
    ensureRoomModal()
  })

  net.on('dungeon.mechanismActivated', (msg) => {
    const instDef = currentInstance ? GAMEPLAY.instances[currentInstance.instanceId] : null
    const mechDef = getMechanismDef(instDef, msg.mechanismId)
    ctx.audio.playSfx('confirm')
    ctx.ui.toast(
      t('multiplayer.dungeon.mechanismActivated', { by: msg.by, mech: mechDef?.name ?? msg.mechanismId }),
      'success',
    )
    ensureRoomModal()
  })

  net.on('dungeon.eliteDefeated', (msg) => {
    const instDef = currentInstance ? GAMEPLAY.instances[currentInstance.instanceId] : null
    const eliteDef = getEliteDef(instDef, msg.eliteId)
    ctx.audio.playSfx('confirm')
    ctx.ui.toast(
      t('multiplayer.dungeon.eliteDefeated', { by: msg.by, elite: eliteDef?.name ?? msg.eliteId }),
      'success',
    )
    ensureRoomModal()
  })

  net.on('dungeon.error', (msg) => {
    ctx.ui.toast(msg.message, 'warn')
  })

  let raidBattleWake: (() => void) | null = null
  const raidBattleInbox: Array<{ events: BattleEvent[]; request: BattleRequest }> = []
  let raidBattleEnd: { victory: boolean } | null = null

  net.on('raid.start', (msg) => {
    currentRaid = {
      raidId: msg.raidId,
      boss: msg.boss,
      members: msg.members,
    }
    raidBattleInbox.length = 0
    raidBattleEnd = null
    if (roomModal) {
      roomModal.close()
      roomModal = null
    }
    const bossSpeciesName = CONTENT.species[msg.boss.speciesId]?.nameZh ?? msg.boss.speciesId
    ctx.ui.toast(
      t('multiplayer.dungeon.raidStarted', { boss: bossSpeciesName, hp: msg.boss.hp, max: msg.boss.maxHp }),
      'warn',
    )

    if (ctx.battle?.run && msg.init) {
      const defaultReq: BattleRequest = msg.request ?? {
        kind: 'action',
        canSwitch: ctx.save.party.filter((c) => c.hp > 0).length > 1,
        canRun: false,
        canItem: true,
      }
      raidBattleInbox.push({ events: [...(msg.events ?? [])], request: defaultReq })
      const collectRaid = async (): Promise<{ events: BattleEvent[]; request: BattleRequest }> => {
        for (;;) {
          if (raidBattleInbox.length > 0) {
            return raidBattleInbox.shift()!
          }
          if (raidBattleEnd !== null) {
            const v = raidBattleEnd.victory
            return {
              events: [{ t: 'end', result: v ? 'win' : 'lose', winner: v ? 0 : 1 }],
              request: WAIT_REQ,
            }
          }
          await new Promise<void>((r) => { raidBattleWake = r })
        }
      }
      const raidBattleChannel: BattleChannel = {
        start: () => collectRaid(),
        submit(action: BattleAction) {
          if (raidBattleEnd !== null) return collectRaid()
          net.send({ t: 'raid.action', raidId: msg.raidId, action })
          return collectRaid()
        },
        dispose() {
          if (raidBattleEnd === null) net.send({ t: 'dungeon.leave' })
          raidBattleEnd ??= { victory: false }
          raidBattleInbox.length = 0
          const wake = raidBattleWake
          raidBattleWake = null
          wake?.()
        },
      }
      void ctx.battle.run(msg.init, { kind: 'legend', channel: raidBattleChannel }).catch((err) => {
        console.error('[raid] battle runner failed', err)
      })
    } else if (typeof document !== 'undefined') {
      if (raidModal) raidModal.close()
      raidModal = mountRaidBattleModal(ctx, channel, () => {
        raidModal = null
      })
    }
  })

  net.on('raid.tick', (msg) => {
    if (currentRaid && currentRaid.raidId === msg.raidId) {
      currentRaid.boss = msg.boss
      currentRaid.members = msg.members
      raidModal?.refresh()
      if (!msg.actorId || msg.actorId === net.selfId) {
        const nextReq: BattleRequest = msg.request ?? {
          kind: 'action',
          canSwitch: ctx.save.party.filter((c) => c.hp > 0).length > 1,
          canRun: false,
          canItem: true,
        }
        raidBattleInbox.push({ events: [...msg.events], request: nextReq })
        const w = raidBattleWake
        raidBattleWake = null
        w?.()
      }
    }
  })

  net.on('raid.end', (msg) => {
    if (raidModal) {
      raidModal.close()
      raidModal = null
    }
    raidBattleEnd = { victory: msg.victory }
    raidBattleInbox.push({
      events: [{ t: 'end', result: msg.victory ? 'win' : 'lose', winner: msg.victory ? 0 : 1 }],
      request: WAIT_REQ,
    })
    const w = raidBattleWake
    raidBattleWake = null
    w?.()

    if (msg.victory) {
      ctx.audio.playSfx('confirm')
      ctx.ui.toast(t('multiplayer.dungeon.raidVictory'), 'success')
    } else {
      ctx.ui.toast(t('multiplayer.dungeon.raidDefeat'), 'warn')
    }
    if (typeof document !== 'undefined') {
      showRaidSummaryModal(ctx, msg.summary, () => {
        const selfMember = msg.summary.members.find((m) => m.id === net.selfId)
        if (msg.victory && selfMember?.qualified) {
          promptContractRoll(ctx, channel, msg.summary)
        }
      })
    }
  })

  net.on('raid.contractResult', (msg) => {
    if (msg.success && msg.card) {
      ctx.ui.toast(t('multiplayer.dungeon.contractSuccess'), 'success')
      const name = creatureName(msg.card)
      ctx.ui.toast(t('battleui.catch.toParty', { name }), 'success')
      if (typeof document !== 'undefined') {
        void showReveal(ctx, msg.card, { full: true })
      }
    } else {
      ctx.ui.toast(t('multiplayer.dungeon.contractFailed'), 'warn')
      if (msg.shardsAwarded) {
        ctx.ui.toast(t('multiplayer.dungeon.shardsEarned', { n: msg.shardsAwarded }), 'info')
      }
    }
  })

  net.on('raid.error', (msg) => {
    ctx.ui.toast(msg.message, 'warn')
  })

  ;(channel as CoopChannel & { _onPartyChange?: (fn: () => void) => () => void })._onPartyChange = (fn) => {
    partyListeners.add(fn)
    return () => partyListeners.delete(fn)
  }

  return channel
}

// -------------------------------------------------------------
// UI Modals
// -------------------------------------------------------------

function showInvitePrompt(
  ctx: GameContext,
  _fromId: string,
  fromName: string,
  onRespond: (accept: boolean) => void,
): void {
  if (!ctx.ui.pushPanel || typeof document === 'undefined') return
  const card = panel(t('multiplayer.party.invite'), { className: 'ap-coop-invite' })
  const desc = el('p', { text: t('multiplayer.party.incomingInvite', { name: fromName }) })

  const acceptBtn = button(t('multiplayer.trade.accept'), () => {
    safePopPanel(ctx, pApi)
    onRespond(true)
  }, { primary: true })

  const declineBtn = button(t('multiplayer.trade.decline'), () => {
    safePopPanel(ctx, pApi)
    onRespond(false)
  })

  card.body.append(desc, el('div', { class: 'ap-btn-row' }, [acceptBtn, declineBtn]))
  const root = el('div', { class: 'aps-screen ap-fullscreen' }, [card.el])

  const pApi: UIPanel = {
    el: root,
    onInput(input: Input) {
      if (input.pressed('confirm')) {
        input.consume('confirm')
        safePopPanel(ctx, pApi)
        onRespond(true)
        return true
      }
      if (input.pressed('cancel')) {
        input.consume('cancel')
        safePopPanel(ctx, pApi)
        onRespond(false)
        return true
      }
      return true
    },
  }

  safePushPanel(ctx, pApi)
}

function mountDungeonRoomModal(
  ctx: GameContext,
  channel: CoopChannel,
  onClosed: () => void,
): { panel: UIPanel; refresh: () => void; close: () => void } {
  const card = panel(t('multiplayer.dungeon.title'), { className: 'ap-dungeon-room-panel' })
  const root = el('div', { class: 'aps-screen ap-fullscreen ap-dungeon-room-screen' }, [card.el])
  let closed = false

  const close = () => {
    if (closed) return
    closed = true
    safePopPanel(ctx, pApi)
    onClosed()
  }

  const refresh = () => {
    const inst = channel.getInstance()
    if (!inst) {
      close()
      return
    }
    const instDef = GAMEPLAY.instances[inst.instanceId]
    const roomDefs = normalizeRooms(instDef)
    const curRoomDef = roomDefs[inst.currentRoom]
    const curRoomState = inst.rooms[inst.currentRoom]
    const dungeonName = instDef ? t(instDef.name) : inst.instanceId
    const roomName = curRoomDef?.name ?? inst.currentRoom

    card.body.replaceChildren()

    const header = el('div', {
      class: 'ap-dungeon-room-header',
      text: t('multiplayer.dungeon.roomTitle', { dungeon: dungeonName, room: roomName }),
    })
    card.body.append(header)

    // Mechanisms in current room
    const mechIds = getRoomMechanismIds(instDef, inst.currentRoom)
    if (mechIds.length > 0) {
      const mechSection = el('div', { class: 'ap-dungeon-mechanisms' }, [
        el('h4', { text: t('multiplayer.dungeon.mechanismsLabel') }),
      ])
      for (const mechId of mechIds) {
        const mechDef = getMechanismDef(instDef, mechId)
        const active = curRoomState?.activeMechanisms.includes(mechId) ?? false
        const mechName = mechDef?.name ?? mechId
        const mechBtn = button(
          active ? `${mechName} (${t('multiplayer.dungeon.mechanismActiveTag')})` : t('multiplayer.dungeon.activateBtn', { name: mechName }),
          () => {
            if (!active) channel.activateMechanism(mechId)
          },
          { primary: !active },
        )
        ;(mechBtn as HTMLButtonElement).disabled = active
        mechBtn.dataset.mechanismId = mechId
        mechSection.append(
          el('div', { class: 'ap-dungeon-mech-row' }, [
            mechBtn,
            ...(mechDef?.desc ? [el('p', { class: 'ap-dungeon-mech-desc', text: mechDef.desc })] : []),
          ]),
        )
      }
      card.body.append(mechSection)
    }

    // Elites in current room
    const eliteIds = getRoomEliteIds(instDef, inst.currentRoom)
    if (eliteIds.length > 0) {
      const eliteSection = el('div', { class: 'ap-dungeon-elites' }, [
        el('h4', { text: t('multiplayer.dungeon.elitesLabel') }),
      ])
      for (const eliteId of eliteIds) {
        const eliteDef = getEliteDef(instDef, eliteId)
        const defeated = curRoomState?.defeatedElites.includes(eliteId) ?? false
        const eliteName = eliteDef?.name ?? eliteId
        const eliteLv = eliteDef?.level ?? 20
        const eliteBtn = button(
          defeated
            ? `${eliteName} (${t('multiplayer.dungeon.eliteDefeatedTag')})`
            : t('multiplayer.dungeon.fightEliteBtn', { name: eliteName, level: eliteLv }),
          () => {
            if (!defeated) void channel.fightElite(eliteId)
          },
          { primary: !defeated },
        )
        ;(eliteBtn as HTMLButtonElement).disabled = defeated
        eliteBtn.dataset.eliteId = eliteId
        eliteSection.append(el('div', { class: 'ap-dungeon-elite-row' }, [eliteBtn]))
      }
      card.body.append(eliteSection)
    }

    // Room navigation buttons
    const navSection = el('div', { class: 'ap-dungeon-nav' }, [
      el('h4', { text: t('multiplayer.dungeon.roomsLabel') }),
    ])
    const navRow = el('div', { class: 'ap-btn-row' })
    for (const rId of Object.keys(inst.rooms)) {
      const rDef = roomDefs[rId]
      const rName = rDef?.name ?? rId
      const isCurrent = rId === inst.currentRoom
      const canAdvance =
        rId === 'lobby' ||
        (isRoomCleared(inst, instDef, inst.currentRoom) &&
          (rId !== 'boss' ||
            Object.keys(inst.rooms).every((k) => k === 'boss' || isRoomCleared(inst, instDef, k))))
      const rBtn = button(t('multiplayer.dungeon.moveRoomBtn', { name: rName }), () => {
        if (!isCurrent && canAdvance) channel.moveRoom(rId)
      }, { primary: rId === 'boss' && canAdvance })
      ;(rBtn as HTMLButtonElement).disabled = isCurrent || !canAdvance
      rBtn.dataset.roomId = rId
      navRow.append(rBtn)
    }
    navSection.append(navRow)
    card.body.append(navSection)

    const leaveBtn = button(t('multiplayer.dungeon.leaveBtn'), () => {
      channel.leaveDungeon()
      close()
    })
    card.body.append(el('div', { class: 'ap-btn-row' }, [leaveBtn]))
  }

  const pApi: UIPanel = {
    el: root,
    onInput(input: Input) {
      if (input.pressed('cancel')) {
        input.consume('cancel')
        channel.leaveDungeon()
        close()
        return true
      }
      return true
    },
  }

  refresh()
  safePushPanel(ctx, pApi)
  return { panel: pApi, refresh, close }
}

function mountRaidBattleModal(
  ctx: GameContext,
  channel: CoopChannel,
  onClosed: () => void,
): { panel: UIPanel; refresh: () => void; close: () => void } {
  const card = panel(t('multiplayer.dungeon.title'), { className: 'ap-raid-panel' })
  const root = el('div', { class: 'aps-screen ap-fullscreen ap-raid-screen' }, [card.el])
  let closed = false

  const close = () => {
    if (closed) return
    closed = true
    safePopPanel(ctx, pApi)
    onClosed()
  }

  const refresh = () => {
    const raid = channel.getRaid()
    if (!raid) {
      close()
      return
    }
    card.body.replaceChildren()

    const bossSpeciesName = CONTENT.species[raid.boss.speciesId]?.nameZh ?? raid.boss.speciesId
    const bossHeader = el('div', { class: 'ap-raid-boss-header' }, [
      el('h3', { text: `${bossSpeciesName} Lv.${raid.boss.level}` }),
      el('div', { class: 'ap-raid-boss-hp', text: `HP ${raid.boss.hp} / ${raid.boss.maxHp}` }),
    ])
    card.body.append(bossHeader)

    const memberRows = el(
      'div',
      { class: 'ap-raid-members' },
      raid.members.map((m) =>
        el('div', { class: 'ap-raid-member-row' }, [
          el('span', { text: `${m.name} (${m.lead.nickname ?? (CONTENT.species[m.lead.speciesId]?.nameZh ?? m.lead.speciesId)})` }),
          el('span', { text: `HP ${m.hp}/${m.maxHp}` }),
          el('span', { text: `${m.contribution}` }),
        ]),
      ),
    )
    card.body.append(memberRows)

    // Active creature moves
    const leadCr = ctx.save.party.find((c) => c.hp > 0) ?? ctx.save.party[0]
    if (leadCr) {
      const moveRow = el('div', { class: 'ap-btn-row ap-raid-moves' })
      leadCr.moves.forEach((slot, idx) => {
        const moveName = CONTENT.moves[slot.id]?.nameZh ?? slot.id
        const mBtn = button(t('multiplayer.dungeon.raidAttack', { name: moveName }), () => {
          channel.actionRaid({ kind: 'move', moveIndex: idx })
        }, { primary: idx === 0 })
        mBtn.dataset.moveIndex = String(idx)
        moveRow.append(mBtn)
      })
      card.body.append(moveRow)
    }

    // Switch party buttons
    if (ctx.save.party.length > 1) {
      const switchRow = el('div', { class: 'ap-btn-row ap-raid-switches' })
      ctx.save.party.forEach((cr, idx) => {
        if (cr.hp <= 0 || cr === leadCr) return
        const sBtn = button(t('multiplayer.dungeon.raidSwitch', { name: creatureName(cr) }), () => {
          channel.actionRaid({ kind: 'switch', partyIndex: idx })
        })
        sBtn.dataset.partyIndex = String(idx)
        switchRow.append(sBtn)
      })
      card.body.append(switchRow)
    }
  }

  const pApi: UIPanel = {
    el: root,
    onInput(input: Input) {
      if (input.pressed('confirm')) {
        input.consume('confirm')
        channel.actionRaid({ kind: 'move', moveIndex: 0 })
        return true
      }
      return true
    },
  }

  refresh()
  safePushPanel(ctx, pApi)
  return { panel: pApi, refresh, close }
}

function showRaidSummaryModal(ctx: GameContext, summary: RaidSummary, onClose: () => void): void {
  const card = panel(summary.victory ? t('multiplayer.dungeon.raidVictory') : t('multiplayer.dungeon.raidDefeat'), {
    className: 'ap-raid-summary',
  })

  const stats = el('div', { class: 'ap-raid-stats' }, [
    el('div', { text: t('multiplayer.dungeon.totalDamage', { n: summary.totalDamage }) }),
  ])

  const memberList = el('div', { class: 'ap-raid-members' }, summary.members.map((m) => {
    return el('div', { class: 'ap-raid-member-row' }, [
      el('span', { text: m.name }),
      el('span', { text: t('multiplayer.dungeon.memberContribution', { dmg: m.damage, pct: m.contributionPct }) }),
      el('span', {
        class: m.qualified ? 'ap-tag-ok' : 'ap-tag-no',
        text: m.qualified ? t('multiplayer.dungeon.qualifiedYes') : t('multiplayer.dungeon.qualifiedNo'),
      }),
    ])
  }))

  const closeBtn = button(t('common.close'), () => {
    safePopPanel(ctx, pApi)
    onClose()
  }, { primary: true })

  card.body.append(stats, memberList, closeBtn)
  const root = el('div', { class: 'aps-screen ap-fullscreen' }, [card.el])

  const pApi: UIPanel = {
    el: root,
    onInput(input: Input) {
      if (input.pressed('confirm') || input.pressed('cancel')) {
        input.consume('confirm')
        input.consume('cancel')
        safePopPanel(ctx, pApi)
        onClose()
        return true
      }
      return true
    },
  }

  safePushPanel(ctx, pApi)
}

function promptContractRoll(ctx: GameContext, channel: CoopChannel, summary: RaidSummary): void {
  const heldBalls = Object.entries(ctx.save.bag ?? {})
    .filter(([id, n]) => (n ?? 0) > 0 && ctx.data.items[id]?.effect.kind === 'ball')
    .map(([id, n]) => ({ id, qty: n ?? 0, name: ctx.data.items[id]?.nameZh ?? id }))

  if (heldBalls.length === 0) {
    ctx.ui.toast(t('multiplayer.dungeon.errNoBall'), 'warn')
    return
  }

  let selectedBall = heldBalls[0].id
  const instDef = GAMEPLAY.instances[summary.instanceId]
  const tierDef = instDef?.tiers[summary.tierId]
  const prog = progressOf(ctx.save, summary.instanceId)
  const first = (prog.captures[summary.tierId] ?? 0) === 0
  const curPity = prog.pity?.[summary.tierId] ?? 0
  const periodKey = instancePeriodKey(instDef?.refresh ?? 'daily', GAMEPLAY.instancePeriod)
  const lockout = dailyLockoutStatus(prog, periodKey)

  const card = panel(t('battleui.capture.title'), { className: 'ap-contract-roll' })
  const hintEl = el('p', { class: 'ap-contract-hint' })
  const pityEl = el('p', { class: 'ap-contract-pity' })
  const limitEl = el('p', {
    class: 'ap-contract-limit',
    text: t('multiplayer.dungeon.dailyLimit', {
      left: lockout.rollsLeft,
      max: GAMEPLAY.instanceDefaults.dailyRollLimit ?? 3,
    }),
  })

  const updateOddsText = () => {
    const bonus = CONTENT.quality.capture.ballBonus[selectedBall] ?? 0
    const isMaster = selectedBall === CONTENT.quality.capture.masterBall
    const odds = tierDef
      ? contractOdds(tierDef, bonus, !first, curPity)
      : { chance: 1, guaranteed: true, pity: curPity, maxPity: 3, avgAttempts: 1 }
    const pct = isMaster ? 100 : Math.round(odds.chance * 100)
    hintEl.textContent = t('multiplayer.dungeon.contractHint', { pct })
    pityEl.textContent = t('multiplayer.dungeon.contractPity', {
      pity: odds.pity,
      max: odds.maxPity,
      avg: odds.avgAttempts,
    })
  }

  const ballBtnRow = el('div', { class: 'ap-btn-row ap-contract-balls' })
  const renderBallButtons = () => {
    ballBtnRow.replaceChildren()
    for (const b of heldBalls) {
      const bBtn = button(`${b.name} x${b.qty}`, () => {
        selectedBall = b.id
        updateOddsText()
        renderBallButtons()
      }, { primary: b.id === selectedBall })
      bBtn.dataset.ballId = b.id
      ballBtnRow.append(bBtn)
    }
  }

  updateOddsText()
  renderBallButtons()

  const rollBtn = button(t('battleui.capture.sign'), () => {
    safePopPanel(ctx, pApi)
    channel.rollContract(selectedBall)
  }, { primary: true })

  card.body.append(hintEl, pityEl, limitEl, ballBtnRow, rollBtn)
  const root = el('div', { class: 'aps-screen ap-fullscreen' }, [card.el])

  const pApi: UIPanel = {
    el: root,
    onInput(input: Input) {
      if (input.pressed('confirm')) {
        input.consume('confirm')
        safePopPanel(ctx, pApi)
        channel.rollContract(selectedBall)
        return true
      }
      return true
    },
  }

  safePushPanel(ctx, pApi)
}


/**
 * Opens the dungeon selection and entry modal.
 */
export function openDungeonModal(ctx: GameContext, defaultInstanceId = 'deepseek-tide'): void {
  const channel = getCoopChannel()
  const allDungeons = getActualDungeons()
  const instances = [...allDungeons].sort(([a], [b]) => {
    if (a === defaultInstanceId) return -1
    if (b === defaultInstanceId) return 1
    return 0
  })

  const party = channel?.getParty() ?? null
  const partySize = party ? party.members.length : 1
  const boolFlags = Object.fromEntries(Object.entries(ctx.save.flags).map(([k, v]) => [k, Boolean(v)]))

  const card = panel(t('multiplayer.dungeon.title'), { className: 'ap-dungeon-modal' })

  const partyBar = el('div', { class: 'ap-dungeon-party-bar ap-btn-row' }, [
    button(t('multiplayer.party.manage'), () => {
      safePopPanel(ctx, pApi)
      openPartyModal(ctx)
    }),
  ])

  const list = el('div', { class: 'ap-dungeon-list' }, instances.map(([id, inst]) => {
    const name = t(inst.name)
    const tiers = Object.keys(inst.tiers)

    const row = el('div', { class: 'ap-dungeon-row', attrs: { 'data-instance-id': id } }, [
      el('h3', { text: name }),
      el('p', { text: inst.desc ? t(inst.desc) : '' }),
      el('div', { class: 'ap-dungeon-tiers' }, tiers.map((tid) => {
        const tier = inst.tiers[tid]
        const check = isTierUnlocked(tier, ctx.save.badges, boolFlags, partySize)
        const btn = button(`${tid} (${t(`boss.${inst.boss}.tier.${tid}`)})`, () => {
          safePopPanel(ctx, pApi)
          if (!channel) return
          const curParty = channel.getParty()
          if (curParty && (curParty.members.length > 1 || (tier.coop?.minPlayers ?? 1) > 1)) {
            channel.startParty(id, tid)
          } else {
            channel.enterDungeon(id, tid)
          }
        })
        btn.dataset.tierId = tid
        if (!check.unlocked) {
          ;(btn as HTMLButtonElement).disabled = true
          if (check.reason) btn.title = check.reason
        }
        return btn
      })),
    ])
    return row
  }))

  const closeBtn = button(t('common.close'), () => {
    safePopPanel(ctx, pApi)
  })

  card.body.append(partyBar, list, closeBtn)
  const root = el('div', { class: 'aps-screen ap-fullscreen' }, [card.el])

  const pApi: UIPanel = {
    el: root,
    onInput(input: Input) {
      if (input.pressed('cancel')) {
        input.consume('cancel')
        safePopPanel(ctx, pApi)
        return true
      }
      return true
    },
  }

  safePushPanel(ctx, pApi)
}

/**
 * Opens the party management lobby modal.
 */
export function openPartyModal(ctx: GameContext): void {
  const channel = getCoopChannel() as (CoopChannel & { _onPartyChange?: (fn: () => void) => () => void }) | null
  if (!channel) return

  const card = panel(t('multiplayer.party.manage'), { className: 'ap-party-modal' })
  const root = el('div', { class: 'aps-screen ap-fullscreen' }, [card.el])
  let offParty: (() => void) | undefined

  const close = () => {
    offParty?.()
    offParty = undefined
    safePopPanel(ctx, pApi)
  }

  const render = () => {
    card.body.replaceChildren()
    const party = channel.getParty()

    if (!party) {
      const createBtn = button(t('multiplayer.party.create'), () => {
        channel.createParty()
      }, { primary: true })
      const dungeonBtn = button(t('multiplayer.party.enterDungeon'), () => {
        close()
        openDungeonModal(ctx)
      })
      card.body.append(
        el('p', { text: t('multiplayer.party.noParty') }),
        el('div', { class: 'ap-btn-row' }, [createBtn, dungeonBtn]),
      )
    } else {
      const isLeader = party.leaderId === ctx.net.selfId
      const selfMember = party.members.find((m) => m.id === ctx.net.selfId)

      const memberRows = el('div', { class: 'ap-party-members' }, party.members.map((m) => {
        const roleLabel = m.leader ? `[${t('multiplayer.party.leader')}]` : `[${t('multiplayer.party.member')}]`
        const readyLabel = m.ready ? t('multiplayer.party.readyYes') : t('multiplayer.party.readyNo')
        const rowChildren: HTMLElement[] = [
          el('span', { text: `${m.name} ${roleLabel}` }),
          el('span', { text: readyLabel }),
        ]
        if (isLeader && !m.leader) {
          rowChildren.push(
            button(t('multiplayer.party.kick'), () => {
              channel.kickParty(m.id)
            }),
          )
        }
        return el('div', { class: 'ap-party-member' }, rowChildren)
      }))

      const actionBtns: HTMLElement[] = []
      if (isLeader) {
        actionBtns.push(
          button(t('multiplayer.party.invite'), () => {
            void ctx.ui.prompt(t('multiplayer.party.invitePrompt'), '', 40).then((target) => {
              if (target?.trim()) channel.inviteParty(target.trim())
            })
          }),
          button(t('multiplayer.party.start'), () => {
            close()
            openDungeonModal(ctx)
          }, { primary: true }),
          button(t('multiplayer.party.disband'), () => {
            channel.disbandParty()
            close()
          }),
        )
      } else {
        const nextReady = !(selfMember?.ready ?? false)
        actionBtns.push(
          button(nextReady ? t('multiplayer.party.ready') : t('multiplayer.party.unready'), () => {
            channel.readyParty(nextReady)
          }, { primary: true }),
        )
      }
      actionBtns.push(
        button(t('multiplayer.party.leave'), () => {
          channel.leaveParty()
          close()
        }),
      )

      card.body.append(memberRows, el('div', { class: 'ap-btn-row' }, actionBtns))
    }

    const closeBtn = button(t('common.close'), () => close())
    card.body.append(closeBtn)
  }

  offParty = channel._onPartyChange?.(() => render())
  render()

  const pApi: UIPanel = {
    el: root,
    onInput(input: Input) {
      if (input.pressed('cancel')) {
        input.consume('cancel')
        close()
        return true
      }
      return true
    },
  }

  safePushPanel(ctx, pApi)
}
