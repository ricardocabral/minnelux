# Library compatibility and import limits

## Library formats

| App | Storage and sign-in | Reads | Publishes |
| --- | --- | --- | --- |
| Web client | Google Cloud Storage with Google sign-in | v1 and v2 | v2 |
| Web client | Amazon S3 with Cognito sign-in | v1 and v2 | v2 |
| Standalone Flickr importer | Google Cloud Storage with Google sign-in | v1 | v1 |

The web client can browse a Flickr library at the same bucket and prefix. Choose **Read only** to keep that library available to the importer. The next publication from the web client writes a v2 manifest. Use a separate bucket or prefix for web client writes if you plan to keep adding Flickr exports with the standalone importer.

The web viewer displays saved previews and details for imported videos. To retrieve a video file, use **Download original** in the Flickr importer.

## Import limits

| App | Input | Preview |
| --- | --- | --- |
| Web client | One JPEG up to 48 MiB per import, with two distinct tags | Generated in the browser |
| Standalone Flickr importer | One or more Flickr account-export ZIPs, with recognized originals up to 1 GiB each | JPEG, PNG, GIF, WebP, and browser-decodable videos up to 48 MiB and 80 megapixels, with a longest edge of up to 360 pixels |

A Flickr ZIP selection can contain up to 16 GiB of ZIP files and 25,000 entries, with up to 24 GiB of eligible expanded content including up to 128 MiB of metadata. If the combined selection exceeds these limits, select fewer ZIPs and continue with the same Flickr source. An album JSON file can be up to 32 MiB. Other metadata files can be up to 1 MiB each.

The Flickr importer can save an original even when preview generation is unavailable. It reads account, contacts, and other export files locally. The account profile supplies the Flickr account identifier used to match export parts to the same source.
