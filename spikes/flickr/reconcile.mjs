const sourceIdPattern = /^\d+$/;
const identity = (sourceKey, kind, value) => JSON.stringify([sourceKey, kind, value]);

// Returns an import preview and structured-cloneable reconciliation state for one source account.
export async function reconcile(sourceKey, part, previous) {
  if (previous && previous.sourceKey !== sourceKey) {
    throw new Error("Flickr import state belongs to a different source account");
  }

  const source = {
    sidecars: { ...previous?.source.sidecars },
    albums: { ...previous?.source.albums },
    media: { ...previous?.source.media },
    invalidMetadata: [...(previous?.source.invalidMetadata ?? [])],
  };
  for (const { name, json } of part.sidecars ?? []) {
    const sourceId = /^photo_(\d+)\.json$/.exec(name)?.[1];
    if (sourceId && sourceId === json?.id) {
      source.sidecars[sourceId] = json;
    } else if (!source.invalidMetadata.includes(name)) {
      source.invalidMetadata.push(name);
    }
  }
  for (const album of part.albums ?? []) {
    if (typeof album.id === "string" && sourceIdPattern.test(album.id)) {
      source.albums[album.id] = album;
    }
  }
  for (const [position, media] of (part.media ?? []).entries()) {
    const key = JSON.stringify([part.id, position, media.name]);
    if (!Object.hasOwn(source.media, key)) {
      source.media[key] = await inspectMedia(media, key);
    }
  }

  const preview = {
    matched: [],
    metadataOnly: [],
    mediaOnly: [],
    ambiguous: [],
    duplicates: [],
    invalidMetadata: [...source.invalidMetadata].sort(),
    unsupportedMedia: [],
    albumDisagreements: [],
    unresolvedAlbums: [],
  };
  const candidates = new Map();
  for (const media of Object.values(source.media)) {
    if (!media.sourceId) {
      preview.ambiguous.push(media.name);
    } else if (!media.mimeType) {
      preview.unsupportedMedia.push(media.name);
    } else {
      const group = candidates.get(media.sourceId) ?? [];
      group.push(media);
      candidates.set(media.sourceId, group);
    }
  }

  const tags = new Map();
  const albumMemberships = new Map();
  for (const album of Object.values(source.albums)) {
    const tagId = identity(sourceKey, "album", album.id);
    tags.set(tagId, { id: tagId, kind: "album", title: album.title });
    for (const sourceId of new Set(album.photos)) {
      const memberships = albumMemberships.get(sourceId) ?? new Set();
      memberships.add(album.id);
      albumMemberships.set(sourceId, memberships);
    }
  }

  const previousAssets = new Map(previous?.assets.map((asset) => [asset.sourceId, asset]));
  const assets = [];
  const sourceIds = new Set([...Object.keys(source.sidecars), ...candidates.keys(), ...albumMemberships.keys()]);
  for (const sourceId of [...sourceIds].sort()) {
    const metadata = source.sidecars[sourceId];
    const authoritativeAlbums = albumMemberships.get(sourceId) ?? new Set();
    const sidecarAlbums = new Map((metadata?.albums ?? []).map((album) => [album.id, album.title]));
    const tagIds = new Set();
    const provisionalTagIds = [];
    for (const albumId of authoritativeAlbums) {
      tagIds.add(identity(sourceKey, "album", albumId));
      if (metadata?.albums && !sidecarAlbums.has(albumId)) {
        preview.albumDisagreements.push({ sourceId, albumId });
      }
    }
    for (const [albumId, title] of sidecarAlbums) {
      if (typeof albumId !== "string" || !sourceIdPattern.test(albumId)) {
        preview.unresolvedAlbums.push({ sourceId, title });
        continue;
      }
      if (Object.hasOwn(source.albums, albumId)) {
        if (!authoritativeAlbums.has(albumId)) {
          preview.albumDisagreements.push({ sourceId, albumId });
        }
      } else {
        const tagId = identity(sourceKey, "album", albumId);
        tags.set(tagId, { id: tagId, kind: "album", title });
        tagIds.add(tagId);
        provisionalTagIds.push(tagId);
      }
    }
    for (const { tag: title } of metadata?.tags ?? []) {
      if (typeof title === "string" && title) {
        const tagId = identity(sourceKey, "keyword", title);
        tags.set(tagId, { id: tagId, kind: "keyword", title });
        tagIds.add(tagId);
      }
    }

    const media = candidates.get(sourceId) ?? [];
    if (!media.length) {
      if (metadata || authoritativeAlbums.size) {
        preview.metadataOnly.push(sourceId);
      }
      continue;
    }
    if (media.length > 1) {
      const digests = await Promise.all(media.map(async ({ bytes }) => {
        const digest = await crypto.subtle.digest("SHA-256", await bytes.arrayBuffer());
        return new Uint8Array(digest).join(",");
      }));
      const distinct = new Set(digests).size;
      if (distinct < media.length) {
        preview.duplicates.push(sourceId);
      }
      if (distinct > 1) {
        preview.ambiguous.push(sourceId);
      }
      continue;
    }

    preview[metadata ? "matched" : "mediaOnly"].push(sourceId);
    const existing = previousAssets.get(sourceId);
    // Sidecar album fallback can be withdrawn once we have that album's authoritative membership.
    const rejected = new Set((existing?.provisionalTagIds ?? []).filter((id) => !tagIds.has(id)));
    const applied = new Set((existing?.appliedTagIds ?? []).filter((id) => !rejected.has(id)));
    const active = new Set((existing?.tagIds ?? []).filter((id) => !rejected.has(id)));
    for (const tagId of tagIds) {
      if (!applied.has(tagId)) {
        active.add(tagId);
        applied.add(tagId);
      }
    }
    assets.push({
      ...normalizeMetadata(metadata),
      ...existing,
      id: identity(sourceKey, "asset", sourceId),
      sourceId,
      originalKey: media[0].key,
      mimeType: media[0].mimeType,
      tagIds: [...active].sort(),
      appliedTagIds: [...applied].sort(),
      provisionalTagIds: provisionalTagIds.sort(),
    });
  }
  preview.ambiguous.sort();
  preview.unsupportedMedia.sort();
  preview.albumDisagreements.sort((a, b) => (
    a.sourceId.localeCompare(b.sourceId) || a.albumId.localeCompare(b.albumId)
  ));
  return {
    sourceKey,
    source,
    assets,
    tags: [...tags.values()].sort((a, b) => a.id.localeCompare(b.id)),
    preview,
  };
}

async function inspectMedia(media, key) {
  const { name, bytes } = media;
  const sourceId = /_(\d+)_o\.[^./]+$/.exec(name)?.[1];
  const suffixes = [...name.matchAll(/_\d+_o(?=[_.]|$)/g)];
  if (!sourceId || suffixes.length !== 1) {
    return { key, name, bytes };
  }
  const signature = new Uint8Array(await bytes.slice(0, 12).arrayBuffer());
  let mimeType;
  if (signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) {
    mimeType = "image/jpeg";
  } else if (String.fromCharCode(...signature.slice(4, 8)) === "ftyp") {
    const brand = String.fromCharCode(...signature.slice(8, 12));
    if (["isom", "iso2", "avc1", "mp41", "mp42"].includes(brand)) {
      mimeType = "video/mp4";
    }
  }
  return { key, name, bytes, sourceId, mimeType };
}

function normalizeMetadata(metadata) {
  if (!metadata) {
    return {};
  }
  const fields = {};
  if (typeof metadata.name === "string") {
    fields.title = metadata.name;
  }
  if (typeof metadata.description === "string") {
    const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
    fields.description = metadata.description
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, entity) => entities[entity])
      .replace(/\s+/g, " ")
      .trim();
  }
  const wallTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  if (wallTime.test(metadata.date_taken)) {
    fields.capturedAt = metadata.date_taken;
  }
  if (wallTime.test(metadata.date_imported)) {
    fields.importedAt = metadata.date_imported;
  }
  if (metadata.geo?.length === 1) {
    const { latitude, longitude } = metadata.geo[0];
    const microdegrees = /^-?\d+$/;
    if (microdegrees.test(latitude) && microdegrees.test(longitude)) {
      const location = { latitude: Number(latitude) / 1e6, longitude: Number(longitude) / 1e6 };
      if (Math.abs(location.latitude) <= 90 && Math.abs(location.longitude) <= 180) {
        fields.location = location;
      }
    }
  }
  if ([0, 90, 180, 270].includes(metadata.rotation)) {
    fields.flickrRotation = metadata.rotation;
  }
  return fields;
}
