import type { S3Credentials } from './s3.ts'
import { boundedBody, checkCancellation, record, storeError } from './io.ts'

export type S3ConnectionSettings = {
  region: string
  cognitoOrigin: string
  userPoolId: string
  clientId: string
  identityPoolId: string
  editorGroup?: string
}

type S3Session = {
  subject: string
  access: 'viewer' | 'editor'
  expiresAt: number
  getCredentials(): S3Credentials
  close(): void
}

const signInTimeout = 180_000
const callbackPrefix = 'minnelux-cognito-'
const regionPattern = /^[a-z]{2}(?:-[a-z]+)+-\d+$/
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/\s/.test(value)

function trustedLogin({region, cognitoOrigin, userPoolId, clientId, identityPoolId, editorGroup}: S3ConnectionSettings): URL {
  const login = URL.parse(cognitoOrigin)
  if (!regionPattern.test(region) || !login || login.origin !== cognitoOrigin || login.protocol !== 'https:' ||
      login.port || !new RegExp(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.auth\\.${region}\\.amazoncognito\\.com$`).test(login.hostname) ||
      !userPoolId.startsWith(region + '_') || !/^[\w-]+$/.test(userPoolId) ||
      !identityPoolId.startsWith(region + ':') || !/^[\w-]+:[0-9a-f-]+$/.test(identityPoolId) ||
      !/^[\w+]+$/.test(clientId) || (editorGroup !== undefined && !validId(editorGroup))) {
    throw storeError('invalidResponse')
  }
  return login
}

function randomHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function authorizationCode(popup: Window, login: URL, clientId: string, redirect: string, verifier: string, signal: AbortSignal): Promise<string> {
  const state = randomHex()
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  if (signal.aborted) throw signal.reason
  const authorize = new URL('/oauth2/authorize', login)
  authorize.search = new URLSearchParams({
    response_type:'code', client_id:clientId, redirect_uri:redirect, scope:'openid', state,
    code_challenge:btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''),
    code_challenge_method:'S256', prompt:'login',
  }).toString()
  // Keep this channel prefix and payload in sync with public/cognito-callback.js.
  const callback = new BroadcastChannel(callbackPrefix + state)
  let abort: (() => void) | undefined
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, {once:true})
      callback.onmessage = ({data}: MessageEvent<unknown>) => {
        if (!record(data) || data.state !== state) return
        if (data.error === true) reject(storeError('denied'))
        else if (!validId(data.code) || data.code.length > 4096) reject(storeError('invalidResponse'))
        else resolve(data.code)
      }
      const link = popup.document.createElement('a')
      link.href = authorize.href
      link.rel = 'noreferrer'
      link.click()
    })
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
    callback.close()
  }
}

async function tokenExchange(login: URL, clientId: string, redirect: string, code: string, verifier: string, signal: AbortSignal): Promise<string> {
  let response: Response
  try {
    response = await fetch(new URL('/oauth2/token', login), {
      method:'POST', body:new URLSearchParams({
        grant_type:'authorization_code', client_id:clientId, code, redirect_uri:redirect, code_verifier:verifier,
      }),
      signal, credentials:'omit', cache:'no-store', redirect:'error', referrerPolicy:'no-referrer',
    })
  } catch {
    if (signal.aborted) throw signal.reason
    throw storeError('transport')
  }
  if ([400, 401, 403].includes(response.status)) throw storeError('denied', response.status)
  if (!response.ok) throw storeError('transport', response.status)
  if (!response.body) throw storeError('invalidResponse')
  let value: unknown
  try {
    const body = await boundedBody(response.body, 192 * 1024, signal)
    value = JSON.parse(await body.text())
  } catch {
    if (signal.aborted) throw signal.reason
    throw storeError('invalidResponse')
  }
  if (!record(value) || typeof value.id_token !== 'string' || value.id_token.length > 50_000 ||
      !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value.id_token)) throw storeError('invalidResponse')
  return value.id_token
}

function groupAccess(idToken: string, editorGroup: string): S3Session['access'] {
  // Called only after the identity pool accepts this token. IAM enforces writes.
  try {
    const bytes = atob(idToken.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))
    const claims: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes, char => char.charCodeAt(0))))
    if (record(claims) && Array.isArray(claims['cognito:groups']) && claims['cognito:groups'].includes(editorGroup)) return 'editor'
  } catch {
    // Unreadable claims cannot grant an editor hint.
  }
  return 'viewer'
}

async function federate(region: string, userPoolId: string, identityPoolId: string, idToken: string, signal: AbortSignal) {
  const {CognitoIdentityClient, GetIdCommand, GetCredentialsForIdentityCommand} = await import('@aws-sdk/client-cognito-identity')
  if (signal.aborted) throw signal.reason
  const identity = new CognitoIdentityClient({
    region, ignoreConfiguredEndpointUrls:true,
    requestHandler:{
      credentials:'omit', cache:'no-store',
      requestInit:() => ({redirect:'error', referrerPolicy:'no-referrer'}),
    },
  })
  const Logins = {[`cognito-idp.${region}.amazonaws.com/${userPoolId}`]:idToken}
  const options = {abortSignal:signal}
  try {
    const {IdentityId} = await identity.send(new GetIdCommand({IdentityPoolId:identityPoolId, Logins}), options)
    if (signal.aborted) throw signal.reason
    if (!validId(IdentityId) || !IdentityId.startsWith(region + ':')) throw storeError('invalidResponse')
    return await identity.send(new GetCredentialsForIdentityCommand({IdentityId, Logins}), options)
  } finally {
    identity.destroy()
  }
}

export async function authorizeS3Session(settings: S3ConnectionSettings, signal?: AbortSignal): Promise<S3Session> {
  checkCancellation(signal)
  const login = trustedLogin(settings)
  const {region, userPoolId, clientId, identityPoolId, editorGroup = 'writers'} = settings
  const callback = new URL('./cognito-callback.html', window.location.href)
  if (callback.protocol !== 'https:' && !(callback.protocol === 'http:' && callback.hostname === 'localhost')) {
    throw storeError('invalidResponse')
  }
  // Open synchronously, before hashing the verifier or importing the SDK.
  const popup = window.open('about:blank', '_blank', 'popup')
  if (!popup) throw Object.assign(new Error('popupBlocked'), {code:'popupBlocked'})
  const attempt = new AbortController()
  const abortAttempt = () => attempt.abort(storeError('aborted'))
  const timeout = setTimeout(() => attempt.abort(Object.assign(new Error('signInTimeout'), {code:'signInTimeout'})), signInTimeout)
  signal?.addEventListener('abort', abortAttempt, {once:true})
  try {
    popup.opener = null
    const verifier = randomHex()
    const code = await authorizationCode(popup, login, clientId, callback.href, verifier, attempt.signal)
    popup.close()
    const token = await tokenExchange(login, clientId, callback.href, code, verifier, attempt.signal)
    const {IdentityId, Credentials} = await federate(region, userPoolId, identityPoolId, token, attempt.signal)
    if (attempt.signal.aborted) throw attempt.signal.reason
    const expiresAt = Credentials?.Expiration?.getTime()
    if (!validId(IdentityId) || !IdentityId.startsWith(region + ':') ||
        !validId(Credentials?.AccessKeyId) || !validId(Credentials?.SecretKey) || !validId(Credentials?.SessionToken) ||
        expiresAt === undefined || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw storeError('invalidResponse')
    return liveSession(`${identityPoolId}/${IdentityId}`, groupAccess(token, editorGroup), expiresAt, {
      accessKeyId:Credentials.AccessKeyId, secretAccessKey:Credentials.SecretKey, sessionToken:Credentials.SessionToken,
    }, signal)
  } catch (error) {
    if (attempt.signal.aborted) throw attempt.signal.reason
    if (record(error) && (error.code === 'denied' || error.code === 'aborted' || error.code === 'transport' || error.code === 'invalidResponse')) {
      const status = typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
        ? error.status : undefined
      throw storeError(error.code, status)
    }
    if (record(error) && (error.name === 'NotAuthorizedException' || error.name === 'ResourceNotFoundException')) throw storeError('denied')
    throw storeError('transport')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abortAttempt)
    popup.close()
  }
}

function liveSession(subject: string, access: S3Session['access'], expiresAt: number, credentials: S3Credentials | undefined, signal?: AbortSignal): S3Session {
  let invalidated: 'aborted' | 'expired' | undefined
  const expiry = setTimeout(() => invalidate('expired'), Math.min(expiresAt - Date.now(), 2_147_483_647))
  function invalidate(code: 'aborted' | 'expired') {
    invalidated ??= code
    credentials = undefined
    clearTimeout(expiry)
    signal?.removeEventListener('abort', close)
  }
  function close() { invalidate('aborted') }
  signal?.addEventListener('abort', close, {once:true})
  return {subject, access, expiresAt, close, getCredentials() {
    if (!credentials) throw storeError(invalidated ?? 'aborted')
    if (expiresAt <= Date.now()) {
      invalidate('expired')
      throw storeError('expired')
    }
    return {...credentials}
  }}
}
