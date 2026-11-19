# Import large Flickr exports from the command line

Use the Flickr importer CLI to publish a batch of Flickr account-export ZIPs to a private Google Cloud Storage library without keeping a browser tab open.

## Prepare the import

1. Keep the original Flickr export ZIPs on disk. Leave temporary disk space for one large original and one ZIP's generated previews. [Per-ZIP and media limits](library-compatibility.md#import-limits)
2. Choose an existing v1 library or an unused prefix in a private bucket. Give the Google Cloud CLI account permission to read library objects, create objects, and conditionally replace `head.json`. [Bucket and IAM setup](connect-google-cloud-storage.md#prepare-storage-and-sign-in) · [Compatible library formats](library-compatibility.md#library-formats)
3. On the machine that will run the import, install Node.js 24 or later and configure a signed-in `gcloud` account. Install ImageMagick 7 (`magick`) to generate image thumbnails. Add `--no-thumbnails` to import originals and metadata without generating new previews. [CLI option reference](library-compatibility.md#flickr-importer-cli)
4. Install the dependencies from the repository root.

   ```sh
   cd apps/flickr-import
   npm ci
   ```

## Publish the ZIPs

For an existing import, find the source key in the selected library. For a new import, choose a stable key and keep using it for all parts of the same export.

```sh
npm run --silent import:flickr -- --bucket MY_BUCKET --prefix library --list-sources
```

Pass the ZIPs in the order you want them processed. Add `--account ACCOUNT` to select a configured account explicitly. Keep the ZIP paths and source key so you can rerun the command if it stops.

```sh
npm run --silent import:flickr -- --bucket MY_BUCKET --prefix library \
  --source MY_SOURCE -- /path/to/export-1.zip /path/to/export-2.zip
```

Each ZIP ends with a `published` or `unchanged` result on a successful run. To check the import visually, open the browser importer with the same bucket and prefix, choose **Sign in to view**, select the source, then choose **View published assets**. [Browse a published import](../../apps/flickr-import/README.md#browse-a-published-import)

## Resume after an interruption

Rerun the same command with the same bucket, prefix, source key, and ZIPs. The CLI checks the published state and reuses verified objects. If the process exited while an object was uploading, it starts that object's upload again. If authentication failed, restore `gcloud` access for the selected account before rerunning.

If the JSON progress reports ambiguous matches or conflicting source records, open the browser importer with write access and preview the same source. Review the saved candidates and reselect any ZIPs whose deferred items were never saved. [Review an import in the browser](../../apps/flickr-import/README.md#import-a-flickr-export)
