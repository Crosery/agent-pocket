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
export const OFFICIAL_SERVER_ID = 'official'

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

export interface SanitizedServerAddress {
  ok: true
  address: string
  httpBase: string
  wsUrl: string
}

export interface SanitizeServerError {
  ok: false
  error: string
}

export function sanitizeServerAddress(input: string): SanitizedServerAddress | SanitizeServerError {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, error: t('screens.serverList.addDialog.addrRequired') }

  if (/^(javascript|data|file|blob|vbscript):/i.test(trimmed)) {
    return { ok: false, error: t('screens.serverList.invalidUrl') }
  }
  if (trimmed.includes('@')) {
    return { ok: false, error: t('screens.serverList.invalidUrl') }
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    return { ok: false, error: t('screens.serverList.invalidUrl') }
  }
  if (trimmed.includes('..') || trimmed.includes('\\')) {
    return { ok: false, error: t('screens.serverList.invalidUrl') }
  }

  let fullUrl = trimmed
  if (!/^[a-z]+:\/\//i.test(fullUrl)) {
    const authority = fullUrl.split('/')[0]
    const isLocal = /^localhost(:\d+)?$/i.test(authority) ||
      /^(127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])(:\d+)?$/.test(authority)
    fullUrl = `${isLocal ? 'http' : 'https'}://${fullUrl}`
  }

  try {
    const u = new URL(fullUrl)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) {
      return { ok: false, error: t('screens.serverList.invalidUrl') }
    }
    if (u.username || u.password) {
      return { ok: false, error: t('screens.serverList.invalidUrl') }
    }
    const p = u.pathname
    if (p !== '' && p !== '/' && p !== '/ws' && p !== '/ws/') {
      return { ok: false, error: t('screens.serverList.invalidUrl') }
    }
    const httpProtocol = u.protocol === 'ws:' ? 'http:' : (u.protocol === 'wss:' ? 'https:' : u.protocol)
    const wsProtocol = httpProtocol === 'https:' ? 'wss:' : 'ws:'
    const httpBase = `${httpProtocol}//${u.host}`
    const wsUrl = `${wsProtocol}//${u.host}${NET_CLIENT.protocol.wsPath}`
    return { ok: true, address: httpBase, httpBase, wsUrl }
  } catch {
    return { ok: false, error: t('screens.serverList.invalidUrl') }
  }
}

export function getOfficialServer(): ServerEntry {
  const configuredUrl = NET_CLIENT.official.url
  const configuredName = NET_CLIENT.official.name
  const browserOrigin = typeof location !== 'undefined' && typeof location.origin === 'string' && /^https?:\/\//i.test(location.origin)
    ? location.origin
    : null
  return {
    id: OFFICIAL_SERVER_ID,
    name: configuredName,
    address: browserOrigin ?? configuredUrl,
    official: true,
  }
}

export function resolveServerUrls(address: string): ResolvedServerUrls {
  const trimmed = address.trim()
  const target = !trimmed || trimmed === 'official' || trimmed === 'default'
    ? getOfficialServer().address
    : trimmed
  const sanitized = sanitizeServerAddress(target)
  if (sanitized.ok) {
    return { httpBase: sanitized.httpBase, wsUrl: sanitized.wsUrl }
  }
  throw new Error(sanitized.error)
}

export function normalizeWsUrl(address: string): string {
  return resolveServerUrls(address).wsUrl
}

export function loadServers(storage?: StorageLike | null): ServerEntry[] {
  const store = storage ?? fallbackStorage()
  const official = getOfficialServer()
  const results: ServerEntry[] = [official]

  let localEntry: ServerEntry | null = null
  if (typeof location !== 'undefined' && location.origin && location.origin !== official.address) {
    localEntry = {
      id: 'srv_local',
      name: t('screens.serverList.currentServer', { host: location.host }),
      address: location.origin,
      official: false,
    }
  }

  try {
    const raw = store.getItem(SERVERS_STORAGE_KEY)
    if (!raw) {
      if (localEntry) results.push(localEntry)
      return results
    }
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      if (localEntry) results.push(localEntry)
      return results
    }
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
    results.push(...custom)
    if (localEntry && !results.some((s) => s.id === 'srv_local' || s.address === localEntry?.address)) {
      results.splice(1, 0, localEntry)
    }
    return results
  } catch {
    if (localEntry) results.push(localEntry)
    return results
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
  const sanitized = sanitizeServerAddress(entry.address)
  if (!sanitized.ok) throw new Error(sanitized.error)
  const current = loadServers(storage)
  const id = `srv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const newServer: ServerEntry = {
    id,
    name: entry.name.trim() || t('screens.serverList.customTag'),
    address: sanitized.address,
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
  if (updates.address !== undefined) {
    const sanitized = sanitizeServerAddress(updates.address)
    if (!sanitized.ok) throw new Error(sanitized.error)
    current[idx].address = sanitized.address
  }
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
  const isOfficial = typeof server === 'object' && (server.id === OFFICIAL_SERVER_ID || !!server.official)
  const res = await probeSingleUrl(urls.httpBase, timeoutMs)
  if (!res.online && isOfficial && typeof location !== 'undefined' && typeof location.origin === 'string' && /^https?:\/\//i.test(location.origin) && urls.httpBase !== location.origin) {
    const localRes = await probeSingleUrl(location.origin, timeoutMs)
    if (localRes.online) return localRes
  }
  return res
}

async function probeSingleUrl(
  httpBase: string,
  timeoutMs: number,
): Promise<ServerProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = performance.now()
  try {
    const res = await fetch(`${httpBase}/api/status`, {
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
