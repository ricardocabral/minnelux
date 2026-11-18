# Minnelux web client PRD

November 18, 2026

[Approved HTML mockup](web-client-mockup.html) · [V1 and V2 roadmap](web-client-roadmap.md) · [Product PRD](minnelux-prd.md) · [Technical specification](../dev/web-client/SPEC.md) · [Implementation plan](../../plans/web-client.md)

## Problem

Someone opening a private archive may know when a photo was taken, remember an album name, or only recall a word in its description. After importing a Flickr library, that same person may need to review untagged items and make the same change across a batch. They should be able to move between finding, viewing, and organizing without losing their place.

Minnelux serves archive owners who control their cloud storage and people who have been granted read-only access to that storage. A new or untagged archive should be browsable immediately. A heavily organized archive should be just as easy to enter through its collections.

## Product decision

Use **one gallery with several ways to find the right items**. All Media is the default. A collection, Untagged, or a search changes the results shown in that gallery. Selection activates editing controls in place. Photos and videos open in one full-screen viewer and return to the same gallery context.

The reference Flickr importer demonstrates reopening a published revision, filtering by tag, loading previews, and downloading originals. Borrow chronological navigation and an asset details panel from Immich, metadata and album context from Flickr, the searchable tag browser from TagSpaces, and in-place selection from Ente. Minnelux uses tags as collections, so an asset can appear in several collections by reference to the same original. [Flickr importer reference](https://github.com/ricardocabral/minnelux/blob/c780b3a/apps/flickr-import/app.ts) · [Immich viewer](https://github.com/immich-app/immich/tree/main/web/src/lib/components/asset-viewer) · [Flickr photo page](https://www.flickrhelp.com/hc/en-us/articles/31687228075540-About-the-Photo-page) · [TagSpaces interface](https://docs.tagspaces.org/ui/userinterface/) · [Ente albums](https://ente.com/help/photos/features/albums-and-organization/albums)

## Requirements and acceptance criteria

| Area | User need | V1 acceptance |
| --- | --- | --- |
| Connect and reopen | As an owner or reader, I can open my private archive from an authorized browser. | Open an existing library or initialize an empty one when authorized. Distinguish confirmed empty, missing access, expired access, unavailable storage, and corrupt library data. Readers can browse, search, view, and download. Editors can also import and edit tags. A fresh authorized browser sees the published state. |
| Browse | As a reader, I can find an event by date and recognize both photos and videos. | All Media opens on a responsive, date-grouped grid. Sort by capture time with the specified stable fallback to added time. Label added dates as such when displayed. Show a video badge and a poster or placeholder. Fetch visible previews on demand and fetch originals when opened or explicitly downloaded. |
| Collections | As a former Flickr user, I can find the albums I recognize. | Surface imported album tags alongside other named collections in a searchable navigation panel. Always offer All Media and Untagged. Selecting a collection changes the result set in the same grid. One asset can appear in several collections and has one asset identity and original. |
| Search and filter | As a reader, I can find an item from the words or details I remember. | Search filenames, titles, descriptions, and tag names. Combine the current collection with text, tag, media type, and date filters. Show ranked results for text queries and chronological results without text. Render only results from the current request and published revision. Provide a clear way to reset filters and distinguish zero matches from an empty collection. |
| Select and tag | As an editor, I can clean up my archive in batches. | A selection toolbar shows the count and offers create, apply, and remove tag actions as appropriate. Offer tag rename through the collection controls. Keep selection when opening and closing the viewer on the same result set. Clear selection when the user changes scope, query, or filters so a later action cannot affect hidden items. Update the collection and index together after publication. Show pending, success, and retryable or ambiguous failure states. |
| View photos | As a reader, I can inspect a photo and continue browsing. | Full-screen viewer supports fit and zoom, previous and next controls, keyboard and touch navigation, title or filename, known date, and clickable tags. Details stay accessible as a drawer or sheet on small screens. Next and previous follow the result order from the opening action. Close or browser Back restores the originating scope, query, filters, scroll position, and focus when available. Following a tag deliberately opens that collection. |
| Play videos | As a reader, I can watch and seek without waiting for a complete transfer. | Open to a poster or placeholder and start on explicit Play. Provide native playback and seeking through the tab-bound private range route. Keep asset navigation separate from video scrubbing. On expiry, offer reauthorization and restore the prior position when identity, library, and asset match. Offer Download original when the browser cannot decode the media and access permits it. |
| Import | As an editor, I can add local files, catalog existing objects, or bring over a Flickr export. | Show per-item progress, actionable errors, and safe retry. For Flickr, preview matches, pending items, duplicates, and ambiguities before publication. Preserve original bytes, source data, stable identities, and owner tag choices across repeated or late parts. Return to browse published assets when the operation finishes. |
| Recover | As an owner, I can keep browsing during a search failure and restore search. | When postings are damaged or unavailable, explain the failure, keep authorized catalog browsing available, and offer repair to editors. Handle independent and overlapping concurrent edits as specified. On disconnect or a library or identity switch, clear private view state and stop obsolete reads. |

## Experience specification

- **Desktop and mobile.** Use the Sunprint palette, with warm paper around the grid and dark green around full-screen media. On desktop, keep the Collections sidebar within sight of the grid. On mobile, open Collections and filters from explicit controls as sheets or drawers. Asset tiles remain usable without hover. [Sunprint brand kit](../mkt/README.md)
- **Browse and selection.** Use one thumbnail component and one selection model across scopes. Tapping a tile opens it. A separate checkbox or Select control begins selection. During selection, make the selected count and the way to exit visible. Preserve the original scroll anchor through a refresh when the asset is still present.
- **Empty and partial states.** Use fixed tile geometry while previews load. A missing preview stays selectable and can open the viewer or its download fallback. An empty library offers import to an editor. An empty collection identifies that collection, and a search with zero matches offers to clear its query or filters.
- **Viewer.** Keep close and next or previous within reach by pointer, keyboard, and touch. When focus is in a video control, its own playback keys take priority. When zoomed, give panning priority over swipe-to-next. Announce position, playback errors, and meaningful loading or publishing states to assistive technology.
- **Private state.** Store collection, query, selection, viewer position, and scroll anchors in the authorized session. Use generic routes and a revision-bound result handle. Keep credentials, private media, and query contents out of app-managed persistent browser storage, history URLs, and diagnostics. Deployed behavior follows the [web client architecture](../dev/web-client/SPEC.md#contracts-shared-by-implementers).

## Release evidence

- Walk through All Media → imported Flickr collection → photo → video → back to the originating tile → bulk tag. Repeat at desktop and mobile widths, with keyboard and touch where applicable. Check restoration after crossing a virtualized row boundary.
- Open as a reader and an editor against deployed private buckets. Verify capability differences, scope changes, stale search responses, denied playback from a second tab, seeking before download completes, and same-asset recovery after reauthorization. Verify supported desktop browsers and physical iPhone Safari using the existing release matrix.
- Verify fresh-session search and tag membership, replay of a multipart Flickr import after owner edits, and browse plus repair with damaged postings. Exercise conditional publication, ambiguous outcomes, and conflicting edits through their real interfaces.
- Use the existing 50,000-item mobile workload and its p95 targets on real GCS transport. Target 3 s from authorized open to visible thumbnails, 1 s for cold text search once the catalog is ready, and 250 ms for warm text search. Report device, browser, sample size, network profile, and peak memory. [Verification targets](../dev/web-client/SPEC.md#verification-targets) · [Release matrix](../../plans/web-client.md#phase-4--verify-parity-and-prepare-release)

## Scope after V1

The [roadmap](web-client-roadmap.md#v2--improve-navigation-and-metadata-review) prioritizes navigation and metadata review experiments. The product PRD keeps public sharing, background phone backup, manual album ordering, and semantic search outside the first release.

## Approved frontend reference

Use the [approved HTML mockup](web-client-mockup.html) as the visual and interaction reference for the V1 frontend. It shows the desktop sidebar and mobile collections sheet, date-grouped gallery, search and filter controls, in-place bulk tagging, and the full-screen photo and video viewer with its details panel.

Open the HTML file directly in a browser. To review the approved flow, open Flickr archive, choose Above the Atlantic, move to the video, return to the same tile, then select two items and apply a tag. On mobile, open Collections and toggle Details in the viewer.

The mockup uses embedded sample media and in-memory edits. Implement production behavior using the acceptance criteria above and the [technical specification](../dev/web-client/SPEC.md), including authorized storage, private streaming, publication, and recovery.
