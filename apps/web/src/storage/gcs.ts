import type { ObjectStat, ObjectStore } from './contract.ts'
import { boundedBody, checkCancellation, lengthBound, record, storeError } from './io.ts'

const origin = 'https://storage.googleapis.com'
const digits = /^\d+$/
const bucketName = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/
const maxControlBytes = 16 * 1024 * 1024
const fields = 'size,contentType,generation'

function byteLength(value: unknown): number {
  if (typeof value !== 'string' || !digits.test(value) || !Number.isSafeInteger(Number(value))) {
    throw storeError('invalidResponse')
  }
  return Number(value)
}

function generation(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw storeError('invalidResponse')
  return value
}

function objectStat(value: unknown): ObjectStat & {observedVersion: string} {
  if (!record(value) || (value.contentType !== undefined && typeof value.contentType !== 'string')) {
    throw storeError('invalidResponse')
  }
  return {
    byteLength: byteLength(value.size), observedVersion: generation(value.generation),
    ...(value.contentType ? {mimeType: value.contentType} : {}),
  }
}

async function json(response: Response, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.body) throw storeError('invalidResponse', response.status)
  const blob = await boundedBody(response.body, maxControlBytes, signal)
  try {
    const value: unknown = JSON.parse(await blob.text())
    checkCancellation(signal)
    if (record(value)) return value
  } catch {
    checkCancellation(signal)
  }
  throw storeError('invalidResponse', response.status)
}

async function errorDetails(response: Response, signal?: AbortSignal): Promise<Record<string, unknown>> {
  try {
    const {error} = await json(response, signal)
    if (record(error)) return error
  } catch {
    checkCancellation(signal)
  }
  return {}
}

async function checkStatus(response: Response, signal?: AbortSignal): Promise<void> {
  if (response.ok) return
  const {status} = response
  if (status === 401) throw storeError('expired', status)
  if (status === 403) throw storeError('denied', status)
  if (status === 413) throw storeError('limit', status)
  if (status === 412) {
    const {errors} = await errorDetails(response, signal)
    if (Array.isArray(errors) && errors.some(item => record(item) && item.reason === 'conditionNotMet')) {
      throw storeError('conflict', status)
    }
  }
  if (status === 408 || status === 409 || status === 429 || status >= 500) throw storeError('transport', status)
  throw storeError('invalidResponse', status)
}

function opaque(value: string, bucket: string, scope: string, kind: string): string {
  let parts: unknown
  try {
    parts = JSON.parse(value)
  } catch {
    throw storeError('invalidResponse')
  }
  if (!Array.isArray(parts) || parts.length !== 4 ||
      parts[0] !== kind || parts[1] !== bucket || parts[2] !== scope ||
      typeof parts[3] !== 'string' || !parts[3]) throw storeError('invalidResponse')
  return parts[3]
}

function checkKey(key: string): void {
  if (!key || key === '.' || key === '..' || /[\u0000\r\n]/.test(key)) throw storeError('invalidResponse')
}

export function createGcsStore(
  bucket: string,
  getToken: () => string | null | Promise<string | null>,
  {fetch: request = globalThis.fetch, signal: sessionSignal}: {fetch?: typeof fetch; signal?: AbortSignal} = {},
): ObjectStore & {libraryId: string} {
  if (!bucketName.test(bucket)) throw storeError('invalidResponse')
  const basePath = '/storage/v1/b/' + encodeURIComponent(bucket) + '/o'
  const requestSignal = (signal?: AbortSignal) =>
    signal && sessionSignal ? AbortSignal.any([signal, sessionSignal]) : signal ?? sessionSignal

  function objectUrl(key: string, download = false): URL {
    checkKey(key)
    return new URL((download ? '/download' : '') + basePath + '/' + encodeURIComponent(key), origin)
  }

  async function send(url: URL, signal?: AbortSignal, options: RequestInit = {}): Promise<Response> {
    checkCancellation(signal)
    const token = await getToken()
    checkCancellation(signal)
    if (!token) throw storeError('expired')
    const headers = new Headers(options.headers)
    headers.set('Authorization', 'Bearer ' + token)
    try {
      const response = await request(url, {
        ...options, headers, signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      })
      checkCancellation(signal)
      return response
    } catch {
      checkCancellation(signal)
      throw storeError('transport')
    }
  }

  async function listAt(prefix: string, signal?: AbortSignal, cursor?: string) {
    const url = new URL(basePath, origin)
    url.searchParams.set('prefix', prefix)
    url.searchParams.set('fields', 'items(name,' + fields + '),nextPageToken')
    if (cursor !== undefined) url.searchParams.set('pageToken', opaque(cursor, bucket, prefix, 'list'))
    const response = await send(url, signal)
    await checkStatus(response, signal)
    const {items = [], nextPageToken} = await json(response, signal)
    if (!Array.isArray(items) ||
        (nextPageToken !== undefined && (typeof nextPageToken !== 'string' || !nextPageToken))) {
      throw storeError('invalidResponse')
    }
    const entries = items.map(item => {
      if (!record(item) || typeof item.name !== 'string' || !item.name.startsWith(prefix)) {
        throw storeError('invalidResponse')
      }
      return {key: item.name, ...objectStat(item)}
    })
    return {
      entries,
      ...(nextPageToken ? {nextCursor: JSON.stringify(['list', bucket, prefix, nextPageToken])} : {}),
    }
  }

  async function failedObject(response: Response, key: string, signal?: AbortSignal): Promise<void> {
    if (response.status === 404) {
      const {message} = await errorDetails(response, signal)
      if (message === 'No such object: ' + bucket + '/' + key) throw storeError('missing', 404)
      if (message === 'Not Found') {
        const {entries, nextCursor} = await listAt(key, signal)
        if (!nextCursor && !entries.some(entry => entry.key === key)) throw storeError('missing', 404)
      }
    }
    await checkStatus(response, signal)
  }

  async function metadata(key: string, signal?: AbortSignal) {
    const url = objectUrl(key)
    url.searchParams.set('fields', fields)
    const response = await send(url, signal)
    await failedObject(response, key, signal)
    return objectStat(await json(response, signal))
  }

  return {
    libraryId: 'gs://' + bucket,
    list(prefix, options) {
      return listAt(prefix, requestSignal(options?.signal), options?.cursor)
    },
    stat(key, options) {
      return metadata(key, requestSignal(options?.signal))
    },
    async read(key, options) {
      const signal = requestSignal(options?.signal)
      const expected = options?.range
      if (expected && (!Number.isSafeInteger(expected.start) || expected.start < 0 ||
          !Number.isSafeInteger(expected.endInclusive) || expected.endInclusive < expected.start)) {
        throw storeError('invalidResponse')
      }
      const url = objectUrl(key, true)
      url.searchParams.set('alt', 'media')
      const response = await send(url, signal, expected ? {
        headers: {Range: 'bytes=' + expected.start + '-' + expected.endInclusive},
      } : {})
      await failedObject(response, key, signal)
      const expectedStatus = expected ? 206 : 200
      if (response.status !== expectedStatus || !response.body) {
        await response.body?.cancel().catch(() => undefined)
        throw storeError('invalidResponse', response.status)
      }
      const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim()
      const headerLength = response.headers.get('content-length')
      const size = headerLength === null ? undefined : byteLength(headerLength)
      if (expected) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
        const start = match && byteLength(match[1])
        const endInclusive = match && byteLength(match[2])
        const objectByteLength = match && byteLength(match[3])
        const expectedBytes = expected.endInclusive - expected.start + 1
        if (start !== expected.start || endInclusive !== expected.endInclusive ||
            objectByteLength === null || objectByteLength <= endInclusive ||
            (size !== undefined && size !== expectedBytes)) {
          await response.body.cancel().catch(() => undefined)
          throw storeError('invalidResponse', response.status)
        }
        return {
          body: lengthBound(response.body, Number.MAX_SAFE_INTEGER, signal, expectedBytes), byteLength: expectedBytes,
          ...(mimeType ? {mimeType} : {}), range: {start, endInclusive, objectByteLength},
        }
      }
      return {
        body: lengthBound(response.body, Number.MAX_SAFE_INTEGER, signal),
        ...(size !== undefined ? {byteLength: size} : {}),
        ...(mimeType ? {mimeType} : {}),
      }
    },
    async readForUpdate(key, {maxBytes, signal: callerSignal}) {
      const signal = requestSignal(callerSignal)
      for (let attempt = 0; attempt < 2; attempt++) {
        let stat
        try {
          stat = await metadata(key, signal)
        } catch (error) {
          if (attempt === 0 && record(error) && error.code === 'missing') return null
          throw error
        }
        if (stat.byteLength > maxBytes) throw storeError('limit')
        const url = objectUrl(key, true)
        url.search = new URLSearchParams({alt: 'media', generation: stat.observedVersion}).toString()
        const response = await send(url, signal)
        if (response.status === 404 && attempt === 0) {
          await response.body?.cancel().catch(() => undefined)
          continue
        }
        await checkStatus(response, signal)
        if (response.status !== 200 || !response.body) throw storeError('invalidResponse', response.status)
        const body = await boundedBody(response.body, maxBytes, signal, stat.byteLength)
        const bytes = new Uint8Array(await body.arrayBuffer())
        checkCancellation(signal)
        return {body: bytes, token: JSON.stringify(['write', bucket, key, stat.observedVersion])}
      }
      throw storeError('invalidResponse')
    },
    async write(key, body, condition, options) {
      checkKey(key)
      const matched = condition.kind === 'create' ? '0' : generation(opaque(condition.token, bucket, key, 'write'))
      const signal = requestSignal(options?.signal)
      const url = new URL('/upload' + basePath, origin)
      url.search = new URLSearchParams({uploadType: 'multipart', ifGenerationMatch: matched, fields: 'generation'}).toString()
      const boundary = 'minnelux-' + crypto.randomUUID()
      const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(body.type) ? body.type : 'application/octet-stream'
      const envelopeType = 'multipart/related; boundary=' + boundary
      const envelope = new Blob([
        '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n',
        JSON.stringify({name: key, contentType}),
        '\r\n--' + boundary + '\r\nContent-Type: ' + contentType + '\r\n\r\n', body,
        '\r\n--' + boundary + '--\r\n',
      ], {type: envelopeType})
      const response = await send(url, signal, {method: 'POST', body: envelope, headers: {'Content-Type': envelopeType}})
      await checkStatus(response, signal)
      return {observedVersion: generation((await json(response, signal)).generation)}
    },
  }
}
