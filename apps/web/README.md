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

## Stay connected across reloads

The static build uses browser-only Google authorization. To enable durable
sessions, deploy the opt-in Node server and build the web client for it. Host
both on a dedicated HTTPS origin you control. The server encrypts the
session records it stores in SQLite on a persistent local disk. Use one server instance for
that database. The browser keeps the session ID in a Secure, HttpOnly cookie
and receives only short-lived access tokens for direct GCS requests.

1. Create a Google OAuth **Web application** client for the session server.
   Register the exact redirect URI
   `https://photos.example.com/api/minnelux-session/callback`. Configure the
   consent screen and add your Google account to the test audience if needed.
   Google may expire refresh tokens after seven days while the app is in
   Testing. Scope and bucket IAM requirements match the existing web client.
   [Google OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server)
2. Build with `VITE_DURABLE_GCS_SESSION=1 npm run build`. Vite must receive only
   the public flag. Keep the client secret and encryption key in the server's
   secret store. Generate the key once with
   `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`.
3. Set these environment variables for `npm run serve:session` from
   `apps/web`. Keep the database in a directory private to the service user
   and outside the asset tree.

   | Variable | Value |
   |---|---|
   | `MINNELUX_ORIGIN` | Exact HTTPS origin, such as `https://photos.example.com` |
   | `MINNELUX_APP_PATH` | App path with a trailing slash. Defaults to `/`. |
   | `MINNELUX_SESSION_DB` | Absolute path to a database on the persistent disk |
   | `MINNELUX_SESSION_KEY` | The generated 32-byte key in base64url |
   | `GOOGLE_OAUTH_CLIENT_ID` | Client ID from the first step |
   | `GOOGLE_OAUTH_CLIENT_SECRET` | Client secret from the first step |

4. Terminate TLS at a reverse proxy and forward the app and
   `/api/minnelux-session/` to the process. It listens on `127.0.0.1:4180` by
   default. Use `PORT` to change the port. Preserve cookies, the request
   Origin header, and the response cache policy. Exclude all session API
   routes from caching. Suppress URL query strings, cookies, authorization
   headers, and request and response bodies in session API logs, including
   ingress and error diagnostics. The callback query carries the short-lived
   authorization code. Use a proxy that forwards the named cookies unchanged.
   Firebase Hosting rewrites only forward the `__session` cookie, so this
   service needs a separate HTTPS ingress. Apply per-source rate limits to
   the session API at the proxy, especially sign-in start and callback. The
   application accepts at most 256 concurrent sign-in attempts per instance.
5. Connect to your test library and reload the page while the gallery is open.
   The gallery should open without prompting for consent again. Use
   **Disconnect** to end the saved session, then reload and check that the
   connect form returns.

A saved session lasts at most seven days. The server can renew the access
token when a page reloads. A tab left open past its access token deadline asks
you to reload. If Google Storage rejects the access token early, Minnelux
marks that token for renewal and asks you to reload. Disconnect deletes the
saved session and clears this tab.
Other tabs holding an access token keep it until its deadline. To revoke
Google's grant, remove the app from your Google Account. All sessions end
when you replace the encryption key and start with a fresh session database.
Keep routine disk backups under the same access policy as the live database.
The app serves a static build without durable sessions when the opt-in flag
is absent.

Run `npm run test:session` after installing Playwright Chromium. This test
requires OpenSSL to generate a temporary local HTTPS certificate. It uses
the real session server and synthetic Google and GCS responses.
