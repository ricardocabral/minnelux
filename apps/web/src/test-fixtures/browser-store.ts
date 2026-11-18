import type { ObjectStore, StoreErrorCode } from '../storage/contract.ts'

export function createBrowserFixtureStore(): ObjectStore {
  function url(key: string, view?: string) {
    const params = new URLSearchParams({ key })
    if (view) params.set('view', view)
    return new URL(`__minnelux_fixture?${params}`, new URL(import.meta.env.BASE_URL, self.location.origin))
  }

  async function request(input: URL, init: RequestInit = {}, allowMissing = false) {
    const response = await fetch(input, { ...init, cache: 'no-store', redirect: 'error' })
    if (response.ok || (allowMissing && response.status === 404)) return response
    const code: StoreErrorCode = response.status === 404 ? 'missing' :
      response.status === 401 ? 'expired' : response.status === 412 ? 'conflict' : response.status === 413 ? 'limit' : 'invalidResponse'
    throw Object.assign(new Error(code), { code })
  }

  return {
    async list(prefix, options) {
      const input = url(prefix, 'list')
      if (options?.cursor) input.searchParams.set('cursor', options.cursor)
      return (await request(input, { signal: options?.signal })).json()
    },
    async stat(key, options) {
      return (await request(url(key, 'stat'), { signal: options?.signal })).json()
    },
    async read(key, options) {
      const range = options?.range
      const response = await request(url(key), {
        signal: options?.signal,
        headers: range ? { Range: `bytes=${range.start}-${range.endInclusive}` } : undefined,
      })
      const objectByteLength = Number(response.headers.get('X-Object-Length'))
      return {
        body: response.body!,
        mimeType: response.headers.get('Content-Type') ?? undefined,
        byteLength: Number(response.headers.get('Content-Length')),
        range: range ? { ...range, objectByteLength } : undefined,
      }
    },
    async readForUpdate(key, options) {
      const response = await request(url(key), { signal: options.signal }, true)
      if (response.status === 404) return null
      if (Number(response.headers.get('Content-Length')) > options.maxBytes) {
        await response.body?.cancel()
        throw Object.assign(new Error('limit'), { code: 'limit' })
      }
      return { body: new Uint8Array(await response.arrayBuffer()), token: response.headers.get('ETag')! }
    },
    async write(key, body, condition, options) {
      const headers: HeadersInit = condition.kind === 'create'
        ? { 'If-None-Match': '*' } : { 'If-Match': condition.token }
      const response = await request(url(key), { method: 'PUT', body, signal: options?.signal, headers })
      return { observedVersion: response.headers.get('ETag') ?? undefined }
    },
  }
}
