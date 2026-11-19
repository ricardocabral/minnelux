# Library compatibility and import limits

## Library formats

| App | Storage and sign-in | Reads | Publishes |
| --- | --- | --- | --- |
| Web client | Google Cloud Storage with Google sign-in | v1 and v2 | v2 |
| Web client | Amazon S3 with Cognito sign-in | v1 and v2 | v2 |
| Flickr importer in the browser | Google Cloud Storage with Google sign-in | v1 | v1 |
| Flickr importer CLI | Google Cloud Storage with Google Cloud CLI credentials | v1 | v1 |

The web client can browse a Flickr library at the same bucket and prefix. Choose **Read only** to keep that library available to the importer. The next publication from the web client writes a v2 manifest. Use a separate bucket or prefix for web client writes if you plan to keep adding Flickr exports with the standalone importer.

The web viewer displays saved previews and details for imported videos. To retrieve a video file, use **Download original** in the Flickr importer.

## Import limits

| App | Input | Preview |
| --- | --- | --- |
| Web client | One JPEG up to 48 MiB per import, with two distinct tags | Generated in the browser |
| Flickr importer in the browser | One or more Flickr account-export ZIPs, with recognized originals up to 1 GiB each | JPEG, PNG, GIF, WebP, and browser-decodable videos up to 48 MiB and 80 megapixels, with a longest edge of up to 360 pixels |
| Flickr importer CLI | Flickr account-export ZIPs, processed one at a time, with recognized originals up to 1 GiB each | JPEG, PNG, GIF, and WebP up to 48 MiB and 80 megapixels, with a longest edge of up to 360 pixels |

A Flickr ZIP selection can contain up to 16 GiB of ZIP files and 25,000 entries, with up to 24 GiB of eligible expanded content including up to 128 MiB of metadata. In the browser these limits apply to the selection. The CLI applies them to each ZIP. If a browser selection exceeds these limits, select fewer ZIPs and continue with the same Flickr source. An album JSON file can be up to 32 MiB. Other metadata files can be up to 1 MiB each. [Import large Flickr exports from the command line](import-flickr-cli.md)

The Flickr importer can save an original even when preview generation is unavailable. It reads account, contacts, and other export files locally. The account profile supplies the Flickr account identifier used to match export parts to the same source.

## Flickr importer CLI

The `import:flickr` npm script is available in `apps/flickr-import`. Import mode takes one or more positional ZIP paths and processes them in the order supplied. List mode returns the source keys and labels already saved at a bucket and prefix.

| Option | Meaning |
| --- | --- |
| `--bucket BUCKET` | Private GCS bucket name. Required for import and list mode. |
| `--prefix PREFIX` | Library root within the bucket. Defaults to `library`. |
| `--source SOURCE` | Stable Flickr source key in the library. Required in import mode. |
| `--label LABEL` | Display label for a new source. Defaults to `Flickr archive`. |
| `--account ACCOUNT` | Configured `gcloud` identity. Defaults to the active account at startup. |
| `--no-thumbnails` | Skips generating new thumbnails and removes the ImageMagick requirement. Existing valid previews are retained. |
| `--list-sources` | Reads the available source keys and labels. Takes the bucket and optional prefix and account. |
| `--help`, `-h` | Prints command usage. |

Import mode emits newline-delimited JSON progress with a one-based ZIP index, review counts, and a publication result. `published` identifies a saved revision. `unchanged` means the ZIP required no new revision. An unresolved publication can return `outcomeUnknown` after the CLI checks for its receipt. The command exits with `0` for success, `1` for an error, or `130` when interrupted. Review counts can be nonzero on a successful run.

The library head is the checkpoint for each published ZIP. GCS uploads above 16 MiB can resume from a confirmed byte offset while the process runs. After a restart, the CLI reuses verified stored objects and starts a new upload for an incomplete object. [Run or resume an import](import-flickr-cli.md)
