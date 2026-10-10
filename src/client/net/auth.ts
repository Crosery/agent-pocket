// Client authentication and account binding HTTP API.
import type { SaveData } from '../../shared/types.ts'
import { t } from '../../shared/content/index.ts'
import { NET_CLIENT } from './config.ts'

export interface AccountInfo {
  id: string
  username: string
}

export interface AccountSessionResult {
  account: AccountInfo
  save: SaveData | null
  imported?: boolean
}

export interface AuthCredentials {
  username: string
  password: string
}

export function getAuthLimits() {
  if (!NET_CLIENT.auth) throw new Error('missing auth limits in net config')
  return NET_CLIENT.auth
}

export function validateUsername(username: string): string | null {
  const limits = getAuthLimits()
  const trimmed = username.trim()
  if (trimmed.length < limits.usernameMinLen || trimmed.length > limits.usernameMaxLen) {
    return t('screens.auth.errors.usernameLength')
  }
  return null
}

export function validatePassword(password: string): string | null {
  const limits = getAuthLimits()
  if (password.length < limits.passwordMinLen || password.length > limits.passwordMaxLen) {
    return t('screens.auth.errors.passwordLength')
  }
  return null
}

function parseErrorMessage(data: unknown, fallback: string): string {
  if (typeof data === 'object' && data !== null && 'error' in data) {
    const code = typeof data.error === 'string' ? data.error : ''
    if (code === 'invalid_credentials') return t('screens.auth.errors.invalidCredentials')
    if (code === 'username_taken') return t('screens.auth.errors.usernameTaken')
    if (code === 'rate_limited') return t('screens.auth.errors.rateLimited')
    if (code === 'already_bound') return t('screens.auth.errors.alreadyBound')
    if (code === 'unauthorized') return t('screens.auth.errors.unauthorized')
    if ('message' in data && typeof data.message === 'string' && data.message.length > 0) return data.message
  }
  return fallback
}

function parseSessionPayload(data: unknown): AccountSessionResult | null {
  if (typeof data !== 'object' || data === null) return null
  if (!('account' in data) || typeof data.account !== 'object' || data.account === null) return null
  const acc = data.account
  if (!('id' in acc) || typeof acc.id !== 'string') return null
  if (!('username' in acc) || typeof acc.username !== 'string') return null
  const account: AccountInfo = { id: acc.id, username: acc.username }
  const save = 'save' in data && typeof data.save === 'object' && data.save !== null ? (data.save as SaveData) : null
  const imported = 'imported' in data && typeof data.imported === 'boolean' ? data.imported : undefined
  return { account, save, imported }
}

export async function getAccountSession(httpBase: string): Promise<AccountSessionResult | null> {
  const res = await fetch(`${httpBase}/api/account`, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
  })
  if (res.status === 401) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const raw: unknown = await res.json()
  const result = parseSessionPayload(raw)
  if (!result) throw new Error(t('screens.auth.errors.network'))
  return result
}

export async function loginAccount(httpBase: string, creds: AuthCredentials): Promise<AccountSessionResult> {
  const uErr = validateUsername(creds.username)
  if (uErr) throw new Error(uErr)
  const pErr = validatePassword(creds.password)
  if (pErr) throw new Error(pErr)

  let res: Response
  try {
    res = await fetch(`${httpBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: creds.username.trim(), password: creds.password }),
      credentials: 'include',
    })
  } catch {
    throw new Error(t('screens.auth.errors.network'))
  }

  const raw: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(parseErrorMessage(raw, t('screens.auth.errors.invalidCredentials')))
  }
  const result = parseSessionPayload(raw)
  if (!result) throw new Error(t('screens.auth.errors.network'))
  return result
}

export async function registerAccount(httpBase: string, creds: AuthCredentials): Promise<AccountSessionResult> {
  const uErr = validateUsername(creds.username)
  if (uErr) throw new Error(uErr)
  const pErr = validatePassword(creds.password)
  if (pErr) throw new Error(pErr)

  let res: Response
  try {
    res = await fetch(`${httpBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: creds.username.trim(), password: creds.password }),
      credentials: 'include',
    })
  } catch {
    throw new Error(t('screens.auth.errors.network'))
  }

  const raw: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(parseErrorMessage(raw, t('screens.auth.errors.usernameTaken')))
  }
  const result = parseSessionPayload(raw)
  if (!result) throw new Error(t('screens.auth.errors.network'))
  return result
}

export async function logoutAccount(httpBase: string): Promise<void> {
  try {
    await fetch(`${httpBase}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    })
  } catch {
    // best-effort
  }
}

export async function bindAccountSave(
  httpBase: string,
  payload: { save: SaveData; imported: boolean },
): Promise<AccountSessionResult> {
  let res: Response
  try {
    res = await fetch(`${httpBase}/api/account/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'include',
    })
  } catch {
    throw new Error(t('screens.auth.errors.network'))
  }

  const raw: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(parseErrorMessage(raw, t('screens.auth.errors.alreadyBound')))
  }
  const result = parseSessionPayload(raw)
  if (!result) throw new Error(t('screens.auth.errors.network'))
  return result
}
