// Multiplayer server list, custom server persistence, URL resolution and status probing.
import { CONTENT, t } from '../../shared/content/index.ts'
import { NET_CLIENT } from './config.ts'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ServerEntry {
  id: string
  name: string
  address: string
  official?: boolean
}

export interface ServerProbeResult {
  online: boolean
  rtt: number
  players: number
  version?: string
  protocolVersion?: number
  compatible: boolean
  name?: string
  error?: string
}

export interface ResolvedServerUrls {
  httpBase: string
  wsUrl: string
}

export const SERVERS_STORAGE_KEY = 'agent-pocket/servers'

function fallbackStorage(): StorageLike {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('__ap_probe__', '1')
      localStorage.removeItem('__ap_probe__')
      return localStorage
    }
  } catch {
    // fallback in memory
  }
  const mem = new Map<string, string>()
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  }
}

export function getOfficialServer(): ServerEntry {
  return {
    id: OFFICIAL_SERVER_ID,
    name: t('screens.serverList.officialName'),
    address: '',
    official: true,
  }
}

export function resolveServerUrls(address: string): ResolvedServerUrls {
  const trimmed = address.trim()
  if (!trimmed || trimmed === 'official' || trimmed === 'default') {
    if (typeof location !== 'undefined' && location.host) {
      const isHttps = location.protocol === 'https:'
      const httpBase = `${isHttps ? 'https:' : 'http:'}//${location.host}`
      const wsUrl = `${isHttps ? 'wss:' : 'ws:'}//${location.host}${NET_CLIENT.protocol.wsPath}`
      return { httpBase, wsUrl }
    }
    return {
      httpBase: 'http://localhost:8787',
      wsUrl: `ws://localhost:8787${NET_CLIENT.protocol.wsPath}`,
    }
  }
  let base = trimmed
  let scheme = ''
  if (/^https?:\/\//i.test(base)) {
    scheme = base.slice(0, base.indexOf('://')).toLowerCase()
    base = base.slice(scheme.length + 3)
  } else if (/^wss?:\/\//i.test(base)) {
    const wsScheme = base.slice(0, base.indexOf('://')).toLowerCase()
    scheme = wsScheme === 'wss' ? 'https' : 'http'
    base = base.slice(wsScheme.length + 3)
  } else {
    const isLocal = /^localhost(:\d+)?$/i.test(base) || /^(127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(base)
    scheme = isLocal ? 'http' : 'https'
  }

  let hostAndPath = base.replace(/\/+$/, '')
  let hostOnly = hostAndPath
  let wsPath = NET_CLIENT.protocol.wsPath
  const slashIdx = hostAndPath.indexOf('/')
  if (slashIdx >= 0) {
    hostOnly = hostAndPath.slice(0, slashIdx)
    const subPath = hostAndPath.slice(slashIdx)
    if (subPath.endsWith('/ws')) {
      wsPath = subPath
      hostAndPath = hostAndPath.slice(0, hostAndPath.length - 3)
    } else {
      wsPath = subPath + NET_CLIENT.protocol.wsPath
    }
  }

  const httpBase = `${scheme}://${hostAndPath.replace(/\/+$/, '')}`
  const wsScheme = scheme === 'https' ? 'wss' : 'ws'
  const wsUrl = `${wsScheme}://${hostOnly}${wsPath.startsWith('/') ? '' : '/'}${wsPath}`
  return { httpBase, wsUrl }
}

export function normalizeWsUrl(address: string): string {
  return resolveServerUrls(address).wsUrl
}

export function loadServers(storage?: StorageLike | null): ServerEntry[] {
  const store = storage ?? fallbackStorage()
  const official = getOfficialServer()
  try {
    const raw = store.getItem(SERVERS_STORAGE_KEY)
    if (!raw) return [official]
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [official]
    const custom = parsed
      .filter((item): item is ServerEntry => (
        item &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        item.id !== OFFICIAL_SERVER_ID &&
        typeof item.name === 'string' &&
        typeof item.address === 'string'
      ))
      .map((item) => ({
        id: item.id,
        name: item.name.trim(),
        address: item.address.trim(),
        official: false,
      }))
    return [official, ...custom]
  } catch {
    return [official]
  }
}

export function saveServers(servers: ServerEntry[], storage?: StorageLike | null): void {
  const store = storage ?? fallbackStorage()
  const customOnly = servers
    .filter((s) => s.id !== OFFICIAL_SERVER_ID && !s.official)
    .map((s) => ({
      id: s.id,
      name: s.name.trim(),
      address: s.address.trim(),
    }))
  store.setItem(SERVERS_STORAGE_KEY, JSON.stringify(customOnly))
}

export function addServer(entry: { name: string; address: string }, storage?: StorageLike | null): ServerEntry {
  const current = loadServers(storage)
  const id = `srv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const newServer: ServerEntry = {
    id,
    name: entry.name.trim() || t('screens.serverList.customTag'),
    address: entry.address.trim(),
    official: false,
  }
  current.push(newServer)
  saveServers(current, storage)
  return newServer
}

export function updateServer(
  id: string,
  updates: { name?: string; address?: string },
  storage?: StorageLike | null,
): boolean {
  if (id === OFFICIAL_SERVER_ID) return false
  const current = loadServers(storage)
  const idx = current.findIndex((s) => s.id === id)
  if (idx < 0) return false
  if (updates.name !== undefined) current[idx].name = updates.name.trim()
  if (updates.address !== undefined) current[idx].address = updates.address.trim()
  saveServers(current, storage)
  return true
}

export function deleteServer(id: string, storage?: StorageLike | null): boolean {
  if (id === OFFICIAL_SERVER_ID) return false
  const current = loadServers(storage)
  const next = current.filter((s) => s.id !== id)
  if (next.length === current.length) return false
  saveServers(next, storage)
  return true
}

export async function probeServer(
  server: ServerEntry | string,
  timeoutMs = 4000,
): Promise<ServerProbeResult> {
  const addr = typeof server === 'string' ? server : server.address
  const urls = resolveServerUrls(addr)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = performance.now()
  try {
    const res = await fetch(`${urls.httpBase}/api/status`, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    })
    const rtt = Math.max(1, Math.round(performance.now() - start))
    if (!res.ok) {
      return {
        online: false,
        rtt: -1,
        players: 0,
        compatible: false,
        error: `HTTP ${res.status}`,
      }
    }
    const rawJson: unknown = await res.json()
    const statusPayload = typeof rawJson === 'object' && rawJson !== null ? rawJson : null
    const protocolVersion = statusPayload && 'protocolVersion' in statusPayload && typeof statusPayload.protocolVersion === 'number'
      ? statusPayload.protocolVersion
      : undefined
    const version = statusPayload && 'version' in statusPayload && typeof statusPayload.version === 'string'
      ? statusPayload.version
      : undefined
    const onlineCount = statusPayload && 'online' in statusPayload && typeof statusPayload.online === 'number'
      ? statusPayload.online
      : 0
    const serverName = statusPayload && 'name' in statusPayload && typeof statusPayload.name === 'string'
      ? statusPayload.name
      : undefined
    const clientProtocol = CONTENT.config.net.protocolVersion
    const compatible = protocolVersion === clientProtocol
    return {
      online: true,
      rtt,
      players: onlineCount,
      version,
      protocolVersion,
      compatible,
      name: serverName,
    }
  } catch (err) {
    return {
      online: false,
      rtt: -1,
      players: 0,
      compatible: false,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}
