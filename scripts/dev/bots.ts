// Real bots for a local game server (ADR 0002 §3.4): N players that join, walk the fake-player patterns of
// content/dev/net-sim.json around a start anchor, and leave. For load, interest-management and multi-client checks.
//   node scripts/dev/bots.ts --port 8830 [--count 12] [--seconds 60] [--anchor town:origin]
// Only loopback servers are accepted. The bots never send the devtools flag, so a production-style server takes them.
import { request } from 'node:http'
import { CONTENT, t } from '../../src/shared/content/index.ts'
import { hash01, peerAt, type FakeConfig } from '../../src/shared/dev/netsim.ts'
import type { ClientMsg, PublicProfile, ServerMsg } from '../../src/shared/protocol.ts'
import { encodeMoveFrame } from '../../src/shared/net-codec.ts'
import { buildWorld, worldAnchors } from '../../src/shared/world/index.ts'
import { createSaveManager } from '../../src/client/core/save.ts'
import { installDevText } from '../../src/client/dev/text.ts'
import { signEnvelopeNode } from '../../src/server/net-envelope.ts'
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
const legacy = process.argv.includes('--legacy')
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

function httpPost(
  targetHost: string,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<{ status: number; cookie: string | null }> {
  const payload = JSON.stringify(body)
  const originHost = targetHost === '::1' ? '[::1]' : targetHost
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: `http://${originHost}:${port}`,
    'sec-fetch-site': 'same-origin',
    ...(cookie ? { cookie } : {}),
  }
  return new Promise((resolve, reject) => {
    const req = request({ host: targetHost, port, path, method: 'POST', headers }, (res) => {
      res.resume()
      res.on('end', () => {
        const rawSetCookie = res.headers['set-cookie']
        const first = Array.isArray(rawSetCookie) ? rawSetCookie[0] ?? null : (rawSetCookie ?? null)
        const pair = first ? first.split(';')[0]?.trim() ?? null : null
        resolve({ status: res.statusCode ?? 0, cookie: pair })
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

async function authBot(i: number, name: string, avatar: string): Promise<{ cookie: string; wsHost: string; origin: string }> {
  const wsHost = i % 2 === 1 && host === 'localhost' ? '::1' : '127.0.0.1'
  const originHost = wsHost === '::1' ? '[::1]' : wsHost
  const origin = `http://${originHost}:${port}`
  const username = `DevBot_${i + 1}`
  const password = 'DevBotPassword#123'
  let res = await httpPost(wsHost, netJson.http.loginPath, { username, password })
  if (res.status !== 200 || !res.cookie) {
    res = await httpPost(wsHost, netJson.http.registerPath, { username, password })
  }
  if (!res.cookie) throw new Error(`bot ${i} auth failed (${res.status})`)
  const mgr = createSaveManager({ world: null, storage: null })
  const baseSave = mgr.newGame({ name, avatar })
  await httpPost(wsHost, netJson.http.bindPath, { save: baseSave, imported: false }, res.cookie)
  return { cookie: res.cookie, wsHost: originHost, origin }
}

async function bot(i: number): Promise<void> {
  const name = t('dev.net.peerName', { n: i + 1 })
  const avatar = avatars[i % avatars.length] ?? ''
  const id = crypto.randomUUID()
  let auth: { cookie: string; wsHost: string; origin: string }
  try {
    auth = await authBot(i, name, avatar)
  } catch (err) {
    stats.errors.push(String((err as Error).message))
    return
  }
  const ws = new WebSocket(
    `ws://${auth.wsHost}:${port}${netJson.protocol.wsPath}`,
    { headers: { Cookie: auth.cookie, Origin: auth.origin } } as unknown as string[],
  )
  let sessionKey = ''
  let authSeq = 0
  const sendRaw = (m: ClientMsg | Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
  }
  const sendSigned = (m: ClientMsg | Record<string, unknown>) => {
    if (ws.readyState !== WebSocket.OPEN) return
    if (!sessionKey) {
      sendRaw(m)
      return
    }
    sendRaw(signEnvelopeNode(sessionKey, m as Record<string, unknown>, ++authSeq))
  }
  let timer: NodeJS.Timeout | undefined
  ws.addEventListener('open', () => {
    stats.connected++
    const pose = peerAt(FAKE, i, 0, anchor)
    const hello: ClientMsg = {
      t: 'hello', v: CONTENT.config.net.protocolVersion, playerId: id, name, avatar, map: anchor.map,
      x: Math.floor(pose.x) + 0.5, y: Math.floor(pose.y) + 0.5, facing: pose.facing, lead: null, profile: profile(id, name, avatar, i),
      signed: true,
      ...(!legacy ? { compact: true } : {}),
    }
    sendRaw(hello)
  })
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data)) as ServerMsg
    if (m.t === 'welcome') {
      stats.welcomed++
      sessionKey = m.sessionKey ?? ''
      let moveSeq = 0
      timer = setInterval(() => {
        const p = peerAt(FAKE, i, (Date.now() - start) / 1000, anchor)
        stats.moves++
        moveSeq++
        if (legacy) {
          sendSigned({ t: 'move', seq: moveSeq, map: anchor.map, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, facing: p.facing, moving: p.moving, running: false })
        } else {
          sendSigned(encodeMoveFrame({ seq: moveSeq, map: anchor.map, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, facing: p.facing, moving: p.moving, running: false }, false))
        }
      }, tickMs)
    } else if (m.t === 'error') stats.errors.push(`${m.code}`)
  })
  ws.addEventListener('close', () => { stats.closed++; clearInterval(timer) })
  ws.addEventListener('error', () => stats.errors.push('ws_error'))
  setTimeout(() => ws.close(), seconds * 1000)
}

for (let i = 0; i < count; i++) setTimeout(() => { void bot(i) }, i * 50)
setTimeout(() => {
  console.log(JSON.stringify({ url, count, ...stats, errors: [...new Set(stats.errors)] }))
  process.exit(stats.welcomed === count ? 0 : 1)
}, seconds * 1000 + 1500 + count * 50)
