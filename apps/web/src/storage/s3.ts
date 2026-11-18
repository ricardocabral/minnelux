import {
  GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3'
import type { GetObjectCommandOutput, S3ClientConfig } from '@aws-sdk/client-s3'
import type { ObjectStore, StoreErrorCode } from './contract.ts'
import { checkCancellation, lengthBound, record, storeError } from './io.ts'

export type S3Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken: string }

const bucketName = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const regionName = /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/
const rejectedCredentials = new Set([
  'ExpiredToken', 'ExpiredTokenException', 'InvalidAccessKeyId', 'InvalidSecurity', 'InvalidToken', 'TokenRefreshRequired',
])
const quotedTag = /^"[\x21\x23-\x7e\x80-\xff]+"$/

function checkKey(key: string): void {
  // Fetch normalizes dot path segments, which could address a different object.
  if (!key || /[\u0000\r\n]/.test(key) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(key)) throw storeError('invalidResponse')
}

function decodeListedKey(value: string | undefined): string {
  if (value === undefined) throw storeError('invalidResponse')
  try {
    return decodeURIComponent(value)
  } catch {
    throw storeError('invalidResponse')
  }
}

function byteLength(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) throw storeError('invalidResponse')
  return value
}

function etag(value: string | undefined): string {
  if (!value || !quotedTag.test(value)) throw storeError('invalidResponse')
  return value
}

function providerError(error: unknown, operation?: 'stat' | 'write') {
  const details = record(error) ? error : {}
  const metadata = record(details.$metadata) ? details.$metadata : {}
  const status = typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined
  const name = details.name
  let code: StoreErrorCode = 'invalidResponse'
  if (status === 404 && (name === 'NoSuchKey' || (operation === 'stat' && name === 'NotFound'))) code = 'missing'
  else if (status === 401 || (typeof name === 'string' && rejectedCredentials.has(name))) code = 'expired'
  else if (status === 403) code = 'denied'
  else if (operation === 'write' && status === 412 && name === 'PreconditionFailed') code = 'conflict'
  else if (status === 413 || name === 'EntityTooLarge') code = 'limit'
  else if (status === undefined || status === 408 || status === 409 || status === 429 || status >= 500) code = 'transport'
  return storeError(code, status)
}

function responseBody(output: GetObjectCommandOutput, signal?: AbortSignal): ReadableStream<Uint8Array> {
  if (!output.Body) {
    checkCancellation(signal)
    throw storeError('invalidResponse', output.$metadata.httpStatusCode)
  }
  return output.Body.transformToWebStream()
}

function checkedBody(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  size?: number,
  maxBytes = Number.MAX_SAFE_INTEGER,
): ReadableStream<Uint8Array> {
  const reader = lengthBound(body, maxBytes, signal, size).getReader()
  // Pull only on demand so queued bytes cannot survive session cancellation.
  return new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        checkCancellation(signal)
        if (chunk.done) controller.close()
        else controller.enqueue(chunk.value)
      } catch (error) {
        checkCancellation(signal)
        if (record(error) && (error.code === 'limit' || error.code === 'invalidResponse')) throw error
        throw storeError('transport')
      }
    },
    cancel(reason) { return reader.cancel(reason) },
  }, {highWaterMark: 0})
}

export function createS3Store(
  bucket: string,
  region: string,
  getCredentials: () => S3Credentials | null,
  {signal: sessionSignal, requestHandler}: {signal?: AbortSignal; requestHandler?: S3ClientConfig['requestHandler']} = {},
): ObjectStore & {libraryId: string} {
  if (!bucketName.test(bucket) || !regionName.test(region)) throw storeError('invalidResponse')
  const libraryId = 's3://' + bucket
  const target = region + '/' + bucket
  const requestSignal = (signal?: AbortSignal) =>
    signal && sessionSignal ? AbortSignal.any([signal, sessionSignal]) : signal ?? sessionSignal
  let connection: {credentials: S3Credentials; client: S3Client} | undefined

  function scopedValue(token: string, kind: 'list' | 'write', scope: string): string {
    let parts: unknown
    try {
      parts = JSON.parse(token)
    } catch {
      throw storeError('invalidResponse')
    }
    if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== kind ||
        parts[1] !== target || parts[2] !== scope || typeof parts[3] !== 'string' || !parts[3]) {
      throw storeError('invalidResponse')
    }
    return parts[3]
  }

  function activeClient(signal?: AbortSignal): S3Client {
    checkCancellation(signal)
    const credentials = getCredentials()
    if (!credentials) throw storeError('expired')
    if (!connection || connection.credentials.accessKeyId !== credentials.accessKeyId ||
        connection.credentials.secretAccessKey !== credentials.secretAccessKey ||
        connection.credentials.sessionToken !== credentials.sessionToken) {
      connection = {
        credentials: {...credentials},
        client: new S3Client({
          region, credentials: {...credentials}, maxAttempts: 1,
          requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
          requestHandler: requestHandler ?? {
            credentials: 'omit', cache: 'no-store',
            requestInit: () => ({redirect: 'error', referrerPolicy: 'no-referrer'}),
          },
        }),
      }
    }
    return connection.client
  }

  async function send<T>(
    dispatch: (client: S3Client) => Promise<T>,
    signal?: AbortSignal,
    operation?: 'stat' | 'write',
  ): Promise<T> {
    const client = activeClient(signal)
    try {
      return await dispatch(client)
    } catch (error) {
      checkCancellation(signal)
      throw providerError(error, operation)
    }
  }

  async function get(key: string, signal?: AbortSignal, range?: string) {
    checkKey(key)
    const output = await send(client => client.send(new GetObjectCommand({
      Bucket: bucket, Key: key, Range: range,
    }), {abortSignal: signal}), signal)
    const body = responseBody(output, signal)
    try {
      checkCancellation(signal)
      const status = output.$metadata.httpStatusCode
      if (status !== (range ? 206 : 200) || (!range && output.ContentRange !== undefined)) {
        throw storeError('invalidResponse', status)
      }
      const size = output.ContentLength === undefined ? undefined : byteLength(output.ContentLength)
      return {output, body, size}
    } catch (error) {
      await body.cancel().catch(() => undefined)
      throw error
    }
  }

  return {
    libraryId,
    async list(prefix, options) {
      const signal = requestSignal(options?.signal)
      const cursor = options?.cursor === undefined ? undefined : scopedValue(options.cursor, 'list', prefix)
      const result = await send(client => client.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, ContinuationToken: cursor, EncodingType: 'url',
      }), {abortSignal: signal}), signal)
      checkCancellation(signal)
      const objects = result.Contents ?? []
      if (result.$metadata.httpStatusCode !== 200 || result.Name !== bucket ||
          result.EncodingType !== 'url' || decodeListedKey(result.Prefix ?? '') !== prefix ||
          result.KeyCount !== objects.length || typeof result.IsTruncated !== 'boolean') {
        throw storeError('invalidResponse')
      }
      const entries = objects.map(item => {
        const key = decodeListedKey(item.Key)
        if (!key.startsWith(prefix)) throw storeError('invalidResponse')
        checkKey(key)
        return {
          key, byteLength: byteLength(item.Size),
          ...(item.ETag === undefined ? {} : {observedVersion: etag(item.ETag)}),
        }
      })
      const next = result.NextContinuationToken
      if (result.IsTruncated !== Boolean(next) || (next !== undefined && (!next || next === cursor))) {
        throw storeError('invalidResponse')
      }
      return {entries, ...(next ? {nextCursor: JSON.stringify(['list', target, prefix, next])} : {})}
    },
    async stat(key, options) {
      checkKey(key)
      const signal = requestSignal(options?.signal)
      const result = await send(client => client.send(new HeadObjectCommand({
        Bucket: bucket, Key: key,
      }), {abortSignal: signal}), signal, 'stat')
      checkCancellation(signal)
      return {
        byteLength: byteLength(result.ContentLength),
        ...(result.ContentType ? {mimeType: result.ContentType} : {}),
        ...(result.ETag === undefined ? {} : {observedVersion: etag(result.ETag)}),
      }
    },
    async read(key, options) {
      const signal = requestSignal(options?.signal)
      const requested = options?.range
      const expectedBytes = requested ? requested.endInclusive - requested.start + 1 : 0
      if (requested && (!Number.isSafeInteger(requested.start) || requested.start < 0 ||
          !Number.isSafeInteger(requested.endInclusive) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1)) {
        throw storeError('invalidResponse')
      }
      const {output, body, size} = await get(key, signal, requested && 'bytes=' + requested.start + '-' + requested.endInclusive)
      const mimeType = output.ContentType?.split(';')[0]?.trim()
      if (requested) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(output.ContentRange ?? '')
        const objectByteLength = Number(match?.[3])
        if (!match || Number(match[1]) !== requested.start || Number(match[2]) !== requested.endInclusive ||
            !Number.isSafeInteger(objectByteLength) || objectByteLength <= requested.endInclusive ||
            (size !== undefined && size !== expectedBytes)) {
          await body.cancel().catch(() => undefined)
          throw storeError('invalidResponse', output.$metadata.httpStatusCode)
        }
        return {
          body: checkedBody(body, signal, expectedBytes),
          byteLength: expectedBytes, range: {...requested, objectByteLength}, ...(mimeType ? {mimeType} : {}),
        }
      }
      return {
        body: checkedBody(body, signal, size),
        ...(size === undefined ? {} : {byteLength: size}), ...(mimeType ? {mimeType} : {}),
      }
    },
    async readForUpdate(key, {maxBytes, signal: callerSignal}) {
      byteLength(maxBytes)
      const signal = requestSignal(callerSignal)
      let observed
      try {
        observed = await get(key, signal)
      } catch (error) {
        if (record(error) && error.code === 'missing') return null
        throw error
      }
      const {output, body, size} = observed
      let tag
      try {
        tag = etag(output.ETag)
        if (size !== undefined && size > maxBytes) throw storeError('limit')
      } catch (error) {
        await body.cancel().catch(() => undefined)
        throw error
      }
      const bytes = new Uint8Array(await new Response(checkedBody(body, signal, size, maxBytes)).arrayBuffer())
      checkCancellation(signal)
      return {body: bytes, token: JSON.stringify(['write', target, key, tag])}
    },
    async write(key, body, condition, options) {
      checkKey(key)
      const signal = requestSignal(options?.signal)
      const precondition = condition.kind === 'create'
        ? {IfNoneMatch: '*'}
        : {IfMatch: etag(scopedValue(condition.token, 'write', key))}
      const result = await send(client => client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentType: body.type || 'application/octet-stream', ...precondition,
      }), {abortSignal: signal}), signal, 'write')
      checkCancellation(signal)
      return result.ETag === undefined ? {} : {observedVersion: etag(result.ETag)}
    },
  }
}
