import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGcsStore } from './gcs.mjs'

test('pins a media fetch to the generation read from object metadata', async () => {
  const requests = []
  const store = createGcsStore('minnelux-test', () => 'fixture-token', {
    fetch: async (url, options) => {
      requests.push({ url, options })
      if (url.searchParams.get('alt') === 'media') {
        return new Response('fixture bytes', { headers: { 'Content-Type': 'text/plain' } })
      }
      return Response.json({ generation: '12345678901234567', size: '13' })
    },
  })
  const result = await store.get('library/album & date/example.jpg')
  assert.equal(await result.body.text(), 'fixture bytes')
  assert.equal(result.generation, '12345678901234567')
  assert.equal(decodeURIComponent(requests[0].url.pathname.split('/').at(-1)), 'library/album & date/example.jpg')
  assert.equal(requests[1].url.searchParams.get('generation'), result.generation)
  assert.ok(requests.every(({ options }) => options.headers.get('Authorization') === 'Bearer fixture-token'))
})

test('writes with a generation precondition and surfaces safe HTTP errors', async () => {
  const store = createGcsStore('minnelux-test', () => 'fixture-token', {
    fetch: async (url, options) => {
      assert.equal(url.searchParams.get('ifGenerationMatch'), '0')
      assert.equal(url.searchParams.get('uploadType'), 'multipart')
      assert.equal(url.searchParams.has('name'), false)
      assert.match(options.headers.get('Content-Type'), /^multipart\/related; boundary=/)
      assert.match(await options.body.text(), /"name":"library\/head.json","contentType":"application\/json"/)
      return new Response('private payload', { status: 412 })
    },
  })
  await assert.rejects(
    store.put('library/head.json', new Blob(['{}'], { type: 'application/json' }), { match: '0' }),
    { status: 412, message: 'Cloud Storage returned HTTP 412' },
  )
})

test('returns null for absent objects and refuses missing write conditions', async () => {
  const store = createGcsStore('minnelux-test', () => 'fixture-token', {
    fetch: async () => new Response(null, { status: 404 }),
  })
  assert.equal(await store.get('library/head.json'), null)
  await assert.rejects(store.put('library/head.json', new Blob(['{}'])), /precondition/)
})

test('limits the editor token to library objects and replacement of the exact head', async () => {
  const { downscopeGcsToken } = await import('./gcs.mjs')
  const token = await downscopeGcsToken('source-fixture', 'minnelux-test', 'library', 'editor', {
    fetch: async (url, options) => {
      assert.equal(url, 'https://sts.googleapis.com/v1/token')
      assert.equal(options.body.get('subject_token'), 'source-fixture')
      const { accessBoundary: { accessBoundaryRules } } = JSON.parse(options.body.get('options'))
      assert.equal(accessBoundaryRules.length, 2)
      assert.deepEqual(accessBoundaryRules[0].availablePermissions, [
        'inRole:roles/storage.objectViewer', 'inRole:roles/storage.objectCreator',
      ])
      assert.match(accessBoundaryRules[0].availabilityCondition.expression, /\/objects\/library\//)
      assert.equal(accessBoundaryRules[1].availabilityCondition.expression,
        "resource.name == 'projects/_/buckets/minnelux-test/objects/library/head.json'")
      return Response.json({ access_token: 'scoped-fixture' })
    },
  })
  assert.equal(token, 'scoped-fixture')
})

test('rejects an oversized object before requesting its media generation', async () => {
  const requests = []
  const store = createGcsStore('minnelux-test', () => 'fixture-token', {
    fetch: async url => {
      requests.push(url.searchParams.get('alt') ?? 'metadata')
      if (!url.searchParams.has('alt')) return Response.json({ generation: '3', size: '65537' })
      return new Response(new Uint8Array(65537))
    },
  })
  await assert.rejects(store.get('library/head.json', { maxBytes: 65536 }), { code: 'corrupt' })
  assert.deepEqual(requests, ['metadata'])
})

test('cancels the media stream when it exceeds the observed size', async () => {
  let reads = 0
  let cancelled = false
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(3))
      if (++reads === 20) controller.close()
    },
    cancel() { cancelled = true },
  })
  const store = createGcsStore('minnelux-test', () => 'fixture-token', {
    fetch: async url => url.searchParams.has('alt')
      ? new Response(stream)
      : Response.json({ generation: '3', size: '4' }),
  })
  await assert.rejects(store.get('library/head.json', { maxBytes: 8 }), { code: 'corrupt' })
  assert.equal(cancelled, true)
  assert.ok(reads < 20)
})

test('resumes a conditional large upload from the byte offset GCS reports', async () => {
  const body = new Blob([new Uint8Array(17 * 1024 ** 2)], { type: 'image/jpeg' })
  const ranges = []
  const store = createGcsStore('minnelux-test', async () => 'fixture-token', {
    resumable: true,
    fetch: async (url, request) => {
      if (request.method === 'POST') {
        assert.equal(url.searchParams.get('uploadType'), 'resumable')
        assert.equal(url.searchParams.get('ifGenerationMatch'), '0')
        assert.deepEqual(JSON.parse(request.body), { name: 'library/large.jpg', contentType: 'image/jpeg' })
        return new Response(null, { headers: { location: 'https://storage.googleapis.com/upload/session?upload_id=fixture' } })
      }
      assert.equal(request.method, 'PUT')
      assert.equal(new URL(url).origin, 'https://storage.googleapis.com')
      const range = new Headers(request.headers).get('Content-Range')
      ranges.push(range)
      if (ranges.length === 1) throw new TypeError('Interrupted upload')
      if (ranges.length < 4) {
        return new Response(null, { status: 308, headers: {
          range: ranges.length === 2 ? 'bytes=0-4194303' : 'bytes=0-12582911',
        } })
      }
      return Response.json({ generation: '12345' })
    },
  })
  assert.deepEqual(await store.put('library/large.jpg', body, { match: '0' }), { generation: '12345' })
  assert.deepEqual(ranges, [
    'bytes 0-8388607/17825792', 'bytes */17825792',
    'bytes 4194304-12582911/17825792', 'bytes 12582912-17825791/17825792',
  ])
})

test('can stage a large verified response on disk and release it after the read', async t => {
  const { createWriteStream, openAsBlob } = await import('node:fs')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Readable } = await import('node:stream')
  const { pipeline } = await import('node:stream/promises')
  const directory = await mkdtemp(join(tmpdir(), 'minnelux-gcs-fixture-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'object')
  const size = 17 * 1024 ** 2
  let remaining = size
  const store = createGcsStore('minnelux-test', () => 'synthetic', {
    fetch: async url => {
      if (!url.searchParams.has('alt')) return Response.json({ generation: '9', size: String(size) })
      return new Response(new ReadableStream({
        pull(controller) {
          if (!remaining) return controller.close()
          const chunk = new Uint8Array(Math.min(remaining, 1024 ** 2)).fill(42)
          remaining -= chunk.length
          controller.enqueue(chunk)
        },
      }), { headers: { 'Content-Type': 'application/octet-stream' } })
    },
  })
  const object = await store.get('library/originals/fixture', {
    maxBytes: size,
    stageBody: async (bytes, type) => {
      await pipeline(Readable.fromWeb(bytes), createWriteStream(path))
      return { body: await openAsBlob(path, { type }), dispose: () => rm(path) }
    },
  })
  assert.equal(object.generation, '9')
  assert.equal(object.body.size, size)
  assert.deepEqual(await object.body.slice(-2).bytes(), new Uint8Array([42, 42]))
  await object.dispose()
})

test('rejects resume status beyond any attempted upload bytes', async () => {
  const body = new Blob([new Uint8Array(17 * 1024 ** 2)])
  for (const [status, message] of [
    [new Response(null, { status: 308, headers: { range: 'bytes=0-9000000' } }), /invalid upload offset/],
    [Response.json({ generation: '3' }), /before the final chunk/],
  ]) {
    let calls = 0
    const store = createGcsStore('minnelux-test', () => 'synthetic', {
      resumable: true,
      fetch: async (url, request) => {
        if (request.method === 'POST') {
          return new Response(null, { headers: { location: 'https://storage.googleapis.com/upload/session' } })
        }
        if (++calls === 1) throw new TypeError('Interrupted first chunk')
        assert.equal(new Headers(request.headers).get('Content-Range'), 'bytes */17825792')
        return status
      },
    })
    await assert.rejects(store.put('library/originals/fixture', body, { match: '0' }), message)
    assert.equal(calls, 2)
  }
})
