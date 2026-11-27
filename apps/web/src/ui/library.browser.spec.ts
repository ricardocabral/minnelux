import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

async function openCollection(page: Page, title: string) {
  const collections = page.getByRole('button', { name: 'Collections', exact: true })
  if (await collections.isVisible()) await collections.click()
  await page.getByRole('navigation', { name: 'Library navigation' }).getByRole('button', { name: title, exact: true }).click()
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
}

test('browses the sample collection and opens authorized Flickr details', async ({ page }) => {
  const remoteMedia: string[] = []
  page.on('request', request => {
    const { hostname } = new URL(request.url())
    if (hostname === 'flickr.com' || hostname.endsWith('.flickr.com')) remoteMedia.push(request.url())
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Open sample library' }).click()
  await expect(page.getByRole('heading', { name: 'All Media', exact: true })).toBeVisible()

  await openCollection(page, 'Travel')
  const cover = page.getByRole('img', { name: 'Travel cover' })
  await expect(cover).toHaveAttribute('src', /^blob:/)
  await expect.poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByText('Across the river')).toBeVisible()
  await expect(page.getByText('2024-12-01 12:30:00 UTC+00:00')).toBeVisible()

  const tile = page.getByRole('button', { name: 'Open Forêt' })
  await tile.click()
  const viewer = page.getByRole('dialog', { name: 'Forêt' })
  await expect(viewer.getByRole('img', { name: 'Forêt' })).toHaveAttribute('src', /^blob:/)
  const details = viewer.getByRole('button', { name: 'Details', exact: true })
  if (await details.getAttribute('aria-expanded') === 'false') await details.click()
  await expect(viewer.getByText('Example', { exact: true })).toBeVisible()
  await expect(viewer.getByText('Original caption', { exact: true })).toBeVisible()
  await expect(viewer.getByText('2024-12-01 12:20:00', { exact: true })).toBeVisible()
  await expect(viewer.getByText('Sample license', { exact: true })).toBeVisible()
  await expect(viewer.getByText('Bridge <3', { exact: true })).toBeVisible()
  await expect(viewer.getByText('River', { exact: true })).toBeVisible()
  await expect(viewer.getByText('Hikes', { exact: true })).toBeVisible()
  await expect(viewer.getByRole('heading', { name: 'Source tag authors' })).toBeVisible()
  await expect(viewer.getByRole('link', { name: 'View source photo' })).toHaveAttribute('href', /^https:\/\/www\.flickr\.com\//)

  await page.goBack()
  await expect(viewer).not.toBeVisible()
  await expect(tile).toBeFocused()

  const search = page.getByRole('searchbox', { name: 'Search photos, videos, and tags' })
  await search.fill('foret')
  await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible()
  await expect(tile).toBeVisible()
  await search.fill('never archived')
  await expect(page.getByText('No matches')).toBeVisible()

  await openCollection(page, 'Pending cover')
  await expect(page.getByRole('link', { name: 'View source cover' })).toHaveAttribute('href', /\/55\/$/)
  await expect(page.getByRole('img', { name: 'Pending cover cover' })).toHaveCount(0)
  expect(remoteMedia).toEqual([])
})

test('shows the preview while the viewer loads the photo original', async ({ page, context }) => {
  let originalReads = 0
  let releaseOriginal!: () => void
  const originalReady = new Promise<void>(resolve => { releaseOriginal = resolve })
  let releaseNavigation!: () => void
  const navigationReady = new Promise<void>(resolve => { releaseNavigation = resolve })
  let viewerOpened = false
  let releaseViewerPreviews!: () => void
  const viewerPreviewsReady = new Promise<void>(resolve => { releaseViewerPreviews = resolve })
  await context.route(
    url => url.pathname === '/__minnelux_fixture' && Boolean(url.searchParams.get('key')?.startsWith('library/previews/')),
    async route => {
      if (viewerOpened) await viewerPreviewsReady
      await route.continue()
    },
  )
  await context.route(
    url => url.pathname === '/__minnelux_fixture' && Boolean(url.searchParams.get('key')?.startsWith('library/originals/')),
    async route => {
      originalReads++
      await (originalReads === 1 ? originalReady : navigationReady)
      await route.continue()
    },
  )

  try {
    await page.goto('/')
    await page.getByRole('button', { name: 'Open sample library' }).click()
    const tile = page.getByRole('button', { name: 'Open Forêt' })
    const tileImage = tile.locator('img')
    await expect.poll(() => tileImage.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
    const previewUrl = await tileImage.getAttribute('src')
    expect(originalReads).toBe(0)
    viewerOpened = true
    await tile.click()

    const viewer = page.getByRole('dialog', { name: 'Forêt' })
    const image = viewer.getByRole('img', { name: 'Forêt' })
    await expect.poll(() => originalReads).toBe(1)
    await expect(image).toHaveAttribute('src', previewUrl!)
    releaseOriginal()

    await expect(image).not.toHaveAttribute('src', previewUrl!)
    const originalUrl = await image.getAttribute('src')
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
    await viewer.getByRole('button', { name: 'Zoom in' }).click()
    await expect(viewer.getByRole('button', { name: 'Fit image' })).toBeVisible()
    await expect(image).toHaveAttribute('src', originalUrl!)

    await viewer.getByRole('button', { name: 'Fit image' }).click()
    await viewer.getByRole('button', { name: 'Previous item' }).click()
    await expect.poll(() => originalReads).toBe(2)
    await page.getByRole('dialog').getByRole('button', { name: 'Next item' }).click()
    await expect.poll(() => originalReads).toBe(3)
    const returnedImage = page.getByRole('dialog', { name: 'Forêt' }).getByRole('img', { name: 'Forêt' })
    await expect(returnedImage).toHaveAttribute('src', previewUrl!)
  } finally {
    releaseOriginal()
    releaseNavigation()
    releaseViewerPreviews()
  }
})

test('downloads the stored photo original from the viewer footer', async ({ page, context }) => {
  let originalReads = 0
  await context.route(
    url => url.pathname === '/__minnelux_fixture' && Boolean(url.searchParams.get('key')?.startsWith('library/originals/')),
    async route => {
      originalReads++
      if (originalReads <= 2) await route.fulfill({ status: 404 })
      else await route.continue()
    },
  )

  await page.goto('/')
  await page.getByRole('button', { name: 'Open sample library' }).click()
  await page.getByRole('button', { name: 'Open Forêt' }).click()
  const viewer = page.getByRole('dialog', { name: 'Forêt' })
  await expect(viewer.getByRole('img', { name: 'Forêt' })).toBeVisible()
  const footer = viewer.locator('footer')
  await footer.getByRole('button', { name: 'Zoom in' }).click()
  await expect(footer.getByRole('button', { name: 'Fit image' })).toBeVisible()

  const downloadButton = footer.getByRole('button', { name: 'Download original' })
  await expect(downloadButton).toBeEnabled()
  await expect.poll(() => originalReads).toBe(1)
  await downloadButton.focus()
  await page.keyboard.press('Enter')
  await expect(footer.getByRole('alert')).toBeVisible()
  await expect(downloadButton).toBeFocused()

  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')])
  expect(originalReads).toBe(3)
  expect(download.suggestedFilename()).toBe('source.jpg')
  expect(await readFile(await download.path())).toEqual(await readFile(
    new URL('../../../../apps/flickr-import/test-fixtures/photo.jpg', import.meta.url),
  ))
  await expect(footer.getByRole('alert')).toHaveCount(0)
})

test.describe('narrow gallery', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Pacific/Honolulu' })

  test('opens the mobile collections sheet and restores a tile from the details viewer', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Open sample library' }).click()
    await expect(page.getByRole('button', { name: 'Collections', exact: true })).toBeVisible()
    await openCollection(page, 'Travel')
    const tile = page.getByRole('button', { name: 'Open Forêt' })
    await tile.tap()
    const viewer = page.getByRole('dialog', { name: 'Forêt' })
    const footer = viewer.locator('footer')
    await expect(footer.getByRole('button', { name: 'Zoom in' })).toBeInViewport()
    await expect(footer.getByRole('button', { name: 'Download original' })).toBeInViewport()
    const details = viewer.getByRole('button', { name: 'Details', exact: true })
    await expect(details).toHaveAttribute('aria-expanded', 'false')
    await details.tap()
    await expect(viewer.getByText('2024-12-01 12:20:00', { exact: true })).toBeVisible()
    await viewer.getByRole('button', { name: 'Close viewer' }).tap()
    await expect(tile).toBeFocused()

    await openCollection(page, 'Untagged')
    await page.getByRole('button', { name: 'Open source.jpg', exact: true }).first().tap()
    const older = page.getByRole('dialog', { name: 'source.jpg' })
    await older.getByRole('button', { name: 'Details', exact: true }).tap()
    await expect(older.getByText('Filename', { exact: true })).toBeVisible()
    await expect(older.getByRole('heading', { name: 'EXIF Camera and lens' })).toHaveCount(0)
    await expect(older.getByRole('heading', { name: 'IPTC', exact: true })).toHaveCount(0)
    await expect(older.getByRole('heading', { name: 'Comments', exact: true })).toHaveCount(0)
  })
})

test('publishes one photo with two tags and finds it in a fresh browser context', async ({ page, browser }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open sample library' }).click()
  await page.getByRole('button', { name: 'Import', exact: true }).click()

  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 480
    canvas.height = 320
    const context = canvas.getContext('2d')!
    context.fillStyle = '#a05838'
    context.fillRect(0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg').split(',')[1]!
  })
  const dialog = page.getByRole('dialog', { name: 'Import media' })
  await dialog.getByLabel('JPEG photo').setInputFiles({
    name: 'Cafe.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(base64, 'base64'),
  })
  await dialog.getByRole('textbox', { name: 'First tag' }).fill('Family')
  await dialog.getByRole('textbox', { name: 'Second tag' }).fill('Québec')
  await dialog.getByRole('button', { name: 'Publish photo' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Photo published.' })).toBeVisible()
  await page.getByRole('button', { name: 'Reopen library' }).click()
  await expect(page.getByRole('button', { name: 'Open Cafe.jpg', exact: true })).toBeVisible()

  const fresh = await browser.newPage({ baseURL: new URL(page.url()).origin })
  try {
    await fresh.goto('/')
    await fresh.getByRole('button', { name: 'Open sample library' }).click()
    const imported = fresh.getByRole('button', { name: 'Open Cafe.jpg', exact: true })
    await fresh.getByRole('searchbox', { name: 'Search photos, videos, and tags' }).fill('cafe')
    const thumbnail = imported.locator('img')
    await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(360)
    await imported.click()
    const viewer = fresh.getByRole('dialog', { name: 'Cafe.jpg' })
    const photo = viewer.getByRole('img', { name: 'Cafe.jpg' })
    await expect(photo).toHaveAttribute('src', /^blob:/)
    await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(480)
    await expect(viewer.getByRole('button', { name: 'Family', exact: true })).toBeVisible()
    await viewer.getByRole('button', { name: 'Québec', exact: true }).click()
    await expect(fresh.getByRole('heading', { name: 'Québec', exact: true })).toBeVisible()
    await expect(imported).toBeVisible()
    await openCollection(fresh, 'Family')
    await expect(imported).toBeVisible()
  } finally {
    await fresh.close()
  }
})

async function losePublicationResponse(context: BrowserContext, nextRead: 'network' | 'expired') {
  const observed = { writes: 0, failedReads: 0 }
  let loseNextRead = false
  await context.route(
    url => url.pathname === '/__minnelux_fixture' && url.searchParams.get('key') === 'library/head.json',
    async route => {
      if (route.request().method() === 'PUT') {
        observed.writes++
        if (observed.writes === 1) {
          const response = await route.fetch()
          expect(response.status()).toBe(204)
          loseNextRead = true
          await route.abort('failed')
          return
        }
      } else if (loseNextRead) {
        observed.failedReads++
        loseNextRead = false
        if (nextRead === 'expired') await route.fulfill({ status: 401 })
        else await route.abort('failed')
        return
      }
      await route.continue()
    },
  )

  return observed
}

test('checks an uncertain publication after closing and reopening the import dialog', async ({ page, context }) => {
  const observed = await losePublicationResponse(context, 'network')

  await page.goto('/')
  await page.getByRole('button', { name: 'Open sample library' }).click()
  const importButton = page.getByRole('button', { name: 'Import', exact: true })
  await importButton.click()
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 15
    canvas.height = 9
    const context = canvas.getContext('2d')!
    context.fillStyle = '#326b51'
    context.fillRect(0, 0, 15, 9)
    return canvas.toDataURL('image/jpeg').split(',')[1]!
  })
  const dialog = page.getByRole('dialog', { name: 'Import media' })
  await dialog.getByLabel('JPEG photo').setInputFiles({
    name: 'Recovery.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(base64, 'base64'),
  })
  await dialog.getByRole('textbox', { name: 'First tag' }).fill('Recovered')
  await dialog.getByRole('textbox', { name: 'Second tag' }).fill('Proof')
  await dialog.getByRole('button', { name: 'Publish photo' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Publication could not be confirmed.')
  expect(observed.writes).toBe(1)
  expect(observed.failedReads).toBe(1)

  await dialog.getByRole('button', { name: 'Close import media' }).click()
  await expect(dialog).not.toBeVisible()
  await importButton.click()
  await expect(dialog.getByRole('button', { name: 'Publish photo' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Check publication' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Publication confirmed.' })).toBeVisible()
  expect(observed.writes).toBe(1)

  await page.getByRole('button', { name: 'Reopen library' }).click()
  await page.getByRole('searchbox', { name: 'Search photos, videos, and tags' }).fill('recovery')
  await expect(page.getByRole('button', { name: 'Open Recovery.jpg', exact: true })).toHaveCount(1)
})

test('warns before reimporting when the session expires after a possibly committed publication', async ({ page, context }) => {
  const observed = await losePublicationResponse(context, 'expired')
  await page.goto('/')
  await page.getByRole('button', { name: 'Open sample library' }).click()
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import media' })
  await dialog.getByLabel('JPEG photo').setInputFiles(fileURLToPath(
    new URL('../../../../apps/flickr-import/test-fixtures/photo.jpg', import.meta.url),
  ))
  await dialog.getByRole('textbox', { name: 'First tag' }).fill('Expiry')
  await dialog.getByRole('textbox', { name: 'Second tag' }).fill('Proof')
  await dialog.getByRole('button', { name: 'Publish photo' }).click()

  await expect(page.getByRole('status').filter({ hasText: 'A publication may have succeeded.' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Check the library before importing the photo again.')
  expect(observed.writes).toBe(1)
  expect(observed.failedReads).toBe(1)
})

test('searches compatibility symbols through the normalized index', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open sample library' }).click()
  const search = page.getByRole('searchbox', { name: 'Search photos, videos, and tags' })
  await search.fill('℃')
  await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible()
  await expect(page.getByText('No matches')).toBeVisible()

  await search.fill('…')
  await expect(page.getByRole('heading', { name: 'All Media', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open Forêt', exact: true })).toBeVisible()
})

test('releases a tile preview after the tile leaves the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 280 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open sample library' }).click()
  const tile = page.getByRole('button', { name: 'Open Forêt', exact: true })
  const preview = tile.locator('img')
  await tile.scrollIntoViewIfNeeded()
  await expect(preview).toHaveAttribute('src', /^blob:/)
  const firstUrl = await preview.getAttribute('src')

  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(preview).toHaveCount(0)
  const stillReadable = await page.evaluate(url => fetch(url).then(response => response.ok, () => false), firstUrl!)
  expect(stillReadable).toBe(false)

  await tile.scrollIntoViewIfNeeded()
  await expect(preview).toHaveAttribute('src', /^blob:/)
  await expect(preview).not.toHaveAttribute('src', firstUrl!)
})

test('prompts for a valid library prefix before loading Google sign-in', async ({ page }) => {
  let identityRequests = 0
  await page.route('https://accounts.google.com/gsi/client', async route => {
    identityRequests++
    await route.abort()
  })
  await page.goto('/')
  await page.getByLabel('Bucket name').fill('sample-bucket')
  await page.getByLabel('Library prefix').fill('../archive')
  await page.getByLabel('Google OAuth client ID').fill('sample.apps.googleusercontent.com')
  await page.getByRole('button', { name: 'Connect to Google Cloud Storage' }).click()
  await expect(page.getByRole('alert')).toHaveText('Enter a library prefix such as library or archive/photos.')
  await expect(page.getByLabel('Library prefix')).toHaveValue('../archive')
  expect(identityRequests).toBe(0)
})
