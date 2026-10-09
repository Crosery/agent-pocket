// Network simulation: link quality, forced disconnects, and the fake server with its fake players.
import { DevError, type CommandArgs, type CommandRun } from '../registry.ts'
import { NET_SIM } from '../net-config.ts'
import type { LinkConfig } from '../net-sim.ts'

const num = (a: CommandArgs, key: string): number | undefined => (a[key] === undefined ? undefined : Number(a[key]))

function inRange(arg: string, v: number | undefined, max: number, min = 0): number | undefined {
  if (v === undefined) return undefined
  if (!(v >= min && v <= max)) throw new DevError('dev.err.netRange', { arg, min, max })
  return v
}

export const netCommands: Record<string, CommandRun> = {
  'net.preset': (host, a) => {
    const name = String(a.name)
    if (!NET_SIM.presets[name]) throw new DevError('dev.err.unknownNetPreset', { name })
    return { link: host.net.preset(name) }
  },
  'net.link': (host, a) => {
    const lim = NET_SIM.limits
    const patch: Partial<LinkConfig> = {}
    const latency = inRange('latencyMs', num(a, 'latencyMs'), lim.latencyMs)
    const jitter = inRange('jitterMs', num(a, 'jitterMs'), lim.jitterMs)
    const chance = inRange('stallChance', num(a, 'stallChance'), 1)
    const lo = inRange('stallMinMs', num(a, 'stallMinMs'), lim.stallMs)
    const hi = inRange('stallMaxMs', num(a, 'stallMaxMs'), lim.stallMs)
    if (latency !== undefined) patch.latencyMs = latency
    if (jitter !== undefined) patch.jitterMs = jitter
    if (chance !== undefined) patch.stallChance = chance
    if (lo !== undefined || hi !== undefined) {
      const cur = host.net.state().link.stallMs
      patch.stallMs = [lo ?? Math.min(cur[0], hi!), hi ?? Math.max(cur[1], lo!)]
    }
    return { link: host.net.setLink(patch) }
  },
  'net.drop': (host) => ({ dropped: host.net.drop() }),
  'net.offline': (host) => { host.ctx.net.disconnect(); return { status: host.ctx.net.status } },
  'net.reconnect': (host) => { host.ctx.net.disconnect(); host.ctx.net.connect(); return { status: host.ctx.net.status } },
  'net.fake': (host, a) => {
    const peers = inRange('peers', num(a, 'peers'), NET_SIM.limits.peers)
    host.net.setFake(a.on !== false, peers)
    host.ctx.net.disconnect()
    host.ctx.net.connect()
    return host.net.state()
  },
  'net.peers': (host, a) => ({ peers: host.net.setPeers(inRange('n', Number(a.n), NET_SIM.limits.peers) as number) }),
}
