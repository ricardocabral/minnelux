import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { prepareFlickrImport } from "./plan.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const catalogId = (kind, value) => "flickr:" + hash(JSON.stringify(["family", kind, value]));
const binding = { sourceKey: "family", label: "Family" };
const empty = { version: 1, sourceKey: "family", revisionId: null, baseToken: "pin", source: null, assets: [], tags: [], receipts: [] };
const photo = await readFile(new URL("./test-fixtures/photo.jpg", import.meta.url));
const movie = await readFile(new URL("./test-fixtures/video.mp4", import.meta.url));
const digits = "90071992547409931";

const original = (id, bytes = photo, filename = "river_" + id + "_o.jpg") =>
  member("original", filename, bytes, bytes === movie ? "video/mp4" : "image/jpeg");
function member(kind, filename, bytes, mimeType, json) {
  return { kind, filename, sha256: hash(bytes), byteLength: Buffer.byteLength(bytes), mimeType, json,
    openBytes: async () => new Blob([bytes]).stream() };
}
function raw(kind, filename, json) {
  return member(kind, filename, JSON.stringify(json, null, 2), "application/json", json);
}
const sidecar = (id, fields = {}) => raw("photo-json", "photo_" + id + ".json", { id, ...fields });
const albums = (...entries) => raw("album-json", "albums.json", { albums: entries });
const part = (label, ...members) => ({ partId: hash(label), members: members.map((m, entryOrdinal) => ({ ...m, entryOrdinal })) });
const prepare = (parts, options = {}, base = empty) => prepareFlickrImport(base, parts, { binding, ...options });

// Materialize each stream and reopen typed references as a separate client would.
async function reopen(plan, previous = empty, objects = new Map()) {
  const refs = new Map();
  for (const upload of plan.uploads) {
    const bytes = Buffer.from(await new Response(await upload.openBytes()).arrayBuffer());
    assert.equal(hash(bytes), upload.sha256);
    assert.equal(bytes.length, upload.byteLength);
    const ref = { kind: upload.kind, sha256: upload.sha256, byteLength: bytes.length,
      mimeType: upload.mimeType, root: "library", key: upload.kind + "/" + upload.sha256 };
    objects.set(ref.key, bytes);
    refs.set(upload.uploadId, ref);
  }
  const persisted = JSON.parse(JSON.stringify(plan, (_, value) =>
    value && Object.keys(value).length === 1 && value.uploadId ? refs.get(value.uploadId) : value));
  const merge = (before, after) => [...new Map([...before, ...after].map(x => [x.id, x])).values()];
  return { base: { ...previous, source: persisted.source ?? previous.source, baseToken: "reopened",
    revisionId: "new", tags: merge(previous.tags, persisted.tags), assets: merge(previous.assets, persisted.assets) },
    openObject: async ref => new Blob([objects.get(ref.key)]).stream(), objects };
}

test("metadata, raw bytes and ordered overlapping albums reunite after reopen", async () => {
  const input = sidecar(digits, { name: "River", description: '<p>A &amp; B</p><script>noise()</script><p>&#x1F30A; 1 &lt; 2</p>',
    geo: [{ latitude: "0", longitude: "-46633308", accuracy: "16" }], rotation: 90,
    date_taken: "2020-03-02 09:05:06", date_imported: "2021-04-03T09:05:06-03:00",
    tags: [{ tag: "Outdoors" }], albums: [{ id: "1", title: "Outdoors" }, { title: "missing" }] });
  const document = albums({ id: "1", title: "Outdoors", photos: [digits, "0", digits, "83"] },
    { id: "2", title: "Outdoors", photos: [digits] });
  const meta = part("metadata", input, document);
  const first = await prepare([meta]);
  assert.deepEqual(first.preview.metadataOnly, [digits]);
  assert.deepEqual(first.preview.albumReferenceOnly, ["83"]);
  assert.equal(first.plan.assets.length, 0);
  const saved = await reopen(first.plan);
  const albumRef = saved.base.source.albums["1"].variants[0].raw;
  assert.equal(await new Response(await saved.openObject(albumRef)).text(), JSON.stringify(document.json, null, 2));
  const media = part("media", original(digits, movie));
  const { plan, preview } = await prepare([media], { openObject: saved.openObject }, saved.base);
  assert.deepEqual(preview.matched, [digits]);
  assert.equal(preview.albumDisagreements.length, 1);
  assert.equal(preview.unresolvedAlbums.length, 1);
  const [item] = plan.assets;
  assert.equal(item.id, catalogId("asset", digits));
  assert.equal(item.mediaKind, "video");
  assert.equal(item.metadata.description, "A & B 🌊 1 < 2");
  assert.deepEqual(item.metadata.location, { latitude: 0, longitude: -46.633308 });
  assert.deepEqual(item.metadata.capturedAt, { wallTime: "2020-03-02T09:05:06", precision: "second", provenance: "flickr" });
  assert.equal(item.metadata.flickrImportedAt.offsetMinutes, -180);
  assert.equal(item.metadata.flickrRotation, 90);
  assert.deepEqual(new Set(item.tagIds), new Set([catalogId("album", "1"), catalogId("album", "2"), catalogId("keyword", "Outdoors")]));
  assert.ok(!Object.hasOwn(plan.source.memberships, "0"));
});

test("media-first owner edits, independent membership and a confirmed original survive replay", async () => {
  const media = part("media", original(digits));
  const first = await prepare([media]);
  assert.deepEqual(first.preview.mediaOnly, [digits]);
  const saved = await reopen(first.plan);
  const old = saved.base.assets[0];
  old.metadata.title = "My title";
  old.tagIds = ["owner-tag"];
  saved.base.source.ownerFields[digits] = { title: "set", description: "cleared" };
  const meta = part("meta", sidecar(digits, { name: "Export title", description: "Export description",
    tags: [{ tag: "Hidden" }], albums: [{ id: "31", title: "Travel" }] }));
  saved.base.source.memberships[digits] = { [catalogId("keyword", "Hidden")]: { owner: "remove" } };
  const second = await prepare([meta, media], { openObject: saved.openObject }, saved.base);
  const item = second.plan.assets[0];
  assert.deepEqual(item.metadata, { title: "My title" });
  assert.equal(item.id, old.id);
  assert.equal(item.addedAt, old.addedAt);
  assert.deepEqual(item.original, old.original);
  assert.deepEqual(new Set(item.tagIds), new Set(["owner-tag", catalogId("album", "31")]));
  const next = await reopen(second.plan, saved.base, saved.objects);
  const travel = next.base.tags.find(x => x.id === catalogId("album", "31"));
  travel.title = "My trips";
  next.base.source.ownerTagNames[travel.id] = "set";
  const incoming = part("later", albums({ id: "31", title: "Source rename", photos: [] }), original(digits, movie));
  const late = await prepare([incoming], { openObject: next.openObject }, next.base);
  assert.equal(late.preview.ambiguous[0].photoId, digits);
  assert.deepEqual(late.plan.assets[0].original, old.original);
  assert.deepEqual(late.plan.assets[0].tagIds, ["owner-tag"]);
  assert.ok(late.plan.tags.every(t => t.id !== travel.id || t.title === "My trips"));
  const latest = await reopen(late.plan, next.base, next.objects);
  const replay = await prepare([meta, media, incoming], { openObject: latest.openObject }, latest.base);
  assert.deepEqual(replay.plan.uploads, []);
  assert.deepEqual(replay.plan.assets, []);
  assert.deepEqual(replay.plan.tags, []);
  assert.deepEqual(replay.plan.source, null);
});

test("500 synthetic source IDs remain distinct with identical bytes and zero original reads during matching", async () => {
  const originals = [], sidecars = [];
  for (let n = 0; n < 500; n++) {
    const id = String(9007199254740999n + BigInt(n));
    originals.push({ ...original(id), openBytes: () => { throw Error("eager original read"); } });
    sidecars.push(sidecar(id));
  }
  const result = await prepare([part("media", ...originals), part("metadata", ...sidecars)]);
  assert.equal(result.preview.matched.length, 500);
  assert.equal(new Set(result.plan.assets.map(a => a.id)).size, 500);
  assert.ok(result.plan.assets.every(a => a.id === catalogId("asset", a.source.photoId)));
});

test("duplicate member names and conflicting raw variants can be resolved from a fresh base", async () => {
  const pair = part("pair", original("1"), original("1"), sidecar("1", {name:"A"}), sidecar("1", {name:"B"}),
    albums({id:"4", title:"A", photos:["1"]}), albums({id:"4", title:"B", photos:["2"]}));
  const result = await prepare([pair]);
  assert.equal(result.preview.duplicates[0].candidates.length, 2);
  assert.equal(result.preview.photoConflicts[0].id, "1");
  assert.equal(result.preview.albumConflicts[0].id, "4");
  assert.deepEqual(result.plan.assets, []);
  assert.deepEqual(result.plan.source.photos["1"].selected, undefined);
  assert.equal(result.plan.source.photos["1"].variants.length, 2);
  const saved = await reopen(result.plan);
  const decisions = { originals: {1:[pair.partId,1]}, photos: {1:[pair.partId,3]}, albums: {4:[pair.partId,5]} };
  const resolved = await prepare([], {openObject:saved.openObject, decisions}, saved.base);
  assert.equal(resolved.plan.assets[0].metadata.title, "B");
  assert.deepEqual(resolved.plan.assets[0].tagIds, []);
  assert.deepEqual(resolved.preview.albumReferenceOnly, ["2"]);
  assert.equal(resolved.plan.uploads.length, 0);
});

test("invalid inputs, account conflicts, partial saves, cancellation and inert preview bytes", async () => {
  const mixed = part("mixed", original("1"), sidecar("2"), raw("photo-json","photo_3.json",{id:"4"}),
    member("invalid","bad.bin","bad",""), original("0"));
  const first = await prepare([mixed], {decisions: {deferMembers:[[mixed.partId,1]]},
    makePreview: async original => {
      assert.equal(await new Response(await original.openBytes()).arrayBuffer().then(x=>x.byteLength), photo.length);
      return new Blob(["thumbnail"], {type:"image/jpeg"});
    }});
  assert.deepEqual(first.plan.assets.map(a=>a.source.photoId), ["1"]);
  assert.equal(first.plan.assets[0].previews.length, 1);
  assert.ok(first.preview.invalidMetadata.length >= 2);
  assert.equal(first.plan.source.parts[mixed.partId].members[1], "deferred");
  const saved = await reopen(first.plan);
  const second = await prepare([mixed], {openObject:saved.openObject}, saved.base);
  assert.deepEqual(second.preview.metadataOnly, ["2"]);
  assert.deepEqual(second.plan.uploads.map(u=>u.kind), ["photo-json"]);
  const profile = part("profile", raw("account-json", "account_profile.json", {nsid:"123@N01"}), sidecar("1"));
  await assert.rejects(prepare([profile], {binding:{...binding,flickrAccountId:"124@N01"}}), /account/i);
  const bound = await prepare([profile]);
  assert.equal(bound.plan.source.binding.flickrAccountId, "123@N01");
  assert.ok(bound.plan.uploads.every(u => u.kind !== "account-json"));
  await assert.rejects(prepare([mixed], {signal:AbortSignal.abort()}), {name:"AbortError"});
});

test("retains recognized download-only formats and gives scanner diagnostics their exact reason", async () => {
  const media = part("tiff", { ...original("1"), mimeType: "image/tiff" },
    { kind: "invalid", filename: "clip_2_o.mov", error: "unsupported-media" },
    { kind: "invalid", filename: "sidecar.json", error: "unsafe-path" });
  const {plan, preview} = await prepare([media]);
  assert.deepEqual(preview.mediaOnly, ["1"]);
  assert.deepEqual(plan.assets[0].previews, []);
  assert.equal(preview.unsupportedMedia[0].reason, "unsupported-media");
  assert.equal(preview.invalidMetadata[0].reason, "unsafe-path");
});

test("a confirmed link cannot be reassigned by selecting a later candidate", async () => {
  const first = await prepare([part("first", original("1"))]);
  const saved = await reopen(first.plan);
  const different = part("other", original("1", movie));
  await assert.rejects(prepare([different], {openObject:saved.openObject, decisions:{ originals:{ 1:[different.partId,0] }}}, saved.base), /confirmed/i);
});

test("invalid geo and time offsets remain in raw JSON, empty album names get a usable label", async () => {
  const input = part("bad-values", original("5"), sidecar("5", { geo:[{latitude:"91000000",longitude:"0"}],
    date_taken:"2021-01-01 05:00:00+15:00" }), albums({id:"27",title:"",photos:["5"]}));
  const {plan} = await prepare([input]);
  assert.deepEqual(plan.assets[0].metadata, {});
  assert.equal(plan.tags[0].title, "27");
});

test("descriptions decode HTML5 entities and quoted greater-than signs without loading URLs", async () => {
  const input = part("html", original("7"), sidecar("7", {
    description:'<div>A&ccedil;&atilde;o<img alt="a > b" src="https://example.invalid/path"> <b>x</b> &CounterClockwiseContourIntegral;</div><style>a {}</style><div>a&lt;b</div>'
  }));
  const result = await prepare([input]);
  assert.equal(result.plan.assets[0].metadata.description, "Ação x ∳ a<b");
});

test("a known source reuses its pre-existing catalog IDs and a different account has distinct asset IDs", async () => {
  const archive = part("ids", original("02"), sidecar("02",{ tags:[{tag:"Sample"}] }));
  const first = await prepare([archive]);
  const secondBinding = { sourceKey: "other-account", label: "Other" };
  const second = await prepareFlickrImport({...empty,sourceKey:secondBinding.sourceKey},[archive],{binding:secondBinding});
  assert.notEqual(second.plan.assets[0].id, first.plan.assets[0].id);
  const saved = await reopen(first.plan);
  saved.base.source.links["02"].assetId = saved.base.assets[0].id = "legacy";
  const oldTag = saved.base.tags[0].id;
  saved.base.tags[0].id = "legacy-tag";
  saved.base.assets[0].tagIds = ["legacy-tag"];
  saved.base.source.memberships["02"]["legacy-tag"] = saved.base.source.memberships["02"][oldTag];
  delete saved.base.source.memberships["02"][oldTag];
  const update = part("update", albums({id:"9", title:"New", photos:["02"]}));
  const next = await prepare([update], {openObject:saved.openObject}, saved.base);
  assert.equal(next.plan.assets[0].id, "legacy");
  assert.ok(next.plan.assets[0].tagIds.includes("legacy-tag"));
});

test("an ambiguous basename can be resolved on reopen, owner-added membership survives withdrawal", async () => {
  const ambiguousName = "x_11_o_copy_12_o.jpg";
  const input = part("ambiguous", original("11", photo, ambiguousName), sidecar("11", {albums:[{id:"8",title:"Shelf"}]}));
  const first = await prepare([input]);
  assert.equal(first.preview.ambiguous[0].candidates[0].filename, ambiguousName);
  const stored = await reopen(first.plan);
  const resolved = await prepare([], {openObject:stored.openObject, decisions:{originals:{"11":[input.partId,0]}}}, stored.base);
  const selected = await reopen(resolved.plan, stored.base, stored.objects);
  const tag = catalogId("album","8");
  selected.base.source.memberships["11"][tag].owner = "add";
  const withdraw = await prepare([part("withdraw",albums({id:"8",title:"Shelf",photos:[]}))], {openObject:selected.openObject}, selected.base);
  assert.deepEqual(withdraw.plan.source.memberships["11"][tag], {owner:"add"});
  const current = await reopen(withdraw.plan, selected.base, selected.objects);
  assert.deepEqual(current.base.assets[0].tagIds, [tag]);
});

test("cold restore reads one album document once and bounds concurrent storage operations", async () => {
  const input = part("many", ...Array.from({length:18}, (_,i)=>sidecar(String(i+1))),
    albums(...Array.from({length:8}, (_,i)=>({id:String(i+1),title:"Folder",photos:["1"]}))));
  const saved = await reopen((await prepare([input])).plan);
  let active = 0, maximum = 0, albumReads = 0;
  async function openObject(ref) {
    active++;
    maximum = Math.max(maximum, active);
    if (ref.kind === "album-json") albumReads++;
    await new Promise(resolve=>setTimeout(resolve,1));
    active--;
    return saved.openObject(ref);
  }
  const replay = await prepare([], {openObject}, saved.base);
  assert.equal(replay.plan.source, null);
  assert.equal(albumReads, 1);
  assert.ok(maximum > 1 && maximum <= 8);
});

test("a saved original retries preview generation on a capable client without reselection", async () => {
  const first = await prepare([part("preview-later", original("1"))]);
  const saved = await reopen(first.plan);
  const retry = await prepare([], {openObject:saved.openObject, makePreview:async original => {
    assert.equal(hash(Buffer.from(await new Response(await original.openBytes()).arrayBuffer())), hash(photo));
    return new Blob(["preview"], {type:"image/webp"});
  }}, saved.base);
  assert.deepEqual(retry.plan.uploads.map(u=>u.kind), ["preview"]);
  assert.deepEqual(retry.plan.assets[0].original, saved.base.assets[0].original);
  assert.equal(retry.plan.assets[0].previews.length,1);
});

test('projects Flickr photo details and album metadata without changing photo or tag identity', async () => {
  const basePhoto = { photopage: 'https://www.flickr.com/photos/member/42/', license: 'CC BY 2.0',
    comments: [{ id: '7', comment: '<p>Here &amp; there</p><script>bad()</script>', user: '3@N01',
      date: '2023-06-18 09:01:02', url: 'https://www.flickr.com/photos/member/42/#comment7' }],
    notes: [{ text: '<b>Bridge</b>', user: 'https://www.flickr.com/photos/author/',
      date: '2023-06-19 11:00:00', x: '0', y: '4', width: '9', height: '10' }],
    groups: [{ id: '12@N00', name: 'Architecture', url: 'https://www.flickr.com/groups/architecture/' }],
    tags: [{ tag: 'Bridge', user: 'https://www.flickr.com/photos/person1/', date_create: '2023-06-20 12:00:00' },
      { tag: 'Bridge', user: 'https://www.flickr.com/photos/person2/' }] };
  const input = part('flickr-details', original('42'), sidecar('42', basePhoto),
    albums({ id: '12', title: 'Travel', description: '<p>Across &amp; around</p>',
      cover_photo: 'https://www.flickr.com/photos/member/49/', created: '1686902400',
      last_updated: '1686988800', photos: ['42'] }));
  const {plan} = await prepare([input]);
  const item = plan.assets[0], album = plan.tags.find(t => t.source.kind === 'album');
  assert.equal(item.id, catalogId('asset', '42'));
  assert.equal(item.metadata.sourceUrl, basePhoto.photopage);
  assert.equal(item.metadata.license, 'CC BY 2.0');
  assert.deepEqual(item.metadata.comments, [{ id: '7', body: 'Here & there', author: '3@N01',
    createdAt: {wallTime:'2023-06-18T09:01:02', precision:'second', provenance:'flickr'}, sourceUrl: basePhoto.comments[0].url }]);
  assert.deepEqual(item.metadata.annotations, [{ body: 'Bridge', author: basePhoto.notes[0].user,
    createdAt: {wallTime:'2023-06-19T11:00:00', precision:'second', provenance:'flickr'},
    bounds:{x:0,y:4,width:9,height:10} }]);
  assert.deepEqual(item.metadata.groupMemberships, [{id:'12@N00',name:'Architecture',sourceUrl:basePhoto.groups[0].url}]);
  assert.deepEqual(item.metadata.tagAttributions, [
    {tagId:catalogId('keyword','Bridge'), author:basePhoto.tags[0].user,
      createdAt:{wallTime:'2023-06-20T12:00:00',precision:'second',provenance:'flickr'}},
    {tagId:catalogId('keyword','Bridge'), author:basePhoto.tags[1].user},
  ]);
  assert.equal(album.id, catalogId('album','12'));
  assert.deepEqual(album.album, {
    description:'Across & around',
    coverPhoto:{photoId:'49',sourceUrl:'https://www.flickr.com/photos/member/49/'},
    createdAt:{wallTime:'2023-06-16T08:00:00',precision:'second',provenance:'flickr',offsetMinutes:0},
    updatedAt:{wallTime:'2023-06-17T08:00:00',precision:'second',provenance:'flickr',offsetMinutes:0},
  });
});

test('backfills an already published JPEG through a metadata-only plan and replays without extra reads', async () => {
  const input = part('old', original('42'), sidecar('42', {date_taken:'2020-03-02 12:00:00'}));
  const first = await prepare([input]);
  const saved = await reopen(first.plan);
  let reads = 0;
  const readEmbeddedJpeg = async (source) => {
    assert.equal((await new Response(await source.openBytes()).blob()).size, photo.length);
    reads++;
    return { orientation: saved.base.assets[0].metadata.exifOrientation,
      exif: { make: 'Fixture', iso: 100, capturedAt: {wallTime:'2019-04-03T11:22:33',precision:'second',provenance:'exif'} },
      iptc: { caption:'Fixture caption' } };
  };
  const backfill = await prepare([], {openObject:saved.openObject,readEmbeddedJpeg}, saved.base);
  assert.equal(reads, 1);
  assert.deepEqual(backfill.plan.uploads, []);
  assert.equal(backfill.plan.assets[0].id, saved.base.assets[0].id);
  assert.deepEqual(backfill.plan.assets[0].original, saved.base.assets[0].original);
  assert.equal(backfill.plan.assets[0].metadata.capturedAt.provenance,'flickr');
  assert.equal(backfill.plan.assets[0].metadata.embedded.exif.capturedAt.provenance,'exif');
  assert.equal(backfill.plan.assets[0].metadata.embedded.iptc.caption,'Fixture caption');
  const updated = await reopen(backfill.plan, saved.base, saved.objects);
  const replay = await prepare([], {openObject:updated.openObject,readEmbeddedJpeg}, updated.base);
  assert.equal(reads, 1);
  assert.equal(replay.plan.source, null);
});
