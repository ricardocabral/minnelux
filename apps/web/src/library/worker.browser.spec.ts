import { expect, test } from '@playwright/test'

test('releases a query result when cancellation reaches the worker after its reply', async ({ page }) => {
  await page.goto('/')
  const started = page.waitForEvent('worker')
  await page.getByRole('button', { name: 'Open sample library' }).click()
  const workerUrl = (await started).url()

  const code = await page.evaluate(async (url) => {
    const worker = new Worker(url, { type: 'module' })
    const envelope = { version: 1, sessionId: 'cancellation-test' }
    function request(operation: string, input: unknown, requestId: string) {
      return new Promise((resolve) => {
        function receive({ data }: MessageEvent) {
          if (data.requestId !== requestId) return
          worker.removeEventListener('message', receive)
          resolve(data)
        }
        worker.addEventListener('message', receive)
        worker.postMessage({ ...envelope, operation, input, requestId })
      })
    }

    try {
      worker.postMessage({ kind: 'start', sessionId: envelope.sessionId, source: { kind: 'sample' } })
      await request('open', null, 'open')
      const query = await request('query', {}, 'query') as { value: { handle: string } }
      worker.postMessage({ ...envelope, requestId: 'cancel-query', operation: 'cancel', input: { requestId: 'query' } })
      const rows = await request('readRange', { handle: query.value.handle, offset: 0, limit: 1 }, 'rows') as { code?: string }
      return rows.code
    } finally {
      worker.terminate()
    }
  }, workerUrl)

  expect(code).toBe('result-expired')
})
