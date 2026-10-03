// Multiplayer hub (Screens.online): connection status + reconnect, online players (whisper / profile / trade /
// battle), leaderboard, own profile card, emote bar and chat tips. Layout numbers: content/multiplayer.json
// (online, emotes); every string: t('multiplayer.*').
import type { GameContext, Input, ListItem, NetStatus, UIPanel } from '../../contracts.ts'
import type { LeaderboardEntry, PublicProfile } from '../../../shared/protocol.ts'
import type { CreatureView } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { creatureName } from '../../../shared/creature.ts'
import { getMap } from '../../../shared/world/worldapi.ts'
import multiplayerJson from '../../../../content/multiplayer.json' with { type: 'json' }
import { UI_CONFIG } from '../config.ts'
import { createRowMenu, type RowMenu } from '../menu.ts'
import { actionKeyLabel, append, button, creatureIcon, el, formatNumber, keyHint, panel, tabs, type TabsHandle } from '../widgets.ts'
import { challengePvp } from '../../net/pvp-channel.ts'
import { injectStyle, startTradeFlow, trackOnlineRoster, type RosterEntry } from '../../net/trade-flow.ts'

/** Client view of content/multiplayer.json → online + emotes. */
export interface OnlineHubRules {
  tabs: TabId[]
  /** Actions offered on an online player, in menu order. */
  playerActions: PlayerAction[]
  visibleRows: number
  listWidth: number
  avatarIconSize: number
  partyIconSize: number
  profileAvatarSize: number
  inspectTimeoutMs: number
  /** Error codes answering an inspect request. */
  inspectAbortErrors: string[]
  leaderboardMaxAgeSeconds: number
  statusRefreshMs: number
}
type TabId = 'players' | 'leaderboard' | 'profile'
type Zone = 'tabs' | 'list' | 'emotes'
type PlayerAction = 'whisper' | 'inspect' | 'trade' | 'battle'

const MP = multiplayerJson as unknown as { online: OnlineHubRules; emotes: string[] }
const RULES = MP.online

const STYLE = `
.mp-hub > .ap-panel { width: min(96vw, calc(var(--u) * var(--mp-list-w))); }
.mp-hub-head { display: flex; align-items: center; gap: calc(var(--u) * 6); }
.mp-hub-title { flex: 1 1 auto; white-space: nowrap; color: var(--ap-gold-hi); }
.mp-hub-head .ap-btn { flex: none; white-space: nowrap; }
.mp-status { display: flex; align-items: center; gap: calc(var(--u) * 5); white-space: nowrap; margin: calc(var(--u) * 2) 0 calc(var(--u) * 5); }
.mp-status-dot { flex: none; --nc: var(--ap-net-offline); width: calc(var(--u) * 5); height: calc(var(--u) * 5); background: var(--nc);
  box-shadow: 0 0 0 var(--u) var(--ap-ink), inset var(--u) var(--u) 0 rgba(255, 255, 255, 0.45); }
.mp-status[data-status='online'] .mp-status-dot { --nc: var(--ap-net-online); }
.mp-status[data-status='connecting'] .mp-status-dot { --nc: var(--ap-net-connecting); animation: ap-twinkle 900ms steps(2) infinite; }
.mp-status[data-status='error'] .mp-status-dot { --nc: var(--ap-net-error); }
.mp-status[data-status='offline'], .mp-status[data-status='error'] { color: var(--ap-text-dim); }
.mp-hub .ap-tabs { margin-bottom: calc(var(--u) * -1); }
.mp-hub-body { border-top: var(--u) solid var(--ap-gold-dk); padding-top: calc(var(--u) * 4); display: grid; align-items: start;
  min-height: calc(var(--u) * var(--row-h) * var(--mp-rows) + var(--u) * 6); }
.mp-hub-body > * { grid-area: 1 / 1; min-width: 0; }
.mp-ghost { visibility: hidden; pointer-events: none; }
.mp-hub .ap-row-icon { width: calc(var(--u) * var(--mp-avatar)); height: calc(var(--u) * var(--mp-avatar)); image-rendering: pixelated; }
.mp-hub .ap-row.mp-self .ap-row-label { color: var(--ap-gold-hi); }
.mp-zone-tabs .ap-tab.is-active { outline: var(--u) solid var(--ap-gold-hi); outline-offset: calc(var(--u) * -2); }
.mp-hub:not(.mp-zone-list) .ap-row.is-active { background: none; }
.mp-hub:not(.mp-zone-list) .ap-row.is-active .ap-cursor { visibility: hidden; }
.mp-emotes { display: flex; flex-wrap: wrap; align-items: center; gap: calc(var(--u) * 3); margin-top: calc(var(--u) * 5); }
.mp-emotes .ap-btn { min-width: calc(var(--u) * 26); padding: calc(var(--u) * 1) calc(var(--u) * 4); }
.mp-emote-label { color: var(--ap-text-dim); margin-right: calc(var(--u) * 2); }
.mp-hub-foot { margin-top: calc(var(--u) * 5); display: flex; flex-direction: column; gap: calc(var(--u) * 3); color: var(--ap-text-dim); }
.mp-hub-keys { display: flex; flex-wrap: wrap; gap: calc(var(--u) * 8); }
.mp-profile { display: grid; grid-template-columns: auto 1fr; gap: calc(var(--u) * 3) calc(var(--u) * 10); align-items: start; }
.mp-profile-avatar { grid-row: span 7; width: calc(var(--u) * var(--mp-pavatar)); height: calc(var(--u) * var(--mp-pavatar));
  image-rendering: pixelated; object-fit: contain; background: rgba(5, 7, 13, 0.45); border: var(--u) solid var(--ap-gold-dk); }
.mp-profile-name { color: var(--ap-gold-hi); }
.mp-profile-row { display: flex; gap: calc(var(--u) * 6); }
.mp-profile-row > :first-child { color: var(--ap-text-dim); min-width: calc(var(--u) * 48); }
.mp-profile-party { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: calc(var(--u) * 8); margin-top: calc(var(--u) * 3); }
.mp-profile-mon { display: flex; flex-direction: column; align-items: center; color: var(--ap-text-dim); }
.mp-profile-modal { background: rgba(5, 7, 13, 0.55); }
.mp-profile-modal > .ap-panel { min-width: calc(var(--u) * 220); }
`

// ---------------------------------------------------------------------------
// Avatars: first "down" frame of the character sheet, cropped once per id
// ---------------------------------------------------------------------------

const avatarCache = new Map<string, Promise<string>>()

function avatarUrl(ctx: GameContext, id: string): Promise<string> {
  let p = avatarCache.get(id)
  if (!p) {
    const src = ctx.assets.characterImageUrl(id)
    p = new Promise<string>((resolve) => {
      const img = new Image()
      img.onload = () => {
        const sp = CONTENT.config.sprites
        const rows = Object.keys(sp.sheetRows).length
        const cw = Math.max(1, Math.floor(img.naturalWidth / sp.sheetFrames))
        const ch = Math.max(1, Math.floor(img.naturalHeight / rows))
        const c = document.createElement('canvas')
        c.width = cw
        c.height = ch
        const g = c.getContext('2d')
        if (!g) { resolve(src); return }
        g.imageSmoothingEnabled = false
        g.drawImage(img, 0, sp.sheetRows.down * ch, cw, ch, 0, 0, cw, ch)
        resolve(c.toDataURL())
      }
      img.onerror = () => resolve('')
      img.src = src
    })
    avatarCache.set(id, p)
  }
  return p
}

function avatarImg(ctx: GameContext, id: string, className: string): HTMLImageElement {
  const img = el('img', { class: className, attrs: { alt: '', draggable: 'false' } })
  void avatarUrl(ctx, id).then((url) => { if (url) img.src = url })
  return img
}

// ---------------------------------------------------------------------------
// Profile card
// ---------------------------------------------------------------------------

function selfProfile(ctx: GameContext): PublicProfile & { trades: number; dexSeen: number } {
  const s = ctx.save
  return {
    id: ctx.net.selfId ?? '', name: s.name, avatar: s.avatar, badges: s.badges.slice(), dexCaught: s.dexCaught.length,
    party: s.party.map((c) => ctx.creatureView(c)), pvpWins: s.stats.pvpWins, pvpLosses: s.stats.pvpLosses,
    playTimeSec: s.playTimeSec, trades: s.stats.trades, dexSeen: s.dexSeen.length,
  }
}

function profileCard(ctx: GameContext, p: PublicProfile & { trades?: number; dexSeen?: number }): HTMLElement {
  const row = (label: string, value: string) => el('div', 'mp-profile-row', [el('span', { text: label }), el('span', { text: value })])
  const hours = Math.floor(p.playTimeSec / 3600)
  const minutes = Math.floor((p.playTimeSec % 3600) / 60)
  const mon = (v: CreatureView) => el('div', { class: 'mp-profile-mon', title: creatureName(v) }, [
    creatureIcon(ctx.assets.creatureImageUrl(v.speciesId), v.shiny, RULES.partyIconSize),
    el('span', { text: t('multiplayer.card.level', { level: v.level }) }),
  ])
  return el('div', { class: 'mp-profile', vars: { '--mp-pavatar': RULES.profileAvatarSize } }, [
    avatarImg(ctx, p.avatar, 'mp-profile-avatar'),
    el('div', { class: 'mp-profile-name ap-big', text: p.name }),
    row(t('multiplayer.profile.badges'), t('multiplayer.profile.badgesValue', { n: p.badges.length })),
    row(t('multiplayer.profile.dex'), p.dexSeen !== undefined
      ? t('multiplayer.profile.dexValue', { caught: formatNumber(p.dexCaught), seen: formatNumber(p.dexSeen) })
      : t('multiplayer.profile.dexCaught', { caught: formatNumber(p.dexCaught) })),
    row(t('multiplayer.profile.pvp'), t('multiplayer.profile.pvpValue', { wins: p.pvpWins, losses: p.pvpLosses })),
    p.trades !== undefined ? row(t('multiplayer.profile.trades'), t('multiplayer.profile.tradesValue', { n: p.trades })) : null,
    p.maxDistance !== undefined ? row(t('multiplayer.profile.distance'), t('multiplayer.profile.distanceValue', { n: formatNumber(p.maxDistance) })) : null,
    row(t('multiplayer.profile.playTime'), t('multiplayer.profile.playTimeValue', { h: hours, m: minutes })),
    el('div', 'mp-profile-party', p.party.length ? p.party.map(mon) : [el('span', { class: 'ap-dim', text: t('multiplayer.profile.partyEmpty') })]),
  ])
}

/** Modal profile window; resolves when closed. */
function showProfile(ctx: GameContext, p: PublicProfile): Promise<void> {
  return new Promise((resolve) => {
    const win = panel(t('multiplayer.profile.title'))
    let closed = false
    const close = () => { if (!closed) { closed = true; ctx.ui.popPanel(modal); resolve() } }
    win.body.append(profileCard(ctx, p), el('div', 'ap-btn-row', [button(t('multiplayer.profile.close'), close, { primary: true })]))
    const modal: UIPanel = {
      el: el('div', 'ap-modal-center mp-profile-modal', [win.el]),
      onInput(input: Input) {
        for (const a of ['confirm', 'cancel', 'menu'] as const) if (input.pressed(a)) { input.consume(a); close() }
        return true
      },
    }
    ctx.ui.pushPanel(modal)
  })
}

/** inspect → profile (null on timeout / not found). */
function fetchProfile(ctx: GameContext, id: string): Promise<PublicProfile | null> {
  return new Promise((resolve) => {
    const offs = [
      ctx.net.on('profile', (m) => { if (m.profile.id === id) done(m.profile) }),
      ctx.net.on('error', (m) => { if (RULES.inspectAbortErrors.includes(m.code)) done(null) }),
    ]
    const timer = setTimeout(() => done(null), RULES.inspectTimeoutMs)
    let settled = false
    function done(p: PublicProfile | null) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const off of offs) off()
      resolve(p)
    }
    ctx.net.send({ t: 'inspect', target: id })
  })
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

const mapName = (ctx: GameContext, id: string) => (ctx.data.world ? getMap(ctx.data.world, id)?.nameZh : undefined) ?? t('multiplayer.online.unknownMap')

/** Opens the multiplayer hub; resolves when it is closed. */
export async function openOnline(ctx: GameContext): Promise<void> {
  injectStyle('mp-hub-style', STYLE)
  const roster = trackOnlineRoster(ctx.net)
  const tabIds = RULES.tabs
  const emoteIds = MP.emotes

  let zone: Zone = 'list'
  let emoteIndex = 0
  let menu: RowMenu | null = null
  let rowsKey = ''
  let actionsOpen = false
  let board: { entries: LeaderboardEntry[]; at: number } | null = null
  let boardLoading = false
  let statusKey = ''
  let sinceRefresh = 0
  let closed = false
  let resolveClosed: () => void = () => {}
  const closedP = new Promise<void>((r) => { resolveClosed = r })

  const titleEl = el('span', { class: 'mp-hub-title ap-big', text: t('multiplayer.online.title') })
  const statusEl = el('div', 'mp-status')
  const reconnectBtn = button(t('multiplayer.status.reconnect'), () => ctx.net.connect())
  const closeBtn = button(t('multiplayer.online.close'), () => close())
  const tabStrip: TabsHandle = tabs(tabIds.map((id) => t(`multiplayer.online.tab.${id}`)), {
    audio: ctx.audio,
    onChange: () => { rowsKey = ''; if (zone === 'list' && !currentHasList()) zone = 'tabs'; render() },
  })
  const body = el('div', { class: 'mp-hub-body', vars: { '--mp-rows': RULES.visibleRows, '--row-h': UI_CONFIG.list.rowHeight } })
  const emoteButtons = emoteIds.map((id, i) => {
    const b = button(t(`multiplayer.emote.${id}.symbol`), () => { emoteIndex = i; sendEmote(id) })
    b.title = t(`multiplayer.emote.${id}.label`)
    return b
  })
  const emoteBar = el('div', 'mp-emotes', [el('span', { class: 'mp-emote-label', text: t('multiplayer.online.emotes') }), ...emoteButtons])
  const tipsEl = el('div')
  const keysEl = el('div', 'mp-hub-keys')
  const win = panel(null)
  win.body.append(
    el('div', 'mp-hub-head', [titleEl, reconnectBtn, closeBtn]),
    statusEl,
    tabStrip.el,
    body,
    emoteBar,
    el('div', 'mp-hub-foot', [tipsEl, keysEl]),
  )
  const root = el('div', {
    class: 'ap-modal-center mp-hub',
    vars: { '--mp-list-w': RULES.listWidth, '--mp-avatar': RULES.avatarIconSize },
  }, [win.el])

  const tab = (): TabId => tabIds[tabStrip.index]
  const currentHasList = () => tab() !== 'profile'

  // ---- header / footer

  function paintStatus(): void {
    const status: NetStatus = ctx.net.status
    const rtt = (ctx.net as { rtt?: number }).rtt ?? -1
    const key = `${status}|${ctx.net.online}|${Math.round(rtt)}`
    if (key === statusKey) return
    statusKey = key
    statusEl.dataset.status = status
    statusEl.replaceChildren()
    append(statusEl, [
      el('span', 'mp-status-dot'),
      el('span', { text: t(`multiplayer.status.${status}`) }),
      status === 'online' ? el('span', { class: 'ap-dim', text: t('multiplayer.status.count', { n: ctx.net.online }) }) : null,
      status === 'online' && rtt >= 0 ? el('span', { class: 'ap-dim', text: t('multiplayer.status.rtt', { ms: Math.round(rtt) }) }) : null,
    ])
    reconnectBtn.hidden = status === 'online' || status === 'connecting'
  }

  function paintFoot(): void {
    const device = ctx.input.lastDevice
    const cmd = UI_CONFIG.chat.commands
    tipsEl.textContent = t('multiplayer.online.chatTips', {
      key: actionKeyLabel('chat', device), whisper: cmd.whisper[0] ?? '', reply: cmd.reply[0] ?? '', global: cmd.global[0] ?? '', local: cmd.local[0] ?? '',
    })
    keysEl.replaceChildren(
      el('span', { text: t('multiplayer.online.hint.tabs') }),
      keyHint('confirm', { label: t('multiplayer.online.hint.act'), device }),
      keyHint('cancel', { label: t('multiplayer.online.hint.close'), device }),
    )
  }

  // ---- body

  interface Row { item: ListItem; self?: boolean; run?: () => void | Promise<void> }

  function playerRows(): Row[] {
    if (ctx.net.status !== 'online') return [{ item: { label: t('multiplayer.online.offline') }, run: () => ctx.net.connect() }]
    const selfId = ctx.net.selfId
    const list = roster.players.slice().sort((a, b) => Number(b.id === selfId) - Number(a.id === selfId) || a.name.localeCompare(b.name))
    if (!roster.at) return [{ item: { label: t('multiplayer.online.loading'), disabled: true } }]
    if (!list.some((p) => p.id !== selfId)) return [{ item: { label: t('multiplayer.online.empty'), disabled: true } }]
    return list.map((p) => ({
      self: p.id === selfId,
      item: {
        label: p.id === selfId ? t('multiplayer.online.self', { name: p.name }) : p.name,
        sub: t(p.busy ? 'multiplayer.online.subBusy' : 'multiplayer.online.sub', { map: mapName(ctx, p.map) }),
        value: p.avatar,
      },
      run: () => playerActions(p),
    }))
  }

  function boardRows(): Row[] {
    if (!board) return [{ item: { label: t('multiplayer.online.loading'), disabled: true } }]
    if (!board.entries.length) return [{ item: { label: t('multiplayer.online.rankEmpty'), disabled: true } }]
    const selfId = ctx.net.selfId
    return board.entries.map((e, i) => ({
      self: e.id === selfId,
      item: {
        label: t('multiplayer.online.rank', { rank: i + 1, name: e.name }),
        sub: t('multiplayer.online.rankSub', { dex: formatNumber(e.dexCaught), badges: e.badges, wins: e.pvpWins, losses: e.pvpLosses, dist: formatNumber(e.maxDistance ?? 0) }),
        value: e.avatar,
      },
      run: () => inspect(e.id, e.name),
    }))
  }

  function ensureBoard(): void {
    const fresh = board && Date.now() - board.at < RULES.leaderboardMaxAgeSeconds * 1000
    if (fresh || boardLoading) return
    boardLoading = true
    void ctx.net.leaderboard().then((entries) => {
      board = { entries, at: Date.now() }
    }, () => {
      board = { entries: [], at: Date.now() }
    }).finally(() => {
      boardLoading = false
      rowsKey = ''
      if (!closed) render()
    })
  }

  let rows: Row[] = []
  let profileEl: HTMLElement = profileCard(ctx, selfProfile(ctx))

  function render(): void {
    root.classList.toggle('mp-zone-list', zone === 'list')
    tabStrip.el.classList.toggle('mp-zone-tabs', zone === 'tabs')
    emoteButtons.forEach((b, i) => b.classList.toggle('mp-focus', zone === 'emotes' && i === emoteIndex))
    const id = tab()
    if (id === 'profile') {
      if (rowsKey !== 'profile') {
        rowsKey = 'profile'
        menu = null
        profileEl = profileCard(ctx, selfProfile(ctx))
        body.replaceChildren(profileEl)
      }
      return
    }
    if (id === 'leaderboard') ensureBoard()
    const next = id === 'players' ? playerRows() : boardRows()
    const key = `${id}|${JSON.stringify(next.map((r) => [r.item.label, r.item.sub, r.item.disabled, r.self]))}`
    if (key === rowsKey) return
    rowsKey = key
    // Keep the cursor on the same entry across refreshes.
    const prevLabel = menu && rows[menu.index] ? rows[menu.index].item.label : null
    rows = next
    const initial = Math.max(0, prevLabel === null ? 0 : rows.findIndex((r) => r.item.label === prevLabel))
    menu = createRowMenu(rows.map((r) => r.item), {
      visibleRows: RULES.visibleRows,
      initial,
      audio: ctx.audio,
      onPick: (i) => { zone = 'list'; void activateRow(i) },
    })
    menu.el.querySelectorAll<HTMLElement>('.ap-row').forEach((rowEl, i) => {
      const r = rows[i]
      if (!r) return
      rowEl.classList.toggle('mp-self', !!r.self)
      if (typeof r.item.value === 'string') {
        const img = avatarImg(ctx, r.item.value, 'ap-row-icon')
        rowEl.insertBefore(img, rowEl.firstChild)
      }
    })
    // The hidden profile card keeps the body as tall as the tallest tab, so switching tabs never resizes the window.
    profileEl.classList.add('mp-ghost')
    profileEl.setAttribute('aria-hidden', 'true')
    body.replaceChildren(profileEl, menu.el)
  }

  async function activateRow(i: number): Promise<void> {
    const r = rows[i]
    if (!r?.run || r.item.disabled || actionsOpen) return
    actionsOpen = true
    try { await r.run() } finally { actionsOpen = false; rowsKey = ''; if (!closed) render() }
  }

  // ---- actions

  async function playerActions(p: RosterEntry): Promise<void> {
    const isSelf = p.id === ctx.net.selfId
    const online = ctx.net.status === 'online'
    const reason = (a: PlayerAction): string | undefined => {
      if (!online) return t('multiplayer.online.actions.offline')
      if (isSelf && a !== 'inspect') return t('multiplayer.online.actions.selfOnly')
      if (p.busy && (a === 'trade' || a === 'battle')) return t('multiplayer.online.actions.busy')
      return undefined
    }
    const actions = RULES.playerActions
    const items: ListItem[] = actions.map((a) => {
      const why = reason(a)
      return { label: t(`multiplayer.online.actions.${a}`), sub: why, disabled: why !== undefined }
    })
    const pick = await ctx.ui.list(p.name, items)
    if (pick < 0 || items[pick].disabled) return
    switch (actions[pick]) {
      case 'whisper': {
        const text = await ctx.ui.prompt(t('multiplayer.online.whisperPrompt', { name: p.name }), '', CONTENT.config.net.chatMaxLen)
        if (text) ctx.net.send({ t: 'chat', channel: 'whisper', to: p.id, text })
        return
      }
      case 'inspect': return inspect(p.id, p.name)
      case 'trade': return startTradeFlow(ctx, p.id, p.name)
      case 'battle': return challengePvp(ctx, p.id, p.name)
    }
  }

  async function inspect(id: string, name: string): Promise<void> {
    if (id === ctx.net.selfId) { await showProfile(ctx, selfProfile(ctx)); return }
    if (ctx.net.status !== 'online') { ctx.ui.toast(t('multiplayer.status.notOnline'), 'warn'); return }
    const profile = await fetchProfile(ctx, id)
    if (!profile) { ctx.ui.toast(t('multiplayer.online.inspectFailed', { name }), 'warn'); return }
    await showProfile(ctx, profile)
  }

  function sendEmote(id: string): void {
    if (ctx.net.status !== 'online') { ctx.ui.toast(t('multiplayer.status.notOnline'), 'warn'); return }
    ctx.net.send({ t: 'emote', emote: t(`multiplayer.emote.${id}.symbol`) })
    ctx.ui.toast(t('multiplayer.online.emoteSent', { label: t(`multiplayer.emote.${id}.label`) }), 'info')
    render()
  }

  // ---- input

  function onInput(input: Input): boolean {
    if (actionsOpen) return true
    if (input.pressed('menu')) { input.consume('menu'); close(); return true }
    const hasList = currentHasList() && !!menu
    if (zone === 'list' && !hasList) zone = 'tabs'
    if (zone === 'tabs') {
      if (input.pressed('left', true)) { input.consume('left'); tabStrip.prev() }
      else if (input.pressed('right', true)) { input.consume('right'); tabStrip.next() }
      else if (input.pressed('down', true) || input.pressed('confirm')) { input.consume('down'); input.consume('confirm'); zone = hasList ? 'list' : 'emotes'; render() }
      else if (input.pressed('cancel')) { input.consume('cancel'); close() }
      return true
    }
    if (zone === 'emotes') {
      const n = emoteButtons.length
      if (input.pressed('left', true)) { input.consume('left'); emoteIndex = (emoteIndex - 1 + n) % n; ctx.audio.playSfx(UI_CONFIG.sfx.move); render() }
      else if (input.pressed('right', true)) { input.consume('right'); emoteIndex = (emoteIndex + 1) % n; ctx.audio.playSfx(UI_CONFIG.sfx.move); render() }
      else if (input.pressed('up', true)) { input.consume('up'); zone = hasList ? 'list' : 'tabs'; render() }
      else if (input.pressed('confirm')) { input.consume('confirm'); sendEmote(emoteIds[emoteIndex]) }
      else if (input.pressed('cancel')) { input.consume('cancel'); close() }
      return true
    }
    // list zone: left/right switch tabs, the edges hand focus to the tab strip / emote bar.
    const m = menu!
    if (input.pressed('left', true)) { input.consume('left'); tabStrip.prev(); return true }
    if (input.pressed('right', true)) { input.consume('right'); tabStrip.next(); return true }
    if (input.pressed('down', true) && m.index >= m.count - 1) { input.consume('down'); zone = 'emotes'; render(); return true }
    if (input.pressed('up', true) && m.index <= 0) { input.consume('up'); zone = 'tabs'; render(); return true }
    const r = m.handleInput(input)
    if (r === 'confirm') void activateRow(m.index)
    else if (r === 'cancel') close()
    return true
  }

  const hub: UIPanel = {
    el: root,
    onInput,
    update(dt: number) {
      sinceRefresh += dt * 1000
      if (sinceRefresh < RULES.statusRefreshMs) return
      sinceRefresh = 0
      paintStatus()
      if (!actionsOpen) render()
    },
  }

  function close(): void {
    if (closed) return
    closed = true
    ctx.ui.popPanel(hub)
    resolveClosed()
  }

  paintStatus()
  paintFoot()
  render()
  ctx.ui.pushPanel(hub)
  await closedP
}
