import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  sourceKey,
  ids,
  metadataFirst,
  metadataLater,
  originalParts,
} from "./fixture.mjs";
import { reconcile } from "./reconcile.mjs";

const photo = new Blob([await readFile(new URL("./fixtures/photo.jpg", import.meta.url))]);
const video = new Blob([await readFile(new URL("./fixtures/video.mp4", import.meta.url))]);
const [photos, videos] = originalParts(photo, video);
const ingest = (part, state) => reconcile(sourceKey, part, state);
const asset = (state, id) => state.assets.find(({ sourceId }) => sourceId === id);
const assetTags = (state, id) =>
  asset(state, id).tagIds.map((tagId) => state.tags.find(({ id }) => id === tagId));

test("metadata-first and media-first converge on the same assets and tags", async () => {
  const pending = await ingest(metadataFirst);
  assert.deepEqual(pending.preview.metadataOnly, [ids.photo, ids.video, ids.pending]);

  const earlyMedia = await ingest(videos);
  assert.deepEqual(earlyMedia.preview.mediaOnly, [ids.video]);
  assert.equal(asset(earlyMedia, ids.video).mimeType, "video/mp4");

  let metadataFirstState = await ingest(photos, pending);
  metadataFirstState = await ingest(metadataLater, metadataFirstState);
  metadataFirstState = await ingest(videos, metadataFirstState);

  let mediaFirstState = await ingest(photos, earlyMedia);
  mediaFirstState = await ingest(metadataLater, mediaFirstState);
  mediaFirstState = await ingest(metadataFirst, mediaFirstState);

  assert.deepEqual(metadataFirstState.assets, mediaFirstState.assets);
  assert.deepEqual(metadataFirstState.tags, mediaFirstState.tags);
  assert.deepEqual(metadataFirstState.preview.matched, [ids.photo, ids.video]);
  assert.deepEqual(metadataFirstState.preview.metadataOnly, [ids.pending]);
  assert.deepEqual(assetTags(metadataFirstState, ids.photo).map(({ kind, title }) => [kind, title]), [
    ["album", "Outdoors"],
    ["album", "Weekend"],
    ["keyword", "Outdoors"],
  ]);
  assert.equal(asset(metadataFirstState, ids.video).id, asset(earlyMedia, ids.video).id);
  assert.deepEqual(metadataFirstState.preview.albumDisagreements, [
    { sourceId: ids.photo, albumId: "2" },
    { sourceId: ids.photo, albumId: "3" },
  ]);
  assert.deepEqual(metadataFirstState.preview.unresolvedAlbums, [
    { sourceId: ids.photo, title: "Missing album ID" },
  ]);
  assert.deepEqual(metadataFirstState.source.albums["1"].photos, [ids.pending, ids.photo]);
});

test("retry preserves owner edits and removed memberships while applying newly supplied memberships", async () => {
  let state = await ingest(photos, await ingest(metadataFirst));
  const original = asset(state, ids.photo);
  const outdoorAlbum = assetTags(state, ids.photo).find(({ kind, title }) => kind === "album" && title === "Outdoors");
  assert.ok(outdoorAlbum);
  original.title = "Owner title";
  original.description = "";
  original.tagIds = original.tagIds.filter((tagId) => tagId !== outdoorAlbum.id);

  state = await ingest(metadataLater, structuredClone(state));
  state = await ingest(photos, await ingest(metadataFirst, state));
  assert.equal(asset(state, ids.photo).id, original.id);
  assert.equal(asset(state, ids.photo).title, "Owner title");
  assert.equal(asset(state, ids.photo).description, "");
  assert.deepEqual(assetTags(state, ids.photo).map(({ kind, title }) => [kind, title]), [
    ["album", "Weekend"],
    ["keyword", "Outdoors"],
  ]);
  assert.deepEqual(state.preview.duplicates, []);
});

test("ambiguous media, byte duplicates, filename mismatches and unsupported payloads surface for review", async () => {
  const same = `repeat_${ids.photo}_o.jpg`;
  const ambiguous = `bad_${ids.unknown}_o_copy_${ids.photo}_o.jpg`;
  const mismatched = `photo_${ids.unknown}.json`;
  const malformed = `unknown_${ids.unknown}_o.jpg`;
  let state = await ingest({
    id: "exceptions",
    sidecars: [{ name: mismatched, json: { id: ids.photo } }],
    media: [
      { name: same, bytes: photo },
      { name: ambiguous, bytes: photo },
      { name: malformed, bytes: new Blob(["not a JPEG"]) },
    ],
  });
  state = await ingest(photos, state);

  assert.deepEqual(state.preview.duplicates, [ids.photo]);
  assert.deepEqual(state.preview.ambiguous, [ambiguous]);
  assert.deepEqual(state.preview.invalidMetadata, [mismatched]);
  assert.deepEqual(state.preview.unsupportedMedia, [malformed]);
  assert.equal(asset(state, ids.photo), undefined);

  state = await ingest({
    id: "conflict",
    media: [{ name: same, bytes: video }],
  }, state);
  assert.ok(state.preview.ambiguous.includes(ids.photo));
});

test("the same Flickr ID cannot link assets across source accounts", async () => {
  const first = await ingest(photos);
  const second = await reconcile("a-different-synthetic-source", photos);
  assert.notEqual(asset(first, ids.photo).id, asset(second, ids.photo).id);
  await assert.rejects(reconcile("a-different-synthetic-source", metadataFirst, first));
});

test("normalized fields retain raw metadata and leave original bytes intact", async () => {
  const state = await ingest(photos, await ingest(metadataFirst));
  const item = asset(state, ids.photo);
  assert.equal(item.mimeType, "image/jpeg");
  assert.equal(item.description, "River & rocks");
  assert.equal(item.capturedAt, "2020-03-02 09:05:06");
  assert.equal(item.importedAt, "2021-05-12 14:35:10");
  assert.deepEqual(item.location, { latitude: -23.55052, longitude: -46.633308 });
  assert.equal(item.flickrRotation, 90);
  assert.deepEqual(state.source.sidecars[ids.photo], metadataFirst.sidecars[0].json);
  const original = Object.values(state.source.media).find(({ sourceId }) => sourceId === ids.photo);
  assert.deepEqual(await original.bytes.arrayBuffer(), await photo.arrayBuffer());
});
