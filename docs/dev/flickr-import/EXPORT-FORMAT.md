# Flickr account export format

Flickr’s account data export splits photo metadata, album lists, and original media across ZIPs. This reference records the observed format and how Minnelux interprets it. See the [importer specification](SPEC.md) for the full import contract.

## Sample archives

These are two parts of a real Flickr account export used for local validation.

| Role | Verified contents |
| --- | --- |
| Metadata | 9,985 per-item `photo_<id>.json` files and 16 other JSON files, including `albums.json` and account data. |
| Originals | 500 JPEGs. All 500 match a metadata record by Flickr ID. This part has no video. |

On November 18, 2026, local validation counted ZIP members and parsed JSON with Python. The EXIF check inspected JPEG APP1/TIFF metadata. The album document also contained 16,794 album-only photo references without supplied sidecars or originals, including the reserved `0` placeholder. Use the [synthetic export](../../../apps/flickr-import/README.md#verify-with-a-synthetic-export) for shared or hosted tests.

## Fields and matching rules

| Export field or structure | Importer handling and sample observations |
| --- | --- |
| **Identity** | A sidecar is named `photo_<id>.json` and contains a string `id`. The 500 sampled originals all match the anchored `_<id>_o` suffix before the extension. Parse IDs as strings and scope them to the Flickr source account. Check that filename and payload IDs agree. The sidecar's `original` URL is useful provenance. Its basename matched **0 of 500** sampled originals. |
| **Partial imports** | **9,485 of 9,985** metadata records await media outside the supplied part. Track matched, metadata-only, media-only, ambiguous, and duplicate items. Keep pending source IDs and album edges so later ZIPs can complete the join. Repeat imports should preserve asset IDs, owner edits, and owner-removed tags. Use file signatures to identify supported media. |
| **Albums and tags** | `albums.json` has an `albums` array. Each record has a string `id`, a `title`, and ordered `photos[]` IDs. Use that list for known albums and surface discrepancies with per-item `albums[]`. Among IDs with sidecars, the album file had **14,424** memberships and the sidecars had **12,311**. The matched JPEGs had **529** memberships across **16** albums, with **22** JPEGs in multiple albums. Map each Flickr album ID to a stable Minnelux tag. Read keywords from `tags[].tag` under a separate source namespace. Retain raw album JSON so ordering and pending edges survive. Use the array rather than declared `photo_count` for membership. |
| **Titles and descriptions** | Map `name` to title and derive plain text from `description` for display and search. **590 of 9,985** descriptions contained HTML-like markup. Retain source JSON for fidelity. Keep unrelated account and contact JSON in the original archive. |
| **Capture date and rotation** | `date_taken` and `date_imported` are offset-free `YYYY-MM-DD HH:mm:ss` strings in this export. All **500** JPEGs had EXIF `DateTimeOriginal` agreeing with the Flickr capture wall time. No original-time offset was found on those JPEGs. Store capture time, precision, provenance, and any known offset separately from import time. Six matched records had Flickr rotation of 90 degrees. Test embedded EXIF orientation and Flickr rotation together to catch double rotation. |
| **Coordinates** | `geo` is an array. The **367 of 9,985** nonempty instances each held one object with string `latitude`, `longitude`, and `accuracy`. All coordinate pairs fit geographic bounds after dividing the integer values by 1,000,000. Community importers use the same conversion. Range-check and preserve the raw values. The joined JPEGs had **0** matching sidecar geotags, so these samples cannot corroborate coordinates against embedded GPS. |

[Flickr account export](https://www.flickrhelp.com/hc/en-us/articles/4404079675156-Downloading-content-from-Flickr) · [Flickr EXIF FAQ](https://www.flickrhelp.com/hc/en-us/articles/4404078521108-EXIF-data-FAQ) · [Flickr-to-iCloud coordinate decoder](https://github.com/gwcoffey/flickr-to-icloud/blob/main/src/ruby/prepare.rb#L59-L63) · [Memento Mori coordinate decoder](https://github.com/antimega/memento-mori/blob/main/memento_mori/flickr.py#L115-L130)
