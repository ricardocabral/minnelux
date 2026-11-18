import { sha256 } from '@noble/hashes/sha2.js'
import { buildPostings, validatePostings } from '../search/search.ts'
import type { ObjectStore, WriteCondition } from '../storage/contract.ts'
import { boundedBody, checkCancellation, record } from '../storage/io.ts'
import { addedDatePattern, hashPattern, previewTypes, relativeKey, validateCatalog, validateMediaReference } from './catalog.ts'
import type {
  CatalogV1, IndexLoad, LibraryIntent, LibraryRepository, PinnedLibrary,
  PublishFailure, PublishResult, StoredObjectRef, TagV1,
} from './contract.ts'

const maxHead = 64 * 1024
const maxManifest = 4 * 1024 * 1024
const maxSnapshot = 128 * 1024 * 1024
const maxOriginal = 48 * 1024 * 1024
const maxPreview = 4 * 1024 * 1024
const maxReceipts = 64
const revisionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const utf8 = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', {fatal: true})

type Descriptor = {key: string; sha256: string; byteLength: number}
type Source = {
  binding: {sourceKey: string; label: string; flickrAccountId?: string}
  state: Descriptor
}
type LibraryReceipt = {operationId: string; fingerprint: string; committedRevisionId: string}
type FlickrReceipt = LibraryReceipt & {sourceKey: string}
type Manifest = {
  revisionId: string
  catalog: Descriptor
  textIndex: unknown
  tagIndex: unknown
  indexVersion: unknown
  tokenizerVersion: unknown
  sources: Source[]
  receipts: FlickrReceipt[]
  libraryReceipts: LibraryReceipt[]
}
type Observation = {condition: WriteCondition; manifest: Manifest | null; baseToken: string}
type PinState = {manifest: Manifest | null; catalog: CatalogV1; previews: Map<string, StoredObjectRef>;
  indexes: Map<'text' | 'tags', IndexLoad>}

function fail(code: PublishFailure | 'missing'): never {
  throw Object.assign(new Error(code), {code})
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && error.name === 'AbortError') return 'aborted'
  return record(error) && typeof error.code === 'string' ? error.code : undefined
}

function failure(error: unknown): PublishFailure {
  const code = errorCode(error)
  switch (code) {
    case 'invalidPlan': case 'invalidReference': case 'integrity': case 'unreadableBytes':
    case 'denied': case 'expired': case 'aborted': case 'corrupt': case 'unsupportedVersion':
      return code
    default:
      return 'storage'
  }
}

function assertCondition(condition: unknown, code: PublishFailure): asserts condition {
  if (!condition) fail(code)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (!record(value)) return JSON.stringify(value)
  return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function hash(value: Blob | string, signal?: AbortSignal): Promise<string> {
  if (value instanceof Blob && value.size > 4 * 1024 * 1024) {
    const digest = sha256.create()
    const chunkSize = 1024 * 1024
    for (let offset = 0; offset < value.size; offset += chunkSize) {
      checkCancellation(signal)
      const chunk = await value.slice(offset, offset + chunkSize).arrayBuffer()
      digest.update(new Uint8Array(chunk))
    }
    return hex(digest.digest())
  }
  const bytes = typeof value === 'string' ? utf8.encode(value) : await value.arrayBuffer()
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function validRevision(value: unknown): value is string {
  return typeof value === 'string' && revisionPattern.test(value)
}

function parseJson(json: Uint8Array): unknown {
  try {
    return JSON.parse(textDecoder.decode(json))
  } catch {
    fail('corrupt')
  }
}

function version(value: unknown): Record<string, unknown> & {version: number} {
  assertCondition(record(value) && typeof value.version === 'number' && Number.isInteger(value.version), 'corrupt')
  return value as Record<string, unknown> & {version: number}
}

function descriptor(value: unknown, expectedKey: (sha: string) => string, limit: number): Descriptor {
  assertCondition(record(value) && nonempty(value.sha256) && hashPattern.test(value.sha256) &&
    typeof value.byteLength === 'number' && Number.isSafeInteger(value.byteLength) &&
    value.byteLength >= 0 && value.byteLength <= limit && value.key === expectedKey(value.sha256), 'corrupt')
  return value as Descriptor
}

function snapshotKey(directory: string, sha: string): string {
  return directory + '/' + sha + '.json.gz'
}

function sourceDirectory(sourceKey: string): string {
  return 'sources/flickr/' + hex(utf8.encode(sourceKey)) + '/state'
}

function decodeManifest(value: unknown, revisionId: string): Manifest {
  const data = version(value)
  assertCondition(data.version === 1 || data.version === 2, 'unsupportedVersion')
  assertCondition(data.revisionId === revisionId && (data.parentRevisionId === null || validRevision(data.parentRevisionId)) &&
    Array.isArray(data.sources), 'corrupt')

  const keys = new Set<string>()
  const accounts = new Set<string>()
  const sources = data.sources.map((source: unknown) => {
    assertCondition(record(source) && record(source.binding), 'corrupt')
    const {sourceKey, label, flickrAccountId} = source.binding
    assertCondition(nonempty(sourceKey) && sourceKey.length <= 200 && !keys.has(sourceKey) && nonempty(label) &&
      (flickrAccountId === undefined || (nonempty(flickrAccountId) && !accounts.has(flickrAccountId))), 'corrupt')
    keys.add(sourceKey)
    if (flickrAccountId) accounts.add(flickrAccountId)
    descriptor(source.state, sha => snapshotKey(sourceDirectory(sourceKey), sha), maxSnapshot)
    return source as Source
  })
  function receipts(value: unknown, flickr: true): FlickrReceipt[]
  function receipts(value: unknown, flickr: false): LibraryReceipt[]
  function receipts(value: unknown, flickr: boolean): LibraryReceipt[] {
    assertCondition(Array.isArray(value) && value.length <= maxReceipts, 'corrupt')
    const seen = new Set<string>()
    for (const receipt of value) {
      assertCondition(record(receipt) && nonempty(receipt.operationId) && validRevision(receipt.committedRevisionId) &&
        typeof receipt.fingerprint === 'string' && hashPattern.test(receipt.fingerprint) &&
        (!flickr || (typeof receipt.sourceKey === 'string' && keys.has(receipt.sourceKey))), 'corrupt')
      const id = JSON.stringify([flickr ? receipt.sourceKey : null, receipt.operationId])
      assertCondition(!seen.has(id), 'corrupt')
      seen.add(id)
    }
    return value
  }

  return {
    revisionId,
    catalog: descriptor(data.catalog, sha => snapshotKey('catalog', sha), maxSnapshot),
    textIndex: data.textIndex,
    tagIndex: data.tagIndex,
    indexVersion: data.indexVersion,
    tokenizerVersion: data.tokenizerVersion,
    sources,
    receipts: receipts(data.receipts, true),
    libraryReceipts: data.version === 2 ? receipts(data.libraryReceipts, false) : [],
  }
}

type Upload = {blob: Blob; sha256: string; kind: 'original' | 'preview'}
type PreparedIntent = {intent: LibraryIntent; fingerprint: string; uploads?: Upload[]}

function title(value: unknown): string {
  assertCondition(typeof value === 'string', 'invalidPlan')
  const trimmed = value.trim().normalize('NFC')
  assertCondition(trimmed.length > 0 && trimmed.length <= 50 && !/[\u0000-\u001f\u007f]/.test(trimmed), 'invalidPlan')
  return trimmed
}

async function prepare(input: LibraryIntent, signal?: AbortSignal): Promise<PreparedIntent> {
  assertCondition(record(input) && nonempty(input.operationId) && input.operationId.length <= 200 && nonempty(input.baseToken), 'invalidPlan')
  const {operationId, baseToken, kind} = input
  const identity = {operationId, baseToken, kind}
  switch (kind) {
    case 'create-tag': {
      const intent = {...identity, kind, title: title(input.title)}
      return {intent, fingerprint: await hash(canonical(intent))}
    }
    case 'set-tag': {
      const {assetId, tagId, present} = input
      assertCondition(nonempty(assetId) && nonempty(tagId) && typeof present === 'boolean', 'invalidPlan')
      const intent = {...identity, kind, assetId, tagId, present}
      return {intent, fingerprint: await hash(canonical(intent))}
    }
    case 'import-photo': {
      const {file, preview, addedAt, tagTitles} = input
      assertCondition(file instanceof File && file.type === 'image/jpeg' && file.size > 0 && file.size <= maxOriginal &&
        nonempty(file.name) && file.name.length <= 255 && !/[\u0000-\u001f\u007f]/.test(file.name) &&
        (preview === undefined || (preview instanceof Blob && previewTypes.includes(preview.type) &&
          preview.size > 0 && preview.size <= maxPreview)) &&
        typeof addedAt === 'string' && addedDatePattern.test(addedAt) && Number.isFinite(Date.parse(addedAt)) &&
        Array.isArray(tagTitles) && tagTitles.length <= 64, 'invalidPlan')
      const titles = tagTitles.map(title)
      const uploads: Upload[] = []
      const blobs = [{blob: file, kind: 'original'}, ...(preview ? [{blob: preview, kind: 'preview'}] : [])] as
        {blob: Blob; kind: Upload['kind']}[]
      for (const {blob, kind} of blobs) {
        checkCancellation(signal)
        let header: Uint8Array
        let sha256: string
        try {
          header = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
          sha256 = await hash(blob)
        } catch {
          checkCancellation(signal)
          fail('unreadableBytes')
        }
        checkCancellation(signal)
        const signature = blob.type === 'image/jpeg' ? header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
          : blob.type === 'image/png' ? hex(header.slice(0, 8)) === '89504e470d0a1a0a'
          : new TextDecoder().decode(header.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(header.slice(8, 12)) === 'WEBP'
        assertCondition(signature, 'invalidPlan')
        uploads.push({blob, sha256, kind})
      }
      const fingerprint = await hash(canonical({...identity, filename: file.name, addedAt, tagTitles: titles,
        uploads: uploads.map(({blob, sha256, kind}) => ({sha256, kind, byteLength: blob.size, mimeType: blob.type})),
      }))
      return {intent: {...identity, kind, file, preview, addedAt, tagTitles: titles}, fingerprint, uploads}
    }
    default:
      fail('invalidPlan')
  }
}

export function createLibraryRepository(
  store: ObjectStore,
  {libraryPrefix = 'library', libraryId, mediaRoots: configuredRoots = {}}: {
    libraryPrefix?: string; libraryId?: string; mediaRoots?: Readonly<Record<string, string>>
  } = {},
): LibraryRepository {
  assertCondition(libraryPrefix === '' || relativeKey(libraryPrefix), 'invalidReference')
  const mediaRoots = new Map(Object.entries(configuredRoots))
  assertCondition(!mediaRoots.has('library') && [...mediaRoots.values()].every(root => root === '' || relativeKey(root)), 'invalidReference')
  const storeIdentity = (store as ObjectStore & {libraryId?: string}).libraryId
  const id = libraryId ?? storeIdentity ?? ''
  const keyFor = (key: string) => libraryPrefix ? libraryPrefix + '/' + key : key
  const pins = new WeakMap<PinnedLibrary, PinState>()

  async function storedBytes(
    ref: Pick<StoredObjectRef, 'key' | 'byteLength' | 'sha256'>,
    signal?: AbortSignal,
    key = keyFor(ref.key),
  ): Promise<Blob> {
    checkCancellation(signal)
    const response = await store.read(key, {signal})
    checkCancellation(signal)
    if (response.byteLength !== undefined && response.byteLength !== ref.byteLength) {
      await response.body.cancel().catch(() => undefined)
      fail('integrity')
    }
    let bytes: Blob
    try {
      bytes = await boundedBody(response.body, ref.byteLength, signal, ref.byteLength)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'invalidResponse' || code === 'limit') fail('integrity')
      throw error
    }
    if (ref.sha256) assertCondition(await hash(bytes, signal) === ref.sha256, 'integrity')
    checkCancellation(signal)
    return bytes
  }

  async function storedJson(ref: Descriptor, compressed: boolean, signal?: AbortSignal): Promise<unknown> {
    const bytes = await storedBytes(ref, signal)
    try {
      const blob = compressed
        ? await boundedBody(bytes.stream().pipeThrough(new DecompressionStream('gzip')), maxSnapshot, signal)
        : bytes
      const json = parseJson(new Uint8Array(await blob.arrayBuffer()))
      checkCancellation(signal)
      return json
    } catch {
      checkCancellation(signal)
      fail('corrupt')
    }
  }

  async function observe(signal?: AbortSignal): Promise<Observation> {
    checkCancellation(signal)
    const response = await store.readForUpdate(keyFor('head.json'), {signal, maxBytes: maxHead})
    checkCancellation(signal)
    let manifest: Manifest | null = null
    if (response) {
      assertCondition(response.body.byteLength <= maxHead && nonempty(response.token), 'corrupt')
      const head = version(parseJson(response.body))
      assertCondition(head.version === 1, 'unsupportedVersion')
      const revisionId = head.revisionId
      assertCondition(validRevision(revisionId), 'corrupt')
      const ref = descriptor(head.manifest, () => 'revisions/' + revisionId + '.json', maxManifest)
      manifest = decodeManifest(await storedJson(ref, false, signal), revisionId)
    }
    const condition: WriteCondition = response === null ? {kind: 'create'} : {kind: 'match', token: response.token}
    const baseToken = await hash(canonical([id, libraryPrefix, response?.token ?? null, manifest?.revisionId ?? null]))
    checkCancellation(signal)
    return {condition, manifest, baseToken}
  }

  async function catalogAt(manifest: Manifest | null, signal?: AbortSignal): Promise<CatalogV1> {
    if (!manifest) return {version: 1, assets: [], tags: []}
    const current = version(await storedJson(manifest.catalog, true, signal))
    assertCondition(current.version === 1, 'unsupportedVersion')
    assertCondition(validateCatalog(current, new Set(manifest.sources.map(source => source.binding.sourceKey)), mediaRoots), 'corrupt')
    return current
  }

  async function open(signal?: AbortSignal): Promise<PinnedLibrary> {
    try {
      const {manifest, baseToken} = await observe(signal)
      const catalog = await catalogAt(manifest, signal)
      checkCancellation(signal)
      const pin = {revisionId: manifest?.revisionId ?? null, baseToken, catalog}
      const previews = new Map(catalog.assets.flatMap(asset => asset.previews[0] ? [[asset.id, {...asset.previews[0]}] as const] : []))
      pins.set(pin, {manifest, catalog, previews, indexes: new Map()})
      return pin
    } catch (error) {
      if (['missing', 'integrity', 'limit', 'invalidResponse'].includes(errorCode(error) ?? '')) fail('corrupt')
      fail(failure(error))
    }
  }

  async function loadIndex(pin: PinnedLibrary, kind: 'text' | 'tags', signal?: AbortSignal): Promise<IndexLoad> {
    checkCancellation(signal)
    const state = pins.get(pin)
    assertCondition(state, 'invalidReference')
    const cached = state.indexes.get(kind)
    if (cached) return cached

    const {manifest, catalog} = state
    let result: IndexLoad
    if (!manifest) result = {status:'ready', value:{version:1, postings:{}}}
    else if (manifest.indexVersion !== 1 || manifest.tokenizerVersion !== 1) {
      result = {status:'repairable', reason:'unsupported'}
    } else {
      try {
        const input = kind === 'text' ? manifest.textIndex : manifest.tagIndex
        const ref = descriptor(input, sha => snapshotKey('index/' + kind, sha), maxSnapshot)
        const value = version(await storedJson(ref, true, signal))
        assertCondition(value.version === 1, 'unsupportedVersion')
        assertCondition(validatePostings(kind, value, catalog), 'corrupt')
        result = {status: 'ready', value}
      } catch (error) {
        switch (errorCode(error)) {
          case 'missing': result = {status:'repairable', reason:'missing'}; break
          case 'unsupportedVersion': result = {status:'repairable', reason:'unsupported'}; break
          case 'corrupt': case 'integrity': case 'limit': case 'invalidResponse':
            result = {status:'repairable', reason:'corrupt'}; break
          default: throw error
        }
      }
    }
    checkCancellation(signal)
    state.indexes.set(kind, result)
    return result
  }

  async function readOriginal(pin: PinnedLibrary, assetId: string, signal?: AbortSignal): Promise<Blob> {
    checkCancellation(signal)
    const ref = pins.get(pin)?.catalog.assets.find(asset => asset.id === assetId)?.original
    assertCondition(validateMediaReference(ref, 'original', mediaRoots), 'invalidReference')
    const root = ref.root === 'library' ? libraryPrefix : mediaRoots.get(ref.root)
    const bytes = await storedBytes(ref, signal, root ? root + '/' + ref.key : ref.key)
    return bytes.slice(0, bytes.size, ref.mimeType)
  }

  async function readPreview(pin: PinnedLibrary, assetId: string, signal?: AbortSignal): Promise<Blob | undefined> {
    checkCancellation(signal)
    const state = pins.get(pin)
    assertCondition(state, 'invalidReference')
    const ref = state.previews.get(assetId)
    if (!ref) return undefined
    assertCondition(ref.sha256 && ref.byteLength <= maxPreview, 'integrity')
    const bytes = await storedBytes({key: ref.key, sha256: ref.sha256, byteLength: ref.byteLength}, signal)
    return bytes.slice(0, bytes.size, ref.mimeType)
  }

  async function immutable(ref: Descriptor, blob: Blob, signal?: AbortSignal): Promise<string | undefined> {
    checkCancellation(signal)
    try {
      const result = await store.write(keyFor(ref.key), blob, {kind: 'create'}, {signal})
      checkCancellation(signal)
      return result.observedVersion
    } catch (error) {
      if (errorCode(error) !== 'conflict' && errorCode(error) !== 'denied') throw error
      try {
        await storedBytes(ref, signal)
      } catch (recheck) {
        if (errorCode(recheck) === 'missing') {
          if (errorCode(error) === 'denied') throw error
          fail('integrity')
        }
        throw recheck
      }
      return undefined
    }
  }

  async function saveSnapshot(directory: string, value: unknown, signal?: AbortSignal): Promise<Descriptor> {
    checkCancellation(signal)
    const json = new Blob([canonical(value)])
    assertCondition(json.size <= maxSnapshot, 'storage')
    const encoded = await boundedBody(json.stream().pipeThrough(new CompressionStream('gzip')), maxSnapshot, signal)
    const sha256 = await hash(encoded)
    const ref = {key: snapshotKey(directory, sha256), sha256, byteLength: encoded.size}
    await immutable(ref, encoded.slice(0, encoded.size, 'application/gzip'), signal)
    return ref
  }

  async function addTag(tags: TagV1[], rawTitle: string): Promise<TagV1> {
    const canonicalTitle = rawTitle.normalize('NFC').toLowerCase()
    const existing = tags.find(tag => !tag.source && tag.title.normalize('NFC').toLowerCase() === canonicalTitle)
    if (existing) return existing
    const tag = {id: 'tag:' + await hash(canonicalTitle), title: rawTitle}
    assertCondition(!tags.some(existing => existing.id === tag.id), 'invalidPlan')
    tags.push(tag)
    return tag
  }

  async function apply(
    prepared: PreparedIntent,
    catalog: CatalogV1,
    sources: Source[],
    signal?: AbortSignal,
  ): Promise<{changed: boolean; sources: Source[]}> {
    const {intent, uploads} = prepared
    if (intent.kind === 'create-tag') {
      const previous = catalog.tags.length
      await addTag(catalog.tags, intent.title)
      return {changed: catalog.tags.length !== previous, sources}
    }
    if (intent.kind === 'import-photo') {
      const [original, preview] = uploads!
      const id = 'local:' + await hash(canonical([intent.operationId, original!.sha256]))
      if (catalog.assets.some(asset => asset.id === id)) return {changed: false, sources}
      const saveMedia = async ({kind, blob, sha256}: Upload): Promise<StoredObjectRef> => {
        const ref = {kind, root:'library', key: (kind === 'original' ? 'originals/' : 'previews/') + sha256,
          sha256, byteLength:blob.size, mimeType:blob.type}
        const observedVersion = await immutable(ref, blob, signal)
        return {...ref, ...(observedVersion ? {observedVersion} : {})}
      }
      const tagIds = new Set<string>()
      for (const tag of intent.tagTitles) tagIds.add((await addTag(catalog.tags, tag)).id)
      const originalRef = await saveMedia(original!)
      const previews = preview ? [await saveMedia(preview)] : []
      catalog.assets.push({id, original:originalRef, filename:intent.file.name, addedAt:intent.addedAt,
        mediaKind:'photo', previews, metadata:{}, tagIds:[...tagIds]})
      return {changed: true, sources}
    }

    const asset = catalog.assets.find(asset => asset.id === intent.assetId)
    assertCondition(asset && catalog.tags.some(tag => tag.id === intent.tagId), 'invalidPlan')
    const present = asset.tagIds.includes(intent.tagId)
    if (present !== intent.present) {
      asset.tagIds = intent.present ? [...asset.tagIds, intent.tagId] : asset.tagIds.filter(id => id !== intent.tagId)
    }
    if (!asset.source) return {changed: present !== intent.present, sources}

    const {sourceKey, photoId} = asset.source
    const owner = sources.find(source => source.binding.sourceKey === sourceKey)
    assertCondition(owner, 'corrupt')
    const state = version(await storedJson(owner.state, true, signal))
    assertCondition(state.version === 1 && record(state.binding) && canonical(state.binding) === canonical(owner.binding) &&
      record(state.links) && record(state.links[photoId]) && state.links[photoId].assetId === asset.id &&
      record(state.memberships), 'corrupt')
    const row = state.memberships[photoId]
    assertCondition(row === undefined || record(row), 'corrupt')
    const existing = row && Object.hasOwn(row, intent.tagId) ? row[intent.tagId] : undefined
    assertCondition(existing === undefined || record(existing), 'corrupt')
    const membership = intent.present ? 'add' : 'remove'
    if (existing?.owner === membership) return {changed: present !== intent.present, sources}
    state.memberships[photoId] = {...row, [intent.tagId]: {...existing, owner:membership}}
    const updated = await saveSnapshot(sourceDirectory(sourceKey), state, signal)
    return {changed: true, sources: sources.map(source => source === owner ? {...source, state:updated} : source)}
  }

  async function publish(input: LibraryIntent, {mode = 'publish', signal}: {mode?: 'publish' | 'recover'; signal?: AbortSignal} = {}): Promise<PublishResult> {
    const unknown = (code?: PublishFailure): PublishResult =>
      ({status:'outcomeUnknown', operationId:input.operationId, ...(code ? {code} : {})})
    const stale = (): PublishResult => mode === 'recover' ? unknown() : {status: 'stale'}
    let stage: 'prepare' | 'observe' | 'write' = 'prepare'
    try {
      assertCondition(mode === 'publish' || mode === 'recover', 'invalidPlan')
      const prepared = await prepare(input, signal)
      const receipt = (manifest: Manifest | null): PublishResult | undefined => {
        const match = manifest?.libraryReceipts.find(item => item.operationId === prepared.intent.operationId)
        if (match) return match.fingerprint === prepared.fingerprint
          ? {status:'published', revisionId:match.committedRevisionId}
          : {status:'failed', code:'invalidPlan'}
      }
      stage = 'observe'
      const current = await observe(signal)
      const m = current.manifest
      const recovered = receipt(m)
      if (recovered) return recovered
      if (current.baseToken !== prepared.intent.baseToken) return stale()
      stage = 'write'
      const catalog = await catalogAt(m, signal)
      const {changed, sources} = await apply(prepared, catalog, m?.sources ?? [], signal)
      if (!changed) return {status:'unchanged', revisionId:m?.revisionId ?? null}
      const revisionId = crypto.randomUUID()
      const {text, tags} = buildPostings(catalog)
      const [catalogRef, textIndex, tagIndex] = await Promise.all([
        saveSnapshot('catalog', catalog, signal),
        saveSnapshot('index/text', text, signal),
        saveSnapshot('index/tags', tags, signal),
      ])
      const libraryReceipts = [...(m?.libraryReceipts ?? []),
        {operationId:prepared.intent.operationId, fingerprint:prepared.fingerprint, committedRevisionId:revisionId},
      ].slice(-maxReceipts)
      const manifest = new Blob([canonical({
        version:2, revisionId, parentRevisionId:m?.revisionId ?? null, catalog:catalogRef, textIndex, tagIndex,
        indexVersion:1, tokenizerVersion:1, sources, receipts:m?.receipts ?? [], libraryReceipts,
      })], {type:'application/json'})
      assertCondition(manifest.size <= maxManifest, 'storage')
      const manifestRef = {key:'revisions/' + revisionId + '.json', sha256:await hash(manifest), byteLength:manifest.size}
      await immutable(manifestRef, manifest, signal)
      const head = new Blob([canonical({version:1, revisionId, manifest:manifestRef})], {type:'application/json'})
      checkCancellation(signal)
      try {
        await store.write(keyFor('head.json'), head, current.condition, {signal})
        checkCancellation(signal)
        return {status:'published', revisionId}
      } catch (error) {
        const code = errorCode(error)
        const status = record(error) ? error.status : undefined
        if (code === 'denied' || code === 'expired' && status === 401 || code === 'limit' && status === 413) throw error
        try {
          const newest = await observe(signal)
          return receipt(newest.manifest) ?? (code === 'conflict' ? stale() : unknown(failure(error)))
        } catch (recheck) {
          return unknown(failure(recheck))
        }
      }
    } catch (error) {
      const code = failure(error)
      if (mode === 'recover' && (stage === 'observe' || (stage === 'prepare' && code !== 'invalidPlan'))) return unknown(code)
      return {status:'failed', code}
    }
  }

  return {open, loadIndex, readOriginal, readPreview, publish}
}
