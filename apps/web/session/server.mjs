import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { relativeKey } from '../src/library/catalog.ts'
import { createGoogleOAuth, OAuthGrantError } from './oauth.mjs'
import { openSessionStore, randomId } from './store.mjs'

const paths = '/api/minnelux-session'
const sessionCookie = '__Host-minnelux-session'
const attemptCookie = '__Host-minnelux-oauth'
const attemptLifetime = 10 * 60
const sessionLifetime = 7 * 24 * 60 * 60
const minTokenLifetimeMs = 60_000
const idPattern = /^[A-Za-z0-9_-]{43}$/
const bucketPattern = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/
const csp = "default-src 'none'; script-src 'self'; connect-src 'self' https://storage.googleapis.com; style-src 'self'; img-src 'self' blob:; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const contentTypes = {
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', png: 'image/png',
  svg: 'image/svg+xml', webp: 'image/webp', jpg: 'image/jpeg',
}

function browserCookie(request, name) {
  const matches = (request.headers.cookie ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(name + '='))
  if (matches.length !== 1) return undefined
  const value = matches[0].slice(name.length + 1)
  return idPattern.test(value) ? value : undefined
}

function cookie(name, value, maxAge) {
  return name + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + maxAge
}

function send(response, status, value) {
  response.statusCode = status
  if (value === undefined) return response.end()
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(value))
}

async function jsonBody(request) {
  if (request.headers['content-type']?.split(';', 1)[0] !== 'application/json') return undefined
  const chunks = []
  let length = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length
    if (length > 4096) {
      request.resume()
      return undefined
    }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return undefined }
}

async function connection(request) {
  const body = await jsonBody(request)
  if (!body || typeof body.bucket !== 'string' || !bucketPattern.test(body.bucket) ||
      !relativeKey(body.prefix) || body.prefix.length > 512 || !['read', 'edit'].includes(body.access)) return undefined
  return { bucket: body.bucket, prefix: body.prefix, access: body.access }
}

export function createSessionServer(config, { request: googleRequest = globalThis.fetch, now = Date.now } = {}) {
  const { origin, appPath = '/', databasePath, key, clientId, clientSecret, assetsPath } = config
  const appOrigin = new URL(origin)
  if (appOrigin.origin !== origin || appOrigin.protocol !== 'https:' ||
      !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(appPath) ||
      !clientId || !clientSecret || key?.length !== 32 || !databasePath || !assetsPath) {
    throw new Error('Invalid Minnelux session configuration')
  }

  const store = openSessionStore(databasePath, key)
  const google = createGoogleOAuth({
    clientId, clientSecret, redirectUri: origin + paths + '/callback', request: googleRequest, now,
  })
  const refreshing = new Map()
  store.purge(now())
  const cleanup = setInterval(() => store.purge(now()), 60 * 60 * 1000).unref()

  function redirect(response, location) {
    response.setHeader('Location', location)
    send(response, 303)
  }

  async function start(request, response) {
    const pin = await connection(request)
    if (!pin) return send(response, 400, { error: 'invalidConnection' })
    const attemptId = randomId()
    const state = randomId()
    const attempt = { ...pin, verifier: randomId(), nonce: randomId() }
    store.removeAttempt(browserCookie(request, attemptCookie))
    const startedAt = now()
    if (!store.startAttempt(attemptId, startedAt, startedAt + attemptLifetime * 1000, state, attempt)) {
      response.setHeader('Retry-After', String(attemptLifetime))
      return send(response, 429, { error: 'tooManyAttempts' })
    }
    response.setHeader('Set-Cookie', cookie(attemptCookie, attemptId, attemptLifetime))
    send(response, 200, { authorizationUrl: google.authorizationUrl({ ...attempt, state }) })
  }

  async function callback(request, response, query) {
    const id = browserCookie(request, attemptCookie)
    const state = query.get('state')
    if (!id || !state || !idPattern.test(state) || query.getAll('state').length !== 1) {
      return redirect(response, appPath + '?signIn=failed')
    }
    const attempt = store.claimAttempt(id, state, now())
    if (!attempt) return redirect(response, appPath + '?signIn=failed')
    function fail() {
      if (store.removeAttempt(id)) response.setHeader('Set-Cookie', cookie(attemptCookie, '', 0))
      redirect(response, appPath + '?signIn=failed')
    }
    const code = query.get('code')
    if (query.has('error') || query.getAll('code').length !== 1 || !code || code.length > 2048) return fail()
    try {
      const grant = await google.exchange(code, attempt)
      const sessionId = randomId()
      const pin = { bucket: attempt.bucket, prefix: attempt.prefix, access: attempt.access }
      const completedAt = now()
      if (!store.establishSession(id, sessionId, browserCookie(request, sessionCookie), completedAt,
        completedAt + sessionLifetime * 1000, { pin, grant: { ...grant, id: randomId() } })) return fail()
      response.setHeader('Set-Cookie', [cookie(attemptCookie, '', 0), cookie(sessionCookie, sessionId, sessionLifetime)])
      redirect(response, appPath)
    } catch {
      fail()
    }
  }

  async function refreshSession(id, session) {
    try {
      const refreshed = await google.refresh(session.grant, session.pin.access)
      const current = store.readSession(id, now())
      if (!current) return undefined
      if (refreshed.refreshToken !== current.grant.refreshToken && !store.updateSession(id, now(), {
        pin: current.pin, grant: { ...current.grant, refreshToken: refreshed.refreshToken },
      })) return undefined
      await google.verifySubject(refreshed.token, current.grant.subject)
      const grant = { ...refreshed, id: randomId(), subject: current.grant.subject }
      return store.updateSession(id, now(), { pin: current.pin, grant }) ? grant : undefined
    } catch (error) {
      if (!(error instanceof OAuthGrantError)) throw error
      store.removeSession(id)
      return undefined
    }
  }

  async function resume(request, response) {
    const id = browserCookie(request, sessionCookie)
    const session = store.readSession(id, now())
    if (session) {
      let grant = session.grant
      if (grant.expiresAt - now() <= minTokenLifetimeMs) {
        if (!refreshing.has(id)) {
          refreshing.set(id, refreshSession(id, session).finally(() => refreshing.delete(id)))
        }
        grant = await refreshing.get(id)
      }
      const expiresAt = Math.min(session.expiresAt, grant?.expiresAt ?? 0)
      if (expiresAt > now()) {
        return send(response, 200, { ...session.pin, token: grant.token, grantId: grant.id, expiresAt })
      }
    }
    send(response, 401, { error: 'noSession' })
  }

  async function rejectGrant(request, response) {
    const body = await jsonBody(request)
    if (!body || typeof body.grantId !== 'string' || !idPattern.test(body.grantId)) return send(response, 400)
    const id = browserCookie(request, sessionCookie)
    const session = store.readSession(id, now())
    if (session?.grant.id === body.grantId) {
      store.updateSession(id, now(), { pin: session.pin, grant: { ...session.grant, expiresAt: 0 } })
    }
    send(response, 204)
  }

  async function serve(request, response) {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Strict-Transport-Security', 'max-age=31536000')

    const url = new URL(origin + (request.url?.startsWith('/') ? request.url : '/invalid'))
    if (url.pathname.startsWith(paths + '/')) {
      if (url.pathname === paths + '/callback' && request.method === 'GET') {
        return callback(request, response, url.searchParams)
      }
      if (request.method !== 'POST') return send(response, 405)
      if (request.headers.origin !== origin) return send(response, 403)
      switch (url.pathname) {
        case paths + '/start': return start(request, response)
        case paths + '/resume': return resume(request, response)
        case paths + '/reject': return rejectGrant(request, response)
        case paths + '/logout':
          store.removeAttempt(browserCookie(request, attemptCookie))
          store.removeSession(browserCookie(request, sessionCookie))
          response.setHeader('Set-Cookie', [cookie(attemptCookie, '', 0), cookie(sessionCookie, '', 0)])
          return send(response, 204)
        default: return send(response, 404)
      }
    }

    if (request.method !== 'GET') return send(response, 405)
    const asset = url.pathname.slice(appPath.length)
    let file, type
    if (url.pathname === appPath) {
      file = 'index.html'
      type = 'text/html; charset=utf-8'
    } else if (url.pathname.startsWith(appPath) && /^assets\/[\w.-]+\.(css|js|png|svg|webp|jpg)$/.test(asset)) {
      file = asset
      type = contentTypes[asset.split('.').at(-1)]
    } else {
      return send(response, 404)
    }
    const body = await readFile(resolve(assetsPath, file)).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (!body) return send(response, 404)
    response.setHeader('Content-Security-Policy', csp)
    response.setHeader('Content-Type', type)
    if (file !== 'index.html') response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    response.end(body)
  }

  const server = createServer({ requestTimeout: 20_000, headersTimeout: 10_000 }, (request, response) => {
    void serve(request, response).catch(() => send(response, 503, { error: 'sessionUnavailable' }))
  })
  server.once('close', () => {
    clearInterval(cleanup)
    store.close()
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {
    MINNELUX_ORIGIN: origin, MINNELUX_APP_PATH: appPath, MINNELUX_SESSION_DB: databasePath,
    GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
    MINNELUX_SESSION_KEY: encodedKey, PORT = '4180', HOST = '127.0.0.1',
  } = process.env
  if (!idPattern.test(encodedKey ?? '')) throw new Error('MINNELUX_SESSION_KEY must contain 32 base64url-encoded bytes')
  createSessionServer({
    origin, appPath, databasePath, clientId, clientSecret, key: Buffer.from(encodedKey, 'base64url'), assetsPath: 'dist',
  }).listen(Number(PORT), HOST)
}
