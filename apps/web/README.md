# Minnelux web client

Run the reference app from this directory with Node.js 24 or later.

```sh
npm ci
npm run dev
```

For a private GCS connection, use a test bucket and a Google OAuth client
registered for the app's origin. Follow the project's GCS setup and HTTPS
requirements. The reference flow opens a revision, displays previews and
saved Flickr details, and publishes a JPEG with tags. Reopen the library
and search for the photo. Use a separate test library during this stage. The
web client writes v2 manifests, and the standalone Flickr importer opens
v1 manifests. [GCS setup](../../docs/prod/minnelux-prd.md#google-account-sign-in-and-gcs-access)

```sh
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

Browser tests use a local fixture endpoint and synthetic photos. The regular
build outputs a static site in `dist/`. The browser tests build in
`dist-test/` and start a local fixture server. Hosted provider and private video checks are tracked
in the [implementation plan](../../plans/web-client.md).
