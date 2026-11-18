# Flickr importer specification

The Flickr importer turns a Flickr account data export into a private Minnelux library. The owner can add metadata and media ZIPs in any order, preview the proposed changes, and resume from another authorized browser. Minnelux keeps the original bytes and relevant source JSON. Flickr albums become Minnelux tags, so one original can appear in multiple collections. [Minnelux PRD](../../prod/minnelux-prd.md) · [Flickr export handoff](../../flickr/HANDOFF.md)

## Import contract

- Accept the ZIPs produced by Flickr’s **Request my Flickr data** flow. A batch may contain metadata, media, or both. Recognize archive contents by their entries. Support metadata-only continuations that do not contain `albums.json`. Use the archive filename for display and diagnostics.
- Bind all parts to one stable Flickr source account key within the selected library. Resolve the binding from available account identity or explicit owner selection. Reuse the same key for later parts. Surface conflicting account evidence before merging.
- Show the import preview before publication. Report counts and affected items, per-file errors, and what can proceed. The owner can defer unresolved items and later supply missing parts or confirm ambiguous links. Show progress for reading, preparation, upload, and publication.
- Preserve originals byte for byte, including embedded EXIF. Preserve relevant raw photo and album JSON and provenance. Keep account export material such as contacts and unrelated profile data in the original archive. Private Flickr items are eligible for import into the owner’s private library.
- Keep imported assets, metadata, source state, thumbnails or posters, and search results available after reopening the library. Readers use the configured storage provider’s identity service. The static app reads local files and communicates directly with private object storage. The importer needs no Flickr login, API key, or CDN requests. [Flickr account export](https://www.flickrhelp.com/hc/en-us/articles/4404079675156-Downloading-content-from-Flickr)

### Preview states

| State | Meaning and behavior |
| --- | --- |
| Matched | One resolved original and a valid sidecar share an account-scoped Flickr ID. Show the metadata and tag changes that will be applied. |
| Metadata only | A valid photo sidecar exists and the original is pending. Keep the source record and album edges for a future import. |
| Media only | An original has a recognized type and an unambiguous source ID, and no sidecar has arrived. An owner-approved import can publish a provisional asset using its final asset ID. Later metadata enriches that asset. |
| Album reference only | An album lists an ID with neither a sidecar nor an original. Keep the edge and count it separately. Preserve reserved placeholders such as `0` in raw album JSON and omit them from live membership and pending-item counts. |
| Ambiguous | A filename has multiple credible identities, the identity is unresolved, or different byte payloads claim the same source ID. Show candidates and defer new links until resolved. Keep any previously confirmed original and its asset visible. |
| Duplicate | More than one candidate has the same source ID and identical bytes. Show the repeat without creating another asset. An existing confirmed link survives. A batch with multiple candidates and no confirmed link goes through duplicate review before the first link is published. |
| Invalid metadata or unreadable entry | The JSON is malformed, required fields are invalid, IDs disagree, or the member cannot be read or verified. Report the error for that entry and retain unrelated valid work. |
| Unsupported media | A member has an unrecognized or unsupported signature. Keep it visible for review. For an accepted original that the current browser cannot decode, preserve the original and provide a placeholder and download path. |

Album disagreements and unresolved album identities are additional diagnostics. An asset with a confirmed link can remain published while a later candidate requires review.

## Source identity and reconciliation

- Validate the string payload `id` against `photo_<id>.json`. Treat Flickr IDs as opaque digit strings through parsing, lookup, persistence, and publication. Derive stable asset identity from the account key and photo ID.
- Recognize the anchored `_<id>_o` suffix before the extension. Use the member basename for matching and retain the archive and member identity for provenance and diagnostics. Keep the sidecar’s `original` URL as provenance. The sample had zero CDN basenames that matched ZIP member basenames.
- Inspect headers or signatures before assigning the media type. A filename ending in `.jpg` can contain video. Legacy forms such as `<id>_<hex-secret>_o.<ext>`, titled video names ending in `_<id>.<ext>`, and extensionless originals are candidates for expanding support. Require a verified fixture and unambiguous matching for each added pattern.
- Give each part a stable identity that survives reselection and browser restarts. Track accepted entries and an occurrence identifier for repeated member names. Keep distinct candidates until their identity and, where necessary, their bytes can be compared. Use a strong digest for byte comparison or retry detection. Distinct Flickr IDs retain their own asset and metadata even when their bytes are identical.
- Persist enough information to recompute pending and unresolved matches from a fresh browser. Keep existing asset IDs, confirmed original references, owner edits, and owner-removed tags across replay, later parts, and publication retries. Use source field provenance or equivalent merge state so later metadata can populate untouched fields and preserve fields the owner cleared deliberately.
- Detect conflicting repeated sidecars or album documents by source ID. Keep the source variants available for diagnosis and report the disagreement. A replay of the same part is idempotent. Arrival order alone must never replace an owner-confirmed link.

### Albums and keywords

`albums.json` contains an `albums` array. Each album has a string `id`, `title`, and ordered `photos` array of string IDs. Build a reverse index from each photo ID to the album IDs containing it. Use `photos` membership even when `photo_count` differs. Membership is a set in the catalog. The raw array preserves order, duplicates if present, and references to items that have yet to arrive.

For every album present in the album document, use its `photos` list as the membership authority. Compare it with per-item `albums[]` and report disagreements. For albums absent from the document, a sidecar album with a valid ID can supply a provisional membership. Report per-item entries with unusable IDs. When the authoritative album arrives, withdraw conflicting provisional memberships while preserving independent owner additions. Record imported memberships and deliberate removals so replay and later parts cannot restore an owner-removed tag. Newly discovered memberships can add tags that the owner has yet to remove.

Key an album tag by source account and album ID. Key keyword tags in a separate namespace and populate them from `tags[].tag`. Titles are display labels and may collide with another album title or keyword. Renaming a tag preserves its ID and memberships. Each asset carries references to all of its tags.

### Metadata mapping

| Flickr source | Minnelux representation |
| --- | --- |
| `name` | Title. Retain the original export filename independently for provenance, display, and search. |
| `description` | Plain text for display and search. Parse markup without executing it or loading embedded resources, decode entities, and preserve readable boundaries. Retain the source string in raw JSON. |
| `date_taken` | Capture time with precision, provenance, and known offset if present. Treat `YYYY-MM-DD HH:mm:ss` without an offset as a recorded wall time. Sort and filter it consistently across devices. Retain embedded EXIF as source evidence. |
| `date_imported` | Flickr import time, distinct from capture time and the time the asset was added to Minnelux. Retain its wall time and any known offset. |
| `geo` | In the verified profile, the populated array holds one object with integer-string `latitude`, `longitude`, and `accuracy`. Divide signed coordinate values by 1,000,000. Validate latitude in `[-90, 90]` and longitude in `[-180, 180]`. Preserve full source precision, valid zero coordinates, and raw accuracy. Keep unknown shapes or invalid values in source JSON. |
| `rotation` and EXIF Orientation | Preserve both source values. Apply the orientation policy consistently in thumbnails, posters where applicable, and the viewer. Account for any orientation the browser decoder already applied. Verify equivalent EXIF and Flickr transforms produce one correction and cover cases where Flickr rotation supplies the only correction. |

### Photo and album details

- Map embedded photo comments from `comments[]` and image annotations from `notes[]`. Keep author, timestamp, and available source link. Preserve annotation bounds as Flickr coordinates. Display comment and annotation bodies as text.
- Map `groups[]` as photo group memberships and keep the Flickr license label and photo-page URL. Keep keyword authors and creation times on the photo by keyword tag ID.
- Store album descriptions, creation and update times, and cover references on album tags. Flickr album timestamps are Unix seconds and carry a UTC offset of zero in the catalog. Retain the Flickr cover photo ID or page URL if its image has yet to arrive.
- Extract JPEG EXIF make and model, lens fields when present, ISO, exposure duration, f-number, flash, focal length, and original, digitized, and modified times. Retain supported IPTC caption and creation fields. The scanner inspects a bounded header while verifying the original. A publish preview can also inspect an already stored original when its catalog record lacks embedded metadata.
- Display these fields in photo details and the selected album’s detail panel. Keep the original JPEG and raw Flickr JSON for full source fidelity.

## Browser and storage architecture

The versioned [importer and library repository contract](REPOSITORY-CONTRACT.md) defines the shared operations, durable records, and publication outcomes used by both implementations.

| Component | Responsibility |
| --- | --- |
| Import UI | Selects local ZIPs and a source account, displays the preview, supports review or deferral, and shows progress and failures. |
| ZIP reader in an import worker | Enumerates members from browser `File` objects, reads relevant JSON by member, and opens originals on demand for signatures, verification, previews, and upload. |
| Flickr reconciliation | Consumes the parsed parts and previously published source state. Resolves source identity, computes preview states, maps metadata and tags, and returns proposed catalog and import-state changes. The spike is the starting point for this logic. [Reconciliation spike](../../../spikes/flickr/README.md) |
| Preview and indexing workers | Generate thumbnails and video posters for browser-decodable originals. Build text postings from filenames, titles, and descriptions and tag postings from membership. Include imported tag names in search through the tag dictionary. |
| Library repository and storage adapter | Manage object references, private reads and writes, immutable snapshot creation, and conditional publication. The importer uses the provider-neutral repository interface. |

Use a browser ZIP library with random access over a `File` or `Blob`, per-entry reads, and streaming or bounded decompression. `zip.js` is a candidate to benchmark. Enumerate central-directory entries, parse photo and album JSON, and keep lightweight references to media members. Read signatures in bounded batches. Decompress and verify selected originals on demand, releasing buffers when each batch finishes. Measure peak memory and scan time on representative archives and on mobile Safari before tuning batch limits. Handle corrupt or unsupported ZIPs and members as actionable errors. Treat entry paths and metadata as untrusted data. Build library object keys from validated identities and digests or stable references, with display names stored separately. [zip.js ZipReader](https://github.com/gildas-lormeau/zip.js/blob/master/docs/classes/ZipReader.md)

### Archive and session safety

Validate member paths, JSON schemas, and media signatures before use. Enforce limits for member count, expanded bytes per file and import, metadata size, decoded dimensions, and concurrent reads and hashing. Surface limit failures in the preview and preserve the last published revision. Render imported filenames, titles, tags, and descriptions as text. Serve supported inert previews from private storage, strip location metadata from thumbnails and posters, and keep provenance URLs out of the media resolver. Resolve stored references only within configured library and media roots. [Untrusted imports](../../prod/minnelux-prd.md#untrusted-imports)

Keep credentials and active private data in memory. Send authenticated requests only to configured HTTPS endpoints. Keep credentials, signed URLs, and private filenames, titles, and locations out of diagnostics and telemetry. Abort in-flight work, ignore late results, and clear private views and app-managed caches on expiry, disconnect, or a library or account switch. Keep originals, previews, raw JSON, import state, and indexes under the same private storage permissions. [Security requirements](../../prod/minnelux-prd.md#security-requirements)

### Durable import state

Durable import state includes a format version, source account and item IDs, part and member references, source JSON object references, pending album edges, candidate and confirmed original references, field provenance, and membership history. A media-first part committed for later reconciliation must store its original bytes under a durable object reference. Browser file handles and in-memory `Blob` objects last only for the active import. Work that has yet to be saved can require the owner to reselect a ZIP.

### Publish and recover

1. Preview against the selected library revision. On confirmation, reread the head and reconcile against the current revision. Assign an operation ID so the publisher can recognize a committed retry.
2. Upload approved originals, previews, raw sources, and import state. Write the immutable catalog and text and tag postings snapshots. Write a revision manifest referencing all of them. Use create-only writes for immutable objects. Validate the head and manifest and verify snapshot digests when reopening a revision. Use the library’s relative object references, including `sources/flickr/<source-key>/...` for Flickr data.
3. Publish by conditionally updating `head.json`. On GCS use `ifGenerationMatch=0` for creation or the observed generation for an update. Readers see one published revision containing the assets, metadata, tags, search postings, and import state.
4. On a stale head, reload and reapply independent changes to the new revision. Surface conflicting owner edits. On interruption or an uncertain write, reread the head and check the operation receipt before retrying. Preserve objects referenced by published revisions. On credential expiry, resume after the owner reauthorizes and the publisher rechecks the head.

GCS is the reference integration. The same import workflow uses the storage adapters for Azure Blob Storage, Amazon S3, and Cloudflare R2. [Library format](../../prod/minnelux-prd.md#4-library-format) · [Publication and recovery](../../prod/minnelux-prd.md#publish-and-recover-a-revision)

## Implementation and acceptance

1. Exercise ZIP selection through the real browser reader using sanitized multipart fixtures. Verify metadata-first and media-first arrivals, split metadata with and without albums, a separate-session continuation, and a replay after durable restore. Include a real JPEG and a real video in the fixtures. Use a mislabeled video to verify signature detection.
2. Verify filename and payload ID agreement, malformed entries, multiple candidates, duplicate member names, byte-identical and different-byte candidates under one source ID, and account isolation. Verify that distinct source IDs sharing bytes remain distinct assets. Check progress and item-level errors in a mixed valid and invalid batch.
3. Verify overlapping albums, a keyword and album with the same display name, same-title albums with separate IDs, authoritative and provisional membership, conflicting sidecars, album-only IDs, and the `0` placeholder. Confirm that owner edits and deliberately cleared fields, tag renames and removals, and confirmed originals survive new parts, repeated imports, and conflicts.
4. Verify plain-text descriptions, offset-free dates across timezones, signed microdegrees including valid zero, invalid coordinate ranges, and source precision. Verify the displayed and previewed transform with EXIF alone, Flickr rotation alone, and both together. Confirm that original bytes and raw JSON survive publication. Verify that generated previews omit embedded location metadata.
5. Prove the private GCS browser path, then exercise the deployed reference workflow from import to fresh-browser reopen. Import an asset into two tags, find it through both collections and persisted text and tag searches, and open it full-screen. Check conditional publication, interrupted retries, concurrent edits, read-only access, and index rebuild. For supported video, observe upstream `206` and `Content-Range`, seek before the full original downloads, and verify playback resumes after reauthorization.
6. Run the PRD security acceptance checks with synthetic data on each provider before importing a real archive. Verify oversized and malformed inputs, safe rendering, provider access boundaries, account and library changes, and absence of credentials and private data in persistent app caches and diagnostics. [Security acceptance](../../prod/minnelux-prd.md#3-validate-and-release-all-four-providers)

The hosted Chrome proof has exercised Google Identity Services, private reads, writes, stale-write rejection, read-only write denial, and range seeking. Clearing the local session and signing in again restored playback. The remaining GCS proof checks include real token expiration, a signed-in account without bucket IAM, and authenticated video seeking on desktop and mobile Safari. The proof uses a synthetic MP4. Validate Flickr video compatibility with a representative export member. Keep the private account ZIPs local and use synthetic or sanitized fixtures in Git and hosted tests. [GCS browser proof](../../../spikes/gcs/README.md#hosted-chrome-results) · [Release validation](../../prod/minnelux-prd.md#6-release-validation-and-implementation-order)

## Compatibility evidence and code reuse

On November 18, 2026, local ZIP enumeration and JSON parsing found 9,985 valid photo sidecars and 500 JPEGs. All 500 matched by Flickr ID. There were 9,485 sidecars awaiting media. The 500 joined JPEGs had 529 memberships across 16 albums, with 22 items appearing in multiple albums. Across all IDs with sidecars, the album document listed 14,424 memberships and the sidecars listed 12,311. The supplied media ZIP had no video. All 500 EXIF `DateTimeOriginal` values agreed with the Flickr capture wall time, and those JPEGs had no embedded original-time offset. In the 9,985 sidecars, 590 descriptions contained HTML-like markup and 367 records had nonempty `geo`. The joined JPEGs had no populated sidecar `geo` to compare with embedded GPS. [Sample archives and format observations](../../flickr/HANDOFF.md)

| Implementation checked | Result on the sample | Design guidance |
| --- | --- | --- |
| TagSpaces’ standalone Flickr Export Organizer | The unmodified Node script wrote 462 media files and 462 sidecars from 500 JPEGs and exited successfully. Removing IDs from output filenames caused 38 overwritten entries across 26 paths. Hash checks confirmed collisions between distinct originals. Picking one album folder drops 30 memberships even before those collisions. | The MIT-licensed script confirms the sidecar and tag mappings. Reuse the mappings already in Minnelux. Preserve IDs and represent albums as references. [Organizer code](https://github.com/tagspaces/flickr-export-organizer/blob/74244881cbb88ee130e4358c5b60f50864a8a599/export-organizer.js) · [License](https://github.com/tagspaces/flickr-export-organizer/blob/master/LICENSE) |
| immich-go Flickr adapter, open PR #1355 at the time of the check | The extracted Go classifier, ID matcher, JSON structs, and album index decoded 9,985 sidecars and found 500 matches and 529 memberships. The classifier rejected a media-only invocation. The adapter maps albums by title and omits sidecar GPS. | Use its two-pass ZIP scan as a reference. Keep account-scoped identity, persistent partial state, and Flickr geography in the browser implementation. [Adapter PR](https://github.com/simulot/immich-go/pull/1355) · [Metadata mapping](https://github.com/jmcauley/immich-go/blob/add-flickr-adapter/adapters/flickr/json.go) |
| Memento Mori | Its local ZIP index matched all 500 given the full sidecar ID set. Of those, 497 pass its public-only filter. Its geo helper decoded 367 populated records and rounded coordinates to five decimals. Of the six sample photos with Flickr rotation of 90°, one also had EXIF Orientation 6 and five had Orientation 1. | Use the on-demand ZIP and legacy filename handling as references. Test its EXIF-first rotation rule against the fixture, and preserve private items and coordinate precision. [ZIP index](https://github.com/antimega/memento-mori/blob/main/memento_mori/flickr.py#L288-L350) · [Rotation handling](https://github.com/antimega/memento-mori/blob/main/memento_mori/flickr.py#L896-L920) |
| Flickr to iCloud | The unmodified Ruby verifier matched all 500, reported 9,485 sidecars awaiting media, and found 22 byte-identical pairs across 44 distinct Flickr IDs. Its downstream preparation merges by digest. | Adapt the verifier’s ID and duplicate checks as acceptance cases. Retain both Flickr identities when byte payloads coincide. [Verifier](https://github.com/gwcoffey/flickr-to-icloud/blob/main/src/ruby/verify.rb) · [Preparation code](https://github.com/gwcoffey/flickr-to-icloud/blob/main/src/ruby/prepare.rb) |

The Minnelux investigation fed parsed ZIP entries into the reconciliation spike. It produced 500 assets and 529 album memberships in both arrival orders and on replay. Its preview grouped 9,485 genuine metadata-only items with 16,794 album-only references, including the `0` placeholder, under a single 26,279 total. Implement the preview states above and keep the raw references. The spike demonstrates the merge logic. Browser ZIP extraction, durable integrated publication, and rendering the combined orientation still require the acceptance checks above. [Reconciliation source](../../../spikes/flickr/reconcile.mjs)
