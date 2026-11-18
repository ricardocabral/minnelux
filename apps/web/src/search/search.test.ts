import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AssetV1, CatalogV1 } from '../library/contract.ts'
import { buildPostings, queryCatalog, validatePostings } from './search.ts'

function asset(id: string, patch: Partial<AssetV1> = {}): AssetV1 {
  return {
    id, filename: id, mediaKind: 'photo', addedAt: '2026-01-01T00:00:00Z', tagIds: [],
    original: {kind: 'original', root: 'library', key: 'originals/' + '1'.repeat(64),
      sha256: '1'.repeat(64), byteLength: 1, mimeType: 'image/jpeg'},
    previews: [], metadata: {}, ...patch,
  }
}

const catalog: CatalogV1 = {
  version: 1,
  tags: [{id: 'construct', title: 'Café 東京'}, {id: 'family', title: 'Family'}],
  assets: [
    asset('a', {filename: 'Cafe Cafe.jpg', metadata: {title: 'Café', description: 'CAFÉ'}, tagIds: ['construct', 'family']}),
    asset('b', {filename: 'IMG.jpg', tagIds: ['construct', 'family'], mediaKind: 'video'}),
    asset('c', {filename: 'constructor', tagIds: ['family']}),
    asset('d', {filename: 'Café', metadata: {
      capturedAt: {wallTime: '2025-12-30T23:30:00', precision: 'second', provenance: 'flickr', offsetMinutes: -120},
    }}),
  ],
}

test('publishes weighted text and ordinal tag postings', () => {
  const {text, tags} = buildPostings(catalog)
  assert.deepEqual(text.postings.cafe, [0, 7, 3, 1])
  assert.deepEqual(tags.postings.construct, [0, 1])
  assert.deepEqual(text.postings.constructor, [2, 1])
})

test('combines current tag titles and persisted text with selected tags and media filters', () => {
  const indexes = buildPostings(catalog)
  assert.deepEqual(queryCatalog(catalog, {text: 'cafÉ café 東京'}, indexes), {ids: ['a', 'b'], total: 2})
  assert.deepEqual(queryCatalog(catalog, {text: 'CAFÉ', tagIds: ['construct', 'family'], mediaKind: 'photo'}, indexes),
    {ids: ['a'], total: 1})

  const renamed = {...catalog, tags: [{id: 'construct', title: 'Kyoto 東京'}, catalog.tags[1]!]}
  assert.deepEqual(queryCatalog(renamed, {text: 'cafe'}, indexes), {ids: ['a', 'd'], total: 2})
  assert.deepEqual(queryCatalog(catalog, {text: 'constructor'}, indexes), {ids: ['c'], total: 1})
  assert.deepEqual(queryCatalog(catalog, {text: 'hasownproperty'}, indexes), {ids: [], total: 0})
})

test('browses by recorded calendar date and preserves stable ordering on ties', () => {
  assert.deepEqual(queryCatalog(catalog, {text: '...'}, {}), {ids: ['a', 'b', 'c', 'd'], total: 4})
  assert.deepEqual(queryCatalog(catalog, {fromDate: '2025-12-30', beforeDate: '2025-12-31', untagged: true}, {}),
    {ids: ['d'], total: 1})
})

test('rejects malformed posting strides, ordinals, weights, and orphan tags', () => {
  for (const list of [[0], [1, 1, 0, 1], [4, 1], [0, 8]]) {
    assert.equal(validatePostings('text', {version: 1, postings: {p: list}}, catalog), false)
  }
  assert.equal(validatePostings('tags', {version: 1, postings: {unknown: [0]}}, catalog), false)
  assert.equal(validatePostings('text', {version: 1, postings: {Café: [0, 1]}}, catalog), false)
  assert.equal(validatePostings('text', JSON.parse('{"version":1,"postings":{"constructor":[2,1]}}'), catalog), true)
})
