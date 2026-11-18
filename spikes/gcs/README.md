# GCS browser proof

[Open the HTTPS probe](https://minnelux.web.app). The page uses Google Identity Services and the Cloud Storage JSON API. Firebase Hosting serves its static files.

The private test bucket is `minnelux-browser-proof-703092535958` in the `minnelux` Google Cloud project. It contains a synthetic JPEG and a 96-second, fast-start H.264 MP4. The page makes publication test writes under a fresh `proof/runs/<uuid>/` prefix on each run.

The deployed page includes the public OAuth client ID for its HTTPS origin. The Google Auth Platform audience is External in Testing, with `rnc000@gmail.com` as its only listed test user.

## Run the checks

1. While signed out, try reading the JPEG and record the denial.
2. Sign in for writing. Verify the JPEG decodes. Run the publication check. Expect snapshots and head creation and update to return HTTP 200, a stale update to return 412, and the new head to remain readable.
3. Sign in for reading. Verify the JPEG decodes and publication returns HTTP 403. Check that the page reports only the read-only storage scope.
4. Open the video, start playback, then use **Seek to 75%**. Record the upstream 206 responses, byte ranges, player position, and bytes streamed by the worker before and after the seek. Confirm the browser plays from the target while the totals are below the object's full size. Repeat on desktop Safari and on an iPhone or iPad in Safari.
5. After the token expires, sign in again and verify the video reopens at the previous position. **Drop local token** exercises the recovery interface on demand. Record an actual provider rejection or expiry separately.
6. With an allowed Google OAuth test user who lacks project and bucket IAM, sign in and confirm the private image read returns HTTP 403.

The dedicated video route is scoped to the requesting tab and its registered video. A second tab opening the same route receives a denial. The worker requests capped ranges when the player requests an open-ended range. It forwards the upstream partial response as a stream and reports the bytes that traverse the worker. Browser developer tools can provide independent network evidence.

## Provider baseline

On November 18, 2026, Chromium 159.0.8154.6 loaded the deployed HTTPS page and one signed-out Cloud Storage JSON API JPEG request returned HTTP 401. A separate authenticated JSON API request with `Origin: https://minnelux.web.app` and `Range: bytes=100000-100099` returned HTTP 206, `Content-Range: bytes 100000-100099/27745984`, and `Content-Length: 100`. JavaScript can read `Content-Range` through the exposed response headers. The same range without authorization returned HTTP 401. Two OPTIONS requests confirmed the JSON API allows `authorization,range` for media GET and `authorization,content-type` for conditional upload POST. These provider probes used a CLI credential for the authorized request.

At 11:37 BRT on the same date, one Chrome 157.0.8103.79 run exercised the browser code on loopback against the real private bucket with a CLI access token supplied in memory. The JPEG decoded at 800 × 450. Both snapshot uploads and both conditional head writes returned HTTP 200. The stale update returned HTTP 412, and the browser reopened revision `r2`. The player sought to 72 seconds and resumed playback after the worker reported streaming 2,929,440 of 27,745,984 bytes. GCS returned HTTP 206 for a new range starting at byte 18,022,400 after the seek. This run verified transport and player behavior. It used a test token callback in place of Google Identity Services.

A second Chrome run at 11:39–11:40 BRT reproduced the result. A separate tab loading the same media route received HTTP 401. After dropping the local session and supplying a token again, the player returned to the saved 72.80-second position. This was a local session reset using the same CLI credential.

## Hosted Chrome results

On November 18, 2026, at 12:02 BRT, Chrome 157.0.8103.79 on `https://minnelux.web.app/` received the Google Identity Services `devstorage.read_write` scope for the allowlisted Gmail account. One run decoded the private JPEG, uploaded two snapshots, created and conditionally updated the head with HTTP 200, and rejected a stale update with HTTP 412. A separate Cloud Storage read confirmed the head still pointed to `r2`.

At 12:09 BRT, a separate tab received `devstorage.read_only`. Its private JPEG read returned HTTP 200 and its publication attempt returned HTTP 403. In one play-and-seek run, the worker received HTTP 206 responses with readable range headers. After the seek, a new range started at byte 18,022,400. Playback resumed at 72.00 seconds after the worker reported streaming 7,123,755 of 27,745,984 bytes. The seek began after 4,274,585 bytes. At 12:10 BRT the player returned to the saved 94.18-second position after clearing the local session and signing in again with Google.

On the first consent attempt the popup closed before the page received a token. For both scopes a subsequent request returned a token after consent had been recorded. If the page reports a closed popup after consent, select the same sign-in button again.

Actual token expiration, a signed-in user without bucket IAM, and desktop and mobile Safari playback remain open. Desktop Safari 26.2 loaded the deployed page, but browser automation did not complete the Google popup flow. Safari WebDriver reports that remote automation is disabled.

## Redeploy

Run `firebase deploy --project minnelux --only hosting` from this directory with the Firebase CLI signed in as an authorized project administrator. Register the deployed origin on a Google OAuth Web application client. For a personal account, use an External audience with Testing status and add the intended test accounts. IAM for the private bucket is managed separately.

The fixtures can be generated with FFmpeg.

```sh
ffmpeg -f lavfi -i testsrc=size=800x450:rate=1 -frames:v 1 photo.jpg
ffmpeg -f lavfi -i testsrc2=size=720x404:rate=24 -t 96 -an \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -movflags +faststart video.mp4
```

Upload them as `proof/fixtures/photo.jpg` and `proof/fixtures/video.mp4`. Use the appropriate content type and leave content encoding unset.
