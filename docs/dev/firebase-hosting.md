# Release Minnelux on Firebase Hosting

Use this runbook to publish the shared `minnelux` Firebase Hosting site. Each release replaces the site's complete file set. Stage the existing GCS compatibility probe at `/`, the Flickr importer at `/flickr-import/`, and the web client at `/web/` together. The [Hosting configuration](../../deploy/firebase.json) applies shared headers and a Content Security Policy for each route.

## Stage the release

Use Node.js 24 or later and the Firebase CLI. From the repository root, choose the Git revision to release and confirm the Firebase project and Hosting site in the console. The example uses `minnelux` for both. The root probe comes from its last source revision in Git history. Use a checkout with that commit available.

```bash
set -e -o pipefail
release_ref=$(git rev-parse HEAD)
probe_ref=4d913e3792234c1a15d4752998ca038283e35f03
stage=$(mktemp -d)
mkdir -p "$stage/public"

git archive "$release_ref" apps/flickr-import apps/web docs/mkt/logo deploy/firebase.json |
  tar -xf - -C "$stage"
git archive "$probe_ref" spikes/gcs/public |
  tar -xf - -C "$stage/public" --strip-components=3
mv "$stage/deploy/firebase.json" "$stage/firebase.json"

(cd "$stage/apps/flickr-import" && npm ci && npm run build)
(cd "$stage/apps/web" && npm ci && npm run build)
cp -R "$stage/apps/flickr-import/dist" "$stage/public/flickr-import"
cp -R "$stage/apps/web/dist" "$stage/public/web"
```

The checked-in web policy allows Google sign-in and GCS. For a deployment that supports S3, add the exact regional bucket and Cognito endpoints to the staged web policy and register the callback for the deployed path. Verify sign-in and private reads for both providers. [S3 browser access](../prod/connect-amazon-s3.md#configure-browser-access)

## Verify and publish

1. From the staging directory, run `firebase emulators:start --only hosting --project demo-minnelux`. Open all three routes and confirm scripts, styles, and workers load. Inspect the app and worker responses for the expected security headers, including `frame-ancestors 'none'` in the route's policy and `https://sts.googleapis.com` in the importer's `connect-src`. Check that the web worker receives the web policy. [Firebase Hosting local testing](https://firebase.google.com/docs/hosting/test-preview-deploy#test-locally)
2. Record the release commit and the current live version in Firebase Hosting's Release history. Sign in to the Firebase CLI with access to the release project and run `firebase deploy --project minnelux --only hosting` from the staging directory.
3. Open [the root probe](https://minnelux.web.app/), [the importer](https://minnelux.web.app/flickr-import/), and [the web client](https://minnelux.web.app/web/). Check each route's scripts and headers again. Using dedicated private test data, sign in, load an image from the root probe, preview a synthetic Flickr export, and open a photo in the web client. [Google Cloud Storage sign-in and IAM](../prod/connect-google-cloud-storage.md#prepare-storage-and-sign-in) · [Synthetic Flickr export](../../apps/flickr-import/README.md#verify-with-a-synthetic-export)
4. If any route regresses, use the site's Release history to roll back to the recorded previous version, then recheck all three routes. [Firebase Hosting rollback](https://firebase.google.com/docs/hosting/manage-hosting-resources#roll-back-release)
