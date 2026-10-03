// Static CDN layout shared by vite.config.ts and scripts/static-cdn.ts.
// Every key is content-addressed, so uploads are insert-only and the CDN never needs a refresh:
//   <prefix><bundle path>                 hashed Vite output, e.g. ap/static/assets/index-AbC123.js
//   <prefix><publicDir><hash>/<path>      the whole public/ tree, keyed by a hash of its contents
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import cdn from '../deploy/cdn.json' with { type: 'json' }

export const CDN = cdn

/** Files under dir as sorted posix paths relative to dir; dotfiles are skipped. */
export function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...listFiles(dir, p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

export function publicHash(publicDir: string): string {
  const h = createHash('sha256')
  for (const f of listFiles(publicDir)) h.update(f).update('\0').update(readFileSync(join(publicDir, f))).update('\0')
  return h.digest('hex').slice(0, 12)
}

/** STATIC_CDN_BASE switches the build to the CDN; it must match deploy/cdn.json exactly. Empty = same-origin. */
export function cdnBase(env: string | undefined = process.env.STATIC_CDN_BASE): string | null {
  if (!env) return null
  const want = `${CDN.origin}/${CDN.prefix}`
  if (env !== want) throw new Error(`STATIC_CDN_BASE must be ${want} (deploy/cdn.json), got ${env}`)
  return want
}
