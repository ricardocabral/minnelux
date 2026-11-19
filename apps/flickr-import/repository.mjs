import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sourceUrl } from './catalog-metadata.mjs';

// All keys passed to the adapter include the configured prefix. Every reference on disk is relative.
const HASH = /^[a-f0-9]{64}$/;
const ID = /^\d+$/;
const MAX_HEAD = 64 * 1024;
const MAX_MANIFEST = 4 * 1024 * 1024;
const MAX_SNAPSHOT = 128 * 1024 * 1024;
const MAX_RECEIPTS = 64;
const encoder = new TextEncoder();
const own = (object, key) => Object.hasOwn(object, key);
const dict = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const safeSize = n => Number.isSafeInteger(n) && n >= 0;
const isId = value => typeof value === 'string' && ID.test(value);
const validHash = value => typeof value === 'string' && HASH.test(value);
const values = Object.values;
const entries = Object.entries;
const fields = ['title', 'description', 'capturedAt', 'location'];

function fail(code) { throw Object.assign(new Error(code), {code}); }
function check(condition, code = 'invalidPlan') { if (!condition) fail(code); }
function errorCode(error) {
  if (error?.status === 401) return 'expired';
  if (error?.status === 403) return 'denied';
  if (error?.name === 'AbortError') return 'aborted';
  const codes = ['invalidPlan','invalidReference','integrity','unreadableBytes','denied','expired','aborted','storage','corrupt','unsupportedVersion'];
  return codes.includes(error?.code) ? error.code : 'storage';
}
function version(record) {
  check(dict(record) && Number.isInteger(record.version), 'corrupt');
  check(record.version === 1, 'unsupportedVersion');
}
function pathSegments(value) {
  return nonempty(value) && value.split('/').every(s => /^[a-zA-Z0-9._~-]+$/.test(s) && s !== '.' && s !== '..');
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (dict(value)) return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  check(value === null || ['string','boolean'].includes(typeof value) || Number.isFinite(value));
  return JSON.stringify(value);
}
function same(a, b) { return a === b || (a !== undefined && b !== undefined && canonical(a) === canonical(b)); }
async function digest(value) {
  if (value instanceof Blob && value.size > 4 * 1024 * 1024) {
    const hash = sha256.create();
    for (let offset = 0; offset < value.size; offset += 1024 * 1024)
      hash.update(new Uint8Array(await value.slice(offset,offset + 1024 * 1024).arrayBuffer()));
    return bytesToHex(hash.digest());
  }
  const bytes = typeof value === 'string' ? encoder.encode(value) : await value.arrayBuffer();
  const result = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(result, n => n.toString(16).padStart(2,'0')).join('');
}
async function mapBounded(items, apply, parallel = 8) {
  let next = 0, failure;
  async function run() {
    while (!failure && next < items.length) {
      const i = next++;
      try { await apply(items[i], i); } catch (error) { failure = error; }
    }
  }
  await Promise.all(Array.from({length: Math.min(items.length, parallel)}, run));
  if (failure) throw failure;
}
function boundedStream(stream, maximum, code, signal) {
  let total = 0;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      signal?.throwIfAborted();
      check(chunk instanceof Uint8Array, code);
      total += chunk.byteLength;
      check(total <= maximum, code);
      controller.enqueue(chunk);
    },
  }), {signal});
}
async function boundedBlob(stream, maximum, code, signal) {
  return new Response(boundedStream(stream,maximum,code,signal)).blob();
}
async function compressed(value) {
  const json = new Blob([canonical(value)]);
  check(json.size <= MAX_SNAPSHOT);
  return new Response(json.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
async function readJson(blob, gzip = false, signal) {
  check(blob.size <= MAX_SNAPSHOT, 'corrupt');
  try {
    if (gzip) blob = await boundedBlob(blob.stream().pipeThrough(new DecompressionStream('gzip')), MAX_SNAPSHOT, 'corrupt', signal);
    return JSON.parse(await blob.text());
  } catch (error) {
    if (signal?.aborted) fail('aborted');
    fail('corrupt');
  }
}
function sourceDirectory(key) {
  // Encoding opaque source keys as UTF-8 hex keeps every character inside one path segment.
  return 'sources/flickr/' + Array.from(encoder.encode(key), n => n.toString(16).padStart(2, '0')).join('');
}
function objectKey(kind, sha, sourceKey) {
  if (kind === 'original') return 'originals/' + sha;
  if (kind === 'preview') return 'previews/' + sha;
  return sourceDirectory(sourceKey) + '/' + kind + '/' + sha;
}
function descriptor(ref) {
  if (!dict(ref) || !safeSize(ref.byteLength) || !validHash(ref.sha256)) return false;
  switch (ref.kind) {
    case 'original': return /^(image\/(jpeg|png|gif|webp|avif|heif|heic|tiff)|video\/(mp4|webm|quicktime|x-msvideo|3gpp))$/.test(ref.mimeType);
    case 'preview': return ['image/jpeg','image/webp','image/png'].includes(ref.mimeType);
    case 'photo-json': case 'album-json': return ref.mimeType === 'application/json';
    default: return false;
  }
}
function validRef(ref, kind, sourceKey) {
  return descriptor(ref) && ref.kind === kind && ref.root === 'library' &&
    ref.key === objectKey(kind, ref.sha256, sourceKey) &&
    (ref.observedVersion === undefined || nonempty(ref.observedVersion));
}
function references(source, assets) {
  const refs = [];
  for (const asset of assets) refs.push(asset.original, ...asset.previews);
  if (source) {
    for (const item of source.candidates) refs.push(item.original);
    for (const records of [source.photos, source.albums])
      for (const item of values(records)) for (const variant of item.variants) refs.push(variant.raw);
  }
  return new Set(refs.map(canonical));
}
function mapReferences(source, assets, resolve) {
  if (source) {
    for (const candidate of source.candidates) candidate.original = resolve(candidate.original,'original');
    for (const [records, kind] of [[source.photos,'photo-json'],[source.albums,'album-json']])
      for (const item of values(records)) for (const v of item.variants) v.raw = resolve(v.raw,kind);
  }
  for (const asset of assets) {
    asset.original = resolve(asset.original, 'original');
    asset.previews = asset.previews.map(ref => resolve(ref, 'preview'));
  }
}
function buildPostings(assets) {
  const text = Object.create(null), tags = Object.create(null);
  for (const [ordinal, asset] of assets.entries()) {
    const weights = new Map();
    for (const [field, weight] of [[asset.filename,1],[asset.metadata.title,4],[asset.metadata.description,2]]) {
      const terms = (field ?? '').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      for (const term of new Set(terms)) weights.set(term,(weights.get(term) ?? 0) + weight);
    }
    for (const [term,weight] of weights) (text[term] ??= []).push(ordinal,weight);
    for (const id of asset.tagIds) (tags[id] ??= []).push(ordinal);
  }
  return {text, tags};
}
function binding(b, sourceKey) {
  return dict(b) && b.sourceKey === sourceKey && nonempty(sourceKey) && sourceKey.length <= 200 &&
    nonempty(b.label) && (b.flickrAccountId === undefined || nonempty(b.flickrAccountId));
}
function validateSource(source, key) {
  check(dict(source) && source.version === 1 && binding(source.binding,key));
  for (const name of ['parts','photos','albums','links','ownerFields','ownerTagNames','memberships']) check(dict(source[name]));
  check(Array.isArray(source.candidates));
  for (const [part, record] of entries(source.parts)) {
    check(validHash(part) && dict(record) && dict(record.members));
    for (const [ordinal, disposition] of entries(record.members)) {
      check(String(Number(ordinal)) === ordinal && safeSize(Number(ordinal)) && ['stored','ignored','deferred'].includes(disposition));
    }
  }
  function member(id) {
    check(Array.isArray(id) && id.length === 2 && validHash(id[0]) && safeSize(id[1]) &&
      source.parts[id[0]]?.members[id[1]] === 'stored');
    return JSON.stringify(id);
  }
  const candidates = new Map();
  for (const c of source.candidates) {
    const m = member(c.member);
    check(!candidates.has(m) && nonempty(c.filename) && (c.photoId === undefined || isId(c.photoId)) &&
      ['pending','confirmed','duplicate','conflict','rejected'].includes(c.review));
    candidates.set(m,c);
  }
  const stored = new Set(candidates.keys());
  const albumMembers = new Map();
  for (const records of [source.photos,source.albums]) {
    for (const [id,record] of entries(records)) {
      check(isId(id) && dict(record) && Array.isArray(record.variants) && record.variants.length);
      const members = new Set();
      for (const v of record.variants) {
        const m = member(v.member);
        check(!members.has(m));
        if (stored.has(m)) check(records === source.albums && same(albumMembers.get(m),v.raw));
        if (records === source.albums) albumMembers.set(m,v.raw);
        members.add(m);
        stored.add(m);
      }
      if (record.selected !== undefined) check(members.has(member(record.selected)));
    }
  }
  for (const [part,record] of entries(source.parts)) {
    for (const [ordinal,status] of entries(record.members))
      if (status === 'stored') check(stored.has(JSON.stringify([part,Number(ordinal)])));
  }
  for (const [id,flags] of entries(source.ownerFields)) {
    check(isId(id) && dict(flags) && entries(flags).every(([k,v]) => fields.includes(k) && ['set','cleared'].includes(v)));
  }
  check(values(source.ownerTagNames).every(value => value === 'set'));
  const confirmedMembers = new Set();
  for (const [id,link] of entries(source.links)) {
    check(isId(id) && dict(link) && nonempty(link.assetId));
    const m = member(link.member);
    check(!confirmedMembers.has(m));
    confirmedMembers.add(m);
    const candidate = candidates.get(m);
    check(candidate?.review === 'confirmed' && (candidate.photoId === undefined || candidate.photoId === id));
  }
  for (const [m,c] of candidates) if (c.review === 'confirmed') check(confirmedMembers.has(m));
  return candidates;
}
const optional = (value, valid) => value === undefined || valid(value);
const text = value => typeof value === 'string';
const safeUrl = value => typeof value === 'string' && sourceUrl(value) === value;
const positive = value => Number.isFinite(value) && value > 0;
const dateOnly = /^\d{4}-\d\d-\d\d$/;
const wallClock = /^\d\d:\d\d:\d\d(?:[+-]\d\d:\d\d)?$/;

function timestamp(date, provenance) {
  return dict(date) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(date.wallTime) &&
    date.precision === 'second' && (provenance ? date.provenance === provenance : ['flickr','exif'].includes(date.provenance)) &&
    optional(date.offsetMinutes,offset => Number.isInteger(offset) && Math.abs(offset) <= 14 * 60);
}

function validateAlbumMetadata(album) {
  check(dict(album) && optional(album.description, text) &&
    optional(album.createdAt, date => timestamp(date, 'flickr')) &&
    optional(album.updatedAt, date => timestamp(date, 'flickr')));
  if (album.coverPhoto !== undefined) {
    const cover = album.coverPhoto;
    check(dict(cover) && (cover.photoId !== undefined || cover.sourceUrl !== undefined) &&
      optional(cover.photoId, id => isId(id) && id !== '0') && optional(cover.sourceUrl, safeUrl));
  }
}

function validateEmbedded(embedded) {
  check(dict(embedded));
  const {exif, iptc} = embedded;
  if (exif !== undefined) {
    check(dict(exif) && ['make','model','lensMake','lensModel'].every(field => optional(exif[field], nonempty)) &&
      ['exposureSeconds','fNumber','focalLengthMm'].every(field => optional(exif[field], positive)) &&
      optional(exif.iso, iso => Number.isSafeInteger(iso) && iso > 0) &&
      optional(exif.flash, flash => safeSize(flash) && flash <= 0xffff) &&
      ['capturedAt','digitizedAt','modifiedAt'].every(field => optional(exif[field], date => timestamp(date, 'exif'))));
  }
  if (iptc !== undefined) {
    check(dict(iptc) && optional(iptc.caption, text) &&
      ['dateCreated','digitalCreationDate'].every(field => optional(iptc[field], value => text(value) && dateOnly.test(value))) &&
      ['timeCreated','digitalCreationTime'].every(field => optional(iptc[field], value => text(value) && wallClock.test(value))));
  }
}

function validateMetadata(m, tags, sourceKey, mimeType) {
  check(dict(m) && ['title','description','license'].every(k => optional(m[k],text)) && optional(m.sourceUrl,safeUrl));
  if (m.location !== undefined) {
    check(dict(m.location) && Number.isFinite(m.location.latitude) && Math.abs(m.location.latitude) <= 90 &&
      Number.isFinite(m.location.longitude) && Math.abs(m.location.longitude) <= 180);
  }
  if (m.flickrRotation !== undefined) check([0,90,180,270].includes(m.flickrRotation));
  if (m.exifOrientation !== undefined) check(Number.isInteger(m.exifOrientation) && m.exifOrientation >= 1 && m.exifOrientation <= 8);
  check([m.capturedAt,m.flickrImportedAt].every(date => optional(date,timestamp)));
  const rows = (field, valid) => check(optional(m[field], list => Array.isArray(list) && list.every(row => dict(row) && valid(row))));
  const hasAuthorAndDate = row => optional(row.author,nonempty) && optional(row.createdAt,date => timestamp(date,'flickr'));
  rows('comments', row => text(row.body) && hasAuthorAndDate(row) && optional(row.id,nonempty) && optional(row.sourceUrl,safeUrl));
  rows('annotations', row => text(row.body) && hasAuthorAndDate(row) &&
    optional(row.bounds,bounds => dict(bounds) && ['x','y','width','height'].every(field => safeSize(bounds[field]))));
  rows('groupMemberships', row => nonempty(row.id) && optional(row.name,nonempty) && optional(row.sourceUrl,safeUrl));
  rows('tagAttributions', row => {
    const tag = tags.get(row.tagId);
    return tag?.source?.kind === 'keyword' && tag.source.sourceKey === sourceKey && nonempty(row.author) && hasAuthorAndDate(row);
  });
  if (m.embedded !== undefined) {
    check(mimeType === 'image/jpeg');
    validateEmbedded(m.embedded);
  }
}
function indexed(records) {
  const index = new Map();
  for (const record of records) {
    check(dict(record) && nonempty(record.id) && !index.has(record.id));
    index.set(record.id,record);
  }
  return index;
}
async function mergeCatalog(source, updatedAssets, updatedTags, catalog, previous) {
  const key = source.binding.sourceKey;
  const candidates = validateSource(source, key);
  const assets = indexed(catalog.assets), tags = indexed(catalog.tags);
  const identities = new Map();
  for (const a of assets.values()) if (a.source?.sourceKey === key) identities.set(canonical(['asset',a.source.photoId]),a.id);
  for (const t of tags.values()) if (t.source?.sourceKey === key) identities.set(canonical([t.source.kind,t.source.value]),t.id);
  async function identity(record, kind, value, collection) {
    check(record.source?.sourceKey === key);
    const existing = identities.get(canonical([kind,value]));
    const expected = existing ?? 'flickr:' + await digest(JSON.stringify([key,kind,value]));
    check(record.id === expected && (!collection.has(record.id) || existing === record.id));
    collection.set(record.id, record);
  }
  indexed(updatedTags);
  indexed(updatedAssets);
  await mapBounded(updatedTags,async tag => {
    check(nonempty(tag.title) && dict(tag.source) && ['album','keyword'].includes(tag.source.kind));
    check(tag.source.kind === 'album' ? isId(tag.source.value) : nonempty(tag.source.value));
    if (tag.album !== undefined) {
      check(tag.source.kind === 'album');
      validateAlbumMetadata(tag.album);
    }
    if (previous?.ownerTagNames[tag.id]) check(tags.get(tag.id)?.title === tag.title);
    await identity(tag,tag.source.kind,tag.source.value,tags);
  });
  await mapBounded(updatedAssets,async asset => {
    check(dict(asset.source) && isId(asset.source.photoId) && nonempty(asset.filename) &&
      ['photo','video'].includes(asset.mediaKind) && Array.isArray(asset.previews) && Array.isArray(asset.tagIds) &&
      new Set(asset.tagIds).size === asset.tagIds.length && asset.tagIds.every(id => tags.has(id)));
    check(typeof asset.addedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(asset.addedAt) &&
      Number.isFinite(Date.parse(asset.addedAt)));
    validateMetadata(asset.metadata, tags, key, asset.original.mimeType);
    const old = assets.get(asset.id);
    if (old) {
      check(asset.addedAt === old.addedAt && same(asset.original,old.original));
      for (const field of fields) if (previous.ownerFields[asset.source.photoId]?.[field])
        check(same(asset.metadata[field],old.metadata[field]));
      for (const id of old.tagIds) if (tags.get(id)?.source?.sourceKey !== key)
        check(asset.tagIds.includes(id));
    }
    await identity(asset,'asset',asset.source.photoId,assets);
  });
  for (const [id,link] of entries(source.links)) {
    const a = assets.get(link.assetId);
    check(a?.source?.sourceKey === key && a.source.photoId === id && same(a.original,candidates.get(JSON.stringify(link.member)).original));
  }
  for (const asset of assets.values()) if (asset.source?.sourceKey === key) check(source.links[asset.source.photoId]?.assetId === asset.id);
  for (const [id,flags] of entries(source.memberships)) {
    check(isId(id) && dict(flags));
    const asset = assets.get(source.links[id]?.assetId);
    for (const [tagId, m] of entries(flags)) {
      check(tags.has(tagId) && dict(m) && ['inherit','add','remove'].includes(m.owner) &&
        (m.source === undefined || (tags.get(tagId)?.source?.sourceKey === key && ['provisional','authoritative'].includes(m.source))));
      if (asset && (m.owner !== 'inherit' || m.source !== undefined))
        check(asset.tagIds.includes(tagId) === (m.owner === 'add' || (m.owner === 'inherit' && Boolean(m.source))));
    }
  }
  // Preserve catalog order for existing records; append new rows in plan order.
  const merge = (base,updates) => {
    const records = new Map(base.map(r => [r.id,r]));
    for (const row of updates) records.set(row.id,row);
    return [...records.values()];
  };
  return {version:1,assets:merge(catalog.assets,updatedAssets),tags:merge(catalog.tags,updatedTags)};
}
function protectSource(source, old) {
  check(same(source.ownerFields,old?.ownerFields ?? {}) && same(source.ownerTagNames,old?.ownerTagNames ?? {}));
  for (const [id,records] of entries(source.memberships)) {
    for (const [tag,record] of entries(records)) check(record.owner === (old?.memberships[id]?.[tag]?.owner ?? 'inherit'));
  }
  if (!old) return;
  for (const [id,records] of entries(old.memberships)) for (const [tag,record] of entries(records))
    if (record.owner !== 'inherit') check(source.memberships[id]?.[tag]?.owner === record.owner);
  check(!old.binding.flickrAccountId || source.binding.flickrAccountId === old.binding.flickrAccountId);
  for (const [id,link] of entries(old.links)) check(same(source.links[id],link));
  for (const [part,record] of entries(old.parts)) for (const [ordinal,status] of entries(record.members))
    if (status !== 'deferred') check(source.parts[part]?.members[ordinal] === status);
  const candidates = new Map(source.candidates.map(c => [JSON.stringify(c.member),c]));
  for (const prior of old.candidates) {
    const now = candidates.get(JSON.stringify(prior.member));
    check(now && same(now.original,prior.original) && now.filename === prior.filename &&
      (prior.review !== 'confirmed' || now.review === 'confirmed'));
  }
  for (const field of ['photos','albums']) for (const [id,record] of entries(old[field])) {
    const variants = new Map(source[field][id]?.variants.map(v => [JSON.stringify(v.member),v.raw]));
    for (const v of record.variants) check(same(variants.get(JSON.stringify(v.member)),v.raw));
  }
}

export function createFlickrRepository(store, {prefix = 'library', uploadConcurrency = 16, stageUpload} = {}) {
  check(pathSegments(prefix), 'invalidReference');
  const pinned = new Map();
  const get = (key, signal, maxBytes) => store.get(prefix + '/' + key, {signal,maxBytes});
  const put = (key, blob, match, signal) => store.put(prefix + '/' + key, blob, {match, signal});

  async function getReferencedObject(key, signal, byteLength) {
    try {
      return await get(key,signal,byteLength);
    } catch (error) {
      if (error?.code === 'corrupt') fail('integrity');
      throw error;
    }
  }

  async function immutable(key, blob, sha, signal) {
    try {
      return await put(key,blob,'0',signal);
    } catch (error) {
      if (![403,412].includes(error.status)) throw error;
      const existing = await getReferencedObject(key,signal,blob.size);
      if (!existing && error.status === 403) throw error;
      check(existing && existing.body.size === blob.size && await digest(existing.body) === sha,'integrity');
      return {generation:existing.generation};
    }
  }
  async function saveSnapshot(directory, value, signal) {
    const body = await compressed(value);
    const sha256 = await digest(body);
    const key = directory + '/' + sha256 + '.json.gz';
    await immutable(key, body.slice(0,body.size,'application/gzip'),sha256,signal);
    return {key,sha256,byteLength:body.size};
  }
  function verifyDescriptor(ref, expectedKey, maxBytes = MAX_SNAPSHOT) {
    check(dict(ref) && validHash(ref.sha256) && safeSize(ref.byteLength) &&
      ref.byteLength <= maxBytes && ref.key === expectedKey, 'corrupt');
  }
  async function loadJson(ref, gzip, signal) {
    const data = await get(ref.key,signal,ref.byteLength);
    check(data && data.body.size === ref.byteLength && await digest(data.body) === ref.sha256,'corrupt');
    const value = await readJson(data.body,gzip,signal);
    version(value);
    return value;
  }
  async function observe(signal) {
    signal?.throwIfAborted();
    const current = await get('head.json',signal,MAX_HEAD);
    if (!current) return {generation:'0', manifest:null};
    check(current.body.size <= MAX_HEAD,'corrupt');
    const head = await readJson(current.body,false,signal);
    version(head);
    check(/^[0-9a-f-]{36}$/.test(head.revisionId),'corrupt');
    verifyDescriptor(head.manifest,'revisions/' + head.revisionId + '.json',MAX_MANIFEST);
    const manifest = await loadJson(head.manifest,false,signal);
    check(manifest.revisionId === head.revisionId && Array.isArray(manifest.sources) &&
      Array.isArray(manifest.receipts) && manifest.receipts.length <= MAX_RECEIPTS,'corrupt');
    for (const [field,dir] of [['catalog','catalog'],['textIndex','index/text'],['tagIndex','index/tags']]) {
      const ref = manifest[field];
      verifyDescriptor(ref,dir + '/' + ref?.sha256 + '.json.gz');
    }
    const sources = new Set(), accounts = new Set();
    for (const row of manifest.sources) {
      const b = row?.binding;
      check(binding(b,b?.sourceKey) && !sources.has(b.sourceKey),'corrupt');
      sources.add(b.sourceKey);
      if (b.flickrAccountId) {
        check(!accounts.has(b.flickrAccountId),'corrupt');
        accounts.add(b.flickrAccountId);
      }
      verifyDescriptor(row.state,sourceDirectory(b.sourceKey) + '/state/' + row.state?.sha256 + '.json.gz');
    }
    for (const r of manifest.receipts)
      check(dict(r) && sources.has(r.sourceKey) && nonempty(r.operationId) && validHash(r.fingerprint) && nonempty(r.committedRevisionId),'corrupt');
    return {generation:current.generation,manifest};
  }
  const tokenFor = (observed, key) => digest(canonical([store.libraryId ?? '',prefix,key,observed.generation,observed.manifest?.revisionId ?? null]));
  async function materialize(observed,key,signal) {
    const m = observed.manifest;
    const row = m?.sources.find(s => s.binding.sourceKey === key);
    const [catalog,source] = await Promise.all([
      m ? loadJson(m.catalog,true,signal) : {version:1,assets:[],tags:[]},
      row ? loadJson(row.state,true,signal) : null,
    ]);
    try {
      check(Array.isArray(catalog.assets) && Array.isArray(catalog.tags));
      indexed(catalog.assets);
      indexed(catalog.tags);
      const assets = catalog.assets.filter(a => a.source?.sourceKey === key);
      const tags = catalog.tags.filter(t => t.source?.sourceKey === key);
      if (source) {
        check(same(row.binding,source.binding));
        mapReferences(source,assets,(ref,kind) => { check(validRef(ref,kind,key)); return ref; });
        await mergeCatalog(source,assets,tags,catalog,source);
      } else check(!assets.length && !tags.length);
      return {catalog,source,assets,tags,refs:references(source,assets)};
    } catch { fail('corrupt'); }
  }
  async function readFlickrImport(key, signal) {
    try {
      check(nonempty(key) && key.length <= 200,'invalidPlan');
      const observed = await observe(signal);
      const baseToken = await tokenFor(observed,key);
      const {source,assets,tags,refs} = await materialize(observed,key,signal);
      pinned.set(baseToken,{key,refs});
      return {version:1,sourceKey:key,revisionId:observed.manifest?.revisionId ?? null,baseToken,source,assets,tags,
        receipts:observed.manifest?.receipts.filter(r => r.sourceKey === key) ?? []};
    } catch (error) { fail(errorCode(error)); }
  }
  async function openImportObject(baseToken,ref,signal) {
    try {
      const pin = pinned.get(baseToken);
      check(pin && validRef(ref,ref?.kind,pin.key) && pin.refs.has(canonical(ref)),'invalidReference');
      const stored = await getReferencedObject(ref.key,signal,ref.byteLength);
      check(stored && (!ref.observedVersion || ref.observedVersion === stored.generation) &&
        stored.body.size === ref.byteLength && await digest(stored.body) === ref.sha256,'integrity');
      return stored.body.stream();
    } catch (error) { fail(errorCode(error)); }
  }
  async function listFlickrSources(signal) {
    try {
      const {manifest} = await observe(signal);
      return manifest?.sources.map(row => row.binding) ?? [];
    } catch (error) { fail(errorCode(error)); }
  }
  async function storeUpload(upload,ref,rawIds,signal) {
    let staged;
    try {
      let blob;
      try {
        const bytes = boundedStream(await upload.openBytes(signal),upload.byteLength,'integrity',signal);
        staged = stageUpload && upload.byteLength > 16 * 1024 ** 2
          ? await stageUpload(bytes,ref.mimeType,signal) : undefined;
        blob = staged?.body ?? await new Response(bytes).blob();
      } catch (error) {
        if (error.code === 'integrity' || errorCode(error) === 'aborted') throw error;
        fail('unreadableBytes');
      }
      check(blob.size === ref.byteLength && await digest(blob) === ref.sha256,'integrity');
      if (rawIds) {
        let json;
        try { json = JSON.parse(await blob.text()); } catch { fail('invalidPlan'); }
        if (ref.kind === 'album-json') check(Array.isArray(json?.albums));
        const ids = ref.kind === 'photo-json' ? [json?.id] : json.albums.map(a => a?.id);
        const present = new Set(ids);
        for (const id of rawIds) check(present.has(id));
      }
      const result = await immutable(ref.key,blob.slice(0,blob.size,ref.mimeType),ref.sha256,signal);
      ref.observedVersion = result.generation;
    } finally {
      await staged?.dispose();
    }
  }
  async function publishFlickrImport(input,{mode='publish',signal,onProgress} = {}) {
    const unknown = code => ({status:'outcomeUnknown',operationId:input.operationId,...(code ? {code} : {})});
    const stale = () => mode === 'recover' ? unknown() : {status:'stale'};
    let stage = 'validate';
    try {
      check(dict(input) && input.version === 1 && nonempty(input.sourceKey) && input.sourceKey.length <= 200 &&
        nonempty(input.baseToken) && nonempty(input.operationId) && ['recover','publish'].includes(mode));
      check([input.assets,input.tags,input.uploads].every(Array.isArray));
      const {uploads:inputs,...intent} = input;
      const plan = structuredClone(intent);
      const uploads = inputs.map(u => {
        check(descriptor(u) && nonempty(u.uploadId) && typeof u.openBytes === 'function');
        return {...u};
      });
      const fingerprint = await digest(canonical({...plan,uploads:uploads.map(({openBytes,...descriptor}) => descriptor)}));
      const receipt = manifest => {
        const r = manifest?.receipts.find(r => r.sourceKey === plan.sourceKey && r.operationId === plan.operationId);
        if (!r) return null;
        if (r.fingerprint !== fingerprint) return {status:'failed',code:'invalidPlan'};
        return {status:'published',revisionId:r.committedRevisionId};
      };
      stage = 'observe';
      const observed = await observe(signal);
      const m = observed.manifest;
      const seen = receipt(m);
      if (seen) return seen;
      if (await tokenFor(observed,plan.sourceKey) !== plan.baseToken) return stale();
      stage = 'prepare';
      const unchanged = {status:'unchanged',revisionId:m?.revisionId ?? null};
      if (plan.source === null) {
        check(!plan.assets.length && !plan.tags.length && !uploads.length);
        return unchanged;
      }
      stage = 'read';
      const base = await materialize(observed,plan.sourceKey,signal);
      stage = 'prepare';
      validateSource(plan.source,plan.sourceKey);
      const account = plan.source.binding.flickrAccountId;
      if (account) check(!m?.sources.some(row => row.binding.sourceKey !== plan.sourceKey && row.binding.flickrAccountId === account));
      const byUpload = new Map(), used = new Set();
      for (const {uploadId,kind,mimeType,byteLength,sha256} of uploads) {
        check(!byUpload.has(uploadId));
        byUpload.set(uploadId,{kind,mimeType,byteLength,sha256,root:'library',key:objectKey(kind,sha256,plan.sourceKey)});
      }
      const oldByKey = new Map();
      for (const text of base.refs) { const r = JSON.parse(text); oldByKey.set(r.key,r); }
      // One album member can supply many album records. Parse each new upload only once.
      const rawIds = new Map();
      for (const field of ['photos','albums']) {
        for (const [id,record] of entries(plan.source[field])) {
          const previouslyLinked = new Set(base.source?.[field][id]?.variants.map(v => canonical(v.raw)));
          for (const {raw} of record.variants) {
            if (raw?.uploadId) {
              if (!rawIds.has(raw.uploadId)) rawIds.set(raw.uploadId,new Set());
              rawIds.get(raw.uploadId).add(id);
            } else check(previouslyLinked.has(canonical(raw)), 'invalidReference');
          }
        }
      }
      mapReferences(plan.source,plan.assets,(input,kind) => {
        check(dict(input),'invalidReference');
        if (own(input,'uploadId')) {
          const ref = byUpload.get(input.uploadId);
          check(Object.keys(input).length === 1 && ref?.kind === kind,'invalidReference');
          used.add(input.uploadId);
          if (oldByKey.has(ref.key)) ref.observedVersion = oldByKey.get(ref.key).observedVersion;
          return ref;
        }
        check(validRef(input,kind,plan.sourceKey) && base.refs.has(canonical(input)),'invalidReference');
        return input;
      });
      check(used.size === uploads.length);
      protectSource(plan.source,base.source);
      const catalog = await mergeCatalog(plan.source,plan.assets,plan.tags,base.catalog,base.source);
      // Pool sizes bound memory while allowing small sidecars to overlap cloud round trips.
      let completed = 0;
      const uploadOne = async u => {
        await storeUpload(u,byUpload.get(u.uploadId),rawIds.get(u.uploadId),signal);
        completed++;
        onProgress?.({phase:'uploading',completed,total:uploads.length});
      };
      const MiB = 1024 * 1024;
      stage = 'store';
      const parallel = Math.min(64, Math.max(1, Math.trunc(uploadConcurrency) || 16));
      await mapBounded(uploads.filter(u => u.byteLength <= MiB),uploadOne,parallel);
      await mapBounded(uploads.filter(u => u.byteLength > MiB && u.byteLength <= 16 * MiB),uploadOne,4);
      await mapBounded(uploads.filter(u => u.byteLength > 16 * MiB),uploadOne,1);
      if (same(plan.source,base.source) && same(catalog,base.catalog)) return unchanged;
      const revisionId = crypto.randomUUID();
      const catalogChanged = !m || !same(catalog,base.catalog);
      const indexes = catalogChanged ? buildPostings(catalog.assets) : null;
      const [catalogRef,textIndex,tagIndex,state] = await Promise.all([
        catalogChanged ? saveSnapshot('catalog',catalog,signal) : m.catalog,
        catalogChanged ? saveSnapshot('index/text',{version:1,postings:indexes.text},signal) : m.textIndex,
        catalogChanged ? saveSnapshot('index/tags',{version:1,postings:indexes.tags},signal) : m.tagIndex,
        saveSnapshot(sourceDirectory(plan.sourceKey) + '/state',plan.source,signal),
      ]);
      const sources = (m?.sources ?? []).filter(s => s.binding.sourceKey !== plan.sourceKey);
      sources.push({binding:plan.source.binding,state});
      const receipts = [...(m?.receipts ?? []),{sourceKey:plan.sourceKey,operationId:plan.operationId,fingerprint,committedRevisionId:revisionId}].slice(-MAX_RECEIPTS);
      const manifest = {version:1,revisionId,parentRevisionId:m?.revisionId ?? null,catalog:catalogRef,textIndex,tagIndex,indexVersion:1,tokenizerVersion:1,sources,receipts};
      const body = new Blob([canonical(manifest)],{type:'application/json'});
      check(body.size <= MAX_MANIFEST);
      const manifestRef = {key:'revisions/' + revisionId + '.json',sha256:await digest(body),byteLength:body.size};
      await immutable(manifestRef.key,body,manifestRef.sha256,signal);
      signal?.throwIfAborted();
      const head = new Blob([canonical({version:1,revisionId,manifest:manifestRef})],{type:'application/json'});
      try {
        await put('head.json',head,observed.generation,signal);
        return {status:'published',revisionId};
      } catch (error) {
        if ([400,401,403,404,413,422].includes(error.status)) throw error;
        try {
          const latest = await observe(signal);
          const resolved = receipt(latest.manifest);
          if (resolved) return resolved;
          return error.status === 412 ? stale() : unknown(errorCode(error));
        } catch (recheck) {
          return unknown(errorCode(recheck));
        }
      }
    } catch (error) {
      const malformed = stage === 'validate' || (stage === 'prepare' && error instanceof TypeError);
      const code = malformed ? 'invalidPlan' : errorCode(error);
      return mode === 'recover' && stage === 'observe' ? unknown(code) : {status:'failed',code};
    }
  }
  return {listFlickrSources,readFlickrImport,openImportObject,publishFlickrImport};
}
