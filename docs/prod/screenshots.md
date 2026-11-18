# Minnelux screenshots

The web client examples use a sample library with 12 alpine photos, one video, three albums, and seven keyword tags. Each screenshot links to its full-size image.

## Browse the library

### All Media

The library groups photos and videos by capture month and falls back to the month they were added when the capture date is missing. The media type switch narrows the gallery to photos or videos.

[![All Media gallery showing alpine photos and a video grouped by month](../screenshots/library.webp)](../screenshots/library.webp)

### Tag collection

Selecting a tag in the sidebar shows all items with that tag. The **Mist** collection includes photos and a video drawn from multiple albums.

[![Mist tag collection with photos and a video](../screenshots/tag.webp)](../screenshots/tag.webp)

### Untagged media

**Untagged** shows items with no tags so they can be found together regardless of capture date.

[![Untagged gallery with two photos](../screenshots/untagged.webp)](../screenshots/untagged.webp)

### Search results

Search matches words in titles, descriptions, filenames, and tag names within the current collection. The results view ranks the best matches first.

[![Search results for lake with two matching photos](../screenshots/search.webp)](../screenshots/search.webp)

### Search with no matches

A search that returns zero results shows **No matches** and offers **Browse All Media** to clear the search and return to the full library.

[![No matches message with a Browse All Media button](../screenshots/search-empty.webp)](../screenshots/search-empty.webp)

### Tag and date filters

The **Filters** dialog narrows the current view by an additional tag, a date range, or both. The start and end dates are inclusive. Items without a capture date are filtered by the date they were added.

[![Filters dialog with the Autumn tag and an October date range](../screenshots/filters.webp)](../screenshots/filters.webp)

### Videos filter

The **Videos** switch limits the current collection or search to video items. In the grid, a **Video** badge identifies each clip.

[![Videos-only gallery with one clip](../screenshots/videos.webp)](../screenshots/videos.webp)

## View media

### Photo viewer

The viewer opens a larger preview and lets you step through the current gallery or search results. Photos with a saved preview support zoom, and **Download original** retrieves the source file.

[![Photo viewer showing a lake reflection with zoom and download controls](../screenshots/photo-viewer.webp)](../screenshots/photo-viewer.webp)

### Photo details

The **Details** panel shows available descriptions, capture information, source links, and collections. Saved EXIF and IPTC fields can include camera settings, captions, and dates.

[![Photo details showing source information, collections, EXIF, and IPTC](../screenshots/photo-details.webp)](../screenshots/photo-details.webp)

### Video preview

For an imported video, the viewer displays a saved poster frame and available source and collection details.

[![Video poster of clouds over the Dolomites alongside the details panel](../screenshots/video-preview.webp)](../screenshots/video-preview.webp)

## Connect storage and import a photo

### Google Cloud Storage connection

The connection form takes a bucket, library prefix, and Google OAuth client ID. With the appropriate bucket permissions, the connection can open the library in read-only or read-and-edit mode. [Google Cloud Storage setup](connect-google-cloud-storage.md)

[![Google Cloud Storage connection form with a read-only access option](../screenshots/connect-gcs.webp)](../screenshots/connect-gcs.webp)

### Amazon S3 connection

The S3 form takes the bucket and AWS region along with Cognito sign-in settings. A configured Cognito editor group enables editing for eligible users whose AWS permissions allow writes. [Amazon S3 setup](connect-amazon-s3.md)

[![Amazon S3 connection form with Cognito sign-in fields](../screenshots/connect-s3.webp)](../screenshots/connect-s3.webp)

### Import a JPEG photo

In a writable library, the import dialog accepts one JPEG and two distinct tags. Publishing saves the original, a browser-generated preview, and the updated catalog.

[![Photo import dialog with a JPEG and two tags selected](../screenshots/import-photo.webp)](../screenshots/import-photo.webp)

## Browse on a phone

### Mobile library

On a narrow screen, the gallery uses two columns and keeps search, media type controls, and filters available.

[![Mobile library with alpine photos laid out in two columns](../screenshots/mobile-library.webp)](../screenshots/mobile-library.webp)

### Mobile collections

The **Collections** panel provides the same library scopes and searchable collection list as the desktop sidebar.

[![Mobile Collections panel showing library scopes and tags](../screenshots/mobile-collections.webp)](../screenshots/mobile-collections.webp)

## Flickr importer

The standalone importer reads Flickr account-export ZIPs. [Flickr importer guide](../../apps/flickr-import/README.md)

### Connect private storage

The importer connects to a private Google Cloud Storage library. **Sign in to import** opens the upload workflow, and **Sign in to view** provides read-only access to published imports.

[![Flickr importer connection form with import and view sign-in options](../screenshots/flickr-connect.webp)](../screenshots/flickr-connect.webp)

### Select a Flickr export

The export form accepts one or more ZIP parts under a new or existing Flickr source. The source keeps later parts associated with the same account export.

[![Flickr source selection with a sample ZIP ready to preview](../screenshots/flickr-select.webp)](../screenshots/flickr-select.webp)

### Review the proposed import

The preview reports matched originals, missing files, and ambiguous candidates. It offers review controls when a match needs a decision before publication.

[![Import preview showing three matched originals and the Publish import button](../screenshots/flickr-preview.webp)](../screenshots/flickr-preview.webp)

### Browse published assets

The published view can filter imported items by album or keyword. It provides available previews and photo details alongside original downloads.

[![Published Flickr assets filtered by album with a loaded preview and expanded photo details](../screenshots/flickr-published.webp)](../screenshots/flickr-published.webp)

## Sample media credits

The catalog uses example collections and dates. The photo details show camera settings from the stock photo listing and sample IPTC values. Photos by Eberhard Grossgasteiger and video by Philip Janz. [Photo collection](https://www.pexels.com/@eberhardgross/) · [Video source](https://www.pexels.com/video/clouds-floating-around-dolomite-mountain-peaks-5452695/) · [Pexels license](https://www.pexels.com/license/)
