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
