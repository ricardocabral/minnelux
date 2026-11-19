import { expect, test } from '@playwright/test'

test('serves both browser favicon formats', async ({ page }) => {
  await page.goto('/')
  const icons = page.locator('link[rel="icon"]')
  await expect(icons).toHaveCount(2)

  const hostedPage = new URL('/web/', page.url())
  const iconPaths = await icons.evaluateAll(async (links, base) => Promise.all(links.map(async link => {
    const image = new Image()
    image.src = (link as HTMLLinkElement).href
    await image.decode()
    return new URL(link.getAttribute('href') ?? '', base).href
  })), hostedPage.href)

  expect(iconPaths).toEqual([
    new URL('favicon.ico', hostedPage).href,
    new URL('favicon.svg', hostedPage).href,
  ])
})
