import { albumMetadata, metadataFor, tagAttribution } from "./catalog-metadata.mjs";

const digits = value => typeof value === "string" && /^\d+$/.test(value);
const usableId = value => digits(value) && value !== "0";
const digestPattern = /^[0-9a-f]{64}$/;
const sameMember = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
const memberKey = ([part, ordinal]) => part + "/" + ordinal;
const editableFields = ["title", "description", "capturedAt", "location"];
const list = value => Array.isArray(value) ? value : [];
const progress = (fn, completed, total) => fn?.({ phase: "preparing", completed, total });
async function digest(data) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
const newId = async (sourceKey, kind, value) => "flickr:" +
  await digest(new TextEncoder().encode(JSON.stringify([sourceKey, kind, value])));

// The catalog and source state contain JSON records. Property order can change across providers.
function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
}

function sourceBinding(base, requested, parts) {
  if (base.version !== 1 || (base.source && base.source.version !== 1)) throw Error("Unsupported import format");
  const binding = base.source?.binding ?? requested;
  if (!binding?.label || !binding.sourceKey || binding.sourceKey !== base.sourceKey ||
      (requested && requested.sourceKey !== base.sourceKey)) throw Error("Select a matching Flickr source account");
  const evidence = new Set();
  for (const id of [binding.flickrAccountId, requested?.flickrAccountId]) if (id) evidence.add(id);
  for (const { members } of parts) {
    for (const entry of members) {
      if (entry.kind === "account-json" && entry.json && Object.hasOwn(entry.json, "nsid")) {
        if (typeof entry.json.nsid !== "string" || !/^\d+@N\d+$/.test(entry.json.nsid)) throw Error("Invalid Flickr account identity");
        evidence.add(entry.json.nsid);
      }
    }
  }
  if (evidence.size > 1) throw Error("Conflicting Flickr account identities");
  const [flickrAccountId] = evidence;
  return { sourceKey: binding.sourceKey, label: binding.label, ...(flickrAccountId && { flickrAccountId }) };
}

function validPhoto(entry) {
  const id = /^photo_(\d+)\.json$/i.exec(entry.filename)?.[1], photo = entry.json;
  return usableId(id) && photo?.id === id &&
    ["name", "description"].every(k => photo[k] === undefined || typeof photo[k] === "string") &&
    ["albums", "tags"].every(k => photo[k] === undefined || Array.isArray(photo[k]));
}
function validAlbum(album) {
  return usableId(album?.id) && typeof album.title === "string" && Array.isArray(album.photos) && album.photos.every(digits);
}
function filenameId(name) {
  const id = /_(\d+)_o\.[^./]+$/i.exec(name)?.[1];
  return usableId(id) && [...name.matchAll(/_\d+_o(?=[_.]|$)/gi)].length === 1 ? id : undefined;
}
function addVariant(table, id, member, raw) {
  (table[id] ??= { variants: [] }).variants.push({ member, raw });
}

function collect(parts, source, decisions, uploads, local, preview) {
  const deferred = new Set(list(decisions.deferMembers).map(memberKey));
  for (const { partId, members } of parts) {
    if (!digestPattern.test(partId)) throw Error("Invalid ZIP part identity");
    const dispositions = (source.parts[partId] ??= { members: {} }).members;
    const ordinals = new Set();
    for (const entry of members) {
      const ordinal = entry.entryOrdinal, member = [partId, ordinal], key = memberKey(member);
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinals.has(ordinal)) throw Error("Invalid ZIP member ordinal");
      ordinals.add(ordinal);
      local.set(key, entry);
      const diagnostic = { member, filename: entry.filename };
      const issue = (reason, category = "invalidMetadata") => preview[category].push({ ...diagnostic, reason });
      const isAlbum = entry.kind === "album-json", isPhoto = entry.kind === "photo-json";
      let acceptedAlbums = [];
      if (entry.kind === "invalid" || entry.kind === "unsupported" || entry.kind === "unsupported-media") {
        const reason = entry.error ?? entry.reason ?? entry.code ?? "unreadable";
        const unsupported = entry.kind !== "invalid" || reason === "unsupported-media";
        issue(reason, unsupported ? "unsupportedMedia" : "invalidMetadata");
        dispositions[ordinal] ??= "deferred";
        continue;
      }
      if (dispositions[ordinal] === "stored" || dispositions[ordinal] === "ignored") continue;
      if (deferred.has(key)) { dispositions[ordinal] = "deferred"; continue; }
      if (isAlbum) {
        if (!Array.isArray(entry.json?.albums)) {
          issue("invalid-album-document");
        } else {
          const counts = new Map();
          for (const album of entry.json.albums) counts.set(album?.id, (counts.get(album?.id) ?? 0) + 1);
          acceptedAlbums = entry.json.albums.filter(album => validAlbum(album) && counts.get(album.id) === 1);
          if (acceptedAlbums.length < entry.json.albums.length) issue("invalid-or-repeated-album");
        }
      }
      if (isPhoto && !validPhoto(entry)) {
        issue("invalid-photo-sidecar");
        dispositions[ordinal] = "deferred";
        continue;
      }
      if (isAlbum && !acceptedAlbums.length) {
        dispositions[ordinal] = "deferred";
        continue;
      }
      if (!isPhoto && !isAlbum && entry.kind !== "original") { dispositions[ordinal] = "ignored"; continue; }
      if (entry.kind === "original" && !/^(image\/(jpeg|png|gif|webp|avif|heif|heic|tiff)|video\/(mp4|webm|quicktime|x-msvideo|3gpp))$/.test(entry.mimeType)) {
        issue("unsupported-media", "unsupportedMedia"); dispositions[ordinal] = "deferred"; continue;
      }
      if (entry.kind === "original" && /_0_o\.[^./]+$/i.test(entry.filename)) {
        issue("reserved-photo-id"); dispositions[ordinal] = "ignored"; continue;
      }
      if (!digestPattern.test(entry.sha256) || !Number.isSafeInteger(entry.byteLength) ||
          entry.byteLength < 0 || typeof entry.openBytes !== "function") {
        issue("unverified-member"); dispositions[ordinal] = "deferred"; continue;
      }
      const upload = { uploadId: key, kind: entry.kind, sha256: entry.sha256,
        byteLength: entry.byteLength, mimeType: entry.mimeType, openBytes: async signal => entry.openBytes(signal) };
      uploads.set(key, upload);
      const ref = { uploadId: key };
      if (isPhoto) addVariant(source.photos, entry.json.id, member, ref);
      else if (isAlbum) for (const album of acceptedAlbums) addVariant(source.albums, album.id, member, ref);
      else {
        const photoId = filenameId(entry.filename);
        source.candidates.push({ member, filename: entry.filename, ...(photoId && { photoId }), original: ref, review: "pending" });
      }
      dispositions[ordinal] = "stored";
    }
  }
}

async function selectRecord(id, record, kind, requested, rawJson) {
  if (requested && !record.variants.some(v => sameMember(v.member, requested))) throw Error("Unknown source record choice");
  let first, chosen, conflict = false;
  for (const [index, variant] of record.variants.entries()) {
    const payload = await rawJson(variant);
    const value = kind === "album" ? payload.albumIndex.get(id) : payload.json;
    if (!value) throw Error("Invalid stored Flickr source record");
    if (index === 0) first = value;
    else if (!equal(first, value)) conflict = true;
    if (sameMember(requested ?? record.selected, variant.member)) chosen = value;
  }
  if (requested) record.selected = requested;
  if (!conflict && !record.selected) {
    record.selected = record.variants[0].member;
    chosen = first;
  }
  return { id, chosen, conflict };
}

async function selectRecords(records, kind, decisions, conflicts, rawJson) {
  for (const id of Object.keys(decisions ?? {})) {
    if (!Object.hasOwn(records, id)) throw Error("Unknown source record choice");
  }
  const selected = new Map();
  const entries = Object.entries(records);
  // Raw sources may be individual private objects. Bound reads and preserve order on cold restore.
  for (let start = 0; start < entries.length; start += 8) {
    const batch = entries.slice(start, start + 8);
    const results = await Promise.all(batch.map(([id, record]) => selectRecord(id, record, kind, decisions?.[id], rawJson)));
    for (const { id, chosen, conflict } of results) {
      if (chosen) selected.set(id, chosen);
      if (conflict) {
        const record = records[id];
        conflicts.push({ id, members: record.variants.map(v => v.member), ...(record.selected && { selected: record.selected }) });
      }
    }
  }
  return selected;
}

async function applyMemberships(source, photos, albums, baseTags, preview) {
  const previousTags = new Map(baseTags.map(t => [JSON.stringify([t.source?.kind, t.source?.value]), t]));
  const tags = new Map(), desired = new Map(), attributions = new Map();
  const sourceKey = source.binding.sourceKey;
  async function tag(kind, value, title) {
    const key = JSON.stringify([kind, value]);
    if (!tags.has(key)) {
      const old = previousTags.get(key), id = old?.id ?? await newId(sourceKey, kind, value);
      tags.set(key, { id, title: source.ownerTagNames[id] === "set" ? old.title : title || value, source: { sourceKey, kind, value } });
    }
    return tags.get(key).id;
  }
  function attach(photoId, tagId, origin) {
    if (!desired.has(photoId)) desired.set(photoId, new Map());
    desired.get(photoId).set(tagId, origin);
  }
  const albumEdges = new Map();
  for (const [id, album] of albums) {
    const tagId = await tag("album", id, album.title);
    const details = albumMetadata(album);
    if (Object.keys(details).length) tags.get(JSON.stringify(["album", id])).album = details;
    for (const photoId of new Set(album.photos)) {
      if (!usableId(photoId)) continue;
      if (!albumEdges.has(photoId)) albumEdges.set(photoId, new Set());
      albumEdges.get(photoId).add(id);
      attach(photoId, tagId, "authoritative");
    }
  }
  for (const [photoId, photo] of photos) {
    const listed = new Set();
    const authoritative = albumEdges.get(photoId);
    for (const album of list(photo.albums)) {
      if (!usableId(album?.id)) {
        preview.unresolvedAlbums.push({ photoId, title: typeof album?.title === "string" ? album.title : "" });
      } else if (!listed.has(album.id)) {
        listed.add(album.id);
        if (!Object.hasOwn(source.albums, album.id)) {
          attach(photoId, await tag("album", album.id, typeof album.title === "string" ? album.title : album.id), "provisional");
        } else if (albums.has(album.id) && !authoritative?.has(album.id)) {
          preview.albumDisagreements.push({ photoId, albumId: album.id });
        }
      }
    }
    if (Array.isArray(photo.albums)) for (const id of authoritative ?? []) {
      if (!listed.has(id)) preview.albumDisagreements.push({ photoId, albumId: id });
    }
    const attributed = [];
    for (const item of list(photo.tags)) {
      if (typeof item?.tag === "string" && item.tag.trim()) {
        const tagId = await tag("keyword", item.tag, item.tag);
        attach(photoId, tagId, "authoritative");
        const entry = tagAttribution(tagId, item);
        if (entry) attributed.push(entry);
      }
    }
    if (attributed.length) attributions.set(photoId, attributed);
  }
  for (const photoId of new Set([...Object.keys(source.memberships), ...desired.keys()])) {
    const before = source.memberships[photoId] ?? {}, after = {};
    for (const [id, membership] of Object.entries(before)) {
      if (membership.owner !== "inherit") after[id] = { owner: membership.owner };
    }
    for (const [id, origin] of desired.get(photoId) ?? []) after[id] = { source: origin, owner: before[id]?.owner ?? "inherit" };
    if (Object.keys(after).length) source.memberships[photoId] = after;
    else delete source.memberships[photoId];
  }
  return { tags: [...tags.values()], albumEdges, attributions };
}

function groupMedia(source, decisions, descriptor, preview) {
  const byMember = new Map(source.candidates.map(c => [memberKey(c.member), c]));
  const choices = new Map();
  for (const [id, member] of Object.entries(decisions.originals ?? {})) {
    const key = memberKey(member), candidate = byMember.get(key);
    if (!usableId(id) || !candidate || (candidate.photoId && candidate.photoId !== id) || choices.has(key)) {
      throw Error("Invalid original choice");
    }
    if (source.links[id] && !sameMember(source.links[id].member, member)) throw Error("Original is already confirmed");
    candidate.photoId = id;
    choices.set(key, id);
  }
  const describe = c => ({ member: c.member, filename: c.filename, sha256: descriptor(c.original).sha256 });
  const groups = new Map(), linked = new Map();
  for (const c of source.candidates) {
    if (!c.photoId) {
      preview.ambiguous.push({ candidates: [describe(c)] });
      continue;
    }
    if (!groups.has(c.photoId)) groups.set(c.photoId, []);
    groups.get(c.photoId).push(c);
  }
  for (const [id, candidates] of groups) {
    const choice = decisions.originals?.[id] ?? source.links[id]?.member;
    const viable = candidates.filter(c => c.review !== "rejected");
    const selected = choice ? candidates.find(c => sameMember(c.member, choice)) : viable.length === 1 ? viable[0] : undefined;
    const seen = new Set(viable.map(c => descriptor(c.original).sha256));
    if (seen.size < viable.length) preview.duplicates.push({ photoId: id, candidates: viable.map(describe) });
    if (seen.size > 1) preview.ambiguous.push({ photoId: id, candidates: viable.map(describe) });
    for (const c of candidates) {
      if (c === selected) c.review = "confirmed";
      else if (c.review !== "rejected") {
        const sameBytes = selected ? descriptor(selected.original).sha256 === descriptor(c.original).sha256 : seen.size === 1;
        c.review = sameBytes ? "duplicate" : "conflict";
      }
    }
    if (selected) linked.set(id, selected);
  }
  return { groups, linked };
}

function activeTags(old, prior, current) {
  const active = new Set(old?.tagIds ?? []);
  for (const id of Object.keys(prior ?? {})) active.delete(id);
  for (const [id, state] of Object.entries(current ?? {})) {
    if (state.owner === "add" || (state.source && state.owner !== "remove")) active.add(id);
    else active.delete(id);
  }
  return [...active].sort();
}

// Builds a local preview and a complete candidate plan against a pinned repository base.
// Publication and retries use the returned plan, including its original operation ID.
export async function prepareFlickrImport(base, parts, {
  binding, openObject, makePreview, readEmbeddedJpeg, operationId = crypto.randomUUID(), decisions = {}, signal, onProgress,
} = {}) {
  signal?.throwIfAborted();
  const account = sourceBinding(base, binding, parts);
  const source = base.source ? structuredClone(base.source) : { version: 1, parts: {}, photos: {}, albums: {},
    candidates: [], links: {}, ownerFields: {}, ownerTagNames: {}, memberships: {} };
  source.binding = account;
  const preview = { matched: [], metadataOnly: [], mediaOnly: [], albumReferenceOnly: [], ambiguous: [], duplicates: [],
    invalidMetadata: [], unsupportedMedia: [], albumDisagreements: [], unresolvedAlbums: [], photoConflicts: [],
    albumConflicts: [], previewErrors: [], embeddedMetadataErrors: [] };
  const local = new Map(), uploads = new Map(), opened = new Map();
  collect(parts, source, decisions, uploads, local, preview);
  async function readSource(member, raw) {
    const entry = local.get(memberKey(member));
    // A reselected archive can supply already-verified JSON without a storage read.
    const useEntry = entry?.json && (raw.uploadId || entry.sha256 === raw.sha256);
    const json = useEntry ? entry.json : await new Response(await openObject(raw, signal)).json();
    const albumIndex = (raw.kind ?? entry?.kind) === "album-json"
      ? new Map(list(json.albums).filter(validAlbum).map(a => [a.id, a])) : undefined;
    return { json, albumIndex };
  }
  function rawJson({ member, raw }) {
    signal?.throwIfAborted();
    const key = memberKey(member);
    if (!opened.has(key)) opened.set(key, readSource(member, raw));
    return opened.get(key);
  }
  const photos = await selectRecords(source.photos, "photo", decisions.photos, preview.photoConflicts, rawJson);
  const albums = await selectRecords(source.albums, "album", decisions.albums, preview.albumConflicts, rawJson);
  const { tags, albumEdges, attributions } = await applyMemberships(source, photos, albums, base.tags, preview);
  const descriptor = ref => ref.uploadId ? uploads.get(ref.uploadId) : ref;
  const { groups, linked } = groupMedia(source, decisions, descriptor, preview);
  const existing = new Map(base.assets.map(a => [a.source.photoId, a]));
  const assets = [], addedAt = new Date().toISOString();
  const ids = [...new Set([...groups.keys(), ...photos.keys(), ...albumEdges.keys()])].sort();
  progress(onProgress, 0, ids.length);
  for (const [index, id] of ids.entries()) {
    signal?.throwIfAborted();
    const photo = photos.get(id), candidate = linked.get(id), old = existing.get(id);
    if (!groups.has(id)) preview[photo ? "metadataOnly" : "albumReferenceOnly"].push(id);
    else if (candidate && groups.get(id).length === 1) preview[photo ? "matched" : "mediaOnly"].push(id);
    if (candidate) {
      const info = descriptor(candidate.original);
      const localEntry = local.get(memberKey(candidate.member));
      const sameOriginal = old && sameMember(base.source?.links[id]?.member, candidate.member);
      const metadata = metadataFor(photo);
      const tagAttributions = attributions.get(id);
      if (tagAttributions) metadata.tagAttributions = tagAttributions;
      const originalInput = { filename: candidate.filename, mimeType: info.mimeType, byteLength: info.byteLength,
        sha256: info.sha256, openBytes: async s => localEntry?.openBytes ? localEntry.openBytes(s) : openObject(candidate.original, s) };
      let jpeg = localEntry?.jpegMetadata;
      if (info.mimeType === "image/jpeg" && !jpeg && !old?.metadata.embedded && readEmbeddedJpeg) {
        try {
          jpeg = await readEmbeddedJpeg(originalInput, signal);
          signal?.throwIfAborted();
        } catch (error) {
          signal?.throwIfAborted();
          if (error.name === "AbortError") throw error;
          preview.embeddedMetadataErrors.push({ photoId: id, member: candidate.member, reason: "jpeg-metadata-unavailable" });
        }
      }
      if (jpeg) {
        metadata.embedded = { ...(jpeg.exif && { exif: jpeg.exif }), ...(jpeg.iptc && { iptc: jpeg.iptc }) };
      } else if (sameOriginal && old.metadata.embedded) {
        metadata.embedded = old.metadata.embedded;
      }
      const orientation = jpeg?.orientation ?? localEntry?.exifOrientation ?? (sameOriginal ? old.metadata.exifOrientation : undefined);
      if (Number.isInteger(orientation) && orientation >= 1 && orientation <= 8) metadata.exifOrientation = orientation;
      for (const field of editableFields) {
        const override = source.ownerFields[id]?.[field];
        if (override === "set" && old && Object.hasOwn(old.metadata, field)) metadata[field] = old.metadata[field];
        else if (override) delete metadata[field];
      }
      const assetId = old?.id ?? source.links[id]?.assetId ?? await newId(account.sourceKey, "asset", id);
      source.links[id] = { assetId, member: candidate.member };
      const item = { id: assetId, source: { sourceKey: account.sourceKey, photoId: id }, original: candidate.original,
        filename: candidate.filename, mediaKind: info.mimeType.startsWith("video/") ? "video" : "photo",
        addedAt: old?.addedAt ?? addedAt, previews: sameOriginal ? old.previews : [], metadata,
        tagIds: activeTags(old, base.source?.memberships[id], source.memberships[id]) };
      const transformChanged = sameOriginal && (old.metadata.flickrRotation !== metadata.flickrRotation ||
        old.metadata.exifOrientation !== metadata.exifOrientation);
      if (transformChanged) item.previews = [];
      if (makePreview && !item.previews.length) {
        try {
          const blob = await makePreview(originalInput, metadata, signal);
          signal?.throwIfAborted();
          if (blob) {
            if (!["image/jpeg", "image/png", "image/webp"].includes(blob.type)) throw Error("Unsupported preview type");
            const uploadId = "preview/" + assetId;
            uploads.set(uploadId, { uploadId, kind: "preview", mimeType: blob.type, byteLength: blob.size,
              sha256: await digest(await blob.arrayBuffer()), openBytes: async s => { s?.throwIfAborted(); return blob.stream(); } });
            item.previews = [{ uploadId }];
          }
        } catch (error) {
          signal?.throwIfAborted();
          if (error.name === "AbortError") throw error;
          preview.previewErrors.push({ photoId: id, member: candidate.member, reason: "preview-unavailable" });
        }
      }
      if (!equal(old, item)) assets.push(item);
    }
    if ((index + 1) % 100 === 0 || index === ids.length - 1) progress(onProgress, index + 1, ids.length);
  }
  signal?.throwIfAborted();
  const beforeTags = new Map(base.tags.map(t => [t.id, t]));
  const changedTags = tags.filter(t => !equal(beforeTags.get(t.id), t));
  const changed = (base.source || Object.keys(source.parts).length) && !equal(source, base.source);
  const plan = { version: 1, sourceKey: account.sourceKey, baseToken: base.baseToken, operationId,
    source: changed || assets.length || changedTags.length ? source : null, assets, tags: changedTags, uploads: [...uploads.values()] };
  return { preview, plan };
}
