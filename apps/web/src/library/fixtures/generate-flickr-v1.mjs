import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {createFlickrRepository} from '../../../../flickr-import/repository.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const part = sha('synthetic archive')
const jpeg = await readFile(new URL('../../../../../apps/flickr-import/test-fixtures/photo.jpg', import.meta.url))
const identity = (sourceKey, kind, value) => 'flickr:' + sha(JSON.stringify([sourceKey, kind, value]))
const upload = (uploadId, kind, bytes) => ({
  uploadId, kind, mimeType: 'image/jpeg', byteLength: bytes.length, sha256: sha(bytes),
  openBytes: async () => new Blob([bytes]).stream(),
})

const objects = new Map()
const store = {
  libraryId: 'v1-compatibility',
  async get(key) { return objects.get(key) ?? null },
  async put(key, body, {match}) {
    if ((objects.get(key)?.generation ?? '0') !== match) throw Object.assign(Error(), {status: 412})
    const generation = String(objects.size + 1)
    objects.set(key, {body, generation})
    return {generation}
  },
}

const originalUuid = crypto.randomUUID
let revision = 0
crypto.randomUUID = () => '00000000-0000-4000-8000-' + String(++revision).padStart(12, '0')
try {
  const repository = createFlickrRepository(store)
  for (const sourceKey of ['other-account', 'sample-account']) {
    const isSample = sourceKey === 'sample-account'
    const photoId = '9007199254740993'
    const albumId = identity(sourceKey, 'album', '007')
    const pendingAlbumId = identity(sourceKey, 'album', '008')
    const keywordId = identity(sourceKey, 'keyword', 'Architecture')
    const flickrDate = {wallTime: '2024-12-01T12:30:00', precision: 'second', provenance: 'flickr', offsetMinutes: 0}
    const tags = isSample ? [
      {id: albumId, title: 'Travel', source: {sourceKey, kind: 'album', value: '007'},
        album: {description: 'Across the river', createdAt: flickrDate,
          coverPhoto: {photoId, sourceUrl: 'https://www.flickr.com/photos/example/9007199254740993/'}}},
      {id: pendingAlbumId, title: 'Pending cover', source: {sourceKey, kind: 'album', value: '008'},
        album: {coverPhoto: {photoId: '55', sourceUrl: 'https://www.flickr.com/photos/example/55/'}}},
      {id: keywordId, title: 'Architecture', source: {sourceKey, kind: 'keyword', value: 'Architecture'}},
    ] : []
    const source = {
      version: 1, binding: {sourceKey, label: sourceKey}, parts: {[part]: {members: {}}}, photos: {}, albums: {},
      candidates: [], links: {}, ownerFields: {}, ownerTagNames: {}, memberships: {},
    }
    const assets = (isSample ? [photoId, '77'] : [photoId, '55']).map((id, ordinal) => {
      const assetId = identity(sourceKey, 'asset', id)
      const member = [part, ordinal]
      const original = {uploadId: 'original'}
      const metadata = isSample && ordinal === 0 ? {
        title: 'Forêt', capturedAt: flickrDate, license: 'Sample license',
        sourceUrl: 'https://www.flickr.com/photos/example/9007199254740993/',
        comments: [{id: '1', body: 'Bridge <3', author: 'sample@N04', createdAt: flickrDate}],
        annotations: [{body: 'River', bounds: {x: 0, y: 1, width: 2, height: 3}}],
        groupMemberships: [{id: '2@N05', name: 'Hikes'}],
        tagAttributions: [{tagId: keywordId, author: 'sample@N04', createdAt: flickrDate}],
        embedded: {exif: {make: 'Example', iso: 100, flash: 0, exposureSeconds: 0.005,
          focalLengthMm: 50, capturedAt: {wallTime: '2024-12-01T12:20:00', precision: 'second', provenance: 'exif'}},
        iptc: {caption: 'Original caption', dateCreated: '2024-12-01', timeCreated: '12:20:00-03:00'}},
      } : {}
      const tagIds = isSample && ordinal === 0 ? [albumId, keywordId] : []
      source.parts[part].members[ordinal] = 'stored'
      source.candidates.push({member, filename: 'source.jpg', photoId: id, original, review: 'confirmed'})
      source.links[id] = {assetId, member}
      if (tagIds.length) source.memberships[id] = Object.fromEntries(
        tagIds.map(tagId => [tagId, {owner: 'inherit', source: 'authoritative'}]))
      return {id: assetId, source: {sourceKey, photoId: id}, original, filename: 'source.jpg', addedAt: '2024-12-01T12:32:00.000Z',
        mediaKind: 'photo', previews: [{uploadId: 'preview'}], metadata, tagIds}
    })
    const base = await repository.readFlickrImport(sourceKey)
    const result = await repository.publishFlickrImport({
      version: 1, sourceKey, source, assets, tags, baseToken: base.baseToken, operationId: 'import-' + sourceKey,
      uploads: [upload('original', 'original', jpeg), upload('preview', 'preview', jpeg)],
    })
    if (result.status !== 'published') throw Error(JSON.stringify(result))
  }

  const fixture = Object.fromEntries(await Promise.all([...objects].sort(([a], [b]) => a.localeCompare(b))
    .map(async ([key, {body, generation}]) =>
      [key, {generation, mimeType: body.type, base64: Buffer.from(await body.arrayBuffer()).toString('base64')}])))
  await writeFile(new URL('flickr-v1.json', import.meta.url), JSON.stringify(fixture, null, 2) + '\n')
} finally {
  crypto.randomUUID = originalUuid
}
