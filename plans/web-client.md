# Minnelux web client implementation plan

Deliver a static browser client that opens, edits, searches, and plays a private archive. Start with shared contracts and a thin GCS reference workflow alongside the provider proofs. Use that workflow as the reference for feature integration, provider parity, and release.

[Product requirements](../docs/prod/minnelux-prd.md) · [Web client architecture](../docs/dev/web-client/SPEC.md) · [GCS reference workflow plan](gcs-reference-workflow.md)

## Decisions every slice uses

- React 19, strict TypeScript, and Vite. Generic hash routes for connection, gallery, import, and viewer. Keep private view state in memory.
- Plain TypeScript library worker for catalog, search, and publication. A separate on-demand import worker handles expensive work. The service worker handles tab-bound video ranges.
- Direct provider-managed identity and object storage. The provider's conditional head write commits a revision of immutable objects. Keep published state in the bucket and only non-secret connection settings in browser persistence.
- Retain the existing Node contract test approach. Use Playwright against the built SPA with synthetic data and real worker APIs. Use deployed HTTPS and real private test buckets for provider and browser release evidence.

Base implementation worktrees on the current agreed main revision. The source material for this draft is main at [`b3d0b33`](https://github.com/ricardocabral/minnelux/commit/b3d0b33) and the Flickr importer branch at [`c780b3a`](https://github.com/ricardocabral/minnelux/commit/c780b3a). Treat that branch as a reuse and compatibility source. Check its integration status when dispatching work.

## Phase 0 · Establish the static proof and shared contracts

**Owner** · Integration lead. **Prerequisites** · An agreed base and a synthetic private photo, seekable video, and small library fixture.

This phase and [GCS Task 1](gcs-reference-workflow.md#task-1--contracts-and-fixtures) are the same shared commit. While the lead prepares it, the storage lane can reproduce the existing hosted GCS proof and generate the Flickr v1 fixture. The frontend lane can prepare the scaffold, synthetic proof page, and browser fixtures with the lead.

- [ ] Establish the strict TypeScript and Vite app in `apps/web/`. Serve a minimal proof page from the built static assets, with a library worker entry and a stable service-worker URL under the deployment base. Demonstrate opening a synthetic revision through the worker and rendering one thumbnail.
- [ ] Check in the shared storage, repository, search, and video contracts. Use the [library worker interface and fixtures in GCS Task 1](gcs-reference-workflow.md#task-1--contracts-and-fixtures) for the frontend handoff. The proof page opens and queries a synthetic revision through that interface.
- [ ] Check in the generated Flickr v1 input and the expected v2 manifest. Publish both as contract fixtures for the implementation tracks. Verify the actual conditional v1-to-v2 publication during [GCS Task 3](gcs-reference-workflow.md#task-3--revision-repository-and-publication).
- [ ] Provide a shared fixture object endpoint that supports pagination, conditional writes, byte ranges, stale-writer rejection, and dropping a successful head write's response. Verify the proof through the browser against this endpoint. Keep the endpoint in test infrastructure.
- [ ] Provide package commands for build, strict type checking and lint, focused Node tests, and Playwright. Document how to replay a seeded case and capture a local failure trace. Give provider, gallery, and importer owners the shared contract commit and fixture entry points.

**Exit evidence** · One reproducible browser walkthrough and a passing contract test that observes a stale precondition rejection. This harness is the starting point for the remaining slices.

## Phase 1 · Prove private access and video on the deployed static build

**PRD coverage** · R1, the storage and video prerequisites for R2 and R7. Existing hosted probes can run during Phase 0. Use the Phase 0 contract commit for implementation in the shared app. This work overlaps Phase 2.

| Parallel assignment | Scope and deliverable |
| --- | --- |
| **GCS proof** | Reuse the GIS proof and run private read, write, and stale publication on deployed HTTPS. Implement the GCS side of authorized range reads. Demonstrate editor, viewer, and signed-in identity without IAM. Record actual expiry and recovery separately from local disconnect. |
| **Video relay** | Own the service-worker route, window registration, and proof-page wiring. Exercise the relay against the fixture range adapter first. Integrate each authorized range adapter as it becomes available, starting with GCS. Prove desktop and mobile Safari seeking, exact-URL denial in another tab, worker restart, expiry, and same-asset recovery. |
| **S3 proof** | Reuse Cognito sign-in and SigV4, install native conditional head checks, and deliver signed ranges behind the common range interface. Verify role permissions and actual credential expiry and revocation. Run the relay replay check after the relay owner connects the adapter. |
| **Azure proof** | Verify Entra/MSAL Browser configuration, scoped read and editor roles, CORS, ETag preconditions, and authenticated ranges through the same relay. |
| **R2 proof** | Verify scoped temporary credentials and signed R2 reads, CORS, conditional writes, and video ranges through the same relay. For the reauthorization proof, use an external issuer that supplies a stable subject tied to the issued credentials. Document the issuer setup and the fresh-session behavior for manually supplied credentials. |
| **Fixture and benchmark evidence** | Recheck sanitized Flickr fixtures in both arrival orders and after reloading published import state. Review or reproduce the whole-snapshot load, build, compress and hash, and publish benchmark for both 50,000-item profiles. Record the existing evidence and any changed results. Prepare real preview objects for device measurement after gallery integration. [Snapshot benchmark](../spikes/snapshots/README.md) |

- [ ] Record the roles, expected operation, browser and device, result, and redacted evidence for each provider. Distinguish actual expiry or revocation from a local session reset. Use synthetic archives.
- [ ] For each provider, observe CORS, conditional creation and update, stale-write rejection, anonymous and unauthorized read denial, viewer write denial, and editor isolation from unrelated objects and protected original replacement and deletion. On desktop and mobile Safari, capture an upstream `206`, a seek before complete transfer, denial of exact-URL replay from a second tab, and reauthorization of the same video.
- [ ] Verify identity evidence across renewal and account changes. Exercise sign-in and the video relay when installed under a nested static path.
- [ ] Close sign-in, private media, and storage feasibility checks for all four providers before full UI implementation. Work on unrelated proof tasks and fixtures while a real credential or device dependency is pending.

**Exit evidence** · Feasibility results for all four providers and ready-to-run shared fixtures. The GCS proof still needs actual expiry, a signed-in no-IAM user, and desktop and mobile Safari playback. Use the S3 proof for transport and conditional writes, and produce new evidence for the tab-bound S3 route. [PRD proof order](../docs/prod/minnelux-prd.md#1-prove-the-browser-only-architecture) · [GCS evidence](../spikes/gcs/README.md) · [S3 evidence](https://github.com/ricardocabral/minnelux/tree/b3d0b33/spikes/s3)

## Phase 2 · Land one end-to-end GCS reference slice

**PRD coverage** · R1, R2, R4, R5, R6, R8, narrow first path. **Prerequisite** · Phase 0 contract commit. Build the repository, search, and minimal proof page while Phase 1 continues. Use the proven GCS adapter for the hosted walkthrough. The Phase 1 feasibility gate still applies to full UI implementation.

**Owners** · The [GCS storage, repository, and search task owners](gcs-reference-workflow.md#phase-1--publish-reopen-and-search-one-photo) build their modules in parallel. The integration lead owns shell and feature wiring. Use the actual worker to go from authorized connection and one local photo to preview, tagging, conditional publication, result display, and fresh-browser search.

- [ ] Open a seeded revision and distinguish confirmed empty, unavailable, unauthorized, and corrupt library states. Import one photo unchanged and create a thumbnail.
- [ ] Publish the original, preview, and same-revision catalog and index objects with two tags on the photo. Verify both collections reference that asset. Confirm the head only advances once. Reopen in a fresh authorized browser and find the photo from persisted search without listing the media prefix on the reopen path.
- [ ] Inject a lost successful head response. Confirm the receipt resolves the outcome without a duplicate asset or publication. Exercise two authorized sessions and verify stale publication cannot overwrite the winning head.
- [ ] Demonstrate the built app on the test GCS bucket. Land a fixture-backed Playwright walkthrough so other owners can use the same result and publication contracts independently.

**Exit evidence** · A pinned reference commit with one real GCS success path and repeatable fixture-backed acceptance, including the repository's v1-to-v2 test. Fixture-backed frontend work can proceed from the Phase 0 contract commit. Feature integration uses the GCS reference commit.

## Phase 3 · Complete the GCS workflow and integrate parallel slices

**PRD coverage** · R2 through R8 on the reference provider. **Start conditions** · Phase 0 for fixture-backed frontend work. Phase 1 feasibility evidence for full UI implementation. **Integration base** · Phase 2 reference commit.

| Assignment | Consumes and owns | End-to-end acceptance |
| --- | --- | --- |
| **Gallery and search** | Consumes revision-bound result and range fixtures. Owns collection and search UI, virtualized rows, and bounded preview scheduling. | Open All Media, Untagged, and a tag collection. Search exact PRD fields and combine tag, kind, and date filters. Verify stable rank or capture-date order, viewport-only previews, and latest-query wins after fast typing or a library switch. |
| **Photo and video viewer** | Consumes result handles and the Phase 1 video route. Owns the viewer, navigation, object URL lifetime, and focus handoff. | Open a result, navigate the pinned list with keyboard, touch, and controls, zoom images, seek video, and restore focus, query, and scroll. Verify decode failure has a download path. Replay tests check session change and worker restart. |
| **Local and existing-object import** | Consumes the import job and publication contracts. Owns local multi-file and existing-object import, progress and error UI for those flows, and byte-preserving retry. | Import mixed photo and video, then catalog objects under an approved existing prefix. Verify originals retain their bytes or existing locations. Per-file errors and retries retain stable IDs, and the published library reopens and searches. |
| **Tag edits and index repair** | Consumes repository publication and display records. Owns edit and repair UI and domain commands, including Flickr provenance overrides. Coordinate repository and search changes with the respective GCS task owners and worker message changes with the integration lead. | Create, rename, apply, and remove tags on single and multiple assets. Verify two collections reference one asset. Simulate independent and overlapping edits. Remove or corrupt an index, browse the catalog, repair it, and search in a fresh session. |
| **Flickr import** | Consumes the existing Flickr contract, shared library revision and import fixtures. Owns the multipart ZIP workflow, match review, and parser and planner integration. | Handle metadata-first and media-first with a publish and fresh-browser reopen between parts. Show ambiguous and duplicate candidates before writing. Verify raw JSON and original bytes, provenance and orientation, replay after owner edits, late collisions, and authoritative album reconciliation. Exercise replay with the integrated owner edit slice before closing this assignment. |
| **S3, Azure, and R2 integration** | Run one independent assignment per provider. Consume the common adapter and provider-specific Phase 1 proof. Own each provider's module, configuration, setup docs, and adapter tests. | Select the provider from the same static build. Use its adapter with the existing library and media contracts. Open, publish and reopen the same fixture workflow. Confirm consistent errors and require no provider-specific branches in gallery, search, or import flows. |

- [ ] Integrate each independently verified slice as its dependencies land. Exercise GCS from import through multi-tag editing, browse and search, fullscreen view, fresh reopen, conflict and retry, and repair. Record its commit and fixture data as the shared parity baseline.

## Phase 4 · Verify parity and prepare release

**PRD coverage** · R1–R8 and the [release gates](../docs/prod/minnelux-prd.md#3-validate-and-release-all-four-providers). **Prerequisites** · The integrated GCS baseline and each provider's integrated adapter.

- [ ] **Provider and privacy lanes.** Run the same deployed workflow for GCS, S3, Azure, and R2 in current Chromium, Firefox, desktop Safari, and mobile Safari. Check direct provider traffic, anonymous and unauthorized denial, write denial for viewers, and editor isolation from unrelated objects and protected original replacement and deletion. Cover actual expiry and revocation, account and library switches, stale and ambiguous publication, and video replay denial. Check deployed response headers, diagnostics, and app-managed browser storage against the security requirements.
- [ ] **Flickr and recovery lane.** Run the complete Flickr acceptance matrix using synthetic multipart ZIPs. Reject malformed and oversized ZIPs, media, and snapshots within the configured limits. Verify imported markup renders as text. Reopen previously published records and restore a known-good revision and media from backup after a damaged head. Copy one library and its referenced media to another supported provider. Verify stable IDs, tags, and search results after any root remapping.
- [ ] **Performance lane.** Run both 50,000-item profiles against real GCS on a midrange phone at 20 Mbps / 80 ms. Measure p95 of authorized open to first visible thumbnails against 3 s, cold search against 1 s, and warm search against 250 ms. Record peak memory, bytes, request counts, run count, browser, and device. Time index build, snapshot compression, and publication separately. If a target misses, isolate transfer, parsing, index, decode, or rendering before changing the storage layout.
- [ ] **Release lead.** Verify each result against the PRD. Prepare the source, static build, and versioned file formats with self-hosting instructions, provider configuration, codec matrix, license, and recovery steps. Record gaps with actual sample counts and unresolved conditions. Claim release readiness only after the required evidence is complete.

## How to dispatch and integrate the work

1. **Integration lead owns shared contracts and wiring.** Keep one worktree per writing agent from the agreed base. The lead owns app entry points, shared schemas and fixtures, dependency manifests, and integration wiring. Each task owner owns feature or provider modules and their focused tests. Changes to a shared contract go through its owner and include an updated fixture and the downstream impact.
2. **Schedule from prerequisites.** Begin hosted GCS proof reproduction and fixture preparation while the integration lead prepares Phase 0. Branch from the contract commit for provider proofs, the GCS reference slice, and fixture-backed frontend work. Rotate provider slots through S3, Azure, and R2 as capacity allows. After the feasibility gate, take the remaining UI work and integrate each slice on the GCS reference.
3. **Give each agent a bounded handoff.** Include the task row, base commit, owned paths, contract links, fixture, acceptance scenarios, and expected artifact. Ask for a diff and the exact checks run, with failing scenarios and dependencies called out. Share a provider capability only after a recorded probe confirms it.
4. **Integrate by tested contracts.** The lead reviews changes for scope and compatibility, runs focused tests and the cross-feature walkthrough, and relies on branch CI for the full suite. When two branches need the same interface change, land the shared contract through its owner before both integrate. Before merging a production change, record the required `Plano pós-merge` evidence and obtain merge authorization.
