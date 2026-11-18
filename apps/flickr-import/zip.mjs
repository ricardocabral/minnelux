import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { BlobReader, ZipReader } from "@zip.js/zip.js";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const MAX_ARCHIVE_BYTES = 16 * GiB;
const MAX_DIRECTORY_BYTES = 16 * MiB;
const MAX_ENTRIES = 25_000;
const MAX_EXPANDED_BYTES = 24 * GiB;
const MAX_METADATA_BYTES = 128 * MiB;
const MAX_ORIGINAL_BYTES = GiB;
const MAX_ALBUM_BYTES = 32 * MiB;
const MAX_SIDECAR_BYTES = MiB;
const SIGNATURE_BYTES = 128;

const photoFilename = /^photo_(\d+)\.json$/i;
const digitString = /^\d+$/;
const mediaFilename = /(?:_\d+_o(?:\.[^.]+)?|\.(?:jpe?g|png|gif|webp|tiff?|bmp|avif|heic|heif|mp4|m4v|mov|avi|mpeg|mpg|webm|mkv|3gp|wmv))$/i;
const zipStructureWarnings = new Set([
  "appended data",
  "prepended data",
  "prepended central directory",
  "trailing central directory data",
  "mismatched central directory offset",
  "mismatched zip64 end of central directory record",
  "wrapped entries count",
]);
const entryErrors = new Set([
  "invalid-json", "invalid-metadata", "photo-id-mismatch", "unsupported-media",
]);
const utf8 = new TextDecoder("utf-8", { fatal: true });
const filenameDecoder = new TextDecoder();
const readEntryOptions = {
  checkCrc32: true,
  checkLocalDirectory: true,
  checkLocalFilename: true,
  checkOverlappingEntry: true,
  useWebWorkers: false,
};

function zipError(code) {
  return Object.assign(new Error(code), { code });
}

async function enumerateEntries(file, signal) {
  const reader = new BlobReader(file);
  const readRange = reader.readUint8Array.bind(reader);
  // zip.js reads the central directory in one range before yielding the first entry.
  reader.readUint8Array = (offset, length) => {
    signal?.throwIfAborted();
    if (length > MAX_DIRECTORY_BYTES) throw zipError("archive-limit");
    return readRange(offset, length);
  };
  const zip = new ZipReader(reader, { filenameValidation: "tolerant", maxAppendedDataSize: 0 });
  try {
    const entries = [];
    for await (const entry of zip.getEntriesGenerator()) {
      signal?.throwIfAborted();
      if (entries.length === MAX_ENTRIES) throw zipError("archive-limit");
      entries.push(entry);
    }
    if (zip.warnings?.some(({ reason }) => zipStructureWarnings.has(reason))) {
      throw zipError("invalid-zip");
    }
    // Retained entries also use this reader after the scan has finished.
    reader.readUint8Array = readRange;
    return entries;
  } catch (error) {
    signal?.throwIfAborted();
    throw zipError(error.code === "archive-limit" ? error.code : "invalid-zip");
  } finally {
    await zip.close();
  }
}

async function hashArchive(file, signal) {
  const hash = sha256.create();
  try {
    for (let offset = 0; offset < file.size; offset += MiB) {
      signal?.throwIfAborted();
      hash.update(new Uint8Array(await file.slice(offset, offset + MiB).arrayBuffer()));
    }
  } catch {
    signal?.throwIfAborted();
    throw zipError("unreadable-zip");
  }
  signal?.throwIfAborted();
  return bytesToHex(hash.digest());
}

function unsafePath(path, directory) {
  const trimmed = directory && path.endsWith("/") ? path.slice(0, -1) : path;
  return path.length > 4096 || /[\\:\x00-\x1f\x7f-\x9f]/.test(path) ||
    trimmed.split("/").some(segment => segment === "" || segment === "." || segment === "..");
}

function describeEntry(entry, entryOrdinal) {
  const rawName = filenameDecoder.decode(entry.rawFilename);
  const basename = entry.filename.replace(/\/$/, "").split(/[\\/]/).at(-1);
  const filename = basename.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 4096);
  const member = { entryOrdinal, filename };
  if (unsafePath(rawName, entry.directory) || unsafePath(entry.filename, entry.directory) || entry.symlink) {
    return { ...member, kind: "invalid", error: "unsafe-path" };
  }
  if (entry.directory || entry.filename.startsWith("__MACOSX/") || /^\.|^thumbs\.db$/i.test(filename)) {
    return { ...member, kind: "ignored" };
  }
  if (/^photo_.*\.json$/i.test(filename)) return { ...member, kind: "photo-json" };
  if (filename.toLowerCase() === "albums.json") return { ...member, kind: "album-json" };
  if (filename.toLowerCase() === "account_profile.json") return { ...member, kind: "account-json" };
  if (/\.json$/i.test(filename)) return { ...member, kind: "ignored" };
  return { ...member, kind: "original" };
}

function mediaType(bytes) {
  const starts = (...signature) => signature.every((value, index) => bytes[index] === value);
  const textAt = (offset, length = 4) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (["GIF87a", "GIF89a"].includes(textAt(0, 6))) return "image/gif";
  if (textAt(0) === "RIFF" && textAt(8) === "WEBP") return "image/webp";
  if (starts(0x49, 0x49, 0x2a, 0) || starts(0x4d, 0x4d, 0, 0x2a)) return "image/tiff";
  if (textAt(0) === "RIFF" && textAt(8) === "AVI ") return "video/x-msvideo";
  if (bytes.length < 16 || textAt(4) !== "ftyp") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxSize = view.getUint32(0);
  if (boxSize < 16) return undefined;
  const brands = [textAt(8)];
  for (let offset = 16; offset + 4 <= Math.min(boxSize, bytes.length); offset += 4) {
    brands.push(textAt(offset));
  }
  if (brands.some(brand => ["avif", "avis"].includes(brand))) return "image/avif";
  if (brands.some(brand => ["heic", "heix", "hevc", "hevx"].includes(brand))) return "image/heic";
  if (brands.some(brand => ["mif1", "msf1"].includes(brand))) return "image/heif";
  if (brands.includes("qt  ")) return "video/quicktime";
  if (brands.some(brand => /^3gp[0-9a-z]$/.test(brand))) return "video/3gpp";
  if (brands.some(brand => /^(?:isom|iso[2-9]|avc1|mp4[12]|M4[VP] |dash)$/.test(brand))) return "video/mp4";
  return undefined;
}

function parseMetadata(member, bytes) {
  let json;
  try {
    json = JSON.parse(utf8.decode(bytes));
  } catch {
    throw zipError("invalid-json");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw zipError("invalid-metadata");
  if (member.kind === "photo-json") {
    const expected = photoFilename.exec(member.filename)?.[1];
    if (expected === undefined || json.id !== expected) throw zipError("photo-id-mismatch");
  } else if (member.kind === "album-json") {
    if (!Array.isArray(json.albums) || json.albums.some(album =>
      typeof album?.id !== "string" || !digitString.test(album.id) ||
      typeof album.title !== "string" || !Array.isArray(album.photos) ||
      album.photos.some(id => typeof id !== "string" || !digitString.test(id)))) {
      throw zipError("invalid-metadata");
    }
  } else {
    // The importer only uses the profile as account-identity evidence.
    return typeof json.nsid === "string" ? { nsid: json.nsid } : {};
  }
  return json;
}

async function openEntry(entry, signal) {
  signal?.throwIfAborted();
  let transform;
  const stream = new TransformStream({ start(controller) { transform = controller; } });
  const abort = () => transform.error(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  entry.getData(stream.writable, { ...readEntryOptions, signal, preventClose: true })
    .then(() => stream.writable.close(), () => transform.error(zipError("unreadable-entry")))
    .catch(() => {
      // The read end may already have been cancelled or aborted by the caller.
    })
    .finally(() => signal?.removeEventListener("abort", abort));
  return stream.readable;
}

async function inspectEntry(entry, member, metadata, signal) {
  const byteLength = entry.uncompressedSize;
  const bytes = new Uint8Array(metadata ? byteLength : Math.min(SIGNATURE_BYTES, byteLength));
  const hash = sha256.create();
  let written = 0;
  await entry.getData(new WritableStream({
    write(chunk) {
      signal?.throwIfAborted();
      if (written + chunk.length > byteLength) throw zipError("unreadable-entry");
      if (written < bytes.length) bytes.set(chunk.subarray(0, bytes.length - written), written);
      written += chunk.length;
      hash.update(chunk);
    },
  }), { ...readEntryOptions, signal });
  if (written !== byteLength) throw zipError("unreadable-entry");

  let mimeType = "application/json";
  if (!metadata) {
    mimeType = mediaType(bytes);
    if (!mimeType) {
      if (mediaFilename.test(member.filename)) throw zipError("unsupported-media");
      return { ...member, kind: "ignored" };
    }
  }
  const descriptor = {
    ...member,
    mimeType,
    byteLength,
    sha256: bytesToHex(hash.digest()),
    openBytes: readSignal => openEntry(entry, readSignal),
  };
  if (metadata) descriptor.json = parseMetadata(member, bytes);
  return descriptor;
}

export function createZipBudget() {
  return {
    archiveBytes: MAX_ARCHIVE_BYTES,
    entries: MAX_ENTRIES,
    expandedBytes: MAX_EXPANDED_BYTES,
    metadataBytes: MAX_METADATA_BYTES,
  };
}

export async function scanFlickrZip(file, { signal, budget = createZipBudget() } = {}) {
  signal?.throwIfAborted();
  if (!(file instanceof Blob)) throw zipError("invalid-zip");
  if (file.size > budget.archiveBytes) throw zipError("archive-limit");
  const entries = await enumerateEntries(file, signal);
  if (entries.length > budget.entries) throw zipError("archive-limit");
  let expandedBytes = 0;
  let metadataBytes = 0;
  const members = entries.map((entry, entryOrdinal) => {
    signal?.throwIfAborted();
    const member = describeEntry(entry, entryOrdinal);
    if (member.kind === "ignored" || member.kind === "invalid") return member;

    const metadata = member.kind !== "original";
    const maxBytes = metadata ?
      (member.kind === "album-json" ? MAX_ALBUM_BYTES : MAX_SIDECAR_BYTES) :
      MAX_ORIGINAL_BYTES;
    const byteLength = entry.uncompressedSize;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maxBytes) {
      return { ...member, kind: "invalid", error: "entry-limit" };
    }
    expandedBytes += byteLength;
    if (metadata) metadataBytes += byteLength;
    if (expandedBytes > budget.expandedBytes || metadataBytes > budget.metadataBytes) {
      throw zipError("archive-limit");
    }
    return member;
  });

  budget.archiveBytes -= file.size;
  budget.entries -= entries.length;
  budget.expandedBytes -= expandedBytes;
  budget.metadataBytes -= metadataBytes;

  const partId = await hashArchive(file, signal);
  for (const member of members) {
    signal?.throwIfAborted();
    if (member.kind === "ignored" || member.kind === "invalid") continue;
    const { entryOrdinal } = member;
    try {
      const metadata = member.kind !== "original";
      members[entryOrdinal] = await inspectEntry(entries[entryOrdinal], member, metadata, signal);
    } catch (error) {
      signal?.throwIfAborted();
      const code = entryErrors.has(error.code) ? error.code : "unreadable-entry";
      members[entryOrdinal] = { ...member, kind: "invalid", error: code };
    }
  }
  signal?.throwIfAborted();
  return { partId, members };
}
