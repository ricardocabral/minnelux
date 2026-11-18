# Flickr importer and library repository contract

The Flickr importer plans a change against a pinned library revision. The library repository stores the objects and publishes the resulting revision. This version 1 interface lets the importer and repository use the same fixtures while their implementations proceed in parallel. The library uses provider-relative object references and conditional head publication. [Library format and publication](../../prod/minnelux-prd.md#4-library-format) · [Flickr importer specification](SPEC.md)

## Operations

These signatures describe the shared application interface. Each repository instance is bound to one authorized library session and its configured library and media roots.

```typescript
interface FlickrImportRepository {
  listFlickrSources(signal?: AbortSignal): Promise<FlickrSource[]>
  readFlickrImport(sourceKey: string, signal?: AbortSignal): Promise<FlickrImportBaseV1>
  openImportObject(baseToken: string, ref: StoredObjectRef, signal?: AbortSignal): Promise<ByteStream>
  publishFlickrImport(plan: FlickrImportPlanV1, options?: PublishOptions): Promise<PublishResult>
}
```

- `listFlickrSources` reads account bindings from the current published revision. A fresh browser can select an existing source before opening a media-only ZIP. An uninitialized library returns an empty list. A first import can establish a new binding.
- `readFlickrImport` pins a head and returns the selected source state, its existing assets and imported tags, owner-applied tag IDs, and recent receipts. An absent source returns `source: null` at the current revision. An absent head returns `revisionId: null` and a base token for conditional creation. Authorization failures, corrupt data, and unsupported versions are errors.
- `openImportObject` opens raw JSON, candidate originals, or other object references supplied by that pinned base. The repository checks that the reference belongs to the base's authorized library, source, and revision, and resolves it only within the configured root for its kind. This operation allows the importer to reopen saved candidates and source records when it needs their bytes.
- `publishFlickrImport` applies one confirmed plan against its base token. The repository validates the plan, stores immutable objects, and publishes the catalog, search snapshots, and import state under one head update. The importer handles ZIP parsing, source identity matching, metadata and album rules, and user review.

## Shared records

These are application types. The repository exposes version 1 records after decoding storage. The revision manifest and snapshot encoding belong to the repository.

```typescript
type ByteStream = ReadableStream<Uint8Array>
type ObjectKind = 'original' | 'preview' | 'photo-json' | 'album-json'
type ObjectDescriptor = { kind: ObjectKind, mimeType: string, byteLength: number, sha256: string }
type StoredObjectRef = ObjectDescriptor & { root: string, key: string, observedVersion?: string }
type ObjectInput = StoredObjectRef | { uploadId: string }
type ImportUpload = ObjectDescriptor & { uploadId: string, openBytes: (signal?: AbortSignal) => Promise<ByteStream> }

type FlickrSource = { sourceKey: string, label: string, flickrAccountId?: string }
type MemberId = readonly [partId: string, entryOrdinal: number]
type PartRecord = { members: Record<number, 'stored' | 'ignored' | 'deferred'> }
type SourceRecord<R> = { variants: { member: MemberId, raw: R }[], selected?: MemberId }
type MediaCandidate<R> = {
  member: MemberId
  filename: string
  photoId?: string
  original: R
  review: 'pending' | 'confirmed' | 'duplicate' | 'conflict' | 'rejected'
}

type SourceState<R> = {
  version: 1
  binding: FlickrSource
  parts: Record<string, PartRecord>
  photos: Record<string, SourceRecord<R>>
  albums: Record<string, SourceRecord<R>>
  candidates: MediaCandidate<R>[]
  links: Record<string, { assetId: string, member: MemberId }>
  ownerFields: Record<string, Partial<Record<EditableField, 'set' | 'cleared'>>>
  ownerTagNames: Record<string, 'set'>
  memberships: Record<string, Record<string, Membership>>
}
type EditableField = 'title' | 'description' | 'capturedAt' | 'location'
type Membership = { source?: 'provisional' | 'authoritative', owner: 'inherit' | 'add' | 'remove' }

type FlickrTime = { wallTime: string, precision: 'second', offsetMinutes?: number, provenance: 'flickr' | 'exif' }
type FlickrComment = { id?: string, body: string, author?: string, createdAt?: FlickrTime, sourceUrl?: string }
type FlickrAnnotation = {
  body: string
  author?: string
  createdAt?: FlickrTime
  bounds?: { x: number, y: number, width: number, height: number }
}
type ExifMetadata = {
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
type IptcMetadata = {
  caption?: string
  dateCreated?: string
  timeCreated?: string
  digitalCreationDate?: string
  digitalCreationTime?: string
}
type AssetMetadata = {
  title?: string
  description?: string
  capturedAt?: FlickrTime
  flickrImportedAt?: FlickrTime
  location?: { latitude: number, longitude: number }
  flickrRotation?: 0 | 90 | 180 | 270
  exifOrientation?: number
  license?: string
  sourceUrl?: string
  comments?: FlickrComment[]
  annotations?: FlickrAnnotation[]
  groupMemberships?: { id: string, name?: string, sourceUrl?: string }[]
  tagAttributions?: { tagId: string, author: string, createdAt?: FlickrTime }[]
  embedded?: { exif?: ExifMetadata, iptc?: IptcMetadata }
}
type FlickrAsset<R> = {
  id: string
  source: { sourceKey: string, photoId: string }
  original: R
  filename: string
  mediaKind: 'photo' | 'video'
  addedAt: string
  previews: R[]
  metadata: AssetMetadata
  tagIds: string[]
}
type AlbumMetadata = {
  description?: string
  coverPhoto?: { photoId?: string, sourceUrl?: string }
  createdAt?: FlickrTime
  updatedAt?: FlickrTime
}
type FlickrTag = {
  id: string
  title: string
  source: { sourceKey: string, kind: 'album' | 'keyword', value: string }
  album?: AlbumMetadata
}
type Receipt = { sourceKey: string, operationId: string, fingerprint: string, committedRevisionId: string }
type FlickrImportBaseV1 = {
  version: 1
  sourceKey: string
  revisionId: string | null
  baseToken: string
  source: SourceState<StoredObjectRef> | null
  assets: FlickrAsset<StoredObjectRef>[]
  tags: FlickrTag[]
  receipts: Receipt[]
}
type FlickrImportPlanV1 = {
  version: 1
  sourceKey: string
  baseToken: string
  operationId: string
  source: SourceState<ObjectInput> | null
  assets: FlickrAsset<ObjectInput>[]
  tags: FlickrTag[]
  uploads: ImportUpload[]
}
type PublishOptions = { mode?: 'publish' | 'recover', signal?: AbortSignal }
type PublishFailure = 'invalidPlan' | 'invalidReference' | 'integrity' | 'unreadableBytes'
  | 'denied' | 'expired' | 'aborted' | 'storage' | 'corrupt' | 'unsupportedVersion'
type PublishResult =
  | { status: 'published', revisionId: string }
  | { status: 'unchanged', revisionId: string | null }
  | { status: 'stale' }
  | { status: 'outcomeUnknown', operationId: string, code?: PublishFailure }
  | { status: 'failed', code: PublishFailure }
```

- **Revision and scope.** `baseToken` is opaque and identifies the observed head condition, including absence, for a specific library and source. It is stable for that observation so an identical confirmed plan can be retried after reauthorization. It conveys no permissions. Reads and writes still require a current authorized session. `readFlickrImport`, `listFlickrSources`, and `openImportObject` reject with a coded error from `PublishFailure` where applicable.
- **Source identity.** The source key is stable within the library. Store a label and the verified Flickr account ID when it is available. An identity-free ZIP uses the owner's selected binding. Reject conflicting account evidence and duplicate bindings for a known Flickr account ID. Persist the binding in the first published source state. App-level source scoping protects data integrity within a library. Provider permissions protect library access.
- **Asset and tag identity.** Treat photo and album IDs as opaque digit strings. New Flickr catalog IDs use `flickr:` plus lowercase SHA-256 of the UTF-8 bytes of `JSON.stringify([sourceKey, kind, value])`. `kind` is `asset`, `album`, or `keyword`. `value` is the photo ID, album ID, or validated keyword. Reuse an existing catalog ID for the same source identity. Distinct photo IDs retain distinct assets even if their original digests match. Current catalog values live on the asset or tag. Use UTC ISO 8601 for `addedAt`, and `YYYY-MM-DDTHH:mm:ss` plus an optional offset in minutes for Flickr wall time.
- **Part identity and review.** `partId` is the lowercase SHA-256 of the ZIP bytes. Use the zero-based central-directory ordinal as `entryOrdinal`. Hash incrementally in a worker using bounded reads. An identical ZIP can resume member by member. `stored` means the durable source or candidate record exists. `ignored` means the owner or input policy made a terminal exclusion. `deferred` or an absent disposition means reselection can process that member again. `pending` and `conflict` candidates with stored bytes can be reviewed after reopen without the ZIP. A confirmed link records the selected candidate and the asset ID. Later candidates stay separate from that link.
- **Raw sources and membership.** Photo records are keyed by Flickr photo ID and album records by album ID. Retain each valid conflicting variant and which member supplied the selected JSON. When a conflict has no selected record, surface it for review before applying its metadata or album edges. Reconstruct pending album edges from selected source records, including references to IDs with no sidecar or original. Keep source membership and owner choices by photo ID and tag ID. The raw album JSON preserves order and reserved placeholders.
- **Owner edits.** The owner-edit workflow writes updated catalog values and override flags together in the same library revision, even when the field's current value is already absent or the tag already removed. An absent field override is untouched. `set` preserves the value on the catalog record. `cleared` preserves the field's intentional absence. An absent membership choice defaults to `inherit`. Source membership may change as albums arrive while `add` and `remove` persist. A tag rename writes `ownerTagNames` keyed by the tag ID. Only the owner-edit workflow changes owner choices. The importer carries the existing choices forward. This state is returned on the next `readFlickrImport`.
- **Upserts.** Each asset and tag ID occurs at most once per plan. Supply complete records for the affected IDs and the resulting state of the selected account. Omitted catalog records and other accounts' state are retained. The repository checks upsert identities, confirmed links, raw records, membership references, and stored object references against the source binding and pinned base. Media and raw objects must come from that base or a same-plan upload. Existing owner or other-source tags may be referenced on affected assets. Upserts may change only assets and imported tags owned by the plan's source. An import may publish state without any asset or tag upserts. A null plan source with empty upserts and uploads represents a no-op without creating an account binding.
- **Object references.** `root` is a configured logical root, `key` is relative to it, and `observedVersion` is opaque. `byteLength` is a nonnegative integer and `sha256` is lowercase hex. Each `uploadId` is unique within a plan, and `openBytes` opens a new byte stream on every call. The repository verifies size and digest and replaces upload IDs with stored references before publishing. The repository verifies that originals, previews, and raw JSON references have their expected kinds. References carry no credentials or signed URLs.

### Optional catalog details

The additional photo and album fields are optional in version 1. Existing catalog snapshots open without migration. Photo comments and annotations carry plain text and preserve Flickr attribution. Annotation bounds retain the original coordinates and sizes. Tag attributions are scoped to the photo and reference the source keyword tag ID. An owner removing the active keyword membership preserves Flickr provenance.

Album metadata belongs to the imported album tag. Retain a cover reference even when its media has yet to arrive. The client resolves a stored Flickr photo ID within the same source account and can use that asset’s preview. A source URL is an explicit navigation target.

Embedded metadata belongs to the JPEG asset. The importer extracts it from original bytes, preserving EXIF wall times with a recorded offset when available. The primary catalog capture date retains its Flickr provenance. IPTC dates use `YYYY-MM-DD` and IPTC times use `HH:mm:ss` with an offset when available. An empty embedded record means the JPEG header was inspected. The schema keeps exposure seconds, focal length in millimeters, and the numeric EXIF flash field.

Reconciliation can populate these fields for existing assets from retained raw JSON and JPEG headers. Reselecting the same ZIP parts supplies their verified bytes locally. An upgrade publishes ordinary catalog and tag upserts, preserving asset IDs, confirmed links, originals, and owner edits.

### Object placement and lifetime

| Object | Placement and reference |
| --- | --- |
| Accepted original or saved candidate | Use `originals/` under the library root. The same immutable reference can be used before selection and after confirmation. An unresolved candidate is reachable from import state. A selected original is also reachable from the asset. Promotion requires no copy or rename. |
| Derived thumbnail or poster | Use `previews/` under the library root. Link the immutable preview from its asset. |
| Raw Flickr JSON and source state | Use `sources/flickr/<source-key>/` under the library root. Store original photo and album JSON bytes. Record references to them from source state. The revision manifest references the published source state for every imported account. |
| Catalog and search postings | Use the catalog, text index, and tag index prefixes in the PRD. The repository controls serialization, content keys, and snapshot layout. |

The repository generates object keys from controlled identifiers and validates root and kind when reading them back. Archive paths, album titles, and CDN URLs are provenance or display data. Publish only stored references. A saved media-first part is resumable because its original bytes and candidate reference were committed together. Unsaved bytes can require ZIP reselection. Keep the objects reachable from published revisions, including unresolved candidates. [PRD library format](../../prod/minnelux-prd.md#4-library-format)

## Publication and retry behavior

Assign a fresh `operationId` to each confirmed plan and retain it for retries of that plan. Default to `mode: 'publish'` for the first submission. Use `mode: 'recover'` when retrying a submission whose head update may already have committed. The repository fingerprints the JSON plan, including its base token and upload descriptors. Exclude `openBytes` and publish options, order object properties lexicographically by key, omit absent optional fields, and preserve array order. Hash the UTF-8 encoding of the resulting compact JSON using lowercase SHA-256. Retry with the same operation ID and plan content.

| Result | Contract |
| --- | --- |
| `published` | Return the committed revision ID. A matching receipt returns this result even if later writers advanced the head. Reject a retained operation ID with a different fingerprint as `invalidPlan`. |
| `unchanged` | The head still matches the base and the plan makes no durable change. Return the current revision ID or `null` for an uninitialized library. Skip head publication. |
| `stale` | The base no longer matches and the operation is known to have had no effect. The importer rereads the base and recomputes the plan. Confirm any changed effect before publishing with a new operation ID. |
| `outcomeUnknown` | The head update may have committed and the repository could not establish the result. Return the operation ID. After reauthorization, check the receipt and retry the same plan in recovery mode if the original base still matches and its bytes are available. When the head has advanced and there is no matching receipt, recovery keeps the outcome unknown. A newer head or missing receipt alone cannot establish failure. |
| `failed` | The request failed with the stated code before any possibly successful head update. Include validation, integrity, permission, credential, or storage failures. An interrupted or cancelled head request with an uncertain result follows the recovery path. |

Check retained receipts for the library, source, and operation ID before testing the base. Create immutable objects and verify any existing object before reusing it. Write the manifest, then conditionally update `head.json` against the pinned condition. Put the receipt in that same revision and carry a bounded set forward in later revisions. After an interrupted head request or a precondition rejection, reread the head and check receipts before returning. With a potentially committed attempt in recovery mode, a stale retry or an inability to read receipts leaves the original result unknown. Include the latest failure code when it can guide reauthorization or retry. The repository owns storage retries and receipt checks. The importer owns decisions against a newer base. [PRD publication and recovery](../../prod/minnelux-prd.md#publish-and-recover-a-revision)

After a full restart, rediscover the account and read published state. A retained operation ID can be checked against recent receipts. When neither the original intent nor its receipt can be recovered, treat the old result as unknown. Preview a new plan against the latest state using stable part, member, and asset identities, then confirm it before publishing. Saved candidates can be used from the repository. Reselect a ZIP if uncommitted bytes are needed.

## Shared contract fixtures

| Scenario | Expected behavior |
| --- | --- |
| Publish metadata first | A fresh session loads the sidecar, album edges, and part identity. The catalog gains the asset once the matching original is confirmed. |
| Publish media first | A fresh session can open the candidate's original bytes without the ZIP. Later metadata reuses the original reference and any published asset ID. |
| Replay with owner edits | Publish an ordinary owner edit that clears an already empty field, renames a tag, and adds or removes tags. Reopen, replay, and verify the choices survive alongside the published original while a late different-byte candidate appears for review. |
| Reopen a partially saved part | Publish one member and defer another without saving its bytes. A fresh browser rediscovers the same source and can reselect the same ZIP, retain the first member, and process the deferred member. |
| Reject a cross-source plan | Use the same Flickr photo ID in two accounts. Try reading an object from the wrong pinned base and try submitting a foreign asset, tag upsert, or candidate reference. Reject those operations. A reference to an existing owner-applied tag remains valid. |
| Lose the head response | A matching receipt resolves a retry to the committed revision. Simulate another publication before the retry and verify the receipt is still honored. |
| Receipt no longer retained | Simulate a lost head response followed by other publications and receipt eviction. Recovery stays unknown. A fresh browser can reconcile the confirmed source state without restoring the old plan or duplicating the linked asset. |
| Start with no head | A no-change plan returns `unchanged` with a null revision ID. A first publish uses conditional creation, and a competing initialization cannot overwrite it. |
| Race a catalog edit | A stale import plan cannot publish over a newer owner edit. Reconcile against the newer head and preserve the edit. |
| Reopen one complete revision | The catalog, pending import state, and both search postings agree. Originals are immutable, and all references resolve under the expected roots. |

Use the media and ZIPs from the [Flickr spike fixtures](../../../spikes/flickr/README.md), and create shared typed base and plan fixtures for this interface. Exercise two independent sessions against the same store with real precondition semantics and injected loss of the head response. The deployed private GCS workflow then verifies storage access, conditional publication, and fresh-browser resume. Whole gzip snapshots are the GCS reference workload. Physical snapshot layout can evolve behind the repository interface as mobile measurements come in. [Snapshot benchmark](../../../spikes/snapshots/README.md) · [Release validation](../../prod/minnelux-prd.md#6-release-validation-and-implementation-order)
