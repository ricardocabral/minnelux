import type { ObjectStore } from './contract.ts'
import { createGcsStore } from './gcs.ts'
import { boundedBody, checkCancellation, record, storeError } from './io.ts'

const scopePrefix = 'https://www.googleapis.com/auth/devstorage.'
const userInfo = 'https://openidconnect.googleapis.com/v1/userinfo'
type Access = 'viewer' | 'editor'

export interface GisOAuth {
  initTokenClient(config: {
    client_id: string
    scope: string
    include_granted_scopes: boolean
    callback(response: unknown): void
    error_callback(error: unknown): void
  }): {requestAccessToken(options: {prompt: string}): void}
}

type GcsSession = {
  subject: string
  access: Access
  expiresAt: number
  signal: AbortSignal
  store: ObjectStore
  close(): void
  getToken(): string
}

function requestGrant(oauth: GisOAuth, clientId: string, scope: string, signal?: AbortSignal): Promise<unknown> {
  checkCancellation(signal)
  return new Promise((resolve, reject) => {
    const abort = () => finish(storeError('aborted'))
    function finish(error: unknown, value?: unknown) {
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value)
    }
    signal?.addEventListener('abort', abort, {once:true})
    try {
      oauth.initTokenClient({
        client_id: clientId,
        scope: 'openid ' + scope,
        include_granted_scopes: false,
        callback: response => finish(null, response),
        error_callback: () => finish(storeError('denied')),
      }).requestAccessToken({prompt: 'select_account'})
    } catch {
      finish(storeError('invalidResponse'))
    }
  })
}

export async function authorizeGcsSession({oauth, clientId, bucket, access, signal, fetch: request = globalThis.fetch}: {
  oauth: GisOAuth
  clientId: string
  bucket: string
  access: Access
  signal?: AbortSignal
  fetch?: typeof fetch
}): Promise<GcsSession> {
  if (!clientId.trim() || (access !== 'viewer' && access !== 'editor')) throw storeError('invalidResponse')
  const controller = new AbortController()
  let token: string | undefined
  let expiresAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  function invalidate(code: 'aborted' | 'expired', status?: number): void {
    token = undefined
    clearTimeout(timer)
    signal?.removeEventListener('abort', close)
    controller.abort(storeError(code, status))
  }
  function close() { invalidate('aborted') }
  function getToken(): string {
    checkCancellation(controller.signal)
    if (expiresAt <= Date.now()) {
      invalidate('expired')
      throw storeError('expired')
    }
    if (!token) throw storeError('expired')
    return token
  }
  const authorizedFetch: typeof fetch = async (input, options) => {
    const response = await request(input, options)
    if (response.status === 401) invalidate('expired', 401)
    return response
  }
  const providerStore = createGcsStore(bucket, getToken, {fetch:authorizedFetch, signal:controller.signal})
  const store: ObjectStore = access === 'editor' ? providerStore : {
    ...providerStore,
    async write() {
      getToken()
      throw storeError('denied')
    },
  }
  const scope = scopePrefix + (access === 'editor' ? 'read_write' : 'read_only')
  const grant = await requestGrant(oauth, clientId, scope, signal)
  checkCancellation(signal)
  if (!record(grant) || grant.error) throw storeError('denied')
  const {access_token, expires_in, scope: granted, token_type} = grant
  const seconds = typeof expires_in === 'string' && /^\d+$/.test(expires_in) ? Number(expires_in) : expires_in
  if (typeof access_token !== 'string' || !access_token || /\s/.test(access_token) ||
      typeof token_type !== 'string' || token_type.toLowerCase() !== 'bearer' ||
      typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds <= 0 || seconds > 86_400 ||
      typeof granted !== 'string') throw storeError('invalidResponse')
  const scopes = new Set(granted.split(/\s+/).filter(Boolean))
  if (!scopes.has('openid') || !scopes.has(scope) ||
      [...scopes].some(grantedScope => grantedScope !== 'openid' && grantedScope !== scope)) {
    throw storeError('denied')
  }

  token = access_token
  expiresAt = Date.now() + seconds * 1000
  timer = setTimeout(() => invalidate('expired'), seconds * 1000)
  signal?.addEventListener('abort', close, {once:true})
  try {
    let response: Response
    try {
      response = await authorizedFetch(userInfo, {
        signal: controller.signal, headers: {Authorization: 'Bearer ' + getToken()},
        credentials:'omit', cache:'no-store', redirect:'error', referrerPolicy:'no-referrer',
      })
      checkCancellation(controller.signal)
    } catch {
      checkCancellation(controller.signal)
      throw storeError('transport')
    }
    if (response.status === 403) throw storeError('denied', 403)
    if (!response.ok || !response.body) throw storeError('invalidResponse', response.status)
    const raw = await boundedBody(response.body, 64 * 1024, controller.signal)
    let result: unknown
    try {
      result = JSON.parse(await raw.text())
      getToken()
    } catch {
      checkCancellation(controller.signal)
      throw storeError('invalidResponse')
    }
    if (!record(result) || typeof result.sub !== 'string' || !result.sub) throw storeError('invalidResponse')
    return {subject:result.sub, access, expiresAt, signal:controller.signal, store, close, getToken}
  } catch (error) {
    close()
    throw error
  }
}
