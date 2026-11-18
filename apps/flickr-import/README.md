# Import a Flickr account export

The Flickr importer is a standalone browser app. It reads export ZIPs locally and sends originals, Flickr metadata, and generated previews directly to your private Google Cloud Storage bucket. [Library compatibility and file limits](../../docs/prod/library-compatibility.md)

## Import a Flickr export

1. Request an account export from Flickr and keep the ZIP parts together. Set up your bucket, Google account permissions, and OAuth client. [Google Cloud Storage setup](../../docs/prod/connect-google-cloud-storage.md)
2. Open the [hosted Flickr importer](https://minnelux.web.app/flickr-import/). Enter the bucket name, library prefix, and Google OAuth web client ID, then choose **Sign in to import**.
3. Choose **New Flickr source** for the first import. Select that same source when adding more parts or updating an earlier import. Select one or more ZIPs.
4. Choose **Preview import** and review proposed matches. Resolve ambiguous matches you recognize. Choose **Publish import** and wait for confirmation.

If publication is unconfirmed, choose **Publish import** again while connected. If the session expired, sign back in to the same bucket and prefix to check the result.

The importer can reopen saved source records and media candidates. Reselect a ZIP when bytes for a deferred item were never saved. To add available metadata to an older import, select the same source, reselect the relevant ZIPs, preview, and publish. A metadata-only update reuses existing originals and previews.

## Browse a published import

Choose **Sign in to view**, select the Flickr source, and choose **View published assets**. Filter by an imported album or keyword tag. Use **Load preview** where available or **Download original**. Expand **Photo details** for available metadata such as Flickr comments, license, or embedded JPEG details. Selecting an album can show its cover, description, and dates.

## Self-host the importer

From the repository root, run with Node.js 22 or later:

```sh
cd apps/flickr-import
npm ci
npm run build
```

Serve `dist/` from a dedicated HTTPS origin. Register that origin on the [Google OAuth client](../../docs/prod/connect-google-cloud-storage.md#prepare-storage-and-sign-in). The built page's Content Security Policy allows Google Identity Services, the Security Token Service, and the Cloud Storage JSON API. Apply the app's [security requirements](../../docs/prod/minnelux-prd.md#security-requirements), including the HTTP response headers `Content-Security-Policy: frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`.

Open the deployed page, sign in to a test bucket and unused prefix, and verify that you can preview, publish, and reopen a synthetic export. From the repository root, run `node spikes/flickr/pack-fixture.mjs` with `zip` installed, then select the ZIPs in the printed directory.

[Project Firebase Hosting runbook](../../spikes/gcs/README.md#redeploy) · [Importer specification](../../docs/dev/flickr-import/SPEC.md) · [Repository contract](../../docs/dev/flickr-import/REPOSITORY-CONTRACT.md)
