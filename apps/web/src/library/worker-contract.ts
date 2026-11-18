import type { AssetV1, FlickrTime, LibraryIntent, PublishOptions, PublishResult, TagV1 } from './contract.ts'
import type { Query } from '../search/contract.ts'

export type LibraryOverview = { revisionId: string | null; baseToken: string; tags: TagV1[]; canWrite: boolean }
export type ResultHandle = { handle: string; total: number; revisionId: string | null }
export type AssetRow = Pick<AssetV1, 'id' | 'filename' | 'mediaKind' | 'addedAt' | 'tagIds'> & {
  title?: string
  capturedAt?: FlickrTime
  hasPreview: boolean
}
export type ConnectConfiguration = { bucket: string; clientId: string; prefix: string; access: 'read' | 'edit' }

export interface LibraryClient {
  open(signal?: AbortSignal): Promise<LibraryOverview>
  query(query: Query, signal?: AbortSignal): Promise<ResultHandle>
  readRange(handle: string, offset: number, limit: number, signal?: AbortSignal): Promise<AssetRow[]>
  readAsset(handle: string, assetId: string, signal?: AbortSignal): Promise<AssetV1>
  readOriginal(handle: string, assetId: string, signal?: AbortSignal): Promise<Blob>
  readPreview(assetId: string, signal?: AbortSignal): Promise<Blob | undefined>
  readAlbumCover(tagId: string, signal?: AbortSignal): Promise<Blob | undefined>
  release(handle: string): Promise<void>
  publish(intent: LibraryIntent, options?: PublishOptions): Promise<PublishResult>
}

export const libraryProtocolVersion = 1

export type LibraryRequests = {
  open: { input: null; output: LibraryOverview }
  query: { input: Query; output: ResultHandle }
  readRange: { input: { handle: string; offset: number; limit: number }; output: AssetRow[] }
  readAsset: { input: { handle: string; assetId: string }; output: AssetV1 }
  readOriginal: { input: { handle: string; assetId: string }; output: Blob }
  readPreview: { input: { assetId: string }; output: Blob | undefined }
  readAlbumCover: { input: { tagId: string }; output: Blob | undefined }
  release: { input: { handle: string }; output: void }
  publish: { input: { intent: LibraryIntent; mode?: PublishOptions['mode'] }; output: PublishResult }
}

export type LibraryOperation = keyof LibraryRequests
export type LibraryEnvelope = { version: typeof libraryProtocolVersion; sessionId: string; requestId: string }
export type LibraryRequest = LibraryEnvelope & (
  | { [Name in LibraryOperation]: { operation: Name; input: LibraryRequests[Name]['input'] } }[LibraryOperation]
  | { operation: 'cancel'; input: { requestId: string } }
)
export type LibraryReply = LibraryEnvelope & (
  | { [Name in LibraryOperation]: { operation: Name; status: 'ok'; value: LibraryRequests[Name]['output'] } }[LibraryOperation]
  | { operation: LibraryOperation; status: 'error'; code: string }
  | { operation: 'publish'; status: 'progress'; completed: number; total: number }
)
