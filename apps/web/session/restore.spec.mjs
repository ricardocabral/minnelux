import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import objectFixture from '../src/library/fixtures/flickr-v1.json' with { type: 'json' }
import { clientId, fakeGoogle } from './fixture.mjs'
import { createSessionServer } from './server.mjs'

test.use({ ignoreHTTPSErrors: true })

test('reopens a private gallery after reload and clears the durable connection on disconnect', async ({ page, context }) => {
  const directory = await mkdtemp(join(tmpdir(), 'minnelux-session-https-test-'))
  const keyFile = join(directory, 'key.pem')
  const certFile = join(directory, 'cert.pem')
  let backend, https
  let elapsed = 0
  const now = () => Date.now() + elapsed
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
      '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
    https = createHttpsServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, (req, res) => {
      const route = request({
        hostname: '127.0.0.1', port: backend.address().port, method: req.method, path: req.url, headers: req.headers,
      }, upstream => {
        res.writeHead(upstream.statusCode, upstream.headers)
        upstream.pipe(res)
      })
      route.on('error', () => { res.statusCode = 502; res.end() })
      req.pipe(route)
    })
    https.listen(0, '127.0.0.1')
    await once(https, 'listening')
    const origin = 'https://127.0.0.1:' + https.address().port
    const provider = await fakeGoogle(now)
    backend = createSessionServer({
      origin, appPath: '/web/', databasePath: join(directory, 'sessions.db'), key: randomBytes(32), clientId,
      clientSecret: 'fixture-secret', assetsPath: resolve('dist-session-test'),
    }, { request: provider.request, now })
    backend.listen(0, '127.0.0.1')
    await once(backend, 'listening')
    await context.route('https://accounts.google.com/o/oauth2/v2/auth?**', route => route.fulfill({
      status: 302, headers: { Location: provider.authorize(route.request().url()).href },
    }))
    await context.route('https://storage.googleapis.com/**', async route => {
      const req = route.request()
      const url = new URL(req.url())
      const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization' }
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
      if (!provider.knownAccessTokens.has((await req.headerValue('authorization'))?.slice('Bearer '.length))) {
        return route.fulfill({ status: 401, headers })
      }
      const objectKey = decodeURIComponent(url.pathname.split('/o/').at(-1))
      const entry = objectFixture[objectKey]
      if (!entry) return route.fulfill({ status: 404, headers })
      const body = Buffer.from(entry.base64, 'base64')
      if (url.searchParams.get('alt') === 'media') return route.fulfill({ body, contentType: entry.mimeType, headers })
      return route.fulfill({
        json: { size: String(body.length), contentType: entry.mimeType, generation: entry.generation }, headers,
      })
    })
    await page.goto(origin + '/web/')
    await page.getByLabel('Bucket name').fill('sample-bucket')
    await page.getByLabel('Library prefix').fill('library')
    await expect(page.getByLabel('Google OAuth client ID')).toHaveCount(0)
    await page.getByRole('button', { name: 'Connect to Google Cloud Storage' }).click()
    const gallery = page.getByRole('heading', { name: 'All Media', exact: true })
    const tile = page.getByRole('button', { name: 'Open Forêt', exact: true })
    await expect(gallery).toBeVisible()
    await expect(tile.locator('img')).toHaveAttribute('src', /^blob:/)
    expect(provider.calls.exchanges).toBe(1)
    expect(await page.evaluate(() => document.cookie)).toBe('')
    expect((await context.cookies()).find(cookie => cookie.name === '__Host-minnelux-session'))
      .toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax' })

    elapsed += 3_600_000
    await page.reload()
    await expect(gallery).toBeVisible()
    await expect(tile.locator('img')).toHaveAttribute('src', /^blob:/)
    expect(provider.calls.exchanges).toBe(1)
    expect(provider.calls.refreshes).toBe(1)

    provider.knownAccessTokens.clear()
    await page.getByRole('button', { name: 'Reopen library' }).click()
    await expect(page.getByText('Your access token was rejected. Reload to reconnect.')).toBeVisible()
    await page.reload()
    await expect(gallery).toBeVisible()
    await expect(tile.locator('img')).toHaveAttribute('src', /^blob:/)
    expect(provider.calls.exchanges).toBe(1)
    expect(provider.calls.refreshes).toBe(2)

    await page.getByRole('button', { name: 'Disconnect' }).click()
    await expect(page.getByRole('button', { name: 'Connect to Google Cloud Storage' })).toBeVisible()
    expect((await context.cookies()).find(cookie => cookie.name === '__Host-minnelux-session')).toBeUndefined()
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Open your library' })).toBeVisible()
    await expect(gallery).toHaveCount(0)
  } finally {
    if (https?.listening) await new Promise(resolve => https.close(resolve))
    if (backend?.listening) await new Promise(resolve => backend.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
