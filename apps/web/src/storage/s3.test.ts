import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createS3Store } from './s3.ts'

const key = 'library/album #1/head.json'
const bucket = 'private-bucket'
const region = 'us-east-1'
const credentials = {accessKeyId: 'testing-key', secretAccessKey: 'testing-secret', sessionToken: 'testing-token'}

function reply(statusCode: number, body?: string, headers: Record<string, string> = {}) {
  return {response: {statusCode, headers, body: body === undefined ? undefined : new Response(body).body}}
}

function errorReply(status: number, code: string) {
  return reply(status, `<Error><Code>${code}</Code><Message>provider details</Message></Error>`)
}

type Handle = (request: {
  method: string
  hostname: string
  path: string
  headers: Record<string, string | undefined>
  query?: Record<string, string | undefined>
  body?: Blob
}, options?: {abortSignal?: AbortSignal}) => Promise<{
  response: {statusCode: number; headers: Record<string, string>; body?: ReadableStream<Uint8Array> | null}
}>

function transport(handle: Handle) {
  return {handle, destroy() {}}
}

test('uses one GET for head bytes and echoes its exact quoted ETag on a conditional replacement', async () => {
  const requests: string[] = []
  const store = createS3Store(bucket, region, () => credentials, {requestHandler: transport(async request => {
    requests.push(request.method)
    assert.equal(request.hostname, 'private-bucket.s3.us-east-1.amazonaws.com')
    assert.equal(request.path, '/library/album%20%231/head.json')
    assert.equal(request.headers['x-amz-security-token'], 'testing-token')
    if (request.method === 'GET') {
      return reply(200, 'head', {'content-length': '4', etag: '"first-2"'})
    }
    assert.equal(request.headers['if-match'], '"first-2"')
    assert.equal(request.headers['content-type'], 'application/json')
    assert.equal(await new Response(request.body).text(), 'next')
    return reply(200, undefined, {etag: '"second"'})
  })})
  const head = await store.readForUpdate(key, {maxBytes: 4})
  assert.ok(head)
  assert.equal(new TextDecoder().decode(head.body), 'head')
  assert.deepEqual(await store.write(key, new Blob(['next'], {type: 'application/json'}), {kind: 'match', token: head.token}),
    {observedVersion: '"second"'})
  await assert.rejects(store.write('other/head.json', new Blob(), {kind: 'match', token: head.token}), {code: 'invalidResponse'})
  assert.deepEqual(requests, ['GET', 'PUT'])
})

test('distinguishes confirmed absence from denial and provider expiry', async () => {
  let response = errorReply(404, 'NoSuchKey')
  const store = createS3Store(bucket, region, () => credentials, {requestHandler: transport(async () => response)})
  assert.equal(await store.readForUpdate(key, {maxBytes: 4}), null)
  response = errorReply(404, 'NoSuchBucket')
  await assert.rejects(store.readForUpdate(key, {maxBytes: 4}), {code: 'invalidResponse', status: 404})
  response = reply(404)
  await assert.rejects(store.stat(key), {code: 'missing', status: 404})
  await assert.rejects(store.readForUpdate(key, {maxBytes: 4}), {code: 'invalidResponse', status: 404})
  response = errorReply(403, 'AccessDenied')
  await assert.rejects(store.readForUpdate(key, {maxBytes: 4}), {code: 'denied', status: 403, message: 'denied'})
  for (const [status, code] of [[400, 'ExpiredToken'], [400, 'InvalidToken'],
    [403, 'InvalidAccessKeyId'], [403, 'InvalidSecurity'], [400, 'TokenRefreshRequired']] as const) {
    response = errorReply(status, code)
    await assert.rejects(store.readForUpdate(key, {maxBytes: 4}), {code: 'expired', status, message: 'expired'})
  }
})

test('bounds head bytes even without length metadata and rejects malformed head metadata', async () => {
  let response = reply(200, 'head', {etag: '"head"'})
  const store = createS3Store(bucket, region, () => credentials, {requestHandler: transport(async () => response)})
  await assert.rejects(store.readForUpdate(key, {maxBytes: 3}), {code: 'limit'})
  response = reply(200, 'head', {'content-length': '4', etag: '"head"'})
  await assert.rejects(store.readForUpdate(key, {maxBytes: 3}), {code: 'limit'})
  response = reply(200, 'he', {'content-length': '4', etag: '"head"'})
  await assert.rejects(store.readForUpdate(key, {maxBytes: 4}), {code: 'invalidResponse'})
  response = reply(200, 'head', {'content-length': '4', etag: 'head'})
  await assert.rejects(store.readForUpdate(key, {maxBytes: 4}), {code: 'invalidResponse'})
})

test('uses create-only writes and surfaces ambiguous conditional conflicts without retrying', async () => {
  let response = errorReply(412, 'PreconditionFailed')
  let count = 0
  const store = createS3Store(bucket, region, () => credentials, {requestHandler: transport(async request => {
    count++
    assert.equal(request.headers['if-none-match'], '*')
    return response
  })})
  const write = () => store.write(key, new Blob(['head']), {kind: 'create'})
  await assert.rejects(write(), {code: 'conflict', status: 412})
  response = errorReply(409, 'ConditionalRequestConflict')
  await assert.rejects(write(), {code: 'transport', status: 409})
  response = errorReply(503, 'SlowDown')
  await assert.rejects(write(), {code: 'transport', status: 503})
  assert.equal(count, 3)
})

test('rejects a malformed successful listing instead of returning an empty page', async () => {
  let xml = '<NotAListing/>'
  const store = createS3Store(bucket, region, () => credentials, {requestHandler: transport(async () => reply(200, xml))})
  await assert.rejects(store.list('library/'), {code: 'invalidResponse'})
  xml = '<ListBucketResult><Name>' + bucket + '</Name><Prefix>other%2F</Prefix>' +
    '<EncodingType>url</EncodingType><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>'
  await assert.rejects(store.list('library/'), {code: 'invalidResponse'})
})

test('preserves S3 pagination and scope and reads object metadata with HEAD', async () => {
  const store = createS3Store(bucket, region, () => credentials, {requestHandler: transport(async request => {
    if (request.method === 'HEAD') return reply(200, undefined, {
      etag: '"found"', 'content-length': '4', 'content-type': 'image/jpeg',
    })
    assert.equal(request.query?.prefix, 'library/')
    assert.equal(request.query?.['encoding-type'], 'url')
    const listing = '<ListBucketResult><Name>' + bucket + '</Name><Prefix>library%2F</Prefix><EncodingType>url</EncodingType>'
    if (request.query?.['continuation-token'] === undefined) {
      return reply(200, listing + '<KeyCount>1</KeyCount><IsTruncated>true</IsTruncated>' +
        '<NextContinuationToken>encoded=/+</NextContinuationToken>' +
        '<Contents><Key>library%2F%C3%BC%2B%25.jpg</Key><Size>4</Size><ETag>"found"</ETag></Contents></ListBucketResult>')
    }
    assert.equal(request.query['continuation-token'], 'encoded=/+')
    return reply(200, listing + '<KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>')
  })})
  const first = await store.list('library/')
  assert.deepEqual(first.entries, [{key: 'library/ü+%.jpg', byteLength: 4, observedVersion: '"found"'}])
  assert.ok(first.nextCursor)
  await assert.rejects(store.list('other/', {cursor: first.nextCursor}), {code: 'invalidResponse'})
  assert.deepEqual(await store.list('library/', {cursor: first.nextCursor}), {entries: []})
  assert.deepEqual(await store.stat(key), {byteLength: 4, mimeType: 'image/jpeg', observedVersion: '"found"'})
})

test('validates the declared full body and the status, offsets, and length of ranges', async () => {
  let rangeRequested: string | undefined
  let response = reply(206, 'bc', {'content-range': 'bytes 1-2/4', 'content-length': '2', 'content-type': 'image/jpeg'})
  const store = createS3Store(bucket, region, () => credentials, {requestHandler: transport(async request => {
    rangeRequested = request.headers.range
    return response
  })})
  const range = {start: 1, endInclusive: 2}
  const result = await store.read(key, {range})
  assert.equal(rangeRequested, 'bytes=1-2')
  assert.deepEqual(result.range, {...range, objectByteLength: 4})
  assert.equal(await new Response(result.body).text(), 'bc')
  response = reply(200, 'abcd')
  await assert.rejects(store.read(key, {range}), {code: 'invalidResponse'})
  response = reply(206, 'bc', {'content-range': 'bytes 2-3/4'})
  await assert.rejects(store.read(key, {range}), {code: 'invalidResponse'})
  response = reply(206, 'b', {'content-range': 'bytes 1-2/4'})
  const short = await store.read(key, {range})
  await assert.rejects(new Response(short.body).text(), {code: 'invalidResponse'})
  response = reply(200, 'abc', {'content-length': '4'})
  const full = await store.read(key)
  assert.equal(rangeRequested, undefined)
  await assert.rejects(new Response(full.body).text(), {code: 'invalidResponse'})
})

test('checks active credentials each time and rejects a late response from an aborted session', async () => {
  let activeCredentials: typeof credentials | null = credentials
  const session = new AbortController()
  let requests = 0
  const store = createS3Store(bucket, region, () => activeCredentials, {
    signal: session.signal,
    requestHandler: transport(async (request, {abortSignal} = {}) => {
      requests++
      assert.equal(request.headers['x-amz-security-token'], 'updated-token')
      session.abort()
      assert.equal(abortSignal?.aborted, true)
      return reply(200, 'private')
    }),
  })
  activeCredentials = null
  await assert.rejects(store.read(key), {code: 'expired'})
  activeCredentials = {...credentials, sessionToken: 'updated-token'}
  await assert.rejects(store.read(key), {code: 'aborted'})
  assert.equal(requests, 1)
})

test('normalizes interruptions after the response starts streaming', async () => {
  const session = new AbortController()
  const caller = new AbortController()
  let bodyController: ReadableStreamDefaultController<Uint8Array>
  let requestSignal: Parameters<Handle>[1]
  const store = createS3Store(bucket, region, () => credentials, {
    signal: session.signal,
    requestHandler: transport(async (_request, options) => {
      requestSignal = options
      return {response: {statusCode: 200, headers: {}, body: new ReadableStream<Uint8Array>({
        start(controller) { bodyController = controller },
      })}}
    }),
  })
  const response = await store.read(key)
  bodyController!.error(new Error('private transport details'))
  await assert.rejects(new Response(response.body).arrayBuffer(), {code: 'transport', message: 'transport'})

  const next = await store.read(key, {signal: caller.signal})
  const read = new Response(next.body).arrayBuffer()
  caller.abort(new Error('private cancellation details'))
  assert.equal(requestSignal!.abortSignal?.aborted, true)
  await assert.rejects(read, {code: 'aborted', message: 'aborted'})
})

test('fails a stream read started after the session has ended', async () => {
  const session = new AbortController()
  const store = createS3Store(bucket, region, () => credentials, {
    signal: session.signal,
    requestHandler: transport(async () => reply(200, 'private')),
  })
  const result = await store.read(key)
  await new Promise<void>(resolve => setImmediate(resolve))
  session.abort()
  await assert.rejects(result.body.getReader().read(), {code: 'aborted'})
})
