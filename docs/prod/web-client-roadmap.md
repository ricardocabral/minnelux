# Minnelux web client roadmap

November 18, 2026

[Web client PRD](web-client-prd.md) · [Approved HTML mockup](web-client-mockup.html) · [Technical implementation plan](../../plans/web-client.md)

## V1 — Browse, search, and organize a private archive

| Milestone | What ships | Exit evidence |
| --- | --- | --- |
| Foundation | Static app shell, provider sign-in and capability handling, private preview and video access. | Deployed HTTPS proof of authorized read, conditional publication, and private video seeking. Verify that playback is confined to the authorized tab and that expiry and renewal behave as specified on desktop and mobile Safari. |
| GCS reference workflow | Import a photo, publish it to a private library, reopen the library, browse, and find the photo through persisted search. | Repeatable fixture-backed walkthrough on a real GCS bucket, including recovery from an interrupted publication response. |
| Complete the web experience | All Media, tag collections and Untagged, ranked search and filters, bulk tagging, one full-screen photo and video viewer, local and existing-object import, multipart Flickr import, and index repair. | Walk through the complete imported-archive workflow on GCS with both reader and editor permissions. Verify viewer return, accessibility, playback recovery, and safe import and edit retry. |
| Release across providers | Carry the same workflows to Amazon S3, Azure Blob Storage, and Cloudflare R2 alongside GCS. | Pass the supported browser and provider matrix, private video checks, migration and recovery checks, and the existing mobile performance targets. |

After the shared contracts are in place, the provider proofs and thin GCS reference workflow can run in parallel. Full feature integration uses the verified GCS reference.

## V2 — Improve navigation and metadata review

These are candidates in evaluation order. The V1 workflow and feedback determine which enter V2.

| Priority | Candidate | Evidence and exit criterion |
| --- | --- | --- |
| 1 | **Jump to date.** Add a month or year picker to chronological results when a large library makes scrolling slow. | Ask users to find known dates in a large archive. Keep the control if it makes that task faster. Verify large jumps and back-to-grid restoration on desktop and mobile. |
| 2 | **Compact metadata list.** Offer a denser layout for the current results with thumbnail, title or filename, date, type, and tags. | Prototype it against the grid on a real or sanitized import. Ship if owners complete metadata review or bulk tagging more reliably. Switching layouts preserves scope, filters, and a useful item anchor. Both layouts use the same selection and viewer behavior. |
| 3 | **Collection covers.** Explore a cover shelf as an optional collection entry point. | Test with both a tag-heavy imported archive and a lightly tagged library. Keep it if people find familiar collections faster and the initial library open stays within the V1 budget. |

Track time to find a known item, wrong-item selections during bulk tagging, and whether people can return to the right place after viewing. Measure these in task walkthroughs with sample or explicitly provided libraries.

Public sharing, background phone backup, manual album ordering, and semantic search each require a separate product decision. [Product scope](minnelux-prd.md#1-product-and-scope)
