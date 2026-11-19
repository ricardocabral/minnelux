import { expect, test } from '@playwright/test'

test('serves both browser favicon formats', async ({ page }) => {
  await page.goto('/')
  const icons = page.locator('link[rel="icon"]')
  await expect(icons).toHaveCount(2)

  const widths = await icons.evaluateAll(async links => Promise.all(links.map(async link => {
    const image = new Image()
    image.src = (link as HTMLLinkElement).href
    await image.decode()
    return image.naturalWidth
  })))

  expect(widths.every(width => width > 0)).toBe(true)
})
