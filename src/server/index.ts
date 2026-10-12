// Agent Pocket game server: HTTP (static dist/ + /api) and the WebSocket hub on one port.
// Run directly: `node src/server/index.ts` (PORT, AP_DATA_DIR, AP_DIST_DIR env vars).
import { once } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { WebSocketServer } from 'ws'
import pkg from '../../package.json' with { type: 'json' }
import type { Creature } from '../shared/types.ts'
import { CONTENT, t } from '../shared/content/index.ts'
import type { AuthorityService } from './authority.ts'
import { checkOriginCsrf } from './accounts.ts'
import { NET, validateNetContent } from './config.ts'
import { createHttpHandler } from './http.ts'
import { createHub, type Hub, type HubMetrics } from './hub.ts'
import { loadPvpModule, type PvpModule } from './pvp-hooks.ts'
import { createProfileStore, type ProfileStore } from './store.ts'
import type { SanitizeCreature } from './trade.ts'
import { loadWorldInfo, type WorldInfo } from './world.ts'

export interface ServerOptions {
  port: number
  /** Directory for persistent server data (profiles.json). */
  dataDir: string
  /** Built client to serve; defaults to <project>/dist. */
  distDir?: string
  host?: string
  /** Inject a PvP module (tests); undefined = load ./pvp.ts, null = disabled. */
  pvp?: PvpModule | null
  /** Accept clients built with developer tooling (--mode devtools). Off unless AP_DEV is set; production never sets it. */
  allowDev?: boolean
  /** Inject world bounds (tests); undefined = build from src/shared/world, null = no bounds. */
  world?: WorldInfo | null
  /** Require HMAC signatures on every post-hello message. */
  requireSigned?: boolean
  quiet?: boolean
}

export interface RunningServer {
  readonly port: number
  readonly store: ProfileStore
  metrics(): HubMetrics
  readonly hub: Hub
  readonly authority: AuthorityService
  close(): Promise<void>
}

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** sanitizeCreature from src/shared/creature.ts, loaded lazily (and retried) so the server runs without it. */
function creatureSanitizer(log: (msg: string) => void): () => SanitizeCreature | null {
  let fn: SanitizeCreature | null = null
  let loading: Promise<void> | null = null
  let warned = false
  const load = () => {
    loading ??= import(new URL('../shared/creature.ts', import.meta.url).href)
      .then((mod: { sanitizeCreature?: (raw: unknown) => Creature | null }) => {
        if (typeof mod.sanitizeCreature === 'function') fn = mod.sanitizeCreature
        else if (!warned) { warned = true; log('creature module has no sanitizeCreature(), trading disabled') }
      })
      .catch((err: Error) => { if (!warned) { warned = true; log(`creature module unavailable, trading disabled (${err.message})`) } })
      .finally(() => { loading = null })
    return loading
  }
  void load()
  return () => {
    if (!fn && !loading) void load()
    return fn
  }
}

function clientIp(req: IncomingMessage): string {
  if (NET.server.trustProxy) {
    const xff = req.headers['x-forwarded-for']
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim()
    if (first) return first
  }
  return req.socket.remoteAddress ?? ''
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const problems = validateNetContent()
  if (problems.length) throw new Error(`invalid net content:\n${problems.join('\n')}`)
  const log = opts.quiet ? () => {} : (msg: string) => console.log(`[server] ${msg}`)

  const world = opts.world !== undefined ? opts.world : await loadWorldInfo(log)
  const store = createProfileStore({ dir: opts.dataDir, world: world?.world ?? null, log })
  await store.load()
  const pvp = opts.pvp !== undefined ? opts.pvp : await loadPvpModule(log)
  const sanitizer = creatureSanitizer(log)
  const hub = createHub({
    store,
    world,
    pvp,
    sanitizer,
    dataDir: opts.dataDir,
    requireSigned: opts.requireSigned,
    allowDev: opts.allowDev === true,
    log,
  })
  await hub.authority.load()
  const startedAt = Date.now()

  const handler = createHttpHandler({
    distDir: opts.distDir ?? resolve(PROJECT_ROOT, NET.http.distDir),
    publicDir: resolve(PROJECT_ROOT, NET.http.publicDir),
    api: {
      health: () => ({ ok: true, online: hub.onlineCount(), uptime: Math.round((Date.now() - startedAt) / 1000), version: pkg.version }),
      status: () => ({
        protocolVersion: CONTENT.config.net.protocolVersion,
        version: pkg.version,
        online: hub.onlineCount(),
        name: t('net.serverName'),
      }),
      leaderboard: () => store.leaderboard(),
      accounts: store,
      clientIp,
      metrics: (req) => {
        const token = process.env.AP_METRICS_TOKEN
        const auth = req.headers.authorization
        if (token && auth === `Bearer ${token}`) return hub.metrics() as unknown as Record<string, unknown>
        return null
      },
    },
  })
  const server = createServer(handler)
  const wss = new WebSocketServer({ noServer: true, maxPayload: NET.server.maxPayloadBytes, clientTracking: false })

  server.on('upgrade', (req, socket, head) => {
    let pathname = ''
    try { pathname = new URL(req.url ?? '/', 'http://localhost').pathname } catch { /* rejected below */ }
    if (pathname !== NET.protocol.wsPath) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    if (!checkOriginCsrf(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, clientIp(req), req))
  })
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    else socket.destroy()
  })

  server.listen(opts.port, opts.host)
  await once(server, 'listening')
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : opts.port
  log(`listening on http://localhost:${port} (ws ${NET.protocol.wsPath}, world bounds ${world ? 'on' : 'off'}, pvp ${pvp ? 'on' : 'off'}, dev ${opts.allowDev ? 'on' : 'off'})`)

  let closing: Promise<void> | null = null
  return {
    port,
    store,
    metrics: () => hub.metrics(),
    hub,
    authority: hub.authority,
    close() {
      closing ??= (async () => {
        hub.close()
        wss.close()
        const closeServer = promisify(server.close.bind(server))
        const closePromise = closeServer()
        server.closeAllConnections()
        await closePromise
        await hub.authority.close()
        await store.close()
      })()
      return closing
    },
  }
}

const isMain = !!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  const port = Number(process.env.PORT) || NET.server.defaultPort
  const dataDir = process.env.AP_DATA_DIR ? resolve(process.env.AP_DATA_DIR) : resolve(PROJECT_ROOT, NET.store.defaultDir)
  const distDir = process.env.AP_DIST_DIR ? resolve(process.env.AP_DIST_DIR) : undefined
  const host = process.env.AP_HOST || undefined
  const allowDev = /^(1|true|yes|on)$/i.test(process.env.AP_DEV ?? '')
  if (!allowDev && (process.env.AP_SAVE_SECRET ?? process.env.SAVE_SECRET ?? '').trim().length < 32) {
    throw new Error('AP_SAVE_SECRET must contain at least 32 characters and remain stable across server restarts')
  }
  startServer({ port, host, dataDir, distDir, allowDev }).then(
    (srv) => {
      const stop = () => { srv.close().then(() => process.exit(0), () => process.exit(1)) }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    },
    (err: Error) => {
      console.error(`[server] failed to start: ${err.message}`)
      process.exit(1)
    },
  )
}
