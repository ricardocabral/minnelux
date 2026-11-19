# Minnelux storage and indexing

The GCS reference workflow publishes one photo with two tags and finds it from a freshly authorized browser using the stored index. The same revision is the unit of publication, browse, and search. The GCS and S3 adapters implement the same object-storage interface. [Product requirements](../../prod/minnelux-prd.md) · [Implementation plan](../../../plans/gcs-reference-workflow.md)

## Storage interface

The session controller binds identity, provider, approved HTTPS endpoints, library root, optional media roots, access mode, expiry, and a cancellation signal. Provider permissions enforce access. The authorized request path uses in-memory credentials. Expiry, disconnect, and account or library changes invalidate the binding, abort work, and discard late replies and private views. Reauthorization may resume the same asset or reconcile the same operation only after checking identity, library, and access again. The web client can restore an opt-in Google Cloud Storage connection from a short-lived token saved in IndexedDB. The GCS reference uses the PRD's GIS token flow with scoped IAM. The importer's optional token downscoping is a provider-specific design choice whose listing, alternate media-root, and expiry behavior would need its own proof. [Web client session contract](../web-client/SPEC.md#session-and-worker-messages) · [PRD security and provider setup](../../prod/minnelux-prd.md#security-requirements)

```typescript
type WriteToken = string
type Cursor = string
type ByteRange = { start: number; endInclusive: number }
type RequestOptions = { signal?: AbortSignal }
type ObjectStat = { byteLength: number; mimeType?: string; observedVersion?: string }
type WriteCondition = { kind: 'create' } | { kind: 'match'; token: WriteToken }

interface ObjectStore {
  list(prefix: string, options?: RequestOptions & { cursor?: Cursor }):
    Promise<{ entries: ReadonlyArray<ObjectStat & { key: string }>; nextCursor?: Cursor }>
  stat(key: string, options?: RequestOptions): Promise<ObjectStat>
  read(key: string, options?: RequestOptions & { range?: ByteRange }):
    Promise<{
      body: ReadableStream<Uint8Array>
      mimeType?: string
      byteLength?: number
      range?: ByteRange & { objectByteLength: number }
    }>
  readForUpdate(key: string, options: RequestOptions & { maxBytes: number }):
    Promise<{ body: Uint8Array; token: WriteToken } | null>
  write(key: string, body: Blob, condition: WriteCondition, options?: RequestOptions):
    Promise<{ observedVersion?: string }>
}
```

- **Keys and cursors.** Keys and prefixes are relative to the bucket or container after resolving configured roots. The repository validates reference kind and root and rejects references escaping that root. The adapter preserves valid provider key spelling and applies provider-specific encoding. A cursor belongs to its exact listing scope. Tokens and observed versions are opaque. An object version is separate from the write token and the asset ID. A write token applies to its original object and provider target.
- **Coherent observation.** `readForUpdate` returns bytes and a token for the same object revision. GCS can pair a metadata observation with a media read pinned to that generation. If the pinned generation disappears between requests, repeat the whole observation or surface the race. S3 uses the body and exact quoted ETag from one GET. `null` means confirmed absence. A denial or ambiguous absence must never initialize a library. Use this operation for the bounded head read. Snapshot and media reads stream through `read`.
- **Conditional writes.** Every write has an explicit condition. GCS maps create to generation zero and match to the observed generation. S3, Azure, and R2 use their native create and match preconditions as documented in the PRD. Use a replayable `Blob` or `File` for the first path. Keep provider upload protocols inside the adapter when large-media imports need them.
- **Errors.** Storage failures expose a code from `missing | denied | expired | conflict | transport | aborted | limit | invalidResponse`, with sanitized provider status where available. Map only a confirmed precondition rejection to `conflict`; a provider's ambiguous conditional conflict must be reconciled by rereading the head. Preserve ambiguous absence as an error. The repository treats an interrupted or cancelled head write as possibly committed unless it has evidence the write did not run.
- **Ranges.** The adapter returns a stream only for a valid partial response to a range request. Validate status, offsets, and lengths and reject unexpected full-body responses. The service worker translates player ranges into bounded reads and checks the requesting tab, session, library, asset, and video MIME type. Serve private media without app caching, and use an opaque same-origin video route bound to the authorized tab.

## Library format and publication

Read v1 as emitted by the Flickr importer. Emit a v2 manifest on new publications so general operation receipts have an explicit format. Keep compatible head, catalog, and posting encodings at v1. The repository owns serialization and validates references before issuing requests.

| Object | Format and rule |
| --- | --- |
| `head.json` | `{version: 1, revisionId, manifest}`. The manifest descriptor points to `revisions/<revisionId>.json`. The head is the mutable publication pointer. |
| Revision manifest | `{version: 1, revisionId, parentRevisionId, catalog, textIndex, tagIndex, indexVersion, tokenizerVersion, sources, receipts}`. Version 1 has these fields. Version 2 sets `version: 2` and adds the required `libraryReceipts` array for ordinary edits and repairs. Object descriptors carry `key`, lowercase SHA-256, and exact byte length. |
| Catalog | `{version: 1, assets, tags}` under `catalog/<sha256>.json.gz`. Asset IDs are stable. Catalog positions define index ordinals within one revision. Preserve existing order where possible and keep view sorting separate. |
| Media and source records | Keep logical root and relative key, kind, size and MIME type, plus the content digest for owned immutable objects and optional observed provider version. Accept v1 Flickr content-addressed original and preview keys. Existing-object imports retain their original location under a configured media root. Use logical root and key as their retry identity. Retain the operation ID and original digest for local upload retries. Preserve source state and owner overrides. |
| Text and tag indexes | Separate `{version: 1, postings}` payloads at `index/text/<sha256>.json.gz` and `index/tags/<sha256>.json.gz`. Persist compressed bytes as gzip payloads so the application verifies the stored bytes before decompressing. |

Use compact UTF-8 JSON with sorted object keys and preserved array order for new writes. Hash the stored bytes. Cap head reads at 64 KiB and manifests at 4 MiB. Start with the Flickr prototype's 128 MiB ceiling per snapshot for both compressed and expanded bytes. Count streamed bytes before buffering or parsing, even when length headers are absent or wrong. Validate record shapes, field values, reference keys, and versions. The ceilings bound input and are subject to the mobile working-set measurements. Large original reads follow the media/import budget separately.

`open(signal?)` returns a pinned revision containing the catalog and an opaque publication base. A confirmed missing head returns an empty catalog with a base for conditional creation. An invalid head, manifest, or catalog rejects the open operation with a coded error the UI can surface. A pin belongs to the active session and library. It provides the catalog and index descriptors for that revision even if the head advances. A publication base represents the observed head condition and can be rechecked after reauthorization for the same library. It conveys no authority.

The first slice uses this library worker interface. Use the same v1 catalog records for the repository, index builders, and fixtures. The ordinary catalog fields use the same spelling as the Flickr records in the linked contract.

```typescript
type CatalogV1 = { version: 1; assets: AssetV1[]; tags: TagV1[] }
type PinnedLibrary = { revisionId: string | null; baseToken: string; catalog: CatalogV1 }
type IndexLoad =
  | { status: 'ready'; value: PostingsV1 }
  | { status: 'repairable'; reason: 'missing' | 'corrupt' | 'unsupported' }

interface LibraryRepository {
  open(signal?: AbortSignal): Promise<PinnedLibrary>
  loadIndex(pin: PinnedLibrary, kind: 'text' | 'tags', signal?: AbortSignal): Promise<IndexLoad>
  publish(intent: LibraryIntent, options?: PublishOptions): Promise<PublishResult>
}
```

Each `LibraryIntent` includes `baseToken` and `operationId`. The first slice needs an import command with a replayable photo and digest, plus commands to create tags and set membership by asset and tag ID. Use targeted commands so reapplying one edit to a newer base can preserve unrelated changes. Add explicit repair and existing-object import commands in Phase 2. Preserve the Flickr repository's public operations over the same publisher. Worker messages carry pin or result handles, with the full catalog retained in the library worker.

The repository publishes ordinary edits and Flickr plans through one sequence.

1. Reobserve the head, check the operation receipt first, then check the base. Use one operation ID per confirmed intent. Fingerprint the canonical intent, including base and upload descriptors. A retained operation ID with a different fingerprint is invalid.
2. Create immutable media and source objects as needed, then write the catalog, both indexes, and manifest. Reuse existing objects only after verifying their size and digest. Reuse an index only if its data and catalog ordinal mapping still agree. Keep Flickr source state and receipts on unrelated edits.
3. Conditionally advance the head from the observed token or confirmed absence. A reader sees one complete revision. A confirmed stale writer reloads and reapplies independent edits against a new base. A conflicting modification to the same field or tag membership requires the owner's decision.
4. Reconcile an interrupted head update by rereading the head and checking the same operation ID and fingerprint. A matching receipt proves publication even if the head advanced. If the old base still matches, the same intent can retry with the same ID. If the head advanced and the receipt is missing or unreadable, report `outcomeUnknown` and preserve that uncertainty. Keep the Flickr contract's `published | unchanged | stale | failed | outcomeUnknown` outcomes.

Preserve the legacy source-scoped `receipts` array. Store library edits and repair receipts in v2 `libraryReceipts` with `{operationId, fingerprint, committedRevisionId}`, capped at 64 using the same retention rule as Flickr receipts. All writers in the integrated app carry both arrays forward. Treat the array as empty when reading v1. A successful conditional write appends v2 without converting or replacing prior immutable v1 objects. Integrate the Flickr writer before concurrent use with v2. The prototype expects a v1 manifest and cannot open v2 by itself. Published objects remain available, with cleanup and backup recovery handled outside app credentials. [Flickr retry contract](../flickr-import/REPOSITORY-CONTRACT.md#publication-and-retry-behavior)

### Optional photo and album fields in Catalog v1

The [Flickr repository contract](../flickr-import/REPOSITORY-CONTRACT.md#shared-records) defines the field types. Read older v1 records with these fields absent. Keep the fields within the catalog snapshot and carry them across manifest upgrades, ordinary edits, and subsequent imports.

| Catalog path | Stored values |
| --- | --- |
| `assets[].metadata.license`, `sourceUrl` | Exported license text and the source photo page URL. |
| `assets[].metadata.comments`, `annotations` | Plain-text comments and annotations with source attribution and timestamps when supplied. Comments can carry an ID and source URL. Annotations can carry original `x`, `y`, `width`, and `height` bounds. |
| `assets[].metadata.groupMemberships`, `tagAttributions` | Flickr group IDs with optional names and URLs, plus source keyword tag IDs with authors and optional timestamps. An attribution belongs to its photo and survives removal of the active tag membership. |
| `assets[].metadata.embedded.exif` | Original JPEG camera and lens make and model, ISO, exposure in seconds, f-number, numeric flash value, focal length in millimeters, and capture, digitization, and modification times. |
| `assets[].metadata.embedded.iptc` | Original JPEG caption, creation date and time, and digital creation date and time. |
| `tags[].album` | Imported album description, optional cover reference by Flickr photo ID and source URL, and creation and update times. This object belongs to the imported album tag. Keep a cover reference even while the corresponding original is absent. |

Preserve time provenance, precision, and any recorded offset. Store embedded camera dates separately from the catalog's primary capture date. An empty `embedded` object records that the importer inspected the original JPEG header and found no mapped fields. Validate known optional values without discarding fields during catalog decoding, serialization, or field-scoped edits. The existing v1 search inputs and posting format remain compatible. Include these details in the v1-to-v2 round-trip fixture. [Reconciliation and backfill rules](../flickr-import/REPOSITORY-CONTRACT.md#optional-catalog-details)

## Search and index repair

The library worker owns the pinned catalog and postings. The repository loads and verifies stored bytes. Search builds and validates posting data and queries it without provider details. These are the seams shared by the repository and search tasks.

```typescript
type PostingsV1 = { version: 1; postings: Record<string, number[]>; repairId?: string }
type Query = {
  text?: string
  tagIds?: readonly string[]
  mediaKind?: 'photo' | 'video'
  fromDate?: string
  beforeDate?: string
  untagged?: boolean
}
type QueryResult = { ids: string[]; total: number }
```

- `buildPostings(catalog)` returns `{text, tags}`. Text postings alternate strictly increasing zero-based asset ordinals with integer weights. Tag postings are strictly increasing ordinals. Normalize text and tag titles with NFKD, strip combining marks, lowercase, and split into Unicode letter/number runs. Count each normalized term once per field. Filename, title, and description contribute 1, 4, and 2. Preserve the importer's field paths and tag `title`. Stamp `indexVersion: 1` and `tokenizerVersion: 1`.
- `validatePostings(kind, value, catalog)` validates the v1 shape, key and token rules, pair stride, weights 1–7, known tag IDs, and ordinals bounded by the pinned catalog. Look up postings by own key. The repository's `loadIndex(pin, kind, signal?)` validates the descriptor, exact bytes, digest, and gzip within limits, then calls this validator. Map missing, corrupt, and unsupported indexes to an explicit repairable state. Preserve denied, expired, aborted, and transport as request failures. Index descriptor validation happens on the corresponding lazy load, so it cannot block a valid catalog.
- `queryCatalog(catalog, query, indexes)` returns a stable ordered result of asset IDs for the pin. The index inputs have optional `text` and `tags` values. A query with text requires both; selected-tag browsing requires only tag postings. Ordinary and untagged browse use the catalog. For each distinct normalized term, union text hits with current catalog tag-title hits and add 3 per matching tag. Intersect across terms and selected tags, then filter by kind and date. Use inclusive `fromDate` and exclusive `beforeDate` in `YYYY-MM-DD`, derived from recorded capture date with added date as fallback. Empty or punctuation-only text browses the catalog. Sort text results by score descending, then use capture time descending with added-time fallback and stable asset ID ascending. Preserve offset-free calendar values across browser timezones.
- Open with head, manifest, and catalog. Load tag postings for collections and text postings on the first text query. Cache loaded indexes in memory by pinned revision and discard them with its session. A fresh-browser text query must use persisted postings without listing media, opening originals, or rebuilding the index. With a damaged index, keep catalog browse available and expose a repair action. A valid index can still be used by a view that does not depend on the damaged one.
- Repair builds from the pinned catalog and publishes a new revision through the same conditional and receipt rules. Keep the catalog descriptor, original refs, and source state. Include the repair operation UUID as `repairId` in both v1 posting payloads so repaired bytes can be written under fresh digest keys even when corrupt bytes occupy the old keys. Readers ignore its value after shape validation. A stale repair cannot replace a newer catalog. After successful repair, a fresh browser searches the repaired revision.

## Release evidence

Use synthetic private data for contract tests and hosted checks. Record test origin, provider, browser and device, timestamp, fixture and sample size, and observed requests/statuses. Test absence versus denial, creates and stale updates, interrupted writes, stale worker replies, out-of-root access, tab isolation, read-only access, and repair after invalid or missing postings.

Measure the 50,000-item workload on a midrange phone with real private GCS at 20 Mbps and 80 ms RTT. Report p95 to visible thumbnails within 3 s, cold text query within 1 s once the catalog is ready, and warm query within 250 ms. Record peak working memory, transferred bytes, request counts, and build, compression, and publication timings separately. Verify migration preserves asset IDs, tags, and search once another provider passes its own contract and security checks. [PRD release criteria](../../prod/minnelux-prd.md#6-release-validation-and-implementation-order)

### Provider validation

#### Google Cloud Storage

On November 18, 2026 at 12:02–12:10 BRT, Chrome 157 on the hosted HTTPS probe completed one Google Identity Services editor run and one viewer run against private GCS. The editor decoded a private JPEG, wrote two snapshots, and created and updated the head with HTTP 200. A stale generation returned 412 and an independent read confirmed the head still named the newer revision. The viewer decoded the JPEG with the read-only scope and received 403 on publication. A signed-out JSON API read in a separate Chromium check returned 401.

In one hosted playback run, the service worker received readable `206` range responses and resumed at 72 seconds after streaming 7,123,755 of 27,745,984 bytes. A separate loopback run against GCS denied replay from a second tab. Local sign-out and a fresh Google sign-in restored the position in the hosted probe. Release checks still cover actual provider token expiry, a signed-in account without bucket IAM, and seeking on desktop and mobile Safari. The fixture was a synthetic fast-start H.264 MP4 stored without content encoding. [Hosted test evidence and reproduction steps](https://github.com/ricardocabral/minnelux/blob/2c48c2aee643ef2e0f558ad9029a65b1b04065fb/spikes/gcs/README.md#hosted-chrome-results)

#### Amazon S3

The November 18, 2026 Cognito and private S3 proof recorded successful editor and viewer reads and 403 responses for anonymous or unassigned reads and viewer writes. The configured origin could read ETag and range headers. The editor listed two fixtures over two pages and received 403 for bucket-wide listing and an out-of-prefix read. Conditional writes returned 200. Duplicate creates and a stale quoted ETag returned 412, and an independent read confirmed the head still named the newer revision.

Two Chrome 157 runs sought to 72 seconds before the synthetic 27,745,984-byte object finished downloading and received a new `206` after the seek. A signed-out context replayed the presigned playback URL after local disconnect. An expired test URL returned 403 and a replacement returned 206. This establishes URL expiry behavior. Verify AWS credential expiry and revocation separately, and test that the app's planned tab-bound route denies replay of its exact playback URL. [Browser proof and reproduction steps](https://github.com/ricardocabral/minnelux/blob/b3d0b33e3164c34d5b3bb5535dd3203552e3d1c6/spikes/s3/README.md) · [S3 setup and CORS](../../prod/connect-amazon-s3.md#configure-browser-access)

### Whole-snapshot measurements

The November 18, 2026 runs at 13:07 and 13:10 BRT used Chrome 157 headless on a macOS desktop, a modeled 20 Mbps per direction and 80 ms per request on loopback, and 40 samples per stage and profile. Each profile generated 50,000 assets with the same seed and tag memberships. The higher-vocabulary profile had 24,618 normalized title and description terms compared with 98 in the baseline, excluding titles equal to filenames. The browser worker built the postings, gzipped and hashed the three snapshots, then uploaded those snapshots, the manifest, and the head.

| Stage | Baseline p95 | Higher-vocabulary p95 |
| --- | ---: | ---: |
| Build text and tag postings | 152.5 ms | 191.2 ms |
| Serialize, gzip, and hash snapshots | 343.7 ms | 351.4 ms |
| Upload snapshots, manifest, and head | 1,851.7 ms | 1,956.0 ms |
| Reopen and order the first 48 asset records | 1,495.0 ms | 1,599.4 ms |
| Cold text query with catalog ready | 603.2 ms | 645.3 ms |
| Warm text query | 7.5 ms | 7.0 ms |

All 80 reopens returned the expected revision and first page. Each of the 80 cold and 80 warm queries matched a direct catalog scan on result count and first-page order. The reopen transferred 2,732,730 to 2,889,422 payload bytes across three reads. Cold search transferred 1,248,128 to 1,357,606 bytes across two reads. Warm search reused the loaded postings.

These results support using whole gzip snapshots for the GCS reference workflow. The reopen clock stopped after ordering catalog records, before fetching or rendering thumbnails. Use the release measurements on real GCS and a midrange phone, including peak memory, to decide whether paging or sharding is worthwhile. [Workload, raw stages, and benchmark source](https://github.com/ricardocabral/minnelux/blob/2c48c2aee643ef2e0f558ad9029a65b1b04065fb/spikes/snapshots/README.md#measurements)
