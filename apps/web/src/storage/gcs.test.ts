import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGcsStore } from './gcs.ts'

const key = 'library/album #1/head.json'
const metadata = (generation: string) => Response.json({generation, size: '4', contentType: 'application/json'})
const missing = (message = 'Not Found') => Response.json({
  error: {code: 404, message, errors: [{reason: 'notFound', message}]},
}, {status: 404})

test('observes a replacement race without pairing current bytes with a stale token', async () => {
  let metadataReads = 0
  const store = createGcsStore('private-bucket', () => 'example', {fetch: async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.pathname.replace(/^\/download/, ''), '/storage/v1/b/private-bucket/o/library%2Falbum%20%231%2Fhead.json')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer example')
    assert.equal(init?.cache, 'no-store')
    if (!url.searchParams.has('alt')) return metadata(String(++metadataReads))
    const generation = url.searchParams.get('generation')
    if (generation === '1') return missing()
    assert.equal(generation, '2')
    return new Response('next')
  }})
  const current = await store.readForUpdate(key, {maxBytes: 4})
  assert.equal(new TextDecoder().decode(current?.body), 'next')
  assert.equal(metadataReads, 2)
})

test('keeps absence, denial, malformed absence, and bounded reads distinct', async () => {
  let response = missing('No such object: private-bucket/' + key)
  const store = createGcsStore('private-bucket', () => 'example', {fetch: async () => response})
  assert.equal(await store.readForUpdate(key, {maxBytes: 4}), null)
  response = new Response(null, {status: 403})
  await assert.rejects(store.readForUpdate(key, {maxBytes: 4}), {code:'denied'})
  response = missing("The specified bucket does not exist.")
  await assert.rejects(store.readForUpdate(key, {maxBytes: 4}), {code:'invalidResponse'})
  response = metadata('1')
  await assert.rejects(store.readForUpdate(key, {maxBytes: 3}), {code:'limit'})
})

test('uses bound opaque tokens for conditional writes and provider cursors', async () => {
  const preconditions: string[] = []
  const store = createGcsStore('private-bucket', () => 'example', {fetch: async (input, init) => {
    const url = new URL(String(input))
    if (init?.method === 'POST') {
      const generation = url.searchParams.get('ifGenerationMatch')!
      preconditions.push(generation)
      assert.match(await (init.body as Blob).text(), /library\/album #1\/head.json/)
      if (generation === '2') return Response.json({error: {errors: [{reason: 'conditionNotMet'}]}}, {status: 412})
      return Response.json({generation: '2'})
    }
    if (!url.pathname.endsWith('/o')) return url.searchParams.has('alt') ? new Response('head') : metadata('2')
    if (!url.searchParams.has('pageToken')) return Response.json({
      items: [{name: 'library/ü.txt', size: '1', generation: '2'}], nextPageToken: 'encoded=/+',
    })
    assert.equal(url.searchParams.get('pageToken'), 'encoded=/+')
    return Response.json({items: []})
  }})
  await store.write(key, new Blob(['head']), {kind: 'create'})
  const head = await store.readForUpdate(key, {maxBytes: 4})
  const match = {kind: 'match', token: head!.token} as const
  await assert.rejects(store.write(key, new Blob(['new']), match), {code: 'conflict'})
  await assert.rejects(store.write('another-key', new Blob(['new']), match), {code: 'invalidResponse'})
  assert.deepEqual(preconditions, ['0', '2'])

  const first = await store.list('library/')
  assert.equal(first.entries[0]?.key, 'library/ü.txt')
  assert.ok(first.nextCursor)
  await assert.rejects(store.list('elsewhere/', {cursor: first.nextCursor}), {code: 'invalidResponse'})
  assert.deepEqual(await store.list('library/', {cursor: first.nextCursor}), {entries: []})
})

test('reads a valid private range and rejects incorrect response semantics', async () => {
  let response = new Response('bc', {status: 206, headers: {
    'Content-Range': 'bytes 1-2/4', 'Content-Length': '2', 'Content-Type': 'image/jpeg',
  }})
  const store = createGcsStore('private-bucket', () => 'example', {fetch: async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('range'), 'bytes=1-2')
    return response
  }})
  const range = {start: 1, endInclusive: 2}
  const result = await store.read(key, {range})
  assert.deepEqual(result.range, {...range, objectByteLength: 4})
  assert.equal(await new Response(result.body).text(), 'bc')
  response = new Response('abcd')
  await assert.rejects(store.read(key, {range}), {code:'invalidResponse'})
  response = new Response('c', {status: 206, headers: {'Content-Range': 'bytes 2-2/4'}})
  await assert.rejects(store.read(key, {range}), {code:'invalidResponse'})
  response = new Response('b', {status: 206, headers: {'Content-Range': 'bytes 1-2/4'}})
  const short = await store.read(key, {range})
  await assert.rejects(new Response(short.body).text(), {code:'invalidResponse'})
})

test('rejects a late response from an invalidated session', async () => {
  const controller = new AbortController()
  const store = createGcsStore('private-bucket', () => 'example', {
    signal: controller.signal,
    fetch: async () => {
      controller.abort()
      return new Response('private')
    },
  })
  await assert.rejects(store.read(key), {code: 'aborted'})
})
