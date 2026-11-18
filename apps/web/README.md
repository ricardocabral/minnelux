# Run or self-host the Minnelux web client

To open a private GCS library without running a server, use the [hosted web client](https://minnelux.web.app/web/). [Google Cloud Storage setup](../../docs/prod/connect-google-cloud-storage.md)

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

For browser-only Google sign-in, allow Google Identity Services scripts, styles, and frames from `https://accounts.google.com/gsi/`. Allow connections to that path, `https://openidconnect.googleapis.com`, and `https://storage.googleapis.com`. Allow same-origin workers and blob images. Set `Cross-Origin-Opener-Policy: same-origin-allow-popups` for sign-in.

Open your deployed URL, connect using a private test bucket, and verify that you can open a photo. [Project Firebase Hosting runbook](../../spikes/gcs/README.md#redeploy)

## Stay connected across reloads

Use the optional Google session server to restore a GCS connection after a reload. Deploy the app and server on the same dedicated HTTPS origin. Run one server instance with a private, persistent SQLite database. The server encrypts saved session records and the browser keeps the session ID in a Secure, HttpOnly cookie. Storage requests still go directly from the browser to GCS.

1. Create a Google OAuth **Web application** client with the exact redirect URI `https://photos.example.com/api/minnelux-session/callback`, using your own origin. The callback path is the same when the app runs under a subpath. Use the [Google consent and bucket IAM setup](../../docs/prod/connect-google-cloud-storage.md#prepare-storage-and-sign-in). [Google OAuth web server setup](https://developers.google.com/identity/protocols/oauth2/web-server)
2. From `apps/web`, run `npm ci` and `VITE_DURABLE_GCS_SESSION=1 npm run build`. Only the public flag belongs in the frontend build. Generate the server's encryption key once with `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`.
3. Set the following environment variables and run `npm run serve:session` from `apps/web`. Keep the key and client secret in the server's secret store. Keep the database outside the asset tree.

   | Variable | Value |
   | --- | --- |
   | `MINNELUX_ORIGIN` | Exact HTTPS origin such as `https://photos.example.com` |
   | `MINNELUX_APP_PATH` | App path with a trailing slash. Defaults to `/`. |
   | `MINNELUX_SESSION_DB` | Absolute path to the database on persistent disk |
   | `MINNELUX_SESSION_KEY` | Generated 32-byte base64url key |
   | `GOOGLE_OAUTH_CLIENT_ID` | Session server's OAuth client ID |
   | `GOOGLE_OAUTH_CLIENT_SECRET` | Session server's OAuth client secret |

4. Terminate TLS at a reverse proxy and forward the app and `/api/minnelux-session/` to the service, which listens on `127.0.0.1:4180` by default. Preserve cookies, the request `Origin` header, and response cache policies. Disable caching for the session API and rate-limit sign-in start and callback requests. Suppress query strings, cookies, authorization headers, and bodies in session API logs, including ingress and error logs. Use an ingress that forwards the named cookies. [Firebase Hosting forwards only the `__session` cookie to Cloud Run and Cloud Functions](https://firebase.google.com/docs/hosting/manage-cache#using_cookies).
5. Connect to a test library and reload the gallery. It should reopen without another consent prompt. Choose **Disconnect**, reload, and confirm the connect form returns.

A saved session lasts at most seven days. Google can also expire refresh tokens after seven days for an External OAuth app in Testing. Reload if the app reports an expired or rejected access token. **Disconnect** removes the saved session. Other tabs can use an issued access token until it expires. To revoke the app's grant, remove it from your Google Account. Starting with a fresh database and a new encryption key ends all saved sessions. Protect database backups with the same access policy as the live database.

[Developer checks](../../AGENTS.md#verify-the-affected-path)
