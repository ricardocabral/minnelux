# Flickr reconciliation spike

Run `node --test spikes/flickr/reconcile.test.mjs` from the repository root. The reconciliation module uses browser APIs and accepts a part's parsed sidecars, album records, and original `Blob`s. Each part has a stable ID so replaying it does not create new candidates. The returned preview and state can be passed to the next import.

The synthetic dataset has two metadata parts and two media parts. It includes an EXIF Orientation 6 JPEG and an H.264 MP4 with a `.jpg` export name to exercise signature detection. Both originals were generated from FFmpeg's `testsrc2`. The sidecars and album records are invented. The tests exercise arrivals in both orders, an album conflict, a pending member, repeated imports after owner edits, source account isolation, and ambiguous or duplicate files.

Album documents can arrive after sidecars. The spike records sidecar-only album edges as provisional and withdraws them when the authoritative list disagrees. The applied-membership history makes retries honor owner removals while allowing newly discovered edges. The spike keeps raw source records and original bytes alongside normalized fields.

The checked fixture boundary starts at parsed parts. ZIP extraction, durable publication, and composing EXIF orientation with Flickr rotation at preview time are follow-up checks.

On November 18, 2026, all five Node tests passed. In a separate headless Chromium 159.0.8154.6 smoke run at an intercepted HTTPS test origin, the browser matched both generated originals to their sidecars in media-first order and detected one byte-identical duplicate through Web Crypto.
