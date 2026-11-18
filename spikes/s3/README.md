# Amazon S3 browser proof

This proof uses Cognito managed login and a private general-purpose S3 bucket from a static HTTPS page. The browser exchanges an authorization code with PKCE for a Cognito ID token, obtains temporary AWS credentials through the identity pool, and signs S3 requests with SigV4. [Minnelux architecture](../../docs/prod/minnelux-prd.md#3-browser-architecture) · [Amazon S3 setup for library owners](../../docs/prod/connect-amazon-s3.md)

## Verified behavior

| Check | Result |
| --- | --- |
| Cognito and IAM | Guest credential issuance was denied. Editors and viewers decoded the private JPEG. Anonymous and unassigned users received `403` on reads, and viewers received `403` on writes. AWS credentials were issued with about an hour of lifetime. |
| CORS and reads | `GET` and `PUT` preflights for the configured origin passed. An unrelated origin was denied. JavaScript could read the ETag and range headers. The editor listed two fixture keys over two pages and received `403` for bucket-wide listing and reading an out-of-prefix object. The missing head returned `404` and the exact-prefix listing was empty. |
| Publication | Conditional snapshot and head writes returned `200`. The browser read the same ETag on PUT and GET. Duplicate creates and a stale ETag returned `412`. A separate S3 read confirmed that the head still pointed to `r2`. |
| Seeking | Two Chrome 157.0.8103.79 runs resumed at 72 seconds after receiving 3,107,627–3,525,851 of 27,745,984 bytes. Chrome DevTools Protocol counted response body bytes at 1 MB/s and 120 ms added latency. S3 served a new `206` starting at byte 18,022,400 after the seek in both runs. |
| Replay and expiry | A signed-out browser context obtained `206` using the exact player URL, including after local disconnect. A new range on a 12-second URL returned `403` after expiry and `206` with a replacement. Same-user sign-in restored playback position. Switching users cleared the previous media state. |

## Connector handoff

- **Authentication.** Use [auth.js](public/auth.js) as the Cognito reference. Retain PKCE state, the verifier, and credentials in memory. Match the exact registered callback. Map users to IAM roles in the identity pool and keep an explicit session expiry. Verify provider expiry and revocation independently of local disconnect. Keep authorization bound to the active identity, library, and trusted endpoints.
- **S3 operations.** Use [storage.js](public/storage.js) for the SDK request shapes and [stack.yaml](stack.yaml) for fixture IAM and CORS. Keep continuation tokens and quoted ETags opaque. Read the head body and ETag in one request. Use `If-None-Match: *` for create-only writes and echo the ETag in `If-Match` for updates. Keep optional object version IDs separate. Reconcile `412`, conditional `409`, or interrupted writes through the library repository. Keep provider status for ambiguous absence and transport errors. Validate conditional completion and cleanup if using multipart uploads. [S3 head semantics](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html) · [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
- **Video.** Use the [GCS worker](../gcs/public/worker.js) as the reference for binding a same-origin route to the authorized tab, session, library, and asset. Add bounded, signed S3 range requests and validate upstream responses before streaming. The proof's direct presigned playback demonstrates S3 transport and the replay that the production route must prevent. Test replay of the exact app playback URL from a separate tab after disconnect. [S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- **Release checks.** Verify the tab-bound S3 route, browser seeking on desktop and iOS Safari, actual AWS credential expiry and revocation, and the shared [provider acceptance checks](../../docs/prod/minnelux-prd.md#3-validate-and-release-all-four-providers) before connecting real archives.

## Reproduce

Use a test AWS account or a test stack in your account. Choose an exact HTTPS origin for the static page. For loopback development, Cognito also allows `http://localhost:8788`. Use the selected origin for both S3 CORS and the Cognito callback.

```sh
cd spikes/s3
npm ci
npm run build

region=us-east-2
stack=minnelux-s3-proof
origin=https://your-proof-origin.example
domain=minnelux-s3-proof-your-unique-suffix

aws cloudformation deploy --region "$region" --stack-name "$stack" \
  --template-file stack.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides AppOrigin="$origin" CognitoDomain="$domain"
aws cloudformation describe-stacks --region "$region" --stack-name "$stack" \
  --query 'Stacks[0].Outputs[?OutputKey==`BrowserConfig`].OutputValue | [0]' \
  --output text > dist/config.json
```

Deploy `dist/` to the selected static origin separately from the private bucket. For loopback use `python3 -m http.server 8788 --bind 127.0.0.1 --directory dist` and open `http://localhost:8788/`. On HTTPS, set `Referrer-Policy: no-referrer` and a Content Security Policy allowing scripts and styles from the site, blob images, media from the regional bucket, and connections to the site, the bucket, the managed-login domain, and `https://cognito-identity.<region>.amazonaws.com`.

Create three synthetic, admin-provisioned Cognito users with permanent test passwords. Assign one to `writers`, one to `readers`, and leave one unassigned. The role mapping uses the user-pool group claim. The unassigned authenticated role has zero S3 permissions. Public S3 access and unauthenticated Cognito identities are disabled. The writer can create revision objects under `proof/runs/` and can update a head with an ETag. Separate administrative credentials seed the fixtures.

```sh
bucket=$(node -p "require('./dist/config.json').bucket")
fixture_dir=$(mktemp -d)
ffmpeg -f lavfi -i testsrc=size=800x450:rate=1 -frames:v 1 "$fixture_dir/photo.jpg"
ffmpeg -f lavfi -i testsrc2=size=720x404:rate=24 -t 96 -an \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -movflags +faststart "$fixture_dir/video.mp4"

aws s3 cp "$fixture_dir/photo.jpg" "s3://$bucket/proof/fixtures/photo.jpg" \
  --region "$region" --content-type image/jpeg --cache-control 'private, no-store'
aws s3 cp "$fixture_dir/video.mp4" "s3://$bucket/proof/fixtures/video.mp4" \
  --region "$region" --content-type video/mp4 --cache-control 'private, no-store'
printf 'Synthetic object outside the granted prefixes\n' > "$fixture_dir/outside.txt"
aws s3 cp "$fixture_dir/outside.txt" "s3://$bucket/private/outside.txt" --region "$region"
```

Publication runs expire after one day. To retire the proof, empty the fixture bucket and delete the stack using administrative credentials.

1. In browser Network tools, check unsigned denial and the configured origin's CORS headers. Sign in as the editor and run the JPEG, listing, range, and publication checks. Confirm the head still points to `r2` after stale-write rejection.
2. Repeat with the viewer and unassigned user. Verify the viewer can read and receives `403` on write. Verify the unassigned user receives `403` on read.
3. Play and seek to 75% before the full fixture downloads. Record the browser, transferred bytes, upstream range, and player position. Run the URL expiry check, repeat a range from a separate signed-out context with the same URL, and check same-user resume and account switching. Redact provider URL query strings from evidence.
