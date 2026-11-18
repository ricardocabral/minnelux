import { relativeKey } from '../library/catalog.ts'
import type { ConnectConfiguration } from '../library/worker-contract.ts'
import { record } from './io.ts'

const endpoint = '/api/minnelux-session/'

function post(path: 'resume' | 'start' | 'logout' | 'reject', body?: object) {
  return fetch(endpoint + path, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    keepalive: path === 'reject',
    redirect: 'error',
    ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

export async function resumeDurableSession() {
  const response = await post('resume')
  if (response.status === 401) return undefined
  if (!response.ok) throw new Error('Session restoration failed')
  const grant: unknown = await response.json()
  if (!record(grant) || typeof grant.bucket !== 'string' || !relativeKey(grant.prefix) ||
      typeof grant.token !== 'string' || !/^[!-~]+$/.test(grant.token) ||
      typeof grant.grantId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grant.grantId) ||
      typeof grant.expiresAt !== 'number' || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now() ||
      (grant.access !== 'read' && grant.access !== 'edit')) throw new Error('Invalid resumed grant')
  return {
    grantId: grant.grantId,
    source: {
      kind: 'gcs' as const, bucket: grant.bucket, prefix: grant.prefix,
      token: grant.token, expiresAt: grant.expiresAt, canWrite: grant.access === 'edit',
    },
  }
}

export async function startDurableSession({ bucket, prefix, access }: ConnectConfiguration) {
  const response = await post('start', { bucket, prefix, access })
  if (!response.ok) throw new Error('Google sign-in could not start')
  const { authorizationUrl } = await response.json()
  if (typeof authorizationUrl !== 'string') throw new Error('Google sign-in URL was missing')
  const url = new URL(authorizationUrl)
  if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password) {
    throw new Error('Google sign-in URL was not allowed')
  }
  window.location.assign(url)
}

export async function endDurableSession() {
  if (!(await post('logout')).ok) throw new Error('Sign-out failed')
}

export async function reportRejectedGrant(grantId: string) {
  if (!(await post('reject', { grantId })).ok) throw new Error('Token invalidation failed')
}
