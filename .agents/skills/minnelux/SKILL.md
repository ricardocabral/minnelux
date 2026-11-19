---
name: minnelux
description: Use when setting up, self-hosting, troubleshooting, or changing the Minnelux repository, including its web client, private GCS or S3 libraries, and Flickr export importer.
---

# Minnelux

Work from the Minnelux checkout. Read the repository instructions for the
relevant contracts and checks before changing code. [AGENTS.md](../../../AGENTS.md)

## Set up the requested workflow

- **Try Minnelux locally.** When the user asks for setup without specifying a
  cloud provider or deployment target, use the synthetic sample. Use Node.js 24
  or later and run the sample's install, test-mode build, and preview commands
  from `apps/web`. Use a free loopback port if the tutorial port is occupied.
  Choose **Open sample library** and verify a photo loads. Report the URL, what
  you verified, and how to stop the server. If you can only check the HTTP
  response, report that as a server check. [Sample library tutorial](../../../docs/prod/first-library.md)
- **Open an existing private library.** Use the requested client and provider.
  Reuse an authorized client origin when the user leaves the hosting choice
  open. Confirm the bucket, exact library prefix, and client origin. To browse,
  use **Read only** for GCS or a Cognito viewer role for S3. Have the user complete
  sign-in in the browser. Verify by opening a known photo. Check sign-in
  settings for the actual origin or callback URL if authentication fails.
  [GCS setup](../../../docs/prod/connect-google-cloud-storage.md) · [S3 setup](../../../docs/prod/connect-amazon-s3.md)
- **Self-host the web client.** Build the regular `apps/web/dist/` and serve it
  over HTTPS. Follow the provider guide for origin registration and browser
  access. For Google sign-in across reloads, use **Remember login** in a
  trusted browser. [Web client setup](../../../apps/web/README.md#self-host-the-web-client) · [Remember a Google login](../../../apps/web/README.md#stay-connected-across-reloads)
- **Import a Flickr export.** Use the standalone importer for Flickr ZIPs. For
  a test import, generate synthetic ZIPs using the importer guide. [Verify with a synthetic export](../../../apps/flickr-import/README.md#verify-with-a-synthetic-export)

## Protect the library

Keep buckets private and secrets out of chat, logs, and builds. Confirm the
target and the user's authorization before provisioning cloud resources,
changing access policies, deploying, or publishing library changes.

The web client reads v1 and v2 and publishes v2. The standalone Flickr
importer reads and publishes v1. Browse a shared v1 library in **Read only**
mode to keep it usable by the importer. Use a separate bucket or prefix for
web-client write checks, and publish synthetic data only when authorized.
[Library compatibility](../../../docs/prod/library-compatibility.md)

For code changes, preserve original bytes and the conditional library head
update that publishes revisions. [Storage specification](../../../docs/dev/storage/SPEC.md)
