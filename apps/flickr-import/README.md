# Minnelux Flickr importer

Import Flickr account-export ZIPs directly from a browser into a private Google Cloud Storage library. The importer previews source matches, preserves original bytes and photo and album JSON, and publishes the catalog, full-text and tag indexes, and resumable import state together. [Flickr specification](../../docs/dev/flickr-import/SPEC.md) · [Repository contract](../../docs/dev/flickr-import/REPOSITORY-CONTRACT.md)

[Open the hosted importer](https://minnelux.web.app/flickr-import/) · [Hosting release instructions](../../spikes/gcs/README.md#redeploy)

## Build and open

Run from the repository root with Node 22 or later.

```sh
cd apps/flickr-import
npm ci
npm test
npm run build
```

Serve `apps/flickr-import/dist/` on a dedicated HTTPS origin. Apply the app's [security requirements](../../docs/prod/minnelux-prd.md#security-requirements), including `Content-Security-Policy: frame-ancestors 'none'` and `X-Content-Type-Options: nosniff` as HTTP response headers. Register the origin on a Google OAuth Web client. The site connects to Google Identity Services, Security Token Service, and the Cloud Storage JSON API directly. Google login and access tokens stay in memory for the active session.

Enter a private bucket, the library prefix (default `library`), and your public OAuth web client ID. Sign in for import or read-only access. The app limits its Cloud Storage token to the chosen prefix. The editor token can replace only `head.json` and can create immutable objects. Google IAM still determines which permissions the account can receive. [GCS sign-in requirements](../../docs/prod/minnelux-prd.md#google-account-sign-in-and-gcs-access) · [Google Credential Access Boundaries](https://docs.cloud.google.com/iam/docs/downscoping-short-lived-credentials)

Choose an existing Flickr source to add parts to it. For a first import, create a source and select one or more ZIPs. Preview before publishing. Saved media candidates and source records can be reopened from a fresh browser. Reselect the archive when bytes for a deferred member were never saved. Reopen published assets through the same connection to browse by tag, load a preview, or download an original. Expand **Photo details** for Flickr comments, annotations, group memberships, license, source link, tag authors, and embedded JPEG data. Select an album to see its description, cover, and dates.

To add these fields to an existing catalog, select the same source, preview, and publish. Reselect the original ZIPs to read the retained records and JPEG headers locally. A metadata-only update reuses existing originals and previews.

## Verify

The package tests cover archive limits and ZIP integrity, reconciliation, references, immutable uploads, conditional publication, and loss of the head response. Run the earlier multipart reconciliation fixture tests with `node --test spikes/flickr/reconcile.test.mjs` from the repository root. Generate sanitized ZIPs with `node spikes/flickr/pack-fixture.mjs`.

The importer accepts recognized originals up to 1 GiB. Preview generation is bounded to smaller JPEG, PNG, GIF, and WebP files and browser-decodable videos. Keep account, contacts, and other unrelated export JSON in the local ZIPs. The account profile contributes only the Flickr account identifier used to validate the source binding.
