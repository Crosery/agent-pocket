// Drops tooling-only fields from content JSON in production client bundles (content/build.json clientStrip).
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

export interface StripRule { file: string; fields: string[] }

/** Deletes `fields` from a JSON document that is an array of objects or an object of objects; returns the new text. */
export function stripFields(text: string, fields: readonly string[]): string {
  const doc = JSON.parse(text) as unknown
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    const top = doc as Record<string, unknown>
    for (const f of fields) delete top[f]
  }
  const rows = Array.isArray(doc) ? doc : doc && typeof doc === 'object' ? Object.values(doc) : []
  for (const row of rows) {
    if (row && typeof row === 'object') {
      const rec = row as Record<string, unknown>
      for (const f of fields) delete rec[f]
    }
  }
  return JSON.stringify(doc)
}

export function loadStripRules(file = new URL('../content/build.json', import.meta.url)): StripRule[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as { clientStrip: StripRule[] }).clientStrip
}

/** Build only (the dev server keeps full content so tooling still sees it). */
export function clientStripPlugin(rules: readonly StripRule[] = loadStripRules()): Plugin {
  return {
    name: 'ap-client-strip',
    enforce: 'pre',
    apply: 'build',
    transform(code, id) {
      const path = id.split('?')[0].replace(/\\/g, '/')
      if (path.endsWith('/package.json')) {
        const parsed = JSON.parse(code) as Record<string, unknown>
        const ver = typeof parsed.version === 'string' ? parsed.version : '0.0.0'
        return { code: JSON.stringify({ version: ver }), map: null }
      }
      const rule = rules.find((r) => path.endsWith(`/content/${r.file}`))
      return rule ? { code: stripFields(code, rule.fields), map: null } : null
    },
  }
}
