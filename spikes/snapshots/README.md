# Browser snapshot benchmark

This spike measures the [PRD's 50,000-item snapshot proposal](../../docs/prod/minnelux-prd.md#6-release-validation-and-implementation-order). A dedicated browser worker builds the catalog's text and tag postings, serializes and compresses the three objects, publishes a revision, and reopens it from object storage. The same worker times search with a freshly fetched index and with the index already in memory.

## Run

From the repository root, start the loopback test server and open its URL in a browser. Click **Run benchmark**. The page prints the raw timings, transfer sizes, and query match counts.

```sh
node spikes/snapshots/serve.mjs 8782 80 20
```

Open [the benchmark on localhost](http://127.0.0.1:8782/). It runs 20 samples by default. Append `?runs=5&auto` for a short run that starts on page load. Append `?runs=40&profile=long-tail&auto` to run the higher-vocabulary profile. Use `node spikes/snapshots/serve.mjs 8782` for unshaped loopback measurements.

The localhost process serves the static page and provides an in-memory test object endpoint. Its optional link model adds the given latency per object request and queues payload transfer time at the given bandwidth, with independent queues for uploads and downloads. It moves actual payloads over loopback after the modeled delay. This timing model omits transport handshake, TLS, and provider overhead. The browser performs the catalog, postings, gzip, hashing, reopen, and query work.

## Workload and verification

Both profiles use the same 50,000 generated assets, 2,995 videos, and 112,723 memberships across 660 album and keyword tags. They use seed `1214652599`. Media records include logical original and preview paths, type, size, source, and capture time. The 13,529 nonempty descriptions have a median length of 35 characters and a p95 of 541 in the baseline profile. Those lengths are 36 and 542 in the higher-vocabulary profile. The local Flickr metadata ZIP had 9,985 photo sidecars and 2,726 nonempty descriptions, with median length 28 and p95 535. The November 18, 2026 local check stripped markup with a regex and counted 5,146 distinct normalized title and description terms, 3,029 appearing once. Only aggregate counts informed the fixture.

The baseline has 98 title and description terms, excluding titles that equal the filename. To check sensitivity to a wider vocabulary, the higher-vocabulary profile replaces the last token in roughly 70% of synthetic titles and nonempty descriptions with a generated name. This profile has 24,618 distinct title and description terms, 16,006 appearing once. Both profiles also use a unique number in each filename. The generated names probe vocabulary size while keeping description length and catalog structure comparable. Real text and filenames may compress differently.

The browser stores weighted text postings as alternating ordinal/weight integers and tag postings as sorted ordinals. Each run uploads all three gzipped snapshots, then the manifest, then the head. It reloads the head, manifest, and catalog with HTTP caching disabled, orders the first 48 assets by capture time, and checks them against the source catalog. A cold query fetches and decodes both postings objects after the catalog is ready. The warm query repeats the same search with both postings already in memory. The benchmark checks the count and ordered first page of each query against a direct scan of the source catalog. Five rotating queries cover accent folding, multiple terms, explicit tag/type/date filters, a unique filename token, and no matches. Timings use nearest-rank percentiles. Transfer counts include object payload bytes as seen by the browser.

## Measurements

Read November 18, 2026 at 13:07 and 13:10 BRT from two headless Chrome 157.0.8103.79 runs on macOS 15.7.3 (Apple M3 Pro, arm64, 18 GB RAM). The local fixture server used Node 26.13.1. Both runs used the 20 Mbps per direction, 80 ms per request model, with 40 samples per row. Timings are in milliseconds.

| Browser stage | Baseline p50 / p95 | Higher-vocabulary p50 / p95 | Requests | Payload bytes, baseline / higher vocabulary |
| --- | ---: | ---: | ---: | ---: |
| Build text and tag postings | 111.5 / 152.5 | 157.7 / 191.2 | 0 | 0 / 0 |
| Serialize, gzip, and hash snapshots | 291.8 / 343.7 | 318.3 / 351.4 | 0 | 0 / 0 |
| Upload snapshots, manifest, and head | 1847.3 / 1851.7 | 1952.7 / 1956.0 | 5 | 3,980,858 / 4,247,028 |
| Reopen and order the first 48 asset records | 1462.0 / 1495.0 | 1527.3 / 1599.4 | 3 | 2,732,730 / 2,889,422 |
| Cold text query, starting with the catalog ready | 591.7 / 603.2 | 632.9 / 645.3 | 2 | 1,248,128 / 1,357,606 |
| Warm text query | 1.5 / 7.5 | 1.3 / 7.0 | 0 | 0 / 0 |

Before gzip, the catalog was 19,860,972 / 19,939,051 bytes, text postings were 3,131,865 / 3,462,915 bytes, and tag postings were 661,152 bytes in both profiles. Gzip reduced those objects to 2,732,292 / 2,888,984 bytes, 961,464 / 1,070,942 bytes, and 286,664 bytes respectively. The head and manifest added 438 bytes. All 80 reopen samples verified the revision and browse page, and all 80 cold and 80 warm queries agreed with a direct catalog scan on match count and ordered first page. The same five queries returned the same counts in both profiles. Each profile ran eight samples per query for `cafe` (8,100 matches), `quebec mountain` (265), `family` with album, media type, and date filters (1,734), `01000` (1), and `qqnotfound` (0). The p95 values pool the five queries within each profile.

Use whole gzip snapshots for the next device test. Both desktop profiles fit the 1,000 ms cold and 250 ms warm query budgets with the catalog already loaded. The catalog took up to 1.60 seconds at p95 to reopen and order the first page. The 3-second target measures first visible thumbnails, which also depends on thumbnail transfer and rendering. Validate that path, peak memory, and real provider transport on a midrange mobile device before fixing the format for release.
