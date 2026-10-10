// Client-side coop channel: party coordination, dungeon room/mechanism sync, and multiplayer Boss Raid flow.
import type { BattleAction } from '../../shared/types.ts'
import type {
  CoopClientMsg,
  InstanceState,
  PartyState,
  RaidMemberState,
  RaidSummary,
  BossRaidState,
} from '../../shared/coop/protocol.ts'
import type { GameContext, Input, NetClient, UIPanel } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import { GAMEPLAY } from '../../shared/gameplay/data.ts'
import { isTierUnlocked } from '../../shared/gameplay/instances.ts'
import { button, el, panel } from '../ui/widgets.ts'
import { creatureName } from '../../shared/creature.ts'
import { showReveal } from '../ui/reveal.ts'

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
  enterDungeon(instanceId: string, tierId: string): void
  moveRoom(roomId: string): void
  activateMechanism(mechanismId: string): void
  fightElite(eliteId: string): void
  leaveDungeon(): void
  actionRaid(action: BattleAction): void
  rollContract(ballId: string): void
}

let activeCoopChannel: CoopChannel | null = null

export function getCoopChannel(): CoopChannel | null {
  return activeCoopChannel
}

export function installCoopChannel(net: NetClient, ctx: GameContext): CoopChannel {
  let currentParty: PartyState | null = null
  let currentInstance: InstanceState | null = null
  let currentRaid: { raidId: string; boss: BossRaidState; members: RaidMemberState[] } | null = null

  const send = (msg: CoopClientMsg) => {
    net.send(msg)
  }

  const channel: CoopChannel = {
    getParty: () => currentParty,
    getInstance: () => currentInstance,
    getRaid: () => currentRaid,
    createParty: () => send({ t: 'party.create' }),
    inviteParty: (to: string) => send({ t: 'party.invite', to }),
    respondParty: (from: string, accept: boolean) => send({ t: 'party.respond', from, accept }),
    leaveParty: () => send({ t: 'party.leave' }),
    kickParty: (targetId: string) => send({ t: 'party.kick', targetId }),
    readyParty: (ready: boolean) => send({ t: 'party.ready', ready }),
    startParty: (instanceId: string, tierId: string) => send({ t: 'party.start', instanceId, tierId }),
    enterDungeon: (instanceId: string, tierId: string) => send({ t: 'dungeon.enter', instanceId, tierId }),
    moveRoom: (roomId: string) => send({ t: 'dungeon.roomMove', roomId }),
    activateMechanism: (mechanismId: string) => send({ t: 'dungeon.mechanism', mechanismId }),
    fightElite: (eliteId: string) => send({ t: 'dungeon.eliteFight', eliteId }),
    leaveDungeon: () => send({ t: 'dungeon.leave' }),
    actionRaid: (action: BattleAction) => {
      if (currentRaid) send({ t: 'raid.action', raidId: currentRaid.raidId, action })
    },
    rollContract: (ballId: string) => {
      if (currentRaid) send({ t: 'raid.rollContract', raidId: currentRaid.raidId, ballId })
    },
  }

  activeCoopChannel = channel

  // -------------------------------------------------------------
  // Server message subscriptions
  // -------------------------------------------------------------

  net.on('party.update', (msg) => {
    currentParty = msg.party
    if (!currentParty) {
      ctx.ui.toast(t('multiplayer.party.left'), 'info')
    }
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
  })

  net.on('dungeon.roomChanged', (msg) => {
    ctx.ui.toast(`进入房间: ${msg.roomId}`, 'info')
  })

  net.on('dungeon.mechanismActivated', (msg) => {
    ctx.audio.playSfx('confirm')
    ctx.ui.toast(`${msg.by} 激活了机关: ${msg.mechanismId}`, 'success')
  })

  net.on('dungeon.eliteDefeated', (msg) => {
    ctx.audio.playSfx('confirm')
    ctx.ui.toast(`${msg.by} 击败了精英守卫: ${msg.eliteId}`, 'success')
  })

  net.on('dungeon.error', (msg) => {
    ctx.ui.toast(msg.message, 'warn')
  })

  net.on('raid.start', (msg) => {
    currentRaid = {
      raidId: msg.raidId,
      boss: msg.boss,
      members: msg.members,
    }
    ctx.ui.toast(`【Boss Raid 开始！】${msg.boss.speciesId} HP: ${msg.boss.hp}/${msg.boss.maxHp}`, 'warn')
  })

  net.on('raid.tick', (msg) => {
    if (currentRaid && currentRaid.raidId === msg.raidId) {
      currentRaid.boss = msg.boss
      currentRaid.members = msg.members
    }
  })

  net.on('raid.end', (msg) => {
    if (msg.victory) {
      ctx.audio.playSfx('confirm')
      ctx.ui.toast(t('multiplayer.dungeon.raidVictory'), 'success')
    } else {
      ctx.ui.toast(t('multiplayer.dungeon.raidDefeat'), 'warn')
    }
    showRaidSummaryModal(ctx, msg.summary, () => {
      // Prompt contract roll if qualified
      const selfMember = msg.summary.members.find((m) => m.id === net.selfId)
      if (msg.victory && selfMember?.qualified) {
        promptContractRoll(ctx, channel)
      }
    })
  })

  net.on('raid.contractResult', (msg) => {
    if (msg.success && msg.card) {
      ctx.ui.toast(t('multiplayer.dungeon.contractSuccess'), 'success')
      const name = creatureName(msg.card)
      ctx.ui.toast(t('battleui.catch.toParty', { name }), 'success')
      void showReveal(ctx, msg.card, { full: true })
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
  const card = panel(t('multiplayer.party.invite'), { className: 'ap-coop-invite' })
  const desc = el('p', { text: t('multiplayer.party.incomingInvite', { name: fromName }) })

  const acceptBtn = button(t('multiplayer.trade.accept'), () => {
    ctx.ui.popPanel(pApi)
    onRespond(true)
  }, { primary: true })

  const declineBtn = button(t('multiplayer.trade.decline'), () => {
    ctx.ui.popPanel(pApi)
    onRespond(false)
  })

  card.body.append(desc, el('div', { class: 'ap-btn-row' }, [acceptBtn, declineBtn]))
  const root = el('div', { class: 'aps-screen ap-fullscreen' }, [card.el])

  const pApi: UIPanel = {
    el: root,
    onInput(input: Input) {
      if (input.pressed('confirm')) {
        input.consume('confirm')
        ctx.ui.popPanel(pApi)
        onRespond(true)
        return true
      }
      if (input.pressed('cancel')) {
        input.consume('cancel')
        ctx.ui.popPanel(pApi)
        onRespond(false)
        return true
      }
      return true
    },
  }

  ctx.ui.pushPanel(pApi)
}

function showRaidSummaryModal(ctx: GameContext, summary: RaidSummary, onClose: () => void): void {
  const card = panel(summary.victory ? t('multiplayer.dungeon.raidVictory') : t('multiplayer.dungeon.raidDefeat'), {
    className: 'ap-raid-summary',
  })

  const stats = el('div', { class: 'ap-raid-stats' }, [
    el('div', { text: `总伤害: ${summary.totalDamage}` }),
  ])

  const memberList = el('div', { class: 'ap-raid-members' }, summary.members.map((m) => {
    return el('div', { class: 'ap-raid-member-row' }, [
      el('span', { text: m.name }),
      el('span', { text: `贡献: ${m.damage} (${m.contributionPct}%)` }),
      el('span', { class: m.qualified ? 'ap-tag-ok' : 'ap-tag-no', text: m.qualified ? '达标' : '未达标' }),
    ])
  }))

  const closeBtn = button(t('common.close'), () => {
    ctx.ui.popPanel(pApi)
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
        ctx.ui.popPanel(pApi)
        onClose()
        return true
      }
      return true
    },
  }

  ctx.ui.pushPanel(pApi)
}

function promptContractRoll(ctx: GameContext, channel: CoopChannel): void {
  const heldBalls = Object.entries(ctx.save.bag)
    .filter(([id, n]) => (n ?? 0) > 0 && ctx.data.items[id]?.effect.kind === 'ball')
    .map(([id]) => id)

  const defaultBall = heldBalls[0] ?? 'prompt-ball'
  const card = panel(t('battleui.capture.title'), { className: 'ap-contract-roll' })
  const hint = el('p', { text: '讨伐成功！请投掷捕获球完成签约：' })

  const rollBtn = button(t('battleui.capture.sign'), () => {
    ctx.ui.popPanel(pApi)
    channel.rollContract(defaultBall)
  }, { primary: true })

  card.body.append(hint, rollBtn)
  const root = el('div', { class: 'aps-screen ap-fullscreen' }, [card.el])

  const pApi: UIPanel = {
    el: root,
    onInput(input: Input) {
      if (input.pressed('confirm')) {
        input.consume('confirm')
        ctx.ui.popPanel(pApi)
        channel.rollContract(defaultBall)
        return true
      }
      return true
    },
  }

  ctx.ui.pushPanel(pApi)
}

/**
 * Opens the dungeon selection and entry modal.
 */
export function openDungeonModal(ctx: GameContext, _defaultInstanceId = 'deepseek-tide'): void {
  const channel = getCoopChannel()
  const instances = Object.entries(GAMEPLAY.instances)
  const card = panel(t('multiplayer.dungeon.title'), { className: 'ap-dungeon-modal' })

  const list = el('div', { class: 'ap-dungeon-list' }, instances.map(([id, inst]) => {
    const name = t(inst.name)
    const tiers = Object.keys(inst.tiers)

    const row = el('div', { class: 'ap-dungeon-row' }, [
      el('h3', { text: name }),
      el('p', { text: inst.desc ? t(inst.desc) : '' }),
      el('div', { class: 'ap-dungeon-tiers' }, tiers.map((tid) => {
        const tier = inst.tiers[tid]
        const check = isTierUnlocked(tier, ctx.save.badges, Object.fromEntries(Object.entries(ctx.save.flags).map(([k, v]) => [k, Boolean(v)])))
        const btn = button(`${tid} (${t(`boss.${inst.boss}.tier.${tid}`)})`, () => {
          ctx.ui.popPanel(pApi)
          if (channel) {
            channel.enterDungeon(id, tid)
          }
        })
        if (!check.unlocked) (btn as HTMLButtonElement).disabled = true
        return btn
      })),
    ])
    return row
  }))

  const closeBtn = button(t('common.close'), () => {
    ctx.ui.popPanel(pApi)
  })

  card.body.append(list, closeBtn)
  const root = el('div', { class: 'aps-screen ap-fullscreen' }, [card.el])

  const pApi: UIPanel = {
    el: root,
    onInput(input: Input) {
      if (input.pressed('cancel')) {
        input.consume('cancel')
        ctx.ui.popPanel(pApi)
        return true
      }
      return true
    },
  }

  ctx.ui.pushPanel(pApi)
}

/**
 * Opens the party management lobby modal.
 */
export function openPartyModal(ctx: GameContext): void {
  const channel = getCoopChannel()
  if (!channel) return

  const party = channel.getParty()
  const card = panel(t('multiplayer.party.leader'), { className: 'ap-party-modal' })

  if (!party) {
    const createBtn = button(t('multiplayer.party.create'), () => {
      channel.createParty()
      ctx.ui.popPanel(pApi)
    }, { primary: true })

    card.body.append(el('p', { text: '尚未加入任何队伍' }), createBtn)
  } else {
    const memberRows = el('div', { class: 'ap-party-members' }, party.members.map((m) => {
      return el('div', { class: 'ap-party-member' }, [
        el('span', { text: `${m.name} ${m.leader ? '👑' : ''}` }),
        el('span', { text: m.ready ? '已准备' : '未准备' }),
      ])
    }))

    const leaveBtn = button(t('multiplayer.party.leave'), () => {
      channel.leaveParty()
      ctx.ui.popPanel(pApi)
    })

    const readyBtn = button(t('multiplayer.party.ready'), () => {
      channel.readyParty(true)
      ctx.ui.popPanel(pApi)
    }, { primary: true })

    card.body.append(memberRows, el('div', { class: 'ap-btn-row' }, [readyBtn, leaveBtn]))
  }

  const closeBtn = button(t('common.close'), () => ctx.ui.popPanel(pApi))
  card.body.append(closeBtn)

  const root = el('div', { class: 'aps-screen ap-fullscreen' }, [card.el])
  const pApi: UIPanel = {
    el: root,
    onInput(input: Input) {
      if (input.pressed('cancel')) {
        input.consume('cancel')
        ctx.ui.popPanel(pApi)
        return true
      }
      return true
    },
  }

  ctx.ui.pushPanel(pApi)
}
