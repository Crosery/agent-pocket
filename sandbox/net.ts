// Browser smoke test for src/client/net: two clients on one page, B walks, A renders B interpolated.
import { createNetClient } from '../src/client/net/index.ts'
import { createEventBus } from '../src/client/core/events.ts'
import type { GameEvents } from '../src/client/contracts.ts'
import type { ClientMsg } from '../src/shared/protocol.ts'
import { CONTENT } from '../src/shared/content/index.ts'

const MAP = 'sandbox-map'
const hello = (name: string, x: number) => (): Extract<ClientMsg, { t: 'hello' }> => ({
  t: 'hello', v: CONTENT.config.net.protocolVersion, playerId: crypto.randomUUID(), name, avatar: '', map: MAP, x, y: 5, facing: 'down', lead: null,
  profile: { id: '', name, avatar: '', badges: [], dexCaught: 1, party: [], pvpWins: 0, pvpLosses: 0, playTimeSec: 0 },
})

const evA = createEventBus<GameEvents>()
const evB = createEventBus<GameEvents>()
const a = createNetClient(evA, hello('小A', 5))
const b = createNetClient(evB, hello('小B', 6))
const chat: string[] = []
evA.on('chat:message', (m) => { chat.push(`[${m.channel}] ${m.name}: ${m.text}`) })
a.connect()
b.connect()

let bx = 6
let sentChat = false
setInterval(() => {
  if (b.status === 'online') {
    bx = bx >= 12 ? 6 : bx + 0.05
    b.reportPosition({ map: MAP, x: bx, y: 5, facing: 'right', moving: true, running: false })
    if (!sentChat) { sentChat = true; b.send({ t: 'chat', channel: 'global', text: '你好，智灵口袋！<b>tag</b>' }) }
  }
  if (a.status === 'online') a.reportPosition({ map: MAP, x: 5, y: 5, facing: 'down', moving: false, running: false })
}, 16)

const fmt = (n: number) => n.toFixed(2)
setInterval(() => {
  const remotes = [...a.remotePlayers().values()].map((p) => `${p.name} x=${fmt(p.x)} rx=${fmt(p.rx)} moving=${p.moving}`)
  document.getElementById('a')!.textContent = `status=${a.status} self=${a.selfId?.slice(0, 8)} online=${a.online} rtt=${fmt(a.rtt)}ms\nmotd=${a.motd}\nremotes:\n  ${remotes.join('\n  ') || '-'}`
  document.getElementById('b')!.textContent = `status=${b.status} self=${b.selfId?.slice(0, 8)} bx=${fmt(bx)}`
  document.getElementById('chat')!.textContent = chat.join('\n') || '-'
}, 50)
