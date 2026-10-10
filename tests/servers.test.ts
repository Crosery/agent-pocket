import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addServer, deleteServer, loadServers, normalizeWsUrl,
  probeServer, resolveServerUrls, updateServer, OFFICIAL_SERVER_ID,
  type StorageLike,
} from '../src/client/net/servers.ts'
import { validatePassword, validateUsername, getAuthLimits } from '../src/client/net/auth.ts'
import { createEventBus } from '../src/client/core/events.ts'
import { createNetClient } from '../src/client/net/client.ts'
import type { GameEvents } from '../src/client/contracts.ts'

function createMemoryStorage(initial: Record<string, string> = {}): StorageLike {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
}

// ---------------------------------------------------------------------------
// Server list persistence & official server immutability
// ---------------------------------------------------------------------------

test('official server is always present as the first entry on fresh load', () => {
  const storage = createMemoryStorage()
  const list = loadServers(storage)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, OFFICIAL_SERVER_ID)
  assert.equal(list[0].official, true)
})

test('custom servers can be added, updated, and deleted', () => {
  const storage = createMemoryStorage()
  const s1 = addServer({ name: '测试服一', address: '127.0.0.1:8787' }, storage)
  assert.ok(s1.id.startsWith('srv_'))
  assert.equal(s1.name, '测试服一')
  assert.equal(s1.address, '127.0.0.1:8787')
  assert.equal(s1.official, false)

  let list = loadServers(storage)
  assert.equal(list.length, 2)
  assert.equal(list[0].id, OFFICIAL_SERVER_ID)
  assert.equal(list[1].id, s1.id)

  const updated = updateServer(s1.id, { name: '测试服改名', address: '192.168.1.100:8787' }, storage)
  assert.equal(updated, true)

  list = loadServers(storage)
  assert.equal(list[1].name, '测试服改名')
  assert.equal(list[1].address, '192.168.1.100:8787')

  const deleted = deleteServer(s1.id, storage)
  assert.equal(deleted, true)

  list = loadServers(storage)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, OFFICIAL_SERVER_ID)
})

test('official server is immutable and cannot be deleted or modified', () => {
  const storage = createMemoryStorage()
  const delOfficial = deleteServer(OFFICIAL_SERVER_ID, storage)
  assert.equal(delOfficial, false)

  const updateOfficial = updateServer(OFFICIAL_SERVER_ID, { name: '篡改名', address: 'evil.com' }, storage)
  assert.equal(updateOfficial, false)

  const list = loadServers(storage)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, OFFICIAL_SERVER_ID)
  assert.equal(list[0].official, true)
  assert.notEqual(list[0].name, '篡改名')
})

test('corrupted or malicious custom data in storage cannot override official server', () => {
  const fakeStore = {
    'agent-pocket/servers': JSON.stringify([
      { id: OFFICIAL_SERVER_ID, name: '伪造官方', address: 'fake.com', official: true },
      { id: 'srv_1', name: '合法自建服', address: '10.0.0.1:8787' },
    ]),
  }
  const storage = createMemoryStorage(fakeStore)
  const list = loadServers(storage)

  assert.equal(list.length, 2)
  assert.equal(list[0].id, OFFICIAL_SERVER_ID)
  assert.equal(list[0].official, true)
  assert.notEqual(list[0].name, '伪造官方')
  assert.equal(list[1].id, 'srv_1')
})

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

test('resolveServerUrls handles official and empty addresses', () => {
  const def = resolveServerUrls('')
  assert.ok(def.httpBase.startsWith('http'))
  assert.ok(def.wsUrl.includes('/ws'))

  const off = resolveServerUrls('official')
  assert.equal(off.httpBase, def.httpBase)
  assert.equal(off.wsUrl, def.wsUrl)
})

test('resolveServerUrls normalizes local IP and localhost to http and ws', () => {
  const local1 = resolveServerUrls('127.0.0.1:8787')
  assert.equal(local1.httpBase, 'http://127.0.0.1:8787')
  assert.equal(local1.wsUrl, 'ws://127.0.0.1:8787/ws')

  const local2 = resolveServerUrls('localhost:8787')
  assert.equal(local2.httpBase, 'http://localhost:8787')
  assert.equal(local2.wsUrl, 'ws://localhost:8787/ws')

  const lan = resolveServerUrls('192.168.1.50:8787/')
  assert.equal(lan.httpBase, 'http://192.168.1.50:8787')
  assert.equal(lan.wsUrl, 'ws://192.168.1.50:8787/ws')
})

test('resolveServerUrls normalizes domain names to https and wss by default', () => {
  const dom = resolveServerUrls('ap.example.com')
  assert.equal(dom.httpBase, 'https://ap.example.com')
  assert.equal(dom.wsUrl, 'wss://ap.example.com/ws')
})

test('resolveServerUrls preserves explicit protocol schemes', () => {
  const explicitHttp = resolveServerUrls('http://myclan.org:8080')
  assert.equal(explicitHttp.httpBase, 'http://myclan.org:8080')
  assert.equal(explicitHttp.wsUrl, 'ws://myclan.org:8080/ws')

  const explicitWs = resolveServerUrls('ws://127.0.0.1:8787/ws')
  assert.equal(explicitWs.httpBase, 'http://127.0.0.1:8787')
  assert.equal(explicitWs.wsUrl, 'ws://127.0.0.1:8787/ws')

  const explicitWss = resolveServerUrls('wss://secure.game.io/ws')
  assert.equal(explicitWss.httpBase, 'https://secure.game.io')
  assert.equal(explicitWss.wsUrl, 'wss://secure.game.io/ws')
})

test('normalizeWsUrl returns only the WebSocket URL', () => {
  assert.equal(normalizeWsUrl('127.0.0.1:8787'), 'ws://127.0.0.1:8787/ws')
  assert.equal(normalizeWsUrl('https://ap.crosery.com'), 'wss://ap.crosery.com/ws')
})

// ---------------------------------------------------------------------------
// Server status probing
// ---------------------------------------------------------------------------

test('probeServer reports online and compatibility when server status matches', async () => {
  const origFetch = globalThis.fetch
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/api/status')) {
        return new Response(JSON.stringify({
          protocolVersion: 1,
          version: '0.2.0',
          online: 7,
          name: '测试自建服',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(null, { status: 404 })
    }

    const res = await probeServer({ id: 'srv_1', name: '测试', address: '127.0.0.1:8787' })
    assert.equal(res.online, true)
    assert.equal(res.compatible, true)
    assert.equal(res.players, 7)
    assert.equal(res.protocolVersion, 1)
    assert.ok(res.rtt >= 0)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('probeServer reports incompatible when protocol version does not match', async () => {
  const origFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      protocolVersion: 999,
      version: '0.9.0',
      online: 3,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })

    const res = await probeServer({ id: 'srv_2', name: '新版服', address: '127.0.0.1:8787' })
    assert.equal(res.online, true)
    assert.equal(res.compatible, false)
    assert.equal(res.players, 3)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('probeServer handles network errors and offline servers gracefully', async () => {
  const origFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }

    const res = await probeServer({ id: 'srv_3', name: '离线服', address: '127.0.0.1:9999' })
    assert.equal(res.online, false)
    assert.equal(res.compatible, false)
    assert.equal(res.players, 0)
    assert.equal(res.rtt, -1)
  } finally {
    globalThis.fetch = origFetch
  }
})

// ---------------------------------------------------------------------------
// Auth input validation rules
// ---------------------------------------------------------------------------

test('validateUsername enforces min and max length bounds', () => {
  const limits = getAuthLimits()
  assert.equal(limits.usernameMinLen, 2)
  assert.equal(limits.usernameMaxLen, 16)

  assert.ok(validateUsername('a') !== null) // too short
  assert.equal(validateUsername('ab'), null) // valid
  assert.equal(validateUsername('Player_123'), null) // valid
  assert.ok(validateUsername('a'.repeat(17)) !== null) // too long
})

test('validatePassword enforces min and max length bounds', () => {
  const limits = getAuthLimits()
  assert.equal(limits.passwordMinLen, 8)
  assert.equal(limits.passwordMaxLen, 72)

  assert.ok(validatePassword('1234567') !== null) // too short
  assert.equal(validatePassword('12345678'), null) // valid
  assert.equal(validatePassword('StrongPassword!#99'), null) // valid
  assert.ok(validatePassword('p'.repeat(73)) !== null) // too long
})

// ---------------------------------------------------------------------------
// NetClient endpoint dynamic reconfiguration
// ---------------------------------------------------------------------------

test('NetClient setEndpoint changes active target endpoint', () => {
  const bus = createEventBus<GameEvents>()
  const client = createNetClient(bus, () => ({
    t: 'hello',
    v: 1,
    playerId: 'p1',
    name: 'test',
    avatar: 'red',
    map: 'home',
    x: 0,
    y: 0,
    facing: 'down',
    lead: null,
    profile: {
      party: [], pvpWins: 0, pvpLosses: 0, playTimeSec: 0,
    },
    build: { devtools: false },
  }))

  const initialEp = client.endpoint
  assert.ok(initialEp === null || (typeof initialEp === 'string' && initialEp.includes('/ws')))

  client.setEndpoint('192.168.1.10:8787')
  assert.equal(client.endpoint, 'ws://192.168.1.10:8787/ws')

  client.setEndpoint('https://play.agentpocket.cn')
  assert.equal(client.endpoint, 'wss://play.agentpocket.cn/ws')

  client.setEndpoint(null)
  const finalEp = client.endpoint
  assert.ok(finalEp === null || (typeof finalEp === 'string' && finalEp.includes('/ws')))
})
