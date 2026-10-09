// The editor's side of the write-back endpoint (scripts/dev-api.ts): same-origin fetches carrying the per-boot token
// that the Vite plugin put into the page.
import type { PatchOp } from '../../../shared/dev/editor.ts'
import type { WriteResult } from './session.ts'
import { EDITOR } from './config.ts'

const token = (): string => document.querySelector<HTMLMetaElement>(`meta[name="${EDITOR.endpoint.tokenMeta}"]`)?.content ?? ''

const headers = (): Record<string, string> => ({ 'content-type': 'application/json', [EDITOR.endpoint.tokenHeader]: token() })

export async function fetchHash(file: string): Promise<string> {
  const res = await fetch(`${EDITOR.endpoint.path}?file=${encodeURIComponent(file)}`, { headers: headers(), cache: 'no-store' })
  const body = (await res.json().catch(() => ({}))) as { hash?: string; error?: string }
  if (!res.ok || !body.hash) throw new Error(body.error ?? String(res.status))
  return body.hash
}

export async function writeBack(file: string, baseHash: string, ops: PatchOp[]): Promise<WriteResult> {
  try {
    const res = await fetch(EDITOR.endpoint.path, { method: 'POST', headers: headers(), body: JSON.stringify({ file, baseHash, ops }) })
    const body = (await res.json().catch(() => ({}))) as { hash?: string; error?: string; problems?: string[] }
    if (res.ok && body.hash) return { ok: true, hash: body.hash }
    return { ok: false, status: res.status, error: body.error ?? String(res.status), ...(body.problems ? { problems: body.problems } : {}) }
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message }
  }
}
