// Qiniu static CDN for the layout in scripts/static-cdn-base.ts.
//   node scripts/static-cdn.ts mint-token --env-file <file>   owner only: prints an insert-only, prefix-scoped upload token
//   node scripts/static-cdn.ts upload                          CI: uploads dist/ (bundles) and public/ under content-addressed keys
//   node scripts/static-cdn.ts verify                          CI: HEADs every key through the CDN (200, size, CORS)
// CI needs STATIC_CDN_BASE and STATIC_CDN_UPLOAD_TOKEN. The token can never overwrite or delete anything.
import { createHmac } from 'node:crypto'
import { setDefaultResultOrder } from 'node:dns'
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { CDN, cdnBase, listFiles, publicHash } from './static-cdn-base.ts'

// GitHub-hosted runners have no IPv6 route while the CDN publishes AAAA records.
setDefaultResultOrder('ipv4first')

const DIST = 'dist'
const PUBLIC = 'public'
const ORIGIN_ONLY = new Set(['index.html', 'release.json'])
const MARKER = '.complete'

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
const die = (msg: string): never => { console.error(`static-cdn: ${msg}`); process.exit(1) }

type Item = { key: string; file: string }

function plan(): { base: string; hash: string; bundles: Item[]; pub: Item[]; marker: string } {
  const base = cdnBase() ?? die('STATIC_CDN_BASE is not set')
  const hash = publicHash(PUBLIC)
  const pubFiles = listFiles(PUBLIC)
  const pubSet = new Set(pubFiles)
  const bundles = listFiles(DIST).filter((f) => !pubSet.has(f) && !ORIGIN_ONLY.has(f)).map((f) => ({ key: `${CDN.prefix}${f}`, file: join(DIST, f) }))
  const pubPrefix = `${CDN.prefix}${CDN.publicDir}${hash}/`
  const pub = pubFiles.map((f) => ({ key: `${pubPrefix}${f}`, file: join(PUBLIC, f) }))
  return { base, hash, bundles, pub, marker: `${pubPrefix}${MARKER}` }
}

const cdnUrl = (key: string) => `${CDN.origin}/${key.split('/').map(encodeURIComponent).join('/')}`

async function pool<T>(items: T[], fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(CDN.concurrency, items.length) }, async () => { while (i < items.length) await fn(items[i++]) }))
}

function token(): string {
  const t = process.env.STATIC_CDN_UPLOAD_TOKEN ?? die('STATIC_CDN_UPLOAD_TOKEN is not set')
  const policy = JSON.parse(Buffer.from(t.split(':')[2] ?? '', 'base64url').toString()) as { deadline: number; scope: string }
  if (policy.scope !== `${CDN.bucket}:${CDN.prefix}`) die(`token scope ${policy.scope} does not match deploy/cdn.json`)
  const hoursLeft = (policy.deadline - Date.now() / 1000) / 3600
  if (hoursLeft < CDN.tokenMinRemainingHours) die(`upload token expires in ${hoursLeft.toFixed(1)} h; mint a new one`)
  return t
}

async function put(tok: string, it: { key: string; body: Buffer; type: string }): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData()
    form.set('token', tok)
    form.set('key', it.key)
    form.set('file', new Blob([new Uint8Array(it.body)], { type: it.type }), it.key.split('/').pop())
    const res = await fetch(CDN.uploadUrl, { method: 'POST', body: form }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }))
    if (res.ok) return
    if (res.status === 614) return // key exists: content-addressed, so it is already the same bytes
    if (attempt >= 2 || (res.status > 0 && res.status < 500)) die(`upload ${it.key} failed: ${res.status} ${await res.text()}`)
  }
}

const mime = (f: string) => (CDN.mime as Record<string, string>)[extname(f).toLowerCase()] ?? 'application/octet-stream'

async function head(url: string): Promise<{ ok: boolean; status: number; headers: Headers }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, { method: 'HEAD', headers: { Origin: 'https://cdn-check.invalid', 'Accept-Encoding': 'identity' } })
    } catch (e) {
      if (attempt >= 2) return { ok: false, status: 0, headers: new Headers({ 'x-error': (e as Error).message }) }
    }
  }
}

async function upload(): Promise<void> {
  const tok = token()
  const p = plan()
  const pubDone = (await head(cdnUrl(p.marker))).ok
  const items = [...p.bundles, ...(pubDone ? [] : p.pub)]
  await pool(items, (it) => put(tok, { key: it.key, body: readFileSync(it.file), type: mime(it.file) }))
  if (!pubDone) await put(tok, { key: p.marker, body: Buffer.from(`${p.hash}\n`), type: 'text/plain' })
  console.log(`static-cdn: uploaded ${items.length} files (public ${p.hash} ${pubDone ? 'already on CDN' : 'uploaded'})`)
}

async function verify(): Promise<void> {
  const p = plan()
  const bad: string[] = []
  await pool([...p.bundles, ...p.pub], async (it) => {
    const res = await head(cdnUrl(it.key))
    const size = readFileSync(it.file).length
    if (!res.ok) bad.push(`${res.status} ${it.key}`)
    else if (Number(res.headers.get('content-length')) !== size) bad.push(`size ${res.headers.get('content-length')} != ${size} ${it.key}`)
    else if (!res.headers.get('access-control-allow-origin')) bad.push(`no CORS ${it.key}`)
  })
  if (bad.length) die(`verify failed for ${bad.length} keys:\n${bad.slice(0, 20).join('\n')}`)
  console.log(`static-cdn: verified ${p.bundles.length + p.pub.length} keys via ${p.base}`)
}

function mintToken(args: string[]): void {
  const envFile = args[args.indexOf('--env-file') + 1] ?? die('--env-file <file> is required')
  const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').map((l) => /^\s*([A-Z0-9_]+)\s*=\s*['"]?(.*?)['"]?\s*$/.exec(l)).filter((m) => m !== null).map((m) => [m[1], m[2]]))
  const ak = env.QINIU_ACCESS_KEY ?? die('QINIU_ACCESS_KEY missing in env file')
  const sk = env.QINIU_SECRET_KEY ?? die('QINIU_SECRET_KEY missing in env file')
  if (env.QINIU_BUCKET && env.QINIU_BUCKET !== CDN.bucket) die(`env file bucket ${env.QINIU_BUCKET} != ${CDN.bucket}`)
  const policy = {
    scope: `${CDN.bucket}:${CDN.prefix}`,
    isPrefixalScope: 1,
    insertOnly: 1,
    fsizeLimit: CDN.fsizeLimit,
    deadline: Math.floor(Date.now() / 1000) + CDN.tokenDays * 86400,
  }
  const encoded = b64url(JSON.stringify(policy))
  process.stdout.write(`${ak}:${b64url(createHmac('sha1', sk).update(encoded).digest())}:${encoded}`)
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'mint-token') mintToken(rest)
else if (cmd === 'upload') await upload()
else if (cmd === 'verify') await verify()
else die('usage: static-cdn.ts mint-token --env-file <file> | upload | verify')
