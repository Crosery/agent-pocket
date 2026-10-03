// Multiplayer presence in the overworld: other players on this map as name-tagged Actors with their lead
// creature following them, emote / local-chat bubbles, and the remote-player interaction menu.
import type { Dir } from '../../shared/types.ts'
import type { PublicProfile } from '../../shared/protocol.ts'
import type { Actor, CreatureActor, GameContext, ListItem } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import { GAME } from './config.ts'
import { createTrail, type Trail } from './trail.ts'
import { DIR_VEC } from './motion.ts'

/** Optional multiplayer flows (src/client/net/trade-flow.ts, pvp-channel.ts), injected when they load. */
export interface MultiplayerHooks {
  startTradeFlow?: (ctx: GameContext, id: string, name: string) => Promise<void>
  challengePvp?: (ctx: GameContext, id: string, name: string) => Promise<void>
}

interface RemoteView {
  id: string
  name: string
  actor: Actor
  avatar: string
  lead: CreatureActor | null
  leadKey: string
  trail: Trail
  lx: number
  ly: number
  x: number
  y: number
}

const leadKeyOf = (l: { speciesId: string; shiny: boolean } | null) => (l ? `${l.speciesId}|${l.shiny ? 1 : 0}` : '')

export function createPresence(ctx: GameContext, deps: { mapId(): string | null; hooks(): MultiplayerHooks | null }) {
  const views = new Map<string, RemoteView>()
  const offs: (() => void)[] = []

  const sheetFor = (avatar: string) =>
    ctx.data.characterById[avatar] ? avatar : (ctx.data.characters.find((c) => c.playable) ?? ctx.data.characters[0])?.id ?? avatar

  const bubbleText = (s: string) => {
    const chars = [...s]
    return chars.length > GAME.presence.bubbleMaxChars ? `${chars.slice(0, GAME.presence.bubbleMaxChars).join('')}…` : s
  }

  function drop(v: RemoteView): void {
    v.actor.dispose()
    v.lead?.dispose()
    views.delete(v.id)
  }

  function clear(): void {
    for (const v of [...views.values()]) drop(v)
  }

  function syncLead(v: RemoteView, lead: { speciesId: string; shiny: boolean } | null): void {
    const key = leadKeyOf(lead && ctx.data.species[lead.speciesId] ? lead : null)
    if (key === v.leadKey) return
    v.lead?.dispose()
    v.lead = null
    v.leadKey = key
    if (lead && key) {
      v.lead = ctx.world.createCreatureActor(lead.speciesId, lead.shiny)
      const at = v.trail.sample(GAME.presence.followerDistance) ?? { x: v.x, y: v.y }
      v.lx = at.x
      v.ly = at.y
    }
  }

  function update(dt: number): void {
    const map = deps.mapId()
    const remotes = ctx.net.remotePlayers()
    for (const v of [...views.values()]) {
      const p = remotes.get(v.id)
      if (!p || p.map !== map) drop(v)
    }
    if (!map || !ctx.world.map || ctx.world.map.id !== map) return
    for (const p of remotes.values()) {
      if (p.map !== map) continue
      let v = views.get(p.id)
      if (!v || v.avatar !== p.avatar) {
        if (v) drop(v)
        const actor = ctx.world.createActor({ sheet: sheetFor(p.avatar), name: p.name, kind: 'remote' })
        // Lead starts behind the player (opposite its facing) instead of on top of it.
        const back = DIR_VEC[p.facing as Dir] ?? DIR_VEC.down
        const bx = p.rx - back.x * GAME.presence.followerDistance, by = p.ry - back.y * GAME.presence.followerDistance
        v = { id: p.id, name: p.name, actor, avatar: p.avatar, lead: null, leadKey: '', trail: createTrail(GAME.follower.trailSpacing, GAME.follower.maxTrail), lx: bx, ly: by, x: p.rx, y: p.ry }
        v.trail.reset({ x: p.rx, y: p.ry, elev: 0 }, { x: bx, y: by, elev: 0 })
        views.set(p.id, v)
      }
      if (v.name !== p.name) { v.name = p.name; v.actor.setName(p.name) }
      v.x = p.rx
      v.y = p.ry
      const elev = ctx.world.elevationAt(v.x, v.y)
      v.actor.setPosition(v.x, v.y, elev)
      v.actor.setFacing(p.facing as Dir)
      v.actor.setMoving(p.moving, p.running)
      v.actor.update(dt)
      syncLead(v, p.lead)
      if (v.lead) {
        v.trail.push({ x: v.x, y: v.y, elev })
        const target = v.trail.sample(GAME.presence.followerDistance)
        if (target) {
          const k = 1 - Math.exp(-dt * GAME.presence.followerRate)
          const nx = v.lx + (target.x - v.lx) * k, ny = v.ly + (target.y - v.ly) * k
          const moved = Math.hypot(nx - v.lx, ny - v.ly)
          if (moved > 1e-3 && Math.abs(nx - v.lx) > 1e-3) v.lead.setFacingLeft(nx < v.lx)
          v.lead.setMoving(moved > GAME.follower.moveEpsilon * dt * 60)
          v.lx = nx
          v.ly = ny
        }
        v.lead.setPosition(v.lx, v.ly, ctx.world.elevationAt(v.lx, v.ly))
        v.lead.update(dt)
      }
    }
  }

  offs.push(ctx.net.on('emote', (m) => {
    const v = views.get(m.id)
    const key = `multiplayer.emote.${m.emote}.symbol`
    if (v && key in ctx.data.text) v.actor.bubble(t(key), GAME.presence.emoteBubbleMs)
  }))
  offs.push(ctx.net.on('chat', (m) => {
    if (m.channel !== 'local') return
    const v = views.get(m.from)
    if (v) v.actor.bubble(bubbleText(m.text), GAME.presence.chatBubbleMs)
  }))

  function nearest(x: number, y: number, radius: number): RemoteView | null {
    let best: RemoteView | null = null
    let bd = radius
    for (const v of views.values()) {
      const d = Math.hypot(v.x - x, v.y - y)
      if (d < bd) { bd = d; best = v }
    }
    return best
  }

  function fetchProfile(id: string): Promise<PublicProfile | null> {
    return new Promise((resolve) => {
      let settled = false
      const done = (p: PublicProfile | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        for (const off of local) off()
        resolve(p)
      }
      const local = [
        ctx.net.on('profile', (m) => { if (m.profile.id === id) done(m.profile) }),
        ctx.net.on('error', () => done(null)),
      ]
      const timer = setTimeout(() => done(null), GAME.presence.inspectTimeoutMs)
      ctx.net.send({ t: 'inspect', target: id })
    })
  }

  async function inspect(v: RemoteView): Promise<void> {
    const profile = await fetchProfile(v.id)
    if (!profile) { ctx.ui.toast(t('world.remote.inspectFailed', { name: v.name }), 'warn'); return }
    if (!profile.party.length) {
      await ctx.ui.say([{ text: t('world.remote.partyEmpty', { name: profile.name }) }])
      return
    }
    const sub = t('world.remote.profileSub', { badges: profile.badges.length, dex: profile.dexCaught, wins: profile.pvpWins, losses: profile.pvpLosses })
    const items: ListItem[] = profile.party.map((c) => ({
      label: c.nickname ?? ctx.data.species[c.speciesId]?.nameZh ?? c.speciesId,
      sub: t('world.remote.partyLevel', { level: c.level }),
      icon: ctx.assets.creatureImageUrl(c.speciesId),
    }))
    await ctx.ui.list(`${t('world.remote.profileTitle', { name: profile.name })} · ${sub}`, items)
  }

  /** Confirm on a remote player: inspect / trade / battle / cancel. */
  async function interact(v: RemoteView): Promise<void> {
    if (ctx.net.status !== 'online') { ctx.ui.toast(t('world.remote.offline'), 'warn'); return }
    const remote = ctx.net.remotePlayers().get(v.id)
    if (remote?.busy) { ctx.ui.toast(t('world.remote.busy', { name: v.name }), 'info'); return }
    const options = [t('world.remote.inspect'), t('world.remote.trade'), t('world.remote.battle'), t('world.remote.cancel')]
    const pick = await ctx.ui.choose(t('world.remote.prompt', { name: v.name }), options, { cancelIndex: options.length - 1 })
    const hooks = deps.hooks()
    if (pick === 0) await inspect(v)
    else if (pick === 1) {
      if (hooks?.startTradeFlow) await hooks.startTradeFlow(ctx, v.id, v.name)
      else ctx.ui.toast(t('world.remote.unavailable'), 'warn')
    } else if (pick === 2) {
      if (hooks?.challengePvp) await hooks.challengePvp(ctx, v.id, v.name)
      else ctx.ui.toast(t('world.remote.unavailable'), 'warn')
    }
  }

  return {
    update,
    clear,
    nearest,
    interact,
    get views(): ReadonlyMap<string, { x: number; y: number; name: string }> { return views },
    dispose(): void { clear(); for (const off of offs) off() },
  }
}

export type Presence = ReturnType<typeof createPresence>
