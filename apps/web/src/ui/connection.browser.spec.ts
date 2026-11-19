import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

test('opens with Google Cloud Storage and shows Amazon-specific settings when selected', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Open your library' })).toBeVisible()
  const provider = page.getByLabel('Storage provider')
  await expect(provider).toHaveValue('gcs')
  await expect(page.getByLabel('Google OAuth client ID')).toBeVisible()

  await provider.selectOption('s3')
  await expect(page.getByLabel('AWS region')).toBeVisible()
  await expect(page.getByLabel('Cognito identity pool ID')).toBeVisible()
  await expect(page.getByLabel('Google OAuth client ID')).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: 'Remember login' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Connect to Amazon S3' })).toBeVisible()

  await provider.selectOption('gcs')
  await expect(page.getByLabel('Google OAuth client ID')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect to Google Cloud Storage' })).toBeVisible()
})

const region = 'us-east-2'
const cognitoOrigin = `https://minnelux-test.auth.${region}.amazoncognito.com`
const userPool = `${region}_Fixture`
const clientId = 'mockclient123'
const poolSuffix = '11111111-1111-4111-8111-111111111111'
const bucket = 'minnelux-test-bucket'
type ObjectEntry = { body: Buffer; type: string; etag: string }

async function mockAws(context: BrowserContext, role: 'viewer' | 'editor', objects: Map<string, ObjectEntry>) {
  let challenge: string | null
  const key = role === 'editor' ? 'fixture-editor-key' : 'fixture-viewer-key'
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, PUT, POST, OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': 'ETag, Content-Range, Accept-Ranges',
  }
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPool}`
  const subject = role === 'editor' ? poolSuffix : '22222222-2222-4222-8222-222222222222'
  const idToken = `${encode({ alg: 'RS256', kid: 'fixture' })}.${encode({
    sub: subject, token_use: 'id', aud: clientId, iss: issuer,
    exp: Math.floor(Date.now() / 1000) + 3600,
    'cognito:groups': role === 'editor' ? ['writers'] : ['readers'],
  })}.synthetic`

  await context.route(`${cognitoOrigin}/**`, async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/oauth2/authorize') {
      challenge = url.searchParams.get('code_challenge')
      const callback = new URL(url.searchParams.get('redirect_uri')!)
      callback.searchParams.set('state', url.searchParams.get('state')!)
      callback.searchParams.set('code', 'fixture-code')
      return route.fulfill({ status: 302, headers: { location: callback.href } })
    }

    const data = new URLSearchParams(route.request().postData() ?? '')
    expect(url.pathname).toBe('/oauth2/token')
    expect(data.get('code')).toBe('fixture-code')
    expect(createHash('sha256').update(data.get('code_verifier') ?? '').digest('base64url')).toBe(challenge)
    return route.fulfill({ json: { id_token: idToken }, headers: cors })
  })

  await context.route(`https://cognito-identity.${region}.amazonaws.com/**`, async route => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    expect(Object.values(request.postDataJSON().Logins)).toEqual([idToken])
    const identity = { IdentityId: `${region}:${subject}` }
    const json = request.headers()['x-amz-target']?.endsWith('.GetId') ? identity : {
      ...identity, Credentials: {
        AccessKeyId: key, SecretKey: 'fixture-signing-secret', SessionToken: 'fixture-session-token',
        Expiration: Math.floor(Date.now() / 1000) + 600,
      },
    }
    return route.fulfill({ json, headers: cors })
  })

  await context.route(`https://${bucket}.s3.${region}.amazonaws.com/**`, async route => {
    const request = route.request()
    const method = request.method()
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const url = new URL(request.url())
    const objectKey = decodeURIComponent(url.pathname.slice(1))
    const headers = request.headers()
    const error = (status: number, code: string) => route.fulfill({
      status, headers: cors, contentType: 'application/xml', body: `<Error><Code>${code}</Code></Error>`,
    })

    expect(headers.authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${key}/`))
    expect(headers['x-amz-security-token']).toBe('fixture-session-token')
    const object = objects.get(objectKey)
    if (method === 'PUT') {
      if (role !== 'editor') return error(403, 'AccessDenied')
      const expected = object ? headers['if-match'] === object.etag : headers['if-none-match'] === '*'
      if (!expected) return error(412, 'PreconditionFailed')
      const body = request.postDataBuffer()!
      const etag = `"${createHash('sha256').update(body).digest('hex')}"`
      objects.set(objectKey, { body, type: headers['content-type'], etag })
      return route.fulfill({ status: 200, headers: { ...cors, ETag: etag } })
    }
    if (!object) return error(404, 'NoSuchKey')
    return route.fulfill({
      status: 200, headers: { ...cors, ETag: object.etag },
      contentType: object.type, body: object.body,
    })
  })
}

async function openS3Form(page: Page, app: string) {
  await page.goto(app)
  await page.getByLabel('Storage provider').selectOption('s3')
  await page.getByLabel('Bucket name').fill(bucket)
  await page.getByLabel('AWS region').fill(region)
  await page.getByLabel('Cognito managed login URL').fill(cognitoOrigin)
  await page.getByLabel('Cognito app client ID').fill(clientId)
  await page.getByLabel('Cognito user pool ID').fill(userPool)
  await page.getByLabel('Cognito identity pool ID').fill(`${region}:${poolSuffix}`)
}

async function connectS3(page: Page, app: string) {
  await openS3Form(page, app)
  await page.getByRole('button', { name: 'Connect to Amazon S3' }).click()
  await expect(page.getByRole('heading', { name: 'All Media', exact: true })).toBeVisible()
}

test('publishes a JPEG through the S3 connector and finds it in a fresh Cognito reader session', async ({ page, browser }) => {
  const app = new URL(test.info().project.use.baseURL!)
  app.hostname = 'localhost'
  const objects = new Map<string, ObjectEntry>()
  await mockAws(page.context(), 'editor', objects)
  await connectS3(page, app.href)

  await page.getByRole('button', { name: 'Import', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import media' })
  await dialog.getByLabel('JPEG photo').setInputFiles({
    name: 'S3 fixture.jpg', mimeType: 'image/jpeg',
    buffer: await readFile(new URL('../../../../apps/flickr-import/test-fixtures/photo.jpg', import.meta.url)),
  })
  await dialog.getByRole('textbox', { name: 'First tag' }).fill('Family')
  await dialog.getByRole('textbox', { name: 'Second tag' }).fill('Travel')
  await dialog.getByRole('button', { name: 'Publish photo' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Photo published.' })).toBeVisible()
  expect(objects.get('library/head.json')).toBeDefined()

  const reader = await browser.newContext()
  try {
    await mockAws(reader, 'viewer', objects)
    const fresh = await reader.newPage()
    await connectS3(fresh, app.href)
    await expect(fresh.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0)
    await fresh.getByRole('searchbox', { name: 'Search photos, videos, and tags' }).fill('fixture')
    await expect(fresh.getByRole('heading', { name: 'Search results' })).toBeVisible()
    const photo = fresh.getByRole('button', { name: 'Open S3 fixture.jpg', exact: true })
    await expect(photo).toBeVisible()
    await photo.click()
    await expect(fresh.getByRole('dialog').getByRole('img', { name: 'S3 fixture.jpg' })).toHaveAttribute('src', /^blob:/)
  } finally {
    await reader.close()
  }
})

test('cancels a pending Cognito sign-in and allows retry', async ({ page, baseURL }) => {
  const app = new URL(baseURL!)
  app.hostname = 'localhost'
  await page.context().route(`${cognitoOrigin}/oauth2/authorize?**`, route =>
    route.fulfill({ contentType: 'text/html', body: '<title>Test login</title><p>Test login</p>' }),
  )
  await openS3Form(page, app.href)
  const popup = page.context().waitForEvent('page')
  const connect = page.getByRole('button', { name: 'Connect to Amazon S3' })
  await connect.click()
  const login = await popup
  await expect(login.getByText('Test login')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel sign-in' }).click()
  await expect(connect).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
})
