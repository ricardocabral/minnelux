# Browser snapshot benchmark

This spike measures the [PRD's 50,000-item snapshot proposal](../../docs/prod/minnelux-prd.md#6-release-validation-and-implementation-order). A dedicated browser worker builds the catalog's text and tag postings, serializes and compresses the three objects, publishes a revision, and reopens it from object storage. The same worker times search with a freshly fetched index and with the index already in memory.

## Run

From the repository root, start the loopback test server and open its URL in a browser. Click **Run benchmark**. The page prints the raw timings, transfer sizes, and query match counts.

```sh
node spikes/snapshots/serve.mjs 8782 80 20
```

Open [the benchmark on localhost](http://127.0.0.1:8782/). It runs 20 samples by default. Use `?runs=5` for a short run or add `&auto` to start on page load. Use `node spikes/snapshots/serve.mjs 8782` for unshaped loopback measurements.

The localhost process serves the static page and provides an in-memory test object endpoint. Its optional link model adds the given latency per object request and queues payload transfer time at the given bandwidth, with independent queues for uploads and downloads. It moves actual payloads over loopback after the modeled delay. This timing model omits transport handshake, TLS, and provider overhead. The browser performs the catalog, postings, gzip, hashing, reopen, and query work.

## Workload and verification

The deterministic fixture has 50,000 generated assets, 2,995 videos, and 112,723 memberships across 660 album and keyword tags. The PRNG seed is printed in the report. Media records include logical original and preview paths, type, size, source, and capture time. About 27% have descriptions. Among the 13,529 nonempty descriptions, the median length is 35 characters and p95 is 541 characters. The workload was calibrated using aggregate counts from the local Flickr metadata ZIP on November 18, 2026. Its 9,985 photo sidecars had 2,726 nonempty descriptions with a median of 28 characters and p95 of 535 characters. The fixture uses an intentionally small natural-language vocabulary and a unique number in each filename. A larger real library may compress differently.

The browser stores weighted text postings as alternating ordinal/weight integers and tag postings as sorted ordinals. Each run uploads all three gzipped snapshots, then the manifest, then the head. It reloads the head, manifest, and catalog with HTTP caching disabled, orders the first 48 assets by capture time, and checks them against the source catalog. A cold query fetches and decodes both postings objects after the catalog is ready. The warm query repeats the same search with both postings already in memory. The benchmark checks the count and ordered first page of each query against a direct scan of the source catalog. Five rotating queries cover accent folding, multiple terms, explicit tag/type/date filters, a unique filename token, and no matches. Timings use nearest-rank percentiles. Transfer counts include object payload bytes as seen by the browser.

## Measurements

Read November 18, 2026 at 11:33 BRT from two headless Chrome 157.0.8103.79 runs on arm64 macOS 15.7.3. Each run measured 20 samples per row. Timings are in milliseconds.

| Browser stage | Loopback p50 / p95 | 20 Mbps, 80 ms model p50 / p95 | Requests | Payload bytes |
| --- | ---: | ---: | ---: | ---: |
| Build text and tag postings | 89.6 / 105.9 | 135.3 / 178.1 | 0 | 0 |
| Serialize, gzip, and hash snapshots | 300.8 / 328.3 | 366.1 / 585.5 | 0 | 0 |
| Upload snapshots, manifest, and head | 7.2 / 11.0 | 1845.0 / 1858.4 | 5 | 3,980,858 |
| Reopen and order the first 48 asset records | 85.2 / 102.8 | 1468.6 / 1553.9 | 3 | 2,732,730 |
| Cold text query, starting with the catalog ready | 17.0 / 23.2 | 589.5 / 602.0 | 2 | 1,248,128 |
| Warm text query | 0.8 / 4.6 | 0.9 / 4.8 | 0 | 0 |

The catalog was 19,860,972 bytes before gzip and 2,732,292 bytes on the wire. Text postings were 3,131,865 / 961,464 bytes and tag postings were 661,152 / 286,664 bytes. The head and manifest added 438 bytes. Each of the 40 reopen, cold query, and warm query samples passed the catalog checks. Queries rotated through `cafe` (8,100 matches), `quebec mountain` (265), `family` with album, media type, and date filters (1,734), `01000` (1), and `qqnotfound` (0), with four samples per query in each run.

Use these snapshots for the next device test. The modeled desktop cold and warm query times fit their 1,000 ms and 250 ms targets with the catalog already loaded. Catalog readiness consumed about 1.55 seconds of the 3-second first-thumbnail target. First visible thumbnails, peak memory, cloud transport and authorization, and the midrange mobile device remain part of release validation. For a bandwidth baseline, the catalog payload alone takes about 1.09 seconds at 20 Mbps.
