import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { queryCatalog } from '../search/search.ts'
import type { ObjectStore } from '../storage/contract.ts'
import { storeError } from '../storage/io.ts'
import { resolveAlbumCover } from './catalog.ts'
import type { LibraryIntent } from './contract.ts'
import { createLibraryRepository } from './repository.ts'

type Stored = {body: Blob; token: string}
type Descriptor = {key: string; byteLength: number; sha256: string}

function memoryStore() {
  const objects = new Map<string, Stored>()
  const trace: string[] = []
  const hooks: {
    beforeWrite?: (key: string) => Promise<void>
    afterWrite?: (key: string) => Promise<void>
  } = {}
  let generation = 100
  const store: ObjectStore = {
    async list() { throw Error('unexpected listing') },
    async stat(key) {
      const obj = objects.get(key)
      if (!obj) throw storeError('missing')
      return {byteLength: obj.body.size, observedVersion: obj.token, mimeType: obj.body.type}
    },
    async read(key) {
      trace.push(key)
      const obj = objects.get(key)
      if (!obj) throw storeError('missing')
      return {body: obj.body.stream(), mimeType: obj.body.type}
    },
    async readForUpdate(key, {maxBytes}) {
      trace.push(key)
      const obj = objects.get(key)
      if (!obj) return null
      if (obj.body.size > maxBytes) throw storeError('limit')
      return {body: new Uint8Array(await obj.body.arrayBuffer()), token: obj.token}
    },
    async write(key, body, condition) {
      await hooks.beforeWrite?.(key)
      const obj = objects.get(key)
      if (condition.kind === 'create' ? obj : obj?.token !== condition.token) throw storeError('conflict')
      const token = String(++generation)
      objects.set(key, {body, token})
      await hooks.afterWrite?.(key)
      return {observedVersion: token}
    },
  }
  return {objects, trace, hooks, store}
}

const headKey = 'library/head.json'
const jpeg = await readFile(new URL('../../../../spikes/flickr/fixtures/photo.jpg', import.meta.url))
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function fixtureStore() {
  const fixture = memoryStore()
  const records = JSON.parse(await readFile(new URL('./fixtures/flickr-v1.json', import.meta.url), 'utf8')) as
    Record<string, {base64: string; generation: string; mimeType: string}>
  for (const [key, value] of Object.entries(records)) {
    fixture.objects.set(key, {body: new Blob([Buffer.from(value.base64, 'base64')], {type: value.mimeType}), token: value.generation})
  }
  return fixture
}

async function readDescriptor(objects: Map<string, Stored>, descriptor: Descriptor): Promise<Buffer> {
  const bytes = Buffer.from(await objects.get('library/' + descriptor.key)!.body.arrayBuffer())
  assert.equal(bytes.byteLength, descriptor.byteLength)
  assert.equal(digest(bytes), descriptor.sha256)
  return bytes
}

async function storedManifest(objects: Map<string, Stored>) {
  const head = JSON.parse(await objects.get(headKey)!.body.text())
  assert.equal(head.version, 1)
  assert.equal(head.manifest.key, 'revisions/' + head.revisionId + '.json')
  return JSON.parse((await readDescriptor(objects, head.manifest)).toString('utf8'))
}

async function snapshotForComparison(objects: Map<string, Stored>, ref: Descriptor) {
  const compressed = await readDescriptor(objects, ref)
  return {key: ref.key.replace(ref.sha256, '{sha256}'), expandedSha256: digest(gunzipSync(compressed))}
}

test('opens the shipped v1 Flickr shape and resolves an album cover only against its own source preview', async () => {
  const {store, objects, trace} = await fixtureStore()
  const count = objects.size
  const repo = createLibraryRepository(store)
  const pin = await repo.open()
  const tag = pin.catalog.tags.find(tag => tag.title === 'Travel')!
  const cover = resolveAlbumCover(pin.catalog, tag.id)
  assert.equal(cover?.source?.sourceKey, 'sample-account')
  assert.equal(cover?.metadata.title, 'Forêt')
  assert.deepEqual(Buffer.from(await (await repo.readPreview(pin, cover!.id))!.arrayBuffer()), jpeg)
  const pending = pin.catalog.tags.find(tag => tag.title === 'Pending cover')!
  assert.equal(resolveAlbumCover(pin.catalog, pending.id), undefined)
  assert.ok(pending.album?.coverPhoto?.sourceUrl)
  const old = pin.catalog.assets.find(asset => asset.source?.photoId === '77')!
  assert.deepEqual(old.metadata, {})
  assert.equal(objects.size, count)
  assert.equal(trace.some(key => key.includes('/index/') || key.includes('/originals/')), false)
})

test('reads a large original without a preview and rejects same-size corruption', async () => {
  const {store, objects} = memoryStore()
  const repository = createLibraryRepository(store)
  const base = await repository.open()
  const bytes = Buffer.concat([jpeg, Buffer.alloc(4 * 1024 * 1024)])
  const result = await repository.publish({
    kind: 'import-photo', baseToken: base.baseToken, operationId: crypto.randomUUID(),
    file: new File([bytes], 'Archive.jpg', {type: 'image/jpeg'}),
    addedAt: '2026-11-18T12:00:00.000Z', tagTitles: [],
  })
  assert.equal(result.status, 'published')

  const pin = await repository.open()
  const [asset] = pin.catalog.assets
  assert.deepEqual(asset!.previews, [])
  const original = await repository.readOriginal(pin, asset!.id)
  assert.equal(original.type, 'image/jpeg')
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes)

  const key = 'library/originals/' + digest(bytes)
  const stored = objects.get(key)!
  const changed = new Blob([stored.body.slice(0, -1), Uint8Array.of(1)])
  objects.set(key, {...stored, body: changed})
  await assert.rejects(repository.readOriginal(pin, asset!.id), {code: 'integrity'})
})

test('upgrades v1 on a targeted edit and preserves metadata, originals, old revisions and Flickr receipts', async t => {
  const {store, objects} = await fixtureStore()
  const before = new Map(objects)
  const expectedManifest = JSON.parse(await readFile(new URL('./fixtures/flickr-v2-manifest.json', import.meta.url), 'utf8'))
  t.mock.method(crypto, 'randomUUID', () => expectedManifest.revisionId)
  const repo = createLibraryRepository(store)
  const pin = await repo.open()
  const asset = pin.catalog.assets.find(asset => asset.metadata.title === 'Forêt')!
  const keyword = pin.catalog.tags.find(tag => tag.title === 'Architecture')!
  const intent = {kind:'set-tag', baseToken:pin.baseToken, operationId:'remove-imported-keyword',
    assetId: asset.id, tagId: keyword.id, present: false} as const
  const published = await repo.publish(intent)
  assert.deepEqual(published, {status:'published', revisionId:expectedManifest.revisionId})
  const freshRepository = createLibraryRepository(store)
  const reopened = await freshRepository.open()
  assert.deepEqual(reopened.catalog.tags, pin.catalog.tags)
  assert.deepEqual(reopened.catalog.assets, pin.catalog.assets.map(row =>
    row.id === asset.id ? {...row, tagIds: row.tagIds.filter(id => id !== keyword.id)} : row))
  const manifest = await storedManifest(objects)
  const sources = await Promise.all(manifest.sources.map(async (row: {binding: {sourceKey: string}; state: Descriptor}) =>
    row.binding.sourceKey === 'sample-account' ? {...row, state: await snapshotForComparison(objects, row.state)} : row))
  assert.deepEqual({
    ...manifest, sources,
    catalog: await snapshotForComparison(objects, manifest.catalog),
    textIndex: await snapshotForComparison(objects, manifest.textIndex),
    tagIndex: await snapshotForComparison(objects, manifest.tagIndex),
  }, expectedManifest)
  for (const [key, value] of before) if (key !== headKey) assert.equal(objects.get(key), value)
  assert.deepEqual(await freshRepository.publish(intent, {mode: 'recover'}), published)
})

test('imports Cafe.jpg with two tags and finds it through persisted postings from a fresh pin', async () => {
  const {store, trace, objects} = memoryStore()
  const repo = createLibraryRepository(store)
  const base = await repo.open()
  const expected = JSON.parse(await readFile(new URL('./fixtures/local-photo.json', import.meta.url), 'utf8')) as
    {operationId: string; filename: string; addedAt: string; tagTitles: string[]; originalSha256: string; assetId: string}
  const {operationId, filename, addedAt, tagTitles} = expected
  const file = new File([jpeg], filename, {type:'image/jpeg'})
  const intent: LibraryIntent = {
    kind: 'import-photo', baseToken: base.baseToken, operationId, file, preview: file, tagTitles, addedAt,
  }
  const outcome = await repo.publish(intent)
  assert.equal(outcome.status, 'published')
  trace.length = 0
  const fresh = createLibraryRepository(store)
  const pin = await fresh.open()
  assert.equal(pin.catalog.assets.length, 1)
  const [photo] = pin.catalog.assets
  assert.equal(photo?.filename, filename)
  assert.equal(photo?.id, expected.assetId)
  assert.deepEqual(Buffer.from(await objects.get('library/' + photo!.original.key)!.body.arrayBuffer()), jpeg)
  assert.equal(photo?.original.sha256, expected.originalSha256)
  assert.deepEqual(pin.catalog.tags.map(tag => tag.title), tagTitles)
  assert.equal(trace.some(key => key.includes('/index/')), false)
  const [text, tags] = await Promise.all([fresh.loadIndex(pin, 'text'), fresh.loadIndex(pin, 'tags')])
  if (text.status !== 'ready' || tags.status !== 'ready') assert.fail('Stored index was unreadable')
  assert.deepEqual(queryCatalog(pin.catalog, {text:'cafe', tagIds: pin.catalog.tags.map(tag => tag.id)},
    {text: text.value, tags: tags.value}), {ids:[expected.assetId], total:1})
  assert.equal(trace.some(key => key.includes('/originals/')), false)
  assert.deepEqual(await fresh.publish(intent), outcome)
  assert.deepEqual(await fresh.publish({...intent, tagTitles:['Other']}), {status: 'failed', code: 'invalidPlan'})
})

test('keeps the winning publication readable and an independent stale edit can be reapplied', async () => {
  const {store} = memoryStore()
  const left = createLibraryRepository(store)
  const right = createLibraryRepository(store)
  const a = await left.open()
  const b = await right.open()
  const first = {kind:'create-tag', operationId:'tag-1', title:'First', baseToken:a.baseToken} as const
  const second = {kind:'create-tag', operationId:'tag-2', title:'Second', baseToken:b.baseToken} as const
  const results = await Promise.all([left.publish(first), right.publish(second)])
  assert.deepEqual(results.map(result => result.status).sort(), ['published', 'stale'])
  const winningTitle = results[0]?.status === 'published' ? 'First' : 'Second'
  const losingIntent = winningTitle === 'First' ? second : first
  const current = await left.open()
  assert.deepEqual(current.catalog.tags.map(tag => tag.title), [winningTitle])
  const reapplied = await left.publish({...losingIntent, baseToken: current.baseToken, operationId:'reapplied'})
  assert.equal(reapplied.status, 'published')
  const latest = await right.open()
  assert.deepEqual(latest.catalog.tags.map(tag => tag.title), [winningTitle, losingIntent.title])
  const originalPostings = await left.loadIndex(current, 'tags')
  assert.deepEqual(originalPostings, {status:'ready', value: {version:1, postings: {}}})
  await assert.rejects(right.loadIndex(current, 'tags'), {code:'invalidReference'})
})

test('reconciles a lost head response after a newer writer has already advanced', async () => {
  const {store, hooks} = memoryStore()
  const first = createLibraryRepository(store)
  const base = await first.open()
  const intent = {kind:'create-tag', title:'One', operationId:'uncertain', baseToken:base.baseToken} as const
  let committed: string | null = null
  hooks.afterWrite = async key => {
    if (key !== headKey) return
    delete hooks.afterWrite
    const other = createLibraryRepository(store)
    const afterFirst = await other.open()
    committed = afterFirst.revisionId
    const advanced = await other.publish({kind:'create-tag', title:'Two', operationId:'other', baseToken:afterFirst.baseToken})
    assert.equal(advanced.status, 'published')
    throw storeError('transport')
  }
  assert.deepEqual(await first.publish(intent), {status:'published', revisionId:committed})
  assert.deepEqual((await first.open()).catalog.tags.map(tag => tag.title), ['One', 'Two'])
})

test('keeps recover-mode ambiguity and a pre-head failure cannot replace the prior valid revision', async () => {
  const {store, hooks} = memoryStore()
  const repo = createLibraryRepository(store)
  const base = await repo.open()
  const skipped = {kind:'create-tag', title:'Uncertain', operationId:'not-observed', baseToken:base.baseToken} as const
  const outcome = await repo.publish({kind:'create-tag', title:'Saved', operationId:'seed', baseToken:base.baseToken})
  assert.equal(outcome.status, 'published')
  assert.deepEqual(await repo.publish(skipped, {mode:'recover'}), {status:'outcomeUnknown', operationId:skipped.operationId})
  const saved = await repo.open()
  hooks.beforeWrite = async key => {
    if (key.startsWith('library/catalog/')) throw storeError('transport')
  }
  assert.deepEqual(await repo.publish({...skipped, baseToken:saved.baseToken}), {status:'failed', code:'storage'})
  assert.equal((await repo.open()).revisionId, saved.revisionId)
})

test('keeps a missing index repairable without blocking browse', async () => {
  const {store, objects, trace} = await fixtureStore()
  const {textIndex} = await storedManifest(objects)
  objects.delete('library/' + textIndex.key)
  const repo = createLibraryRepository(store)
  const pin = await repo.open()
  assert.equal(pin.catalog.assets.length, 4)
  assert.deepEqual(await repo.loadIndex(pin, 'text'), {status:'repairable', reason:'missing'})
  assert.equal((await repo.loadIndex(pin, 'tags')).status, 'ready')
  assert.ok(trace.includes('library/' + textIndex.key))
})

test('keeps a dispatched head write uncertain when the session expires after commit', async () => {
  const {store, hooks} = memoryStore()
  const repo = createLibraryRepository(store)
  const base = await repo.open()
  const originalObservation = store.readForUpdate
  const intent = {kind:'create-tag', title:'Saved', operationId:'expires-after-dispatch', baseToken:base.baseToken} as const
  hooks.afterWrite = async key => {
    if (key !== headKey) return
    delete hooks.afterWrite
    store.readForUpdate = async () => { throw storeError('expired') }
    throw storeError('expired')
  }
  assert.deepEqual(await repo.publish(intent), {status:'outcomeUnknown', operationId:intent.operationId, code:'expired'})
  store.readForUpdate = originalObservation
  assert.equal((await createLibraryRepository(store).publish(intent, {mode:'recover'})).status, 'published')
})
