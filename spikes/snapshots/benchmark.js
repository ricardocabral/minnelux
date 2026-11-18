const ITEM_COUNT = 50_000;
const SEED = 0x486620b7;
const FIRST_PAGE_SIZE = 48;
const FORMAT_VERSION = 1;
const TOKENIZER_VERSION = 1;
const EARLIEST_DATE = Date.UTC(2008, 0, 1);
const LATEST_DATE = Date.UTC(2026, 0, 1);
const DAYS = (LATEST_DATE - EARLIEST_DATE) / 86_400_000;
const traffic = { requests: 0, bytes: 0 };

const places = [
  "Lisboa", "São Paulo", "Recife", "Salvador", "Paris", "Kyōto", "Asakusa", "Bogotá",
  "München", "Oaxaca", "Petrópolis", "Québec", "Belém", "Montevideo", "Berlin", "Manaus",
  "Ubatuba", "Córdoba", "Barcelona", "Lima", "Paraty", "Brooklyn", "Olinda", "Porto",
];

const subjects = [
  "family", "portrait", "café", "river", "beach", "concert", "architecture", "garden",
  "museum", "sunset", "hiking", "street", "wedding", "festival", "cooking", "weekend",
  "rain", "silhouette", "birthday", "market", "mountain", "birds", "harbor", "train",
];

const details = [
  "blue", "early", "clouds", "bridge", "bicycle", "door", "boats", "night", "morning",
  "lights", "trail", "storm", "water", "stairs", "flowers", "field", "crowd", "fire",
  "station", "window", "trees", "stone", "alley", "promenade", "snow", "lighthouse",
  "island", "square", "bus", "piano", "violins", "ferry", "kitchen", "painting", "cat",
  "plaza", "lookout", "wharf", "shadows", "fountain", "jeep", "tower", "books",
  "botanical", "red", "children", "flowers", "museum", "paper", "riverside", "coast",
];

const queries = [
  { text: "cafe" },
  { text: "quebec mountain" },
  { text: "family", tagId: "album-0", kind: "image", after: "2010-01-01", before: "2024-01-01" },
  { text: "01000" },
  { text: "qqnotfound" },
];

function tokenize(value) {
  return value.normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function createCatalog() {
  let randomState = SEED;
  const draw = (limit) => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) % limit;
  };

  const tags = Object.fromEntries([
    ...Array.from({ length: 240 }, (_, i) => [
      `album-${i}`,
      { name: `${places[i % places.length]} ${subjects[Math.floor(i / places.length)]}` },
    ]),
    ...Array.from({ length: 420 }, (_, i) => [
      `keyword-${i}`,
      { name: `${subjects[i % subjects.length]} ${details[Math.floor(i / subjects.length)]}` },
    ]),
  ]);

  const assets = Array.from({ length: ITEM_COUNT }, (_, ordinal) => {
    const captureTime = new Date(EARLIEST_DATE + draw(DAYS * 86_400) * 1000).toISOString().slice(0, 19);
    const id = `asset-${String(ordinal).padStart(5, "0")}`;
    const place = places[draw(places.length)];
    const subject = subjects[draw(subjects.length)];
    const video = draw(100) < 6;
    const extension = video ? "mp4" : "jpg";
    const kind = video ? "video" : "image";
    const mime = video ? "video/mp4" : "image/jpeg";
    const filename = `${video ? "VID" : "IMG"}_${String(ordinal).padStart(5, "0")}.${extension}`;
    const title = draw(100) < 75
      ? `${place} ${subject} ${details[draw(details.length)]}`
      : filename;
    const descriptionChance = draw(100);
    const longDescription = descriptionChance === 0 || (descriptionChance === 1 && draw(2) === 0);
    const description = descriptionChance < 27
      ? [place, subject, ...Array.from({ length: longDescription ? 80 : 3 }, () => details[draw(details.length)])].join(" ")
      : "";
    const tagIds = new Set();
    const albumChance = draw(100);
    const albumCount = albumChance < 15 ? 0 : albumChance < 55 ? 1 : albumChance < 90 ? 2 : 3;
    for (let tag = 0; tag < albumCount; tag++) {
      // Give a few large albums a disproportionate share of archive items.
      tagIds.add(`album-${draw(100) < 25 ? draw(8) : draw(240)}`);
    }
    if (draw(100) < 29) {
      for (let tag = 0, count = 1 + draw(5); tag < count; tag++) {
        tagIds.add(`keyword-${draw(420)}`);
      }
    }
    const location = draw(100) < 4
      ? { latitude: -24 + draw(9_000_000) / 1_000_000, longitude: -48 + draw(7_000_000) / 1_000_000 }
      : undefined;

    return {
      id,
      source: { type: "synthetic", id: String(ordinal + 1_000_000_000) },
      original: {
        root: "originals",
        key: `${captureTime.slice(0, 4)}/${captureTime.slice(5, 7)}/${filename}`,
        mime,
        bytes: video ? 2_000_000 + draw(80_000_000) : 500_000 + draw(8_000_000),
      },
      previewKey: `previews/${id}/thumb.jpg`,
      filename,
      kind,
      title,
      description,
      captureTime,
      location,
      tagIds: [...tagIds],
    };
  });

  return { assets, tags };
}

function buildPostings(assets) {
  const text = Object.create(null);
  const tags = Object.create(null);
  for (const [ordinal, asset] of assets.entries()) {
    const weights = new Map();
    for (const [value, weight] of [[asset.filename, 1], [asset.title, 4], [asset.description, 2]]) {
      for (const term of new Set(tokenize(value))) {
        weights.set(term, (weights.get(term) ?? 0) + weight);
      }
    }
    for (const [term, weight] of weights) (text[term] ??= []).push(ordinal, weight);
    for (const tagId of asset.tagIds) (tags[tagId] ??= []).push(ordinal);
  }
  return { text, tags };
}

function search(catalog, text, tags, query) {
  const tagNames = Object.entries(catalog.tags);
  let scores;
  for (const term of new Set(tokenize(query.text))) {
    const matches = new Map();
    const postings = Object.hasOwn(text, term) ? text[term] : [];
    for (let offset = 0; offset < postings.length; offset += 2) {
      matches.set(postings[offset], postings[offset + 1]);
    }
    for (const [id, tag] of tagNames) {
      if (tokenize(tag.name).includes(term)) {
        for (const ordinal of tags[id] ?? []) matches.set(ordinal, (matches.get(ordinal) ?? 0) + 3);
      }
    }
    scores = scores
      ? new Map([...scores].filter(([ordinal]) => matches.has(ordinal))
        .map(([ordinal, score]) => [ordinal, score + matches.get(ordinal)]))
      : matches;
  }

  const requiredTag = query.tagId ? new Set(tags[query.tagId] ?? []) : null;
  const results = [...(scores ?? new Map())].filter(([ordinal]) => {
    const asset = catalog.assets[ordinal];
    return (!requiredTag || requiredTag.has(ordinal))
      && (!query.kind || asset.kind === query.kind)
      && (!query.after || asset.captureTime >= query.after)
      && (!query.before || asset.captureTime < query.before);
  });
  results.sort(([ordinalA, scoreA], [ordinalB, scoreB]) =>
    scoreB - scoreA || compareAssets(catalog.assets[ordinalA], catalog.assets[ordinalB]));
  return { count: results.length, page: results.slice(0, FIRST_PAGE_SIZE).map(([ordinal]) => catalog.assets[ordinal].id) };
}

function compareAssets(a, b) {
  return b.captureTime.localeCompare(a.captureTime) || a.id.localeCompare(b.id);
}

function expectedSearch(catalog, query) {
  const queryTerms = [...new Set(tokenize(query.text))];
  const tagTerms = Object.fromEntries(Object.entries(catalog.tags).map(([id, tag]) => [id, tokenize(tag.name)]));
  const matches = [];
  for (const asset of catalog.assets) {
    if ((query.tagId && !asset.tagIds.includes(query.tagId))
      || (query.kind && query.kind !== asset.kind)
      || (query.after && asset.captureTime < query.after)
      || (query.before && asset.captureTime >= query.before)) continue;

    const filename = tokenize(asset.filename);
    const title = tokenize(asset.title);
    const description = tokenize(asset.description);
    const scores = queryTerms.map((term) =>
      Number(filename.includes(term))
      + 4 * Number(title.includes(term))
      + 2 * Number(description.includes(term))
      + 3 * asset.tagIds.filter((id) => tagTerms[id].includes(term)).length);
    if (scores.every((score) => score > 0)) {
      matches.push({ asset, score: scores.reduce((total, score) => total + score, 0) });
    }
  }
  matches.sort((a, b) => b.score - a.score || compareAssets(a.asset, b.asset));
  return { count: matches.length, page: matches.slice(0, FIRST_PAGE_SIZE).map(({ asset }) => asset.id) };
}

async function encodeSnapshot(path, data) {
  const json = new Blob([JSON.stringify(data)]);
  const gzip = await new Response(json.stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", gzip);
  const contentId = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { key: `${path}/${contentId}.json.gz`, gzip, jsonBytes: json.size };
}

async function writeObject(key, body) {
  const response = await fetch(`./objects/${key}`, { method: "PUT", body });
  if (!response.ok) throw new Error(`Upload ${key} failed (${response.status})`);
  traffic.requests++;
  traffic.bytes += typeof body === "string" ? new Blob([body]).size : body.byteLength;
}

async function publish(revision, snapshots) {
  const manifest = JSON.stringify({
    formatVersion: FORMAT_VERSION,
    tokenizerVersion: TOKENIZER_VERSION,
    revision,
    catalog: snapshots.catalog.key,
    text: snapshots.text.key,
    tags: snapshots.tags.key,
  });
  const head = JSON.stringify({ formatVersion: FORMAT_VERSION, revision });
  await Promise.all(Object.values(snapshots).map(({ key, gzip }) => writeObject(key, gzip)));
  await writeObject(`revisions/${revision}.json`, manifest);
  await writeObject("head.json", head);
  return new Blob([manifest, head]).size;
}

async function readObject(key, compressed = false) {
  const response = await fetch(`./objects/${key}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Read ${key} failed (${response.status})`);
  traffic.requests++;
  traffic.bytes += Number(response.headers.get("Content-Length"));
  if (!compressed) return response.json();
  return new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).json();
}

async function openLibrary() {
  const head = await readObject("head.json");
  const manifest = await readObject(`revisions/${head.revision}.json`);
  const catalog = await readObject(manifest.catalog, true);
  const firstPage = catalog.assets.toSorted(compareAssets).slice(0, FIRST_PAGE_SIZE);
  return { catalog, manifest, firstPage };
}

function summarize(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = (ratio) => Number(sorted[Math.ceil(ratio * sorted.length) - 1].toFixed(2));
  return { n: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
}

async function benchmark(runs) {
  if (!Number.isInteger(runs) || runs < 1 || runs > 100) throw new Error("Run count must be 1–100");
  const catalog = createCatalog();
  const expected = queries.map((query) => expectedSearch(catalog, query));
  const browsePage = catalog.assets.toSorted(compareAssets).slice(0, FIRST_PAGE_SIZE).map(({ id }) => id);
  const samples = {
    buildPostings: [],
    gzipAndHashSnapshots: [],
    publish: [],
    openAndOrderFirstPage: [],
    coldTextQuery: queries.map(() => []),
    warmTextQuery: queries.map(() => []),
  };
  let footprint;
  let transfers;

  for (let iteration = 0; iteration < runs; iteration++) {
    postMessage({ progress: `Sample ${iteration + 1} of ${runs}` });
    const revision = crypto.randomUUID();
    const queryIndex = iteration % queries.length;
    const query = queries[queryIndex];
    transfers = {};

    let start = performance.now();
    const { text, tags } = buildPostings(catalog.assets);
    samples.buildPostings.push(performance.now() - start);

    start = performance.now();
    const snapshots = {
      catalog: await encodeSnapshot("catalog", catalog),
      text: await encodeSnapshot("index/text", text),
      tags: await encodeSnapshot("index/tags", tags),
    };
    samples.gzipAndHashSnapshots.push(performance.now() - start);

    start = performance.now();
    traffic.requests = 0;
    traffic.bytes = 0;
    const revisionBytes = await publish(revision, snapshots);
    samples.publish.push(performance.now() - start);
    transfers.publish = { ...traffic };

    start = performance.now();
    traffic.requests = 0;
    traffic.bytes = 0;
    const reader = await openLibrary();
    samples.openAndOrderFirstPage.push(performance.now() - start);
    transfers.open = { ...traffic };
    if (reader.manifest.revision !== revision || reader.catalog.assets.length !== ITEM_COUNT
      || JSON.stringify(reader.firstPage.map(({ id }) => id)) !== JSON.stringify(browsePage)) {
      throw new Error("Reopened catalog or browse page differs from the published revision");
    }

    start = performance.now();
    traffic.requests = 0;
    traffic.bytes = 0;
    const [readText, readTags] = await Promise.all([
      readObject(reader.manifest.text, true),
      readObject(reader.manifest.tags, true),
    ]);
    const cold = search(reader.catalog, readText, readTags, query);
    samples.coldTextQuery[queryIndex].push(performance.now() - start);
    transfers.coldTextQuery = { ...traffic };

    start = performance.now();
    traffic.requests = 0;
    traffic.bytes = 0;
    const warm = search(reader.catalog, readText, readTags, query);
    samples.warmTextQuery[queryIndex].push(performance.now() - start);
    transfers.warmTextQuery = { ...traffic };
    const correct = JSON.stringify(expected[queryIndex]);
    if (JSON.stringify(cold) !== correct || JSON.stringify(warm) !== correct) {
      throw new Error(`Reloaded postings search differs from catalog scan for ${JSON.stringify(query)}`);
    }

    footprint = Object.fromEntries(Object.entries(snapshots).map(([name, { gzip, jsonBytes }]) => [
      name, { gzipBytes: gzip.byteLength, jsonBytes },
    ]));
    footprint.headAndManifestBytes = revisionBytes;
  }

  return {
    browser: navigator.userAgent,
    itemCount: ITEM_COUNT,
    tagCount: Object.keys(catalog.tags).length,
    tagMembershipCount: catalog.assets.reduce((sum, { tagIds }) => sum + tagIds.length, 0),
    videoCount: catalog.assets.filter(({ kind }) => kind === "video").length,
    firstPageSize: FIRST_PAGE_SIZE,
    seed: SEED,
    runs,
    footprint,
    transfersPerSample: transfers,
    milliseconds: {
      buildPostings: summarize(samples.buildPostings),
      gzipAndHashSnapshots: summarize(samples.gzipAndHashSnapshots),
      publish: summarize(samples.publish),
      openAndOrderFirstPage: summarize(samples.openAndOrderFirstPage),
      coldTextQuery: summarize(samples.coldTextQuery.flat()),
      warmTextQuery: summarize(samples.warmTextQuery.flat()),
    },
    queries: queries.map((query, i) => ({
      ...query,
      matches: expected[i].count,
      samples: samples.coldTextQuery[i].length,
      coldMilliseconds: samples.coldTextQuery[i].map((ms) => Number(ms.toFixed(2))),
      warmMilliseconds: samples.warmTextQuery[i].map((ms) => Number(ms.toFixed(2))),
    })),
  };
}

self.addEventListener("message", async ({ data: { runs } }) => {
  try {
    postMessage({ result: await benchmark(runs) });
  } catch (error) {
    postMessage({ error: error.stack ?? String(error) });
  }
});
