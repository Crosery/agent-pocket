import type { Creature, SaveData, Settings, World } from '../../shared/types.ts'
import type { SaveManager } from '../contracts.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import type { Content } from '../../shared/content/index.ts'
import { preUnlockedIds } from '../../shared/world/anchors.ts'
import { hashString } from '../../shared/rng.ts'
import { decodeSaveCode, encodeSaveCode } from './save-codec.ts'
import { migrateSave } from './save-migrate.ts'
import { playableAvatars, sanitizeName, sanitizeSaveData, sanitizeSettings, worldSpawn } from './save-sanitize.ts'
import type { SanitizeContext } from './save-sanitize.ts'
import { defaultBuildWorld, defaultSanitizeCreature } from './shared-deps.ts'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface SaveDeps {
  /** Generated world (or a lazy provider). Defaults to building it once on first need. */
  world?: World | (() => World | null) | null
  /** Creature validator; defaults to src/shared/creature.ts sanitizeCreature. */
  sanitizeCreature?: (raw: unknown) => Creature | null
  /** Defaults to window.localStorage, else an in-memory store. */
  storage?: StorageLike | null
  now?: () => number
  newId?: () => string
  content?: Content
}

export function createSaveManager(deps: SaveDeps = {}): SaveManager {
  const c = deps.content ?? CONTENT
  const storage = deps.storage ?? defaultStorage()
  const now = deps.now ?? (() => Date.now())
  const newId = deps.newId ?? randomId
  const sanitizeCreature = deps.sanitizeCreature ?? ((raw: unknown) => defaultSanitizeCreature(raw, c))

  let worldCache: World | null | undefined
  const world = (): World | null => {
    if (worldCache !== undefined) return worldCache
    const w = deps.world
    if (typeof w === 'function') return w() ?? null
    if (w !== undefined) return (worldCache = w)
    try { worldCache = defaultBuildWorld() } catch (err) { console.error(err); worldCache = null }
    return worldCache
  }

  const ctx = (): SanitizeContext => ({
    content: c, world: world(), sanitizeCreature, defaultName: t('audio.save.defaultName', undefined, c), now, newId,
  })
  const key = (slot = 0) => `${c.config.save.storagePrefix}${slot}`
  const sanitize = (raw: unknown): SaveData | null => sanitizeSaveData(raw, ctx())

  return {
    hasSave(slot = 0) {
      try { return storage.getItem(key(slot)) !== null } catch { return false }
    },
    load(slot = 0) {
      let text: string | null
      try { text = storage.getItem(key(slot)) } catch { return null }
      if (text === null) return null
      try { return sanitize(migrateSave(JSON.parse(text), c)) } catch { return null }
    },
    write(save: SaveData, slot = 0) {
      try {
        storage.setItem(key(slot), JSON.stringify(save))
        return true
      } catch {
        return false
      }
    },
    newGame(opts) {
      const avatars = playableAvatars(c)
      const w = world()
      const spawn = worldSpawn(w)
      const bag: Record<string, number> = {}
      for (const [id, qty] of Object.entries(c.config.economy.startItems)) {
        if (c.items[id] && Number.isFinite(qty) && qty > 0) bag[id] = Math.floor(qty)
      }
      const playerId = newId()
      return {
        version: c.config.save.version,
        playerId,
        name: sanitizeName(opts.name, c, t('audio.save.defaultName', undefined, c)),
        avatar: avatars.includes(opts.avatar) ? opts.avatar : avatars[0] ?? '',
        createdAt: now(),
        playTimeSec: 0,
        money: c.config.economy.startMoney,
        badges: [],
        party: [],
        boxes: Array.from({ length: c.config.party.boxCount }, () => []),
        bag,
        dexSeen: [],
        dexCaught: [],
        position: { ...spawn },
        respawn: { ...spawn },
        flags: {},
        quests: {},
        visitedTowns: [],
        exploredChunks: {},
        repelSteps: 0,
        clockMinutes: c.config.time.startMinutes,
        stats: { battlesWon: 0, caught: 0, steps: 0, pvpWins: 0, pvpLosses: 0, trades: 0, shiniesFound: 0 },
        settings: sanitizeSettings(c.config.defaultSettings, c),
        anchors: { unlocked: w ? preUnlockedIds(w) : [], seen: w ? preUnlockedIds(w) : [] },
        rollSeed: hashString(playerId) >>> 0,
        instances: {},
      }
    },
    exportCode(save: SaveData) {
      return encodeSaveCode(save, c.config.save.version)
    },
    importCode(code: string) {
      const decoded = decodeSaveCode(code)
      return decoded ? sanitize(migrateSave(decoded.data, c)) : null
    },
    defaultSettings(): Settings {
      return sanitizeSettings(c.config.defaultSettings, c)
    },
    sanitize,
  }
}

function randomId(): string {
  const cr = (globalThis as { crypto?: Crypto }).crypto
  if (cr && typeof cr.randomUUID === 'function') return cr.randomUUID()
  let s = ''
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

function defaultStorage(): StorageLike {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage
    if (ls) {
      const probe = '__ap_probe__'
      ls.setItem(probe, '1')
      ls.removeItem(probe)
      return ls
    }
  } catch { /* private mode / disabled storage: fall through to memory */ }
  const mem = new Map<string, string>()
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => { mem.set(k, v) },
    removeItem: (k) => { mem.delete(k) },
  }
}
