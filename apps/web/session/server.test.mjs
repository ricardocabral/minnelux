import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { clientId, fakeGoogle, readScope } from './fixture.mjs'
import { createSessionServer } from './server.mjs'
import { maxPendingAttempts } from './store.mjs'

const origin = 'https://test.example'
const prefix = '/api/minnelux-session/'
const pin = { bucket: 'test-bucket', prefix: 'library', access: 'read' }
const cookieValue = response => response.headers.getSetCookie().at(-1).split(';', 1)[0]

async function setup(t) {
  let time = Date.now()
  const now = () => time
  const directory = await mkdtemp(join(tmpdir(), 'minnelux-session-test-'))
  const provider = await fakeGoogle(now)
  const databasePath = join(directory, 'sessions.db')
  const config = { origin, databasePath, assetsPath: directory, key: randomBytes(32), clientId, clientSecret: 'fixture-secret' }
  let server
  let base

  async function restart() {
    if (server) await new Promise(resolve => server.close(resolve))
    server = createSessionServer(config, { request: provider.request, now })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    base = 'http://127.0.0.1:' + server.address().port
  }
  await restart()
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })

  async function post(path, { cookie = '', body, from = origin } = {}) {
    return fetch(base + prefix + path, {
      method: 'POST', headers: { Origin: from, Cookie: cookie, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    })
  }
  async function begin() {
    const start = await post('start', { body: pin })
    assert.equal(start.status, 200)
    assert.match(start.headers.get('cache-control'), /no-store/)
    assert.match(start.headers.getSetCookie()[0], /; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/)
    return { cookie: cookieValue(start), authorization: new URL((await start.json()).authorizationUrl) }
  }
  async function callback(location, cookie) {
    return fetch(base + location.pathname + location.search, {
      redirect: 'manual', headers: { Cookie: cookie ?? '' },
    })
  }
  async function connect() {
    const attempt = await begin()
    return callback(provider.authorize(attempt.authorization), attempt.cookie)
  }
  return { post, begin, callback, connect, provider, restart, databasePath, advance: ms => { time += ms } }
}

test('binds OAuth state to a browser, consumes it once, and sets an opaque secure session', async t => {
  const { post, begin, callback, provider, databasePath } = await setup(t)
  assert.equal((await post('start', { body: pin, from: 'https://other.example' })).status, 403)
  assert.equal((await post('start', { body: { ...pin, prefix: '../private' } })).status, 400)
  const attempt = await begin()
  assert.equal(attempt.authorization.searchParams.get('scope'), readScope)
  assert.equal(attempt.authorization.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(attempt.authorization.searchParams.get('access_type'), 'offline')
  const location = provider.authorize(attempt.authorization)
  assert.equal((await callback(location)).headers.get('location'), '/?signIn=failed')
  assert.equal(provider.calls.exchanges, 0)
  const completed = await callback(location, attempt.cookie)
  assert.equal(completed.headers.get('location'), '/')
  assert.match(completed.headers.getSetCookie().at(-1), /^__Host-minnelux-session=[\w-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax;/)
  assert.equal((await callback(location, attempt.cookie)).headers.get('location'), '/?signIn=failed')
  assert.equal(provider.calls.exchanges, 1)
  const cookie = cookieValue(completed)
  const resume = await post('resume', { cookie })
  assert.equal(resume.status, 200)
  assert.equal(resume.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Object.keys(await resume.json()).sort(), ['access', 'bucket', 'expiresAt', 'grantId', 'prefix', 'token'])
  const bytes = await readFile(databasePath)
  assert.equal(bytes.includes('fixture-refresh-'), false)
  assert.equal(bytes.includes('fixture-access-'), false)
  assert.equal(bytes.includes(cookie.split('=')[1]), false)
})

test('restores across server restarts, renews a rotation once, and clears the session on logout', async t => {
  const { connect, post, restart, provider, advance } = await setup(t)
  const connected = await connect()
  assert.equal(connected.headers.get('location'), '/')
  const cookies = cookieValue(connected)
  await restart()
  const before = await (await post('resume', { cookie: cookies })).json()
  assert.equal(before.bucket, pin.bucket)
  assert.equal(before.prefix, pin.prefix)
  assert.equal(before.access, 'read')
  assert.equal(provider.calls.exchanges, 1)
  advance(3_600_000)
  const [first, second] = await Promise.all([post('resume', { cookie: cookies }), post('resume', { cookie: cookies })])
  assert.equal(first.status, 200)
  const renewed = await first.json()
  assert.deepEqual(renewed, await second.json())
  assert.notEqual(renewed.token, before.token)
  assert.equal(provider.calls.refreshes, 1)
  await restart()
  advance(3_600_000)
  assert.equal((await post('resume', { cookie: cookies })).status, 200)
  assert.equal(provider.calls.refreshes, 2)
  assert.equal((await post('logout', { cookie: cookies, from: 'https://other.example' })).status, 403)
  const logout = await post('logout', { cookie: cookies })
  assert.equal(logout.status, 204)
  assert.match(logout.headers.getSetCookie().at(-1), /Max-Age=0$/)
  assert.equal((await post('resume', { cookie: cookies })).status, 401)
})

test('rejects broader scopes, unmatched nonce, and a Google ID token with multiple audiences', async t => {
  const { connect, advance, post, provider } = await setup(t)
  provider.calls.exchangeScope = readScope + ' https://www.googleapis.com/auth/devstorage.read_write'
  assert.equal((await connect()).headers.get('location'), '/?signIn=failed')
  delete provider.calls.exchangeScope
  provider.calls.nonce = 'unmatched'
  assert.equal((await connect()).headers.get('location'), '/?signIn=failed')
  delete provider.calls.nonce
  provider.calls.audience = [clientId, 'another.apps.googleusercontent.com']
  provider.calls.authorizedParty = clientId
  assert.equal((await connect()).headers.get('location'), '/?signIn=failed')
  delete provider.calls.audience
  const connected = await connect()
  assert.equal(connected.headers.get('location'), '/')
  advance(3_600_000)
  provider.calls.refreshScope = readScope + ' https://www.googleapis.com/auth/cloud-platform'
  assert.equal((await post('resume', { cookie: cookieValue(connected) })).status, 401)
  delete provider.calls.refreshScope
  assert.equal((await post('resume', { cookie: cookieValue(connected) })).status, 401)
  assert.equal(provider.calls.refreshes, 1)
})

test('signing out cancels a callback that is already exchanging the OAuth code', async t => {
  const { post, begin, callback, provider } = await setup(t)
  const attempt = await begin()
  const exchanging = Promise.withResolvers()
  const finish = Promise.withResolvers()
  provider.calls.beforeExchange = () => {
    exchanging.resolve()
    return finish.promise
  }
  const pending = callback(provider.authorize(attempt.authorization), attempt.cookie)
  await exchanging.promise
  try {
    assert.equal((await post('logout', { cookie: attempt.cookie })).status, 204)
  } finally {
    finish.resolve()
  }
  const canceled = await pending
  assert.equal(canceled.headers.get('location'), '/?signIn=failed')
  assert.deepEqual(canceled.headers.getSetCookie(), [])
})

test('limits outstanding sign-in attempts and accepts new attempts after expiry', async t => {
  const { begin, post, advance } = await setup(t)
  for (let count = 0; count < maxPendingAttempts; count++) await begin()
  const full = await post('start', { body: pin })
  assert.equal(full.status, 429)
  assert.equal(full.headers.get('retry-after'), '600')
  assert.deepEqual(full.headers.getSetCookie(), [])
  advance(600_000)
  await begin()
})

test('only a rejection for the current session and access grant requires early renewal', async t => {
  const { connect, post, provider } = await setup(t)
  const firstCookie = cookieValue(await connect())
  const otherCookie = cookieValue(await connect())
  const first = await (await post('resume', { cookie: firstCookie })).json()
  const other = await (await post('resume', { cookie: otherCookie })).json()

  const reject = cookie => post('reject', { cookie, body: { grantId: first.grantId } })
  assert.equal((await reject(otherCookie)).status, 204)
  assert.deepEqual(await (await post('resume', { cookie: otherCookie })).json(), other)
  assert.equal((await reject(firstCookie)).status, 204)
  const renewed = await (await post('resume', { cookie: firstCookie })).json()
  assert.notEqual(renewed.grantId, first.grantId)
  assert.notEqual(renewed.token, first.token)
  assert.equal((await reject(firstCookie)).status, 204)
  assert.deepEqual(await (await post('resume', { cookie: firstCookie })).json(), renewed)
  assert.equal(provider.calls.refreshes, 1)
})

test('keeps a rotated refresh token after a transient identity failure and withholds the unverified bearer', async t => {
  const { connect, post, restart, provider, advance } = await setup(t)
  const cookie = cookieValue(await connect())
  const before = await (await post('resume', { cookie })).json()
  advance(3_600_000)
  provider.calls.userInfoFailures = 1
  const failed = await post('resume', { cookie })
  assert.equal(failed.status, 503)
  assert.deepEqual(await failed.json(), { error: 'sessionUnavailable' })
  await restart()
  const recovered = await post('resume', { cookie })
  assert.equal(recovered.status, 200)
  assert.notEqual((await recovered.json()).token, before.token)
  assert.equal(provider.calls.refreshes, 2)
})
