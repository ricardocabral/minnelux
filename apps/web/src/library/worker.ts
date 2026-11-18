import { createGcsStore } from '../storage/gcs.ts'
import { record } from '../storage/io.ts'
import { queryCatalog, searchTerms } from '../search/search.ts'
import type { PostingsV1 } from '../search/contract.ts'
import { createBrowserFixtureStore } from '../test-fixtures/browser-store.ts'
import { relativeKey, resolveAlbumCover } from './catalog.ts'
import type { AssetV1, LibraryRepository, PinnedLibrary } from './contract.ts'
import { createLibraryRepository } from './repository.ts'
import {
  libraryProtocolVersion,
  type LibraryOperation,
  type LibraryReply,
  type LibraryRequest,
  type WorkerStart,
} from './worker-contract.ts'

function failure(code: string) {
  return Object.assign(new Error(code), { code })
}

function serve(sessionId: string, repository: LibraryRepository, canWrite: boolean) {
  let openAttempt = 0
  let current: PinnedLibrary | undefined
  let assets = new Map<string, AssetV1>()
  const postings = new Map<'text' | 'tags', PostingsV1>()
  const results = new Map<string, string[]>()
  const running = new Map<string, AbortController>()

  async function run(request: Exclude<LibraryRequest, { operation: 'cancel' }>, signal: AbortSignal) {
    if (request.operation === 'open') {
      const attempt = ++openAttempt
      current = undefined
      assets.clear()
      postings.clear()
      results.clear()
      const pin = await repository.open(signal)
      signal.throwIfAborted()
      if (attempt !== openAttempt) throw failure('aborted')
      current = pin
      assets = new Map(pin.catalog.assets.map(asset => [asset.id, asset]))
      return { revisionId: pin.revisionId, baseToken: pin.baseToken, tags: pin.catalog.tags, canWrite }
    }

    if (!current) throw failure('library-not-open')
    const pin = current

    function requireCurrent() {
      signal.throwIfAborted()
      if (current !== pin) throw failure('aborted')
    }

    async function load(kind: 'text' | 'tags') {
      const cached = postings.get(kind)
      if (cached) return cached
      const result = await repository.loadIndex(pin, kind, signal)
      requireCurrent()
      if (result.status === 'repairable') throw failure('index-' + result.reason)
      postings.set(kind, result.value)
      return result.value
    }

    switch (request.operation) {
      case 'query': {
        const query = request.input
        const hasText = searchTerms(query.text ?? '').size > 0
        const [text, tags] = await Promise.all([
          hasText ? load('text') : undefined,
          hasText || query.tagIds?.length ? load('tags') : undefined,
        ])
        requireCurrent()
        const { ids, total } = queryCatalog(pin.catalog, query, { text, tags })
        const handle = request.requestId
        results.set(handle, ids)
        return { handle, total, revisionId: pin.revisionId }
      }
      case 'readRange': {
        const { handle, offset, limit } = request.input
        const ids = results.get(handle)
        if (!ids) throw failure('result-expired')
        if (!Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw failure('invalid-range')
        return ids.slice(offset, offset + limit).map((id) => {
          const asset = assets.get(id)
          if (!asset) throw failure('asset-missing')
          return {
            id, filename: asset.filename, mediaKind: asset.mediaKind, addedAt: asset.addedAt,
            tagIds: asset.tagIds, title: asset.metadata.title, capturedAt: asset.metadata.capturedAt,
            hasPreview: Boolean(asset.previews.length),
          }
        })
      }
      case 'readAsset':
      case 'readOriginal': {
        const { assetId, handle } = request.input
        if (!results.get(handle)?.includes(assetId)) throw failure('result-expired')
        const asset = assets.get(assetId)
        if (!asset) throw failure('asset-missing')
        if (request.operation === 'readAsset') return asset
        const blob = await repository.readOriginal(pin, assetId, signal)
        requireCurrent()
        return blob
      }
      case 'readPreview': {
        const blob = await repository.readPreview(pin, request.input.assetId, signal)
        requireCurrent()
        return blob
      }
      case 'readAlbumCover': {
        const asset = resolveAlbumCover(pin.catalog, request.input.tagId)
        if (!asset) return undefined
        const blob = await repository.readPreview(pin, asset.id, signal)
        requireCurrent()
        return blob
      }
      case 'release':
        results.delete(request.input.handle)
        return undefined
      case 'publish':
        if (!canWrite) return { status: 'failed', code: 'denied' }
        return repository.publish(request.input.intent, { mode: request.input.mode, signal })
    }
  }

  return async (request: LibraryRequest) => {
    if (request?.version !== libraryProtocolVersion || request.sessionId !== sessionId ||
      typeof request.requestId !== 'string') return
    if (request.operation === 'cancel') {
      running.get(request.input.requestId)?.abort()
      results.delete(request.input.requestId)
      return
    }
    if (running.has(request.requestId)) return
    const controller = new AbortController()
    running.set(request.requestId, controller)
    const envelope = {
      version: libraryProtocolVersion, sessionId, requestId: request.requestId,
      operation: request.operation as LibraryOperation,
    } as const
    try {
      const value = await run(request, controller.signal)
      if (!controller.signal.aborted) postMessage({ ...envelope, status: 'ok', value } as LibraryReply)
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code : controller.signal.aborted ? 'aborted' : 'library-error'
      if (!controller.signal.aborted) postMessage({ ...envelope, status: 'error', code } satisfies LibraryReply)
    } finally {
      running.delete(request.requestId)
    }
  }
}

async function startLibrary({ source, sessionId }: WorkerStart) {
  if (source.kind === 'sample') {
    if (import.meta.env.MODE === 'test') {
      return serve(sessionId, createLibraryRepository(createBrowserFixtureStore()), true)
    }
    return undefined
  }

  const live = () => Date.now() < source.expiresAt
  const store = source.kind === 'gcs'
    ? createGcsStore(source.bucket, () => live() ? source.token : null)
    : (await import('../storage/s3.ts')).createS3Store(
      source.bucket, source.region, () => live() ? source.credentials : null,
    )
  return serve(sessionId, createLibraryRepository(store, { libraryPrefix: source.prefix }), source.canWrite)
}

function validSource(source: unknown): source is WorkerStart['source'] {
  if (!record(source)) return false
  if (source.kind === 'sample') return import.meta.env.MODE === 'test'
  const {bucket, prefix, expiresAt, canWrite} = source
  if (typeof bucket !== 'string' || !bucket || !relativeKey(prefix) ||
      typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 ||
      typeof canWrite !== 'boolean') return false

  const validCredential = (value: unknown) => typeof value === 'string' && /^[!-~]+$/.test(value)
  if (source.kind === 'gcs') return validCredential(source.token)
  if (source.kind !== 's3' || typeof source.region !== 'string' || !source.region ||
      !record(source.credentials)) return false
  const {accessKeyId, secretAccessKey, sessionToken} = source.credentials
  return [accessKeyId, secretAccessKey, sessionToken].every(validCredential)
}

let receive: ReturnType<typeof startLibrary> | undefined

self.addEventListener('message', ({ data }: MessageEvent<WorkerStart | LibraryRequest>) => {
  if (!data || typeof data !== 'object') return
  if ('kind' in data) {
    if (receive || data.kind !== 'start' || data.version !== libraryProtocolVersion ||
        typeof data.sessionId !== 'string' || !data.sessionId || !validSource(data.source)) return
    receive = startLibrary(data).catch(() => {
      reportError(new Error('The library worker could not start.'))
      return undefined
    })
    return
  }
  void receive?.then(handler => handler?.(data))
})
