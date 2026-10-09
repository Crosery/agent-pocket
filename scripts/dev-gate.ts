// Developer-tooling gate (ADR 0002 §5), shared by vite.config.ts, scripts/check-dev-gate.mjs and the tests.
// Needles live in content/dev/gate.json; they are regular expressions matched against the built text files.
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import gate from '../content/dev/gate.json' with { type: 'json' }

export interface GateConfig {
  sentinel: string
  prodForbidden: string[]
  devtoolsRequired: string[]
}

export const GATE: GateConfig = gate

/** The dev server and `vite build --mode devtools` carry the tooling; a plain `vite build` does not. */
export function devtoolsBuild(command: string, mode: string): boolean {
  return command === 'serve' || mode === 'devtools'
}

const TEXT_EXT = new Set(['.js', '.mjs', '.css', '.html', '.json', '.map', '.txt', '.svg'])

/** Text files under dir as posix paths relative to dir (binary assets are skipped). */
export function bundleTextFiles(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...bundleTextFiles(dir, p))
    else if (e.isFile() && TEXT_EXT.has(extname(e.name))) out.push(p)
  }
  return out.sort()
}

export interface Hit { pattern: string; file: string; sample: string }

/** Every (pattern, file) pair where the pattern occurs, with a short excerpt. */
export function scanBundle(dir: string, patterns: readonly string[]): Hit[] {
  const regs = patterns.map((p) => ({ p, re: new RegExp(p) }))
  const hits: Hit[] = []
  for (const file of bundleTextFiles(dir)) {
    const text = readFileSync(join(dir, file), 'utf8')
    for (const { p, re } of regs) {
      const m = re.exec(text)
      if (m) hits.push({ pattern: p, file, sample: text.slice(Math.max(0, m.index - 24), m.index + m[0].length + 24).replace(/\s+/g, ' ') })
    }
  }
  return hits
}

/** Production build: none of the forbidden needles may occur anywhere. */
export function productionProblems(dir: string, cfg: GateConfig = GATE): string[] {
  return scanBundle(dir, cfg.prodForbidden).map((h) => `${dir}: ${h.file} contains /${h.pattern}/ ... ${h.sample}`)
}

/** Devtools build: every required needle must occur (guards against the production check passing vacuously). */
export function devtoolsProblems(dir: string, cfg: GateConfig = GATE): string[] {
  const found = new Set(scanBundle(dir, cfg.devtoolsRequired).map((h) => h.pattern))
  return cfg.devtoolsRequired.filter((p) => !found.has(p)).map((p) => `${dir}: devtools build lacks /${p}/`)
}
