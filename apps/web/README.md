# Run or self-host the Minnelux web client

Run Minnelux locally or deploy the static web client to your own HTTPS host.

## Run locally

From the repository root, run with Node.js 24 or later:

```sh
cd apps/web
npm ci
npm run dev -- --host localhost
```

Open the localhost URL printed by Vite. Connect a private library using the setup guide for your provider. If the app says Google sign-in is ready, select **Connect to Google Cloud Storage** again. [Google Cloud Storage setup](../../docs/prod/connect-google-cloud-storage.md) · [Amazon S3 setup](../../docs/prod/connect-amazon-s3.md) · [Sample library tutorial](../../docs/prod/first-library.md)

## Self-host the web client

From `apps/web`, run `npm ci` and `npm run build` with Node.js 24 or later. Serve `dist/` from a dedicated HTTPS origin. Apply the [deployment security requirements](../../docs/prod/minnelux-prd.md#security-requirements) and register the public origin with your sign-in provider. [Google Cloud Storage setup](../../docs/prod/connect-google-cloud-storage.md) · [Amazon S3 setup](../../docs/prod/connect-amazon-s3.md)

For Google sign-in, allow Google Identity Services scripts, styles, and frames from `https://accounts.google.com/gsi/`. Allow connections to that path, `https://openidconnect.googleapis.com`, and `https://storage.googleapis.com`. Allow same-origin workers and blob images. Set `Cross-Origin-Opener-Policy: same-origin-allow-popups` for sign-in.

For Google-hosted deployments, follow the steps for [Firebase Hosting](../../docs/prod/connect-google-cloud-storage.md#deploy-to-firebase-hosting) or [Cloud Storage](../../docs/prod/connect-google-cloud-storage.md#deploy-to-cloud-storage). Open your deployed URL, connect using a private test bucket, and verify that you can open a photo.

## Stay connected across reloads

Select **Remember login** before connecting to Google Cloud Storage. The checkbox starts unchecked. When Google authorizes the connection, Minnelux saves one short-lived Google access token and its library connection in this browser's site data. Reload the same site in the same browser profile while the token is valid to reopen the library.

Use **Remember login** only in a trusted browser. Scripts running on the app's origin can read the saved token. When Minnelux detects that the token expired or Google rejects it, connect again to get a new token. Choose **Disconnect** to remove the saved login, or clear the site's browser data. [Google Cloud Storage setup](../../docs/prod/connect-google-cloud-storage.md)

[Developer checks](../../AGENTS.md#verify-the-affected-path)
