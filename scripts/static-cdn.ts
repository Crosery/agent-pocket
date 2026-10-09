// Qiniu static CDN for the layout in scripts/static-cdn-base.ts.
//   node scripts/static-cdn.ts mint-token --env-file <file>   owner only: prints an insert-only, prefix-scoped upload token
//   node scripts/static-cdn.ts upload                          CI: uploads dist/ (bundles) and public/ under content-addressed keys
//   node scripts/static-cdn.ts verify                          CI: HEADs keys through the CDN (200, size, CORS): every key uploaded
//                                                              by this run's upload, plus a sample of the unchanged public set
// CI needs STATIC_CDN_BASE and STATIC_CDN_UPLOAD_TOKEN. The token can never overwrite or delete anything.
import { createHmac } from 'node:crypto'
import { setDefaultResultOrder } from 'node:dns'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { CDN, cdnBase, listFiles, publicHash } from './static-cdn-base.ts'

// GitHub-hosted runners have no IPv6 route while the CDN publishes AAAA records.
setDefaultResultOrder('ipv4first')

const DIST = 'dist'
const PUBLIC = 'public'
const ORIGIN_ONLY = new Set(['index.html', 'release.json'])
const MARKER = '.complete'
// upload -> verify handoff (same CI step): which public keys this run actually uploaded.
const UPLOADED = join(tmpdir(), 'ap-static-cdn-uploaded.json')

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

async function pool<T>(items: T[], fn: (x: T) => Promise<void>, width: number = CDN.concurrency): Promise<void> {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => { while (i < items.length) await fn(items[i++]) }))
}

function token(): string {
  const t = process.env.STATIC_CDN_UPLOAD_TOKEN ?? die('STATIC_CDN_UPLOAD_TOKEN is not set')
  const policy = JSON.parse(Buffer.from(t.split(':')[2] ?? '', 'base64url').toString()) as { deadline: number; scope: string }
  if (policy.scope !== `${CDN.bucket}:${CDN.prefix}`) die(`token scope ${policy.scope} does not match deploy/cdn.json`)
  const hoursLeft = (policy.deadline - Date.now() / 1000) / 3600
  if (hoursLeft < CDN.tokenMinRemainingHours) die(`upload token expires in ${hoursLeft.toFixed(1)} h; mint a new one`)
  return t
}

// CI runners upload to Qiniu z2 at tens of KB/s: a flat limit aborted the 1.7 MB main bundle (v0.2.0-rc.2), so the
// limit grows with the file size.
const uploadTimeout = (bytes: number) => CDN.uploadTimeoutMs + Math.ceil((bytes / CDN.uploadMinBytesPerSec) * 1000)

async function put(tok: string, it: { key: string; body: Buffer; type: string }): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData()
    form.set('token', tok)
    form.set('key', it.key)
    form.set('file', new Blob([new Uint8Array(it.body)], { type: it.type }), it.key.split('/').pop())
    const res = await fetch(CDN.uploadUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(uploadTimeout(it.body.length)) }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }))
    if (res.ok) return
    if (res.status === 614) return // key exists: content-addressed, so it is already the same bytes
    if (attempt >= 2 || (res.status > 0 && res.status < 500)) die(`upload ${it.key} failed: ${res.status} ${await res.text()}`)
  }
}

const mime = (f: string) => (CDN.mime as Record<string, string>)[extname(f).toLowerCase()] ?? 'application/octet-stream'

async function head(url: string): Promise<{ ok: boolean; status: number; headers: Headers }> {
  // CI runners reach the CDN over a lossy path: retry network errors and 5xx with backoff. Without a per-request
  // timeout one stalled connection hung verify until the 30-minute job limit (v0.2.0-rc.1).
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { method: 'HEAD', headers: { Origin: 'https://cdn-check.invalid', 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(CDN.verifyTimeoutMs) })
      if (res.status < 500 || attempt >= CDN.verifyRetries) return res
    } catch (e) {
      if (attempt >= CDN.verifyRetries) return { ok: false, status: 0, headers: new Headers({ 'x-error': String((e as Error).cause ?? e) }) }
    }
    await new Promise((r) => setTimeout(r, CDN.verifyBackoffMs * 2 ** attempt))
  }
}

async function upload(): Promise<void> {
  const tok = token()
  const p = plan()
  const pubDone = (await head(cdnUrl(p.marker))).ok
  const items = [...p.bundles, ...(pubDone ? [] : p.pub)]
  await pool(items, (it) => put(tok, { key: it.key, body: readFileSync(it.file), type: mime(it.file) }))
  if (!pubDone) await put(tok, { key: p.marker, body: Buffer.from(`${p.hash}\n`), type: 'text/plain' })
  writeFileSync(UPLOADED, JSON.stringify({ hash: p.hash, pub: !pubDone }))
  console.log(`static-cdn: uploaded ${items.length} files (public ${p.hash} ${pubDone ? 'already on CDN' : 'uploaded'})`)
}

async function verify(): Promise<void> {
  const p = plan()
  // An unchanged public set was uploaded and verified by an earlier release under the same content hash and is never
  // overwritten, so re-HEADing all ~860 keys from a US runner only adds cross-border timeouts (v0.2.0-rc.6). Sample it.
  const handoff = existsSync(UPLOADED) ? (JSON.parse(readFileSync(UPLOADED, 'utf8')) as { hash: string; pub: boolean }) : null
  const pubFull = !handoff || handoff.hash !== p.hash || handoff.pub
  const step = Math.max(1, Math.floor(p.pub.length / CDN.verifySample))
  const pub = pubFull ? p.pub : p.pub.filter((_, i) => i % step === 0).slice(0, CDN.verifySample)
  const all = [...p.bundles, ...pub]
  console.log(`static-cdn: verifying ${p.bundles.length} bundle keys + ${pub.length}/${p.pub.length} public keys (${pubFull ? 'full' : 'sample, public set unchanged'})`)
  // status 0 = the runner could not reach the CDN at all (connect reset / timeout), not a CDN answer. Those keys get slower
  // re-check rounds; only real answers (404, wrong size, missing CORS) or keys still unreachable after every round fail.
  const check = async (items: typeof all, width: number, log: boolean): Promise<{ bad: string[]; unreachable: typeof all }> => {
    const bad: string[] = []
    const unreachable: typeof all = []
    let done = 0
    await pool(items, async (it) => {
      const res = await head(cdnUrl(it.key))
      if (log && (++done % 100 === 0 || done === items.length)) console.log(`static-cdn: verified ${done}/${items.length}`)
      const size = readFileSync(it.file).length
      if (res.status === 0) unreachable.push(it)
      else if (!res.ok) bad.push(`${res.status} ${it.key}`)
      else if (Number(res.headers.get('content-length')) !== size) bad.push(`size ${res.headers.get('content-length')} != ${size} ${it.key}`)
      else if (!res.headers.get('access-control-allow-origin')) bad.push(`no CORS ${it.key}`)
    }, width)
    return { bad, unreachable }
  }
  let { bad, unreachable } = await check(all, CDN.verifyConcurrency, true)
  for (let round = 1; unreachable.length && round <= CDN.verifyRecheckRounds; round++) {
    console.log(`static-cdn: ${unreachable.length} keys unreachable, re-check round ${round} in ${CDN.verifyRecheckDelayMs} ms`)
    await new Promise((r) => setTimeout(r, CDN.verifyRecheckDelayMs))
    const next = await check(unreachable, CDN.verifyRecheckConcurrency, false)
    bad = [...bad, ...next.bad]
    unreachable = next.unreachable
  }
  bad = [...bad, ...unreachable.map((it) => `0 ${it.key} (unreachable after ${CDN.verifyRecheckRounds} re-check rounds)`)]
  if (bad.length) die(`verify failed for ${bad.length} keys:\n${bad.slice(0, 20).join('\n')}`)
  console.log(`static-cdn: verified ${all.length} keys via ${p.base}`)
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
