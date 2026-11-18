import type { PostingsV1 } from '../search/contract.ts'

export type FlickrTime = {
  wallTime: string
  precision: 'second'
  offsetMinutes?: number
  provenance: 'flickr' | 'exif'
}
type FlickrComment = { id?: string; body: string; author?: string; createdAt?: FlickrTime; sourceUrl?: string }
type FlickrAnnotation = {
  body: string
  author?: string
  createdAt?: FlickrTime
  bounds?: { x: number; y: number; width: number; height: number }
}
export type ExifMetadata = {
  make?: string
  model?: string
  lensMake?: string
  lensModel?: string
  iso?: number
  exposureSeconds?: number
  fNumber?: number
  flash?: number
  focalLengthMm?: number
  capturedAt?: FlickrTime
  digitizedAt?: FlickrTime
  modifiedAt?: FlickrTime
}
export type IptcMetadata = {
  caption?: string
  dateCreated?: string
  timeCreated?: string
  digitalCreationDate?: string
  digitalCreationTime?: string
}
export type AssetMetadata = {
  title?: string
  description?: string
  capturedAt?: FlickrTime
  flickrImportedAt?: FlickrTime
  location?: { latitude: number; longitude: number }
  flickrRotation?: 0 | 90 | 180 | 270
  exifOrientation?: number
  license?: string
  sourceUrl?: string
  comments?: FlickrComment[]
  annotations?: FlickrAnnotation[]
  groupMemberships?: { id: string; name?: string; sourceUrl?: string }[]
  tagAttributions?: { tagId: string; author: string; createdAt?: FlickrTime }[]
  embedded?: { exif?: ExifMetadata; iptc?: IptcMetadata }
}

export type StoredObjectRef = {
  kind: 'original' | 'preview' | 'photo-json' | 'album-json'
  root: string
  key: string
  mimeType: string
  byteLength: number
  sha256?: string
  observedVersion?: string
}

export type AssetV1 = {
  id: string
  source?: { sourceKey: string; photoId: string }
  original: StoredObjectRef
  filename: string
  mediaKind: 'photo' | 'video'
  addedAt: string
  previews: StoredObjectRef[]
  metadata: AssetMetadata
  tagIds: string[]
}

export type AlbumMetadata = {
  description?: string
  coverPhoto?: { photoId?: string; sourceUrl?: string }
  createdAt?: FlickrTime
  updatedAt?: FlickrTime
}
export type TagV1 = {
  id: string
  title: string
  source?: { sourceKey: string; kind: 'album' | 'keyword'; value: string }
  album?: AlbumMetadata
}

export type CatalogV1 = { version: 1; assets: AssetV1[]; tags: TagV1[] }
export type PinnedLibrary = { revisionId: string | null; baseToken: string; catalog: CatalogV1 }
export type IndexLoad =
  | { status: 'ready'; value: PostingsV1 }
  | { status: 'repairable'; reason: 'missing' | 'corrupt' | 'unsupported' }

export type LibraryIntent = { baseToken: string; operationId: string } & (
  | { kind: 'import-photo'; file: File; preview?: Blob; tagTitles: readonly string[]; addedAt: string }
  | { kind: 'create-tag'; title: string }
  | { kind: 'set-tag'; assetId: string; tagId: string; present: boolean }
)
export type PublishFailure = 'invalidPlan' | 'invalidReference' | 'integrity' | 'unreadableBytes'
  | 'denied' | 'expired' | 'aborted' | 'storage' | 'corrupt' | 'unsupportedVersion'
export type PublishResult =
  | { status: 'published'; revisionId: string }
  | { status: 'unchanged'; revisionId: string | null }
  | { status: 'stale' }
  | { status: 'outcomeUnknown'; operationId: string; code?: PublishFailure }
  | { status: 'failed'; code: PublishFailure }

export type PublishOptions = { mode?: 'publish' | 'recover'; signal?: AbortSignal }

export interface LibraryRepository {
  open(signal?: AbortSignal): Promise<PinnedLibrary>
  loadIndex(pin: PinnedLibrary, kind: 'text' | 'tags', signal?: AbortSignal): Promise<IndexLoad>
  readOriginal(pin: PinnedLibrary, assetId: string, signal?: AbortSignal): Promise<Blob>
  readPreview(pin: PinnedLibrary, assetId: string, signal?: AbortSignal): Promise<Blob | undefined>
  publish(intent: LibraryIntent, options?: PublishOptions): Promise<PublishResult>
}
