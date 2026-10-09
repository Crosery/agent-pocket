// The command registry (ADR 0002 §2): one place where every developer action is defined. Schemas, titles and
// effect classes live in content/dev/console.json; the handlers are registered by id from ./commands/*.
// The panel, the command line, &cmd=, scenarios and window.__ap.v1.cmd() all end up in Registry.run().
import consoleJson from '../../../content/dev/console.json' with { type: 'json' }
import { t } from '../../shared/content/index.ts'
import type { DevHost } from './kit.ts'

export type ArgType = 'string' | 'number' | 'integer' | 'boolean' | 'json'
export type Needs = 'live' | 'rebuildWorld' | 'reload'

export interface ArgSpec {
  name: string
  type: ArgType
  optional?: boolean
  /** Name of a code-side enum list (EnumRefs); the value must be one of its entries. */
  enumRef?: string
  labelKey?: string
}

export interface CommandMeta {
  titleKey: string
  group: string
  /** Changes game state (marks the session as tainted). */
  mutates: boolean
  /** live: effective immediately · rebuildWorld: the world is rebuilt · reload: needs a page reload. */
  needs: Needs
  args: ArgSpec[]
}

export interface ConsoleFile {
  limits: {
    eventBuffer: number; logLines: number; waitTimeoutMs: number; waitPollMs: number; dumpMaxChars: number
    /** Default seconds per stepped frame, largest time scale, most frames per step command. */
    stepDt: number; maxScale: number; maxStepFrames: number
  }
  commands: Record<string, CommandMeta>
  /** Deprecated window.__ap.<name> hooks -> what to use instead (printed once per name). */
  legacy: Record<string, string>
}

export const CONSOLE: ConsoleFile = consoleJson as unknown as ConsoleFile

export type CommandArgs = Record<string, unknown>
export type CommandRun = (host: DevHost, args: CommandArgs) => unknown | Promise<unknown>
export type EnumRefs = Record<string, () => string[]>

export interface CommandInfo {
  id: string
  title: string
  group: string
  mutates: boolean
  needs: Needs
  args: { name: string; type: ArgType; optional: boolean; options?: string[] }[]
}

export interface Taint { count: number; firstAt: number | null }

export interface Registry {
  has(id: string): boolean
  /** Validates and coerces the arguments, runs the command and returns its JSON-safe result. */
  run(id: string, args?: CommandArgs): Promise<unknown>
  /** "tp.xy 100 200" or `give potion 3`: whitespace separated, "double quotes" keep spaces, args by position. */
  runLine(line: string): Promise<unknown>
  describe(): CommandInfo[]
  readonly taint: Taint
}

/** Error with a player-readable (zh-CN) message; the registry throws nothing else for bad input. */
export class DevError extends Error {
  constructor(key: string, params?: Record<string, string | number>) {
    super(t(key, params))
    this.name = 'DevError'
  }
}

export function tokenize(line: string): string[] {
  const out: string[] = []
  for (const m of line.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2])
  return out
}

function coerce(spec: ArgSpec, v: unknown, enums: EnumRefs): unknown {
  const bad = (why: string) => new DevError('dev.err.badArg', { arg: spec.name, why })
  switch (spec.type) {
    case 'number':
    case 'integer': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
      if (!Number.isFinite(n)) throw bad(t('dev.err.notNumber'))
      if (spec.type === 'integer' && !Number.isInteger(n)) throw bad(t('dev.err.notInteger'))
      return n
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v
      if (v === 'true' || v === '1' || v === 1) return true
      if (v === 'false' || v === '0' || v === 0) return false
      throw bad(t('dev.err.notBoolean'))
    }
    case 'json': {
      if (typeof v !== 'string') return v
      try { return JSON.parse(v) } catch { throw bad('JSON') }
    }
    default: {
      const s = String(v)
      const list = spec.enumRef ? enums[spec.enumRef]?.() : undefined
      if (list && !list.includes(s)) throw bad(t('dev.err.notOneOf', { list: list.join(' / ') }))
      return s
    }
  }
}

export function createRegistry(
  host: DevHost,
  impls: Record<string, CommandRun>,
  opts: { meta?: Record<string, CommandMeta>; enums?: EnumRefs; now?: () => number } = {},
): Registry {
  const meta = opts.meta ?? CONSOLE.commands
  const enums = opts.enums ?? {}
  const now = opts.now ?? Date.now
  const taint: Taint = { count: 0, firstAt: null }

  async function run(id: string, raw: CommandArgs = {}): Promise<unknown> {
    const m = meta[id]
    const impl = impls[id]
    if (!m || !impl) throw new DevError('dev.err.unknownCmd', { id })
    const args: CommandArgs = {}
    for (const spec of m.args) {
      const v = raw[spec.name]
      if (v === undefined || v === null || v === '') {
        if (!spec.optional) throw new DevError('dev.err.missingArg', { arg: spec.name })
        continue
      }
      args[spec.name] = coerce(spec, v, enums)
    }
    const extra = Object.keys(raw).filter((k) => !m.args.some((a) => a.name === k))
    if (extra.length) throw new DevError('dev.err.extraArgs', { args: extra.join(', ') })
    const result = await impl(host, args)
    if (m.mutates) { taint.count++; taint.firstAt ??= now() }
    return result === undefined ? null : JSON.parse(JSON.stringify(result))
  }

  return {
    has: (id) => !!meta[id] && !!impls[id],
    run,
    runLine(line) {
      const [id, ...rest] = tokenize(line.trim())
      if (!id) return Promise.reject(new DevError('dev.err.emptyLine'))
      const m = meta[id]
      const raw: CommandArgs = {}
      if (m) m.args.forEach((a, i) => { if (rest[i] !== undefined) raw[a.name] = rest[i] })
      if (m && rest.length > m.args.length) return Promise.reject(new DevError('dev.err.extraArgs', { args: rest.slice(m.args.length).join(' ') }))
      return run(id, raw)
    },
    describe: () => Object.entries(meta).filter(([id]) => impls[id]).map(([id, m]) => ({
      id, title: t(m.titleKey), group: m.group, mutates: m.mutates, needs: m.needs,
      args: m.args.map((a) => ({ name: a.name, type: a.type, optional: !!a.optional, ...(a.enumRef && enums[a.enumRef] ? { options: enums[a.enumRef]() } : {}) })),
    })),
    taint,
  }
}
