# GCS reference workflow implementation plan

> Execute by task using the Superpowers subagent-driven development or executing-plans skill. The integrator owns shared contracts and app wiring. Use a separate worktree for each implementation track.

**Goal**

Deploy a static GCS workflow that imports a photo, gives it two tags, and finds it through persisted search in a fresh browser. Extend that workflow through existing-object import, private media viewing, concurrent edits, and index repair.

**Architecture**

An authorized object store supplies bytes and conditional writes. The library worker pins revisions and publishes immutable objects before advancing the head. Search operates on that pinned catalog and its gzip postings. The static TypeScript app uses provider-managed identity and direct provider requests.

[Storage and indexing specification](../docs/dev/storage/SPEC.md) · [Product requirements](../docs/prod/minnelux-prd.md#6-release-validation-and-implementation-order) · [Web client implementation plan](web-client.md)

## Before implementation

- Start from current upstream `main`. At planning time it includes the S3 proof and Flickr repository contract at `b3d0b33`. The local Flickr implementation at `c780b3a` is a reference outside that base. Preserve its tests and use its emitted v1 objects for compatibility. If the implementation lands first, start from that updated base.
- Task 1 and [web client Phase 0](web-client.md#phase-0--establish-the-static-proof-and-shared-contracts) deliver one contract commit. Use one `apps/web/` scaffold, one library worker, and one publisher. While the integrator prepares the commit, the storage lane can reproduce the hosted GCS proof and generate the Flickr v1 fixture. Frontend work can prepare the scaffold and synthetic browser checks with the integrator.
- Keep credentials and private data in authorized browser memory, enforce bounded reads, and use native conditional writes. The v1 read and v2 publication formats and provider behavior in the spec apply to all tasks.
- Give each agent its owned paths, upstream commit, relevant spec sections, fixture, and acceptance checks. Agents return the commit, focused check output, and open issues. The integrator owns contract changes, dependency and lockfile changes, browser wiring, and the merged proof. Run the full automated suite in branch CI, and keep local checks focused.

## Review focus

| Condition | Owning task or track |
| --- | --- |
| A metadata read races a head replacement, or storage cannot distinguish absence from denial. | Task 2 verifies a coherent head observation and prevents denied initialization. |
| A successful head write loses its response, then another writer advances the head. | Task 3 verifies reconciliation with a retained receipt and uncertainty when the receipt is gone. |
| A stale pin or a malformed posting could point to the wrong asset. | Task 4 verifies revision binding and rejects invalid ordinals. |
| A corrupt immutable posting occupies the expected digest key. | Phase 2 repair creates fresh keys and preserves the catalog and source state. |
| A second tab has the exact media URL, or a response arrives after invalidation. | Task 2 and Phase 2 viewing verify tab scope and cancellation through the browser. |

## Phase 1 · Publish, reopen, and search one photo

Covers the first path through R1, R2, R4, R5, and R8. Use a minimal static test page with sign-in, file selection, tags, publish, reopen, and a search field. This is the first deployed slice.

### Task 1 · Contracts and fixtures

**Owner** Integrator. Own the app scaffold, worker message types, `src/test-fixtures/`, and `contract.ts` under `src/storage/`, `src/library/`, and `src/search/`. Feature agents own implementations and their tests in those directories.

- [ ] Define `ObjectStore`, the pinned catalog and index-loading interface, publication outcomes, and the search types from the spec. Define the authorized video range and registration interface with its fixture implementation. Add a focused TypeScript check and a Node test command to the shared scaffold.
- [ ] Define the frontend handoff in `apps/web/src/library/worker-contract.ts`. Use typed request, reply, progress, and error messages with a protocol version, session ID, and request ID. Include opening a pin, querying for a revision-bound result handle and total count, reading ordered rows by offset and limit, releasing results, publishing, and cancellation. Keep the catalog and ordered IDs in the worker. Supply a fixture worker and a browser check that opens, queries, and reads a range while discarding replies for an invalidated session. [Worker message requirements](../docs/dev/web-client/SPEC.md#session-and-worker-messages)
- [ ] Generate a sanitized v1 revision with the [standalone Flickr writer](../apps/flickr-import/README.md), including photo and album details and a record without those optional fields. Keep stored bytes, known asset and tag IDs, expected search results, and expected source and receipt references. Freeze an expected v2 manifest for a publication against that v1 base. Add a separate deterministic local-photo fixture with `Cafe.jpg`, tags `Family` and `Québec`, and one expected asset ID after publication.
- [ ] Supply a test store that enforces create-only and observed-token writes, rotates the token on replacement, and can fail before a write or lose its response after commit. Verify those behaviors through its interface and use the same fixture behavior for the browser proof endpoint. Keep the hosted checks for real provider behavior.
- [ ] Publish the shared commit once the TypeScript check and fixture-backed browser check pass. Storage Tasks 2–4 and fixture-backed frontend work can then run in parallel. Task 3 owns the actual v1-to-v2 publication test. Resolve changes to the shared interfaces through the integrator.

### Task 2 · GCS storage and browser proof

**Owner** Storage agent. Own `src/storage/` implementations and tests plus GCS proof changes under `spikes/gcs/`. Start hosted proof reproduction while Task 1 is in progress. Start adapter implementation from its contract commit.

- [ ] Implement the GIS session and GCS store. Exercise missing versus denied, create-only collisions, stale writes, opaque cursors, private full reads, and valid versus unexpected range responses. Extend the Flickr prototype's generation-pinned pattern for the head.
- [ ] Force a replacement between the metadata and body reads. Assert a coherent bytes/token pair or a surfaced race. Force a late response after expiry, disconnect, and switch. Assert private state stays cleared.
- [ ] On the hosted probe, complete desktop Safari and physical iPhone Safari playback and seeking, actual credential expiry and reauthorization, and a signed-in identity without bucket IAM. Include exact-URL cross-tab denial and verify seek begins before the original finishes downloading. Record actual outcomes and separate simulated local invalidation from provider expiry.

### Task 3 · Revision repository and publication

**Owner** Library agent. Own `src/library/` implementations and tests, excluding the shared contract file. Use Task 1's store and search interfaces while Tasks 2 and 4 proceed.

- [ ] Implement bounded v1 reads, logical references, revision pinning, immutable writes, and a single conditional publisher. Open the v1 Flickr snapshot and assert no writes. Conditionally publish an ordinary edit, compare the manifest with the expected v2 fixture, and reopen it in a fresh session. Assert preserved IDs, media references, source state, owner overrides, Flickr receipts, and [optional photo and album fields](../docs/dev/storage/SPEC.md#optional-photo-and-album-fields-in-catalog-v1). Verify the prior immutable objects are intact.
- [ ] From two sessions on the same test store, exercise concurrent initialization, a losing tag edit, and separate changes that can be reapplied after reloading. Verify the losing writer leaves the winning revision readable. Reject an out-of-root reference before a request is sent.
- [ ] Inject a lost response after a successful head update and advance the head with a second writer. Recover by the retained receipt and assert there is one logical edit. With the receipt unavailable and head advanced, assert `outcomeUnknown`. A failure before the head attempt leaves the previous revision readable.
- [ ] Publish the local-photo fixture through the repository and reopen it with a new session against the same store. Verify the original digest, stable ID, two tags, and catalog and postings descriptors agree.

### Task 4 · Persisted search and validation

**Owner** Search agent. Own `src/search/` implementations, tests, and search worker handlers, excluding the shared contract file. Use the frozen catalog fixture and the spec's `buildPostings`, `validatePostings`, and `queryCatalog` interfaces.

- [ ] Implement v1 build, validation, and query. Check filename, title and description weights, current tag-title joins, accents and Unicode, repeated terms, two selected tags, media and date filters, empty text, and stable ordering against an independent scan.
- [ ] Feed bad ordinal order, range, pair stride, and weights, unknown tags, and dictionary keys such as `constructor` through the real postings validator and query.
- [ ] Use the stored Flickr fixture and two successive pins. Verify a tag rename is reflected on the new pin and a late reply or a posting load for the old pin cannot populate the new view. Verify catalog browse skips text postings, and fresh text search uses stored postings without a list or original read. The search agent owns the query test and the integrator verifies the actual request trace.

### Integration check

Run the focused storage, repository, and search tests with the scaffold's test command and run its TypeScript check. The integrator owns the hosted smoke page and collects evidence for the following checks.

- [ ] Integrate Tasks 2–4 on a static HTTPS origin with a real private GCS bucket and synthetic media. Import `Cafe.jpg`, publish a small preview, apply `Family` and `Québec`, then reopen in a fresh browser and search for `cafe`. Verify each collection points to the same asset. Repeat browse and search with viewer access and verify writes are denied.
- [ ] Run the competing writer and interrupted head cases through the deployable path using controlled interruption. Capture which revision a fresh browser sees, along with relevant requests. Use this reference commit as the base for broader integrations. The minimal GCS walkthrough can proceed while [provider feasibility proofs](web-client.md#phase-1--prove-private-access-and-video-on-the-deployed-static-build) continue. Close those proofs before full UI implementation.

## Phase 2 · Complete and harden the GCS workflow

Covers R2–R8 on GCS. Use the working slice and v1-to-v2 fixtures as integration inputs. Fixture-backed frontend work can start from Task 1. Use the [web client feature assignments](web-client.md#phase-3--complete-the-gcs-workflow-and-integrate-parallel-slices) for worktree ownership and complete the provider feasibility gate before full UI implementation.

| Track | Exclusive implementation ownership | Acceptance |
| --- | --- | --- |
| Import and organization | Local and existing-object import, Flickr import, and tag edits have separate feature owners in the web client plan. The integrator owns final wiring. | Import local photos and videos and catalog existing objects by paginated prefix. Preserve bytes, locations, and retry IDs. Generate bounded previews or placeholders, report per-item errors, and apply or remove tags in bulk. Import another Flickr part through the shared publisher and verify owner overrides, source state, and both receipt sets survive. |
| Browse and private viewing | Gallery and viewer owners consume the shared worker and the existing route from the video relay owner. | Browse sorted previews, open full-screen photos and videos, and restore the pinned result and position. On desktop and mobile Safari, validate real `206` ranges, seek before full transfer, deny exact URL replay from another tab, and resume only for the same authorized asset. |
| Index repair | The library and search owners maintain their implementations and tests. The edit and repair feature owner implements user-facing commands and UI. | Browse a valid catalog with a missing, incompatible, or corrupt index. Repair without opening originals, including a corrupt object occupying its digest key. Race repair against a newer edit, test lost-response recovery, and verify a fresh browser searches the repaired revision. |

- [ ] Integrate all tracks in one deployed GCS build. Play a private video, exercise local and existing-object imports, bulk tag, browse two collections, reopen and search, and repair an index. Exercise multipart Flickr in a fresh authorized session using the Flickr contract fixtures.
- [ ] On a midrange phone with a real private GCS bucket, run the 50,000-item test defined in the spec. Record the baseline and request and memory breakdown before changing snapshot layout. Resolve or explicitly report any unmet PRD target.

## Phase 3 · Add provider adapters and verify portability

Covers provider parity in R1 and migration in R8. Provider feasibility probes can begin with the shared contracts. Once Phase 1 confirms the storage, catalog, and search contracts, production adapter work can overlap Phase 2 when capacity allows. Give Azure, S3, and R2 separate adapter and authentication directories and one provider owner each. Reuse the shared contract runner. Use the S3 proof for signing and identity setup.

- [ ] On each private provider, prove list pagination, access scope, confirmed absence, private range reads, conditional create and replace, stale rejection, expiry and revocation, and viewer-only access. Validate CORS from the deployed origin. Keep credentials and provider-specific request details inside the adapter and session.
- [ ] With the Phase 2 workflow, verify the same browse, search, publication, repair, and tab-bound playback on current Chromium, Firefox, and Safari, including mobile Safari. Run the PRD security acceptance, including disconnect and account switching, protected originals, and recovery from backup.
- [ ] Copy a library and its referenced originals across supported providers, remap logical roots, validate media versions, and compare stable IDs, tag membership, and ordered search results. Record evidence per provider before claiming parity. Keep the PRD’s release gates and the repository’s post-merge verification criterion for production changes.

[Provider parity, security, Flickr, and performance acceptance](../docs/prod/minnelux-prd.md#3-validate-and-release-all-four-providers)
