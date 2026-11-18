# Flickr export handoff

Use this handoff alongside the [Minnelux PRD](../prod/minnelux-prd.md#6-release-validation-and-implementation-order). First prove that a deployed static page can authenticate, read, write, and seek video directly against a private GCS bucket. Prepare a sanitized Flickr fixture in parallel, then use it to exercise the import and search workflow.

## Local export samples

These are two parts of a real Flickr account export used for local validation.

| Role | Verified contents |
| --- | --- |
| Metadata | 9,985 per-item `photo_<id>.json` files and 16 other JSON files, including `albums.json` and account data. |
| Originals | 500 JPEGs. All 500 match a metadata record by Flickr ID. This part has no video. |

The counts were checked locally on November 18, 2026 by reading ZIP members and JSON with Python. The earlier EXIF check inspected the JPEG APP1/TIFF metadata. Keep the original ZIPs local. Use synthetic or sanitized fixtures in the repo and the hosted spike.

## Flickr data and import rules

| Export field or structure | What to implement |
| --- | --- |
| **Identity** | A sidecar is named `photo_<id>.json` and contains a string `id`. The 500 sampled originals all match the anchored `_<id>_o` suffix before the extension. Parse IDs as strings and scope them to the Flickr source account. Check that filename and payload IDs agree. The sidecar's `original` URL is useful provenance. Its basename matched **0 of 500** sampled originals. |
| **Partial imports** | **9,485 of 9,985** metadata records await media outside the supplied part. Track matched, metadata-only, media-only, ambiguous, and duplicate items. Keep pending source IDs and album edges so later ZIPs can complete the join. Repeat imports should preserve asset IDs, owner edits, and owner-removed tags. Use file signatures to identify supported media. |
| **Albums and tags** | `albums.json` has an `albums` array. Each record has a string `id`, a `title`, and ordered `photos[]` IDs. Use that list for known albums and surface discrepancies with per-item `albums[]`. Among IDs with sidecars, the album file had **14,424** memberships and the sidecars had **12,311**. The matched JPEGs had **529** memberships across **16** albums, with **22** JPEGs in multiple albums. Map each Flickr album ID to a stable Minnelux tag. Read keywords from `tags[].tag` under a separate source namespace. Retain raw album JSON so ordering and pending edges survive. Use the array rather than declared `photo_count` for membership. |
| **Titles and descriptions** | Map `name` to title and derive plain text from `description` for display and search. **590 of 9,985** descriptions contained HTML-like markup. Retain source JSON for fidelity. Keep unrelated account and contact JSON in the original archive. |
| **Capture date and rotation** | `date_taken` and `date_imported` are offset-free `YYYY-MM-DD HH:mm:ss` strings in this export. All **500** JPEGs had EXIF `DateTimeOriginal` agreeing with the Flickr capture wall time. No original-time offset was found on those JPEGs. Store capture time, precision, provenance, and any known offset separately from import time. Six matched records had Flickr rotation of 90 degrees. Test embedded EXIF orientation and Flickr rotation together to catch double rotation. |
| **Coordinates** | `geo` is an array. The **367 of 9,985** nonempty instances each held one object with string `latitude`, `longitude`, and `accuracy`. All coordinate pairs fit geographic bounds after dividing the integer values by 1,000,000. Community importers use the same conversion. Range-check and preserve the raw values. The joined JPEGs had **0** matching sidecar geotags, so these samples cannot corroborate coordinates against embedded GPS. |

[Flickr account export](https://www.flickrhelp.com/hc/en-us/articles/4404079675156-Downloading-content-from-Flickr) · [Flickr EXIF FAQ](https://www.flickrhelp.com/hc/en-us/articles/4404078521108-EXIF-data-FAQ) · [Flickr-to-iCloud coordinate decoder](https://github.com/gwcoffey/flickr-to-icloud/blob/main/src/ruby/prepare.rb#L59-L63) · [Memento Mori coordinate decoder](https://github.com/antimega/memento-mori/blob/main/memento_mori/flickr.py#L115-L130)

## Prove the GCS path first

1. Deploy a minimal static HTTPS page and connect it to a private GCS test bucket. Register the page's exact origin on a Google OAuth web client. Use an External audience and add the personal Gmail account as a test user if the OAuth app is in Testing. Grant the account bucket IAM for the operation being tested. Use a sanitized JPEG and a small, seekable MP4 fixture. The supplied Flickr media part exercises JPEG only.
2. On a user click, use the Google Identity Services token model to obtain a short-lived OAuth access token in JavaScript. Read with `devstorage.read_only` and a bucket-level Storage Object Viewer grant. For writes, request `devstorage.read_write` with an appropriate bucket-scoped write role. Send the token in `Authorization: Bearer …` to the GCS JSON API, including `GET /storage/v1/b/{bucket}/o/{encoded-key}?alt=media` for object bytes. The JSON API uses Google's default CORS behavior. [Browser token flow](https://developers.google.com/identity/oauth2/web/guides/use-token-model) · [Bucket IAM roles](https://docs.cloud.google.com/storage/docs/access-control/iam-roles) · [Cloud Storage OAuth scopes](https://docs.cloud.google.com/storage/docs/oauth-scopes) · [Object reads](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get) · [GCS CORS](https://docs.cloud.google.com/storage/docs/cross-origin)
3. Verify private image read, authorized upload, and conditional head creation and update using `ifGenerationMatch`. Exercise stale-write rejection, denied publication with a read-only token, and denied reads for a signed-in user without bucket IAM. Check the browser network trace for direct identity and storage calls. [GCS write preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions)
4. Exercise an in-browser Service Worker route for authenticated video ranges on desktop and mobile Safari. Verify `206` and usable `Content-Range` headers, then seek before the full object downloads. Renew an expired Google token through user action and resume at the prior playback position. Public GCS probe requests returned `206` and exposed range headers. Private OAuth, IAM enforcement, and real Safari playback still need this end-to-end check.

## Proceed with the GCS workflow

Once the spike passes, wire the reference flow end to end. Import media into one stable asset record, generate a thumbnail, apply two tags, and upload a catalog snapshot with persisted text and tag postings. Publish them together through a conditional update to `head.json`. Open in a fresh authorized browser, check both tag collections, search by imported text and tags, and open the full-screen viewer.

The Flickr fixture can be prepared independently of GCS. Include metadata-first and media-first parts, an ambiguous filename, a repeat import after an owner edit, overlapping albums, keyword and album title collisions, offset-free capture time, markup, microdegree coordinates, and both rotation sources. Use the archive counts above to check local parsing and the sanitized fixture to verify the browser workflow.
