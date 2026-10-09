// Real bots for a local game server (ADR 0002 §3.4): N players that join, walk the fake-player patterns of
// content/dev/net-sim.json around a start anchor, and leave. For load, interest-management and multi-client checks.
//   node scripts/dev/bots.ts --port 8830 [--count 12] [--seconds 60] [--anchor town:origin]
// Only loopback servers are accepted. The bots never send the devtools flag, so a production-style server takes them.
import { WebSocket } from 'ws'
import { CONTENT, t } from '../../src/shared/content/index.ts'
import { hash01, peerAt, type FakeConfig } from '../../src/shared/dev/netsim.ts'
import type { ClientMsg, PublicProfile, ServerMsg } from '../../src/shared/protocol.ts'
import { buildWorld, worldAnchors } from '../../src/shared/world/index.ts'
import { installDevText } from '../../src/client/dev/text.ts'
import netSim from '../../content/dev/net-sim.json' with { type: 'json' }
import netJson from '../../content/net.json' with { type: 'json' }

const FAKE = netSim.fake as unknown as FakeConfig

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

installDevText()
const port = Number(arg('port', process.env.PORT ?? String(netJson.server.defaultPort)))
const count = Math.max(1, Math.floor(Number(arg('count', String(FAKE.peers)))))
const seconds = Number(arg('seconds', '60'))
const anchorId = arg('anchor', 'town:origin')
const host = arg('host', 'localhost')
if (!['localhost', '127.0.0.1', '::1'].includes(host)) { console.error(`bots: only loopback hosts are allowed (got ${host})`); process.exit(2) }

const world = buildWorld()
const anchor = worldAnchors(world)[anchorId]
if (!anchor) { console.error(`bots: unknown anchor ${anchorId}`); process.exit(2) }
const avatars = CONTENT.characters.filter((c) => c.playable).map((c) => c.id)
const tickMs = 1000 / CONTENT.config.net.tickHz
const url = `ws://${host}:${port}${netJson.protocol.wsPath}`
const stats = { connected: 0, welcomed: 0, errors: [] as string[], closed: 0, moves: 0 }
const start = Date.now()

function profile(id: string, name: string, avatar: string, i: number): PublicProfile {
  return { id, name, avatar, badges: [], dexCaught: Math.floor(hash01(i, 1) * (FAKE.dexMax + 1)), party: [], pvpWins: 0, pvpLosses: 0, playTimeSec: 0 }
}

function bot(i: number): void {
  const name = t('dev.net.peerName', { n: i + 1 })
  const avatar = avatars[i % avatars.length] ?? ''
  const id = crypto.randomUUID()
  const ws = new WebSocket(url)
  const send = (m: ClientMsg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) }
  let timer: ReturnType<typeof setInterval> | null = null
  ws.on('open', () => {
    stats.connected++
    const pose = peerAt(FAKE, i, 0, anchor)
    send({ t: 'hello', v: CONTENT.config.net.protocolVersion, playerId: id, name, avatar, map: anchor.map, x: Math.floor(pose.x) + 0.5, y: Math.floor(pose.y) + 0.5, facing: pose.facing, lead: null, profile: profile(id, name, avatar, i) })
  })
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as ServerMsg
    if (m.t === 'welcome') {
      stats.welcomed++
      timer = setInterval(() => {
        const p = peerAt(FAKE, i, (Date.now() - start) / 1000, anchor)
        stats.moves++
        send({ t: 'move', map: anchor.map, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, facing: p.facing, moving: p.moving, running: false })
      }, tickMs)
    } else if (m.t === 'error') stats.errors.push(`${m.code}`)
  })
  ws.on('close', () => { stats.closed++; if (timer) clearInterval(timer) })
  ws.on('error', (e) => stats.errors.push(String((e as Error).message)))
  setTimeout(() => ws.close(), seconds * 1000)
}

for (let i = 0; i < count; i++) setTimeout(() => bot(i), i * 50)
setTimeout(() => {
  console.log(JSON.stringify({ url, count, ...stats, errors: [...new Set(stats.errors)] }))
  process.exit(stats.welcomed === count ? 0 : 1)
}, seconds * 1000 + 1500 + count * 50)
