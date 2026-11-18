import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { ids, metadataFirst } from "../../spikes/flickr/fixture.mjs";
import { prepareFlickrImport } from "./plan.mjs";
import { scanFlickrZip } from "./zip.mjs";

const jpeg = await readFile(new URL("../../spikes/flickr/fixtures/photo.jpg", import.meta.url));
const mp4 = await readFile(new URL("../../spikes/flickr/fixtures/video.mp4", import.meta.url));
const sidecar = JSON.stringify(metadataFirst.sidecars[0].json);

// Independent ZIP fixture writer for corrupt entries and repeated central-directory names.
function archive(entries, name = "arbitrary-name.zip") {
  const locals = [];
  const directory = [];
  let localOffset = 0;
  for (const { path, localPath = path, payload = "", stored = false, declaredSize } of entries) {
    const filename = Buffer.from(path);
    const localName = Buffer.from(localPath);
    const bytes = Buffer.from(payload);
    const compressed = stored ? bytes : deflateRawSync(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(stored ? 0 : 8, 8);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(declaredSize ?? bytes.length, 22);
    header.writeUInt16LE(localName.length, 26);
    locals.push(header, localName, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    header.copy(central, 6, 4, 28);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(localOffset, 42);
    directory.push(central, filename);
    localOffset += header.length + localName.length + compressed.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.reduce((sum, bytes) => sum + bytes.length, 0), 12);
  eocd.writeUInt32LE(localOffset, 16);
  return new File([...locals, ...directory, eocd], name);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function read(stream) {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

test("recognizes a metadata continuation by entry name and preserves its raw JSON bytes", async () => {
  const name = `photo_${ids.photo}.json`;
  const zip = archive([
    { path: `export/${name}`, payload: sidecar },
    { path: "account_profile.json", payload: '{"nsid":"123@N99","email":"owner@example.invalid"}' },
    { path: "contacts.json", payload: "unrelated export material" },
  ]);
  const { partId, members } = await scanFlickrZip(zip);
  assert.equal(partId, digest(Buffer.from(await zip.arrayBuffer())));
  assert.equal((await scanFlickrZip(new File([zip], "renamed.zip"))).partId, partId);
  assert.deepEqual(members.map(({ entryOrdinal, filename, kind }) => ({ entryOrdinal, filename, kind })), [
    { entryOrdinal: 0, filename: name, kind: "photo-json" },
    { entryOrdinal: 1, filename: "account_profile.json", kind: "account-json" },
    { entryOrdinal: 2, filename: "contacts.json", kind: "ignored" },
  ]);
  assert.deepEqual(members[0].json, metadataFirst.sidecars[0].json);
  assert.equal(members[0].mimeType, "application/json");
  assert.equal(members[0].byteLength, Buffer.byteLength(sidecar));
  assert.equal(members[0].sha256, digest(sidecar));
  assert.equal((await read(await members[0].openBytes())).toString(), sidecar);
  assert.deepEqual(members[1].json, { nsid: "123@N99" });
});

test("recognizes media by signature and reopens duplicate filenames by their central-directory occurrence", async () => {
  const name = `ridge_${ids.photo}_o.jpg`;
  const { members } = await scanFlickrZip(archive([
    { path: name, payload: jpeg, stored: true },
    { path: name, payload: mp4 },
  ]));
  assert.deepEqual(members.map(({ entryOrdinal, filename, kind, mimeType, sha256 }) =>
    ({ entryOrdinal, filename, kind, mimeType, sha256 })), [
    { entryOrdinal: 0, filename: name, kind: "original", mimeType: "image/jpeg", sha256: digest(jpeg) },
    { entryOrdinal: 1, filename: name, kind: "original", mimeType: "video/mp4", sha256: digest(mp4) },
  ]);
  assert.equal(members[0].jpegMetadata.orientation, 6);
  assert.equal(members[1].jpegMetadata, undefined);
  assert.equal(members[1].byteLength, mp4.length);
  assert.deepEqual(await read(await members[0].openBytes()), jpeg);
  assert.deepEqual(await read(await members[1].openBytes()), mp4);
  assert.deepEqual(await read(await members[1].openBytes()), mp4);
});

test("reports unsafe paths, malformed JSON and unsupported media while retaining valid entries", async () => {
  const { members } = await scanFlickrZip(archive([
    { path: "../albums.json", payload: '{"albums":[]}' },
    { path: "C:/albums.json", payload: '{"albums":[]}' },
    { path: "nested\\albums.json", payload: '{"albums":[]}' },
    { path: "photo_5.json", payload: "{broken" },
    { path: "photo_6.json", payload: '{"id":6}' },
    { path: "photo_7.json", payload: '{"id":"8"}' },
    { path: "ridge_9_o.jpg", payload: "not media" },
    { path: "albums.json", payload: '{"albums":[{"id":"1","title":"Walks","photos":["0","9"]}]}' },
  ]));
  assert.deepEqual(members.map(({ kind, error }) => error ?? kind), [
    "unsafe-path", "unsafe-path", "unsafe-path", "invalid-json", "photo-id-mismatch",
    "photo-id-mismatch", "unsupported-media", "album-json",
  ]);
  assert.deepEqual(members[7].json.albums[0].photos, ["0", "9"]);
});

test("imports valid albums from a mixed document and keeps the original JSON bytes", async () => {
  const payload = JSON.stringify({ albums: [
    { id: "1", title: "Walks", photos: [ids.photo] },
    { id: "2", title: "Invalid member ID", photos: [42] },
    null,
  ] }, null, 2);
  const part = await scanFlickrZip(archive([{ path: "albums.json", payload }]));
  const base = { version: 1, sourceKey: "fixture", baseToken: "empty", source: null, assets: [], tags: [] };
  const { plan, preview } = await prepareFlickrImport(base, [part], {
    binding: { sourceKey: base.sourceKey, label: "Fixture" },
  });
  assert.deepEqual(plan.tags.map(tag => tag.title), ["Walks"]);
  assert.deepEqual(preview.albumReferenceOnly, [ids.photo]);
  assert.deepEqual(preview.invalidMetadata.map(issue => issue.reason), ["invalid-or-repeated-album"]);
  assert.equal(plan.uploads.length, 1);
  assert.equal((await read(await plan.uploads[0].openBytes())).toString(), payload);
});

test("rejects archive structure corruption and isolates a member that fails CRC validation", async () => {
  const zip = archive([
    { path: "damaged_1_o.jpg", payload: jpeg, stored: true },
    { path: "photo_2.json", payload: '{"id":"2"}' },
  ]);
  const corrupted = Buffer.from(await zip.arrayBuffer());
  corrupted[30 + Buffer.byteLength("damaged_1_o.jpg") + 10] ^= 1;
  const { members } = await scanFlickrZip(new Blob([corrupted]));
  assert.equal(members[0].error, "unreadable-entry");
  assert.equal(members[1].kind, "photo-json");
  await assert.rejects(scanFlickrZip(zip.slice(0, -3)), { code: "invalid-zip" });
});

test("rejects a member whose local filename disagrees with the central directory", async () => {
  const { members } = await scanFlickrZip(archive([
    { path: "albums.json", localPath: "../unsafe/x", payload: '{"albums":[]}' },
  ]));
  assert.equal(members[0].error, "unreadable-entry");
});

test("does not inflate oversized declarations or read more expanded bytes than declared", async () => {
  const { members } = await scanFlickrZip(archive([
    { path: "photo_1.json", payload: '{"id":"1"}', declaredSize: 10 ** 9 },
    { path: "photo_2.json", payload: '{"id":"2"}', declaredSize: 1 },
    { path: "photo_3.json", payload: '{"id":"3"}' },
    { path: "ridge_4_o.jpg", payload: jpeg, declaredSize: 1024 ** 3 + 1 },
  ]));
  assert.deepEqual(members.map(({ kind, error }) => error ?? kind), [
    "entry-limit", "unreadable-entry", "photo-json", "entry-limit",
  ]);
});

test("rejects excess expanded bytes before reading any member payload", async () => {
  const zip = archive(Array.from({ length: 5 }, (_, index) => ({
    path: `part-${index}/albums.json`,
    payload: '{"albums":[]}',
    declaredSize: 32 * 1024 * 1024,
  })));
  const memberRead = new Error("first local header was read");
  const abort = new AbortController();
  class ObservedZip extends Blob {
    slice(start, end) {
      // The central directory starts after the local headers.
      if (start === 0 && end === 30) abort.abort(memberRead);
      return super.slice(start, end);
    }
  }
  await assert.rejects(scanFlickrZip(new ObservedZip([zip]), { signal: abort.signal }), {
    code: "archive-limit",
  });
});

test("honors cancellation both during ZIP reads and during later entry reads", async () => {
  const zip = archive([{ path: "ridge_1_o.jpg", payload: jpeg }]);
  const aborted = AbortSignal.abort();
  await assert.rejects(scanFlickrZip(zip, { signal: aborted }), { name: "AbortError" });
  const { members } = await scanFlickrZip(zip);
  await assert.rejects(members[0].openBytes(aborted), { name: "AbortError" });
  const controller = new AbortController();
  const stream = await members[0].openBytes(controller.signal);
  controller.abort();
  await assert.rejects(read(stream), { name: "AbortError" });
  const unread = await members[0].openBytes();
  await unread.cancel();
  assert.deepEqual(await read(await members[0].openBytes()), jpeg);
});

test("rejects a later ZIP that would exceed the selection-wide metadata budget", async () => {
  const { createZipBudget } = await import("./zip.mjs");
  const budget = createZipBudget();
  budget.metadataBytes = Buffer.byteLength(sidecar);
  const zip = archive([{ path: `photo_${ids.photo}.json`, payload: sidecar }]);
  assert.equal((await scanFlickrZip(zip, { budget })).members[0].kind, "photo-json");
  await assert.rejects(scanFlickrZip(zip, { budget }), { code: "archive-limit" });
});
