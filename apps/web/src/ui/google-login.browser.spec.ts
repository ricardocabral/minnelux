import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import objectFixture from '../library/fixtures/flickr-v1.json' with { type: 'json' }

const token = 'fixture-google-access-token'

async function mockGoogle(context: BrowserContext, expiresIn = 3600) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization' }
  let signIns = 0
  let storageReads = 0
  let rejected = false
  await context.route('https://accounts.google.com/gsi/client', route => {
    signIns++
    return route.fulfill({ contentType: 'application/javascript', body: `
      window.google = { accounts: { oauth2: { initTokenClient(config) {
        return { requestAccessToken() {
          config.callback({
            access_token: '${token}', token_type: 'Bearer', expires_in: ${expiresIn},
            scope: 'openid https://www.googleapis.com/auth/devstorage.read_only',
          })
        } }
      } } } }
    ` })
  })
  await context.route('https://openidconnect.googleapis.com/v1/userinfo', route =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ json: { sub: 'fixture-google-user' }, headers: cors }))
  await context.route('https://storage.googleapis.com/**', async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    storageReads++
    expect(await route.request().headerValue('authorization')).toBe('Bearer ' + token)
    if (rejected) return route.fulfill({ status: 401, headers: cors })
    const url = new URL(route.request().url())
    expect(url.pathname).toMatch(/\/b\/sample-bucket\/o\//)
    const key = decodeURIComponent(url.pathname.split('/o/').at(-1)!)
    const entry = (objectFixture as Record<string, { base64: string; mimeType: string; generation: string }>)[key]
    if (!entry) return route.fulfill({ status: 404, headers: cors })
    const body = Buffer.from(entry.base64, 'base64')
    if (url.searchParams.get('alt') === 'media') return route.fulfill({ body, contentType: entry.mimeType, headers: cors })
    return route.fulfill({
      json: { size: String(body.length), contentType: entry.mimeType, generation: entry.generation }, headers: cors,
    })
  })
  return {
    get signIns() { return signIns },
    get storageReads() { return storageReads },
    rejectToken() { rejected = true },
  }
}

async function openGoogleForm(page: Page) {
  await page.goto('/')
  await page.getByLabel('Bucket name').fill('sample-bucket')
  await page.getByLabel('Library prefix').fill('/library/')
  await page.getByLabel('Google OAuth client ID').fill('sample.apps.googleusercontent.com')
}

async function connectGoogle(page: Page) {
  const connect = page.getByRole('button', { name: 'Connect to Google Cloud Storage' })
  await connect.click()
  await expect(page.getByRole('status')).toHaveText('Google sign-in is ready. Click Connect again')
  await connect.click()
  await expect(page.getByRole('button', { name: 'Open Forêt', exact: true }).locator('img')).toHaveAttribute('src', /^blob:/)
}

test('starts with Remember login off and does not reconnect after reload by default', async ({ page, context }) => {
  const google = await mockGoogle(context)
  await openGoogleForm(page)
  const remember = page.getByRole('checkbox', { name: 'Remember login' })
  await expect(remember).not.toBeChecked()
  await page.getByRole('button', { name: 'About Remember login' }).focus()
  await expect(page.getByRole('tooltip')).toContainText('Google credentials will be saved in this browser')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toBeHidden()
  await connectGoogle(page)
  const reads = google.storageReads
  expect(JSON.stringify(await context.storageState({ indexedDB: true }))).not.toContain(token)

  await page.reload()
  await expect(page.getByRole('checkbox', { name: 'Remember login' })).not.toBeChecked()
  expect(google.storageReads).toBe(reads)
})

test('restores a remembered Google login in the same browser and clears it on disconnect', async ({ page, context }) => {
  const google = await mockGoogle(context)
  await openGoogleForm(page)
  await page.getByRole('checkbox', { name: 'Remember login' }).check()
  await connectGoogle(page)
  expect(JSON.stringify(await context.storageState({ indexedDB: true }))).toContain(token)

  await page.reload()
  await expect(page.getByRole('button', { name: 'Open Forêt', exact: true }).locator('img')).toHaveAttribute('src', /^blob:/)
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0)
  expect(google.signIns).toBe(1)

  await page.getByRole('button', { name: 'Disconnect' }).click()
  await expect(page.getByRole('checkbox', { name: 'Remember login' })).not.toBeChecked()
  expect(JSON.stringify(await context.storageState({ indexedDB: true }))).not.toContain(token)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Connect to Google Cloud Storage' })).toBeVisible()
})

test('discards a remembered token that expired while the app was closed', async ({ page, context }) => {
  const google = await mockGoogle(context, 120)
  const now = Date.now()
  await page.clock.setFixedTime(now)
  await openGoogleForm(page)
  await page.getByRole('checkbox', { name: 'Remember login' }).check()
  await connectGoogle(page)
  await page.goto('about:blank')
  const reads = google.storageReads

  await page.clock.setFixedTime(now + 121_000)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Connect to Google Cloud Storage' })).toBeVisible()
  expect(google.storageReads).toBe(reads)
  expect(JSON.stringify(await context.storageState({ indexedDB: true }))).not.toContain(token)

  await page.clock.setFixedTime(now)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Connect to Google Cloud Storage' })).toBeVisible()
  expect(google.storageReads).toBe(reads)
})

test('clears a remembered token after Cloud Storage rejects it', async ({ page, context }) => {
  const google = await mockGoogle(context)
  await openGoogleForm(page)
  await page.getByRole('checkbox', { name: 'Remember login' }).check()
  await connectGoogle(page)
  google.rejectToken()

  await page.reload()
  await expect(page.getByRole('button', { name: 'Connect to Google Cloud Storage' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('The session expired. Connect again.')
  const reads = google.storageReads
  await page.reload()
  await expect(page.getByRole('button', { name: 'Connect to Google Cloud Storage' })).toBeVisible()
  expect(google.storageReads).toBe(reads)
})

test('keeps a remembered login after a transient worker load failure', async ({ page, context }) => {
  const google = await mockGoogle(context)
  await openGoogleForm(page)
  await page.getByRole('checkbox', { name: 'Remember login' }).check()
  await connectGoogle(page)

  const libraryWorker = /\/assets\/worker-[^/]+\.js$/
  await page.route(libraryWorker, route => route.abort())
  await page.reload()
  await expect(page.getByRole('button', { name: 'Remove saved login' })).toBeVisible()

  await page.unroute(libraryWorker)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Open Forêt', exact: true }).locator('img')).toHaveAttribute('src', /^blob:/)
  expect(google.signIns).toBe(1)
})

test('opens the library for this page if browser storage is unavailable', async ({ page, context }) => {
  await mockGoogle(context)
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      get() { throw new DOMException('Browser storage disabled', 'SecurityError') },
    })
  })
  await openGoogleForm(page)
  await page.getByRole('checkbox', { name: 'Remember login' }).check()
  await connectGoogle(page)
  await expect(page.getByRole('status').filter({ hasText: 'The browser could not save this login.' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Connect to Google Cloud Storage' })).toBeVisible()
})
