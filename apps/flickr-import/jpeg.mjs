export const MAX_JPEG_HEADER_BYTES = 512 * 1024

const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
const utf8 = new TextDecoder('utf-8', { fatal: true })
const latin1 = new TextDecoder('iso-8859-1')
const tiffUnitBytes = { 2: 1, 3: 2, 4: 4, 5: 8 }

function bytesAt(view, start, length) {
  return new Uint8Array(view.buffer, view.byteOffset + start, length)
}

function validDate(date) {
  const parsed = new Date(date + 'T00:00:00Z')
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === date
}

function validClock(clock) {
  return /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(clock)
}

function offsetMinutes(value) {
  const match = /^([+-])(\d{2}):([0-5]\d)$/.exec(value)
  if (!match) return
  const minutes = Number(match[2]) * 60 + Number(match[3])
  if (minutes <= 14 * 60) return (match[1] === '-' ? -minutes : minutes) || 0
}

function exifTime(value, zone) {
  const match = /^(\d{4}):(\d\d):(\d\d) (\d\d:\d\d:\d\d)$/.exec(value)
  if (!match) return
  const date = match.slice(1, 4).join('-')
  if (!validDate(date) || !validClock(match[4])) return
  const result = { wallTime: date + 'T' + match[4], precision: 'second', provenance: 'exif' }
  const offset = offsetMinutes(zone)
  if (offset !== undefined) result.offsetMinutes = offset
  return result
}

// All pointers are relative to this segment's TIFF header. Only follow IFD0 and its EXIF directory.
function readExif(view, result) {
  if (view.byteLength < 8) return
  const order = view.getUint16(0)
  if (order !== 0x4949 && order !== 0x4d4d) return
  const little = order === 0x4949
  const u16 = at => view.getUint16(at, little)
  const u32 = at => view.getUint32(at, little)
  if (u16(2) !== 42) return

  function directory(start) {
    const tags = new Map()
    if (start === undefined || start < 8 || start + 2 > view.byteLength) return tags
    const end = start + 2 + 12 * u16(start)
    if (end > view.byteLength) return tags
    for (let at = start + 2; at < end; at += 12) tags.set(u16(at), at)
    return tags
  }

  function value(tags, tag, type) {
    const at = tags.get(tag)
    if (at === undefined || u16(at + 2) !== type) return
    const count = u32(at + 4)
    if (!count || (type !== 2 && count !== 1)) return
    const length = count * tiffUnitBytes[type]
    const pos = length <= 4 ? at + 8 : u32(at + 8)
    if (pos < 8 || pos + length > view.byteLength) return
    if (type === 2) {
      const raw = bytesAt(view, pos, count)
      const nul = raw.indexOf(0)
      return latin1.decode(nul < 0 ? raw : raw.subarray(0, nul)).trim() || undefined
    }
    if (type === 3) return u16(pos)
    if (type === 4) return u32(pos)
    if (type === 5 && u32(pos + 4) && u32(pos)) return u32(pos) / u32(pos + 4)
  }

  const main = directory(u32(4))
  const sub = directory(value(main, 0x8769, 4))
  const orientation = value(main, 0x0112, 3)
  if (orientation >= 1 && orientation <= 8) result.orientation ??= orientation
  const iso = value(sub, 0x8827, 3)
  const fields = {
    make: value(main, 0x010f, 2), model: value(main, 0x0110, 2),
    lensMake: value(sub, 0xa433, 2), lensModel: value(sub, 0xa434, 2),
    iso: (iso === 65535 || !iso ? value(sub, 0x8833, 4) : iso) || undefined,
    exposureSeconds: value(sub, 0x829a, 5), fNumber: value(sub, 0x829d, 5),
    flash: value(sub, 0x9209, 3), focalLengthMm: value(sub, 0x920a, 5),
    capturedAt: exifTime(value(sub, 0x9003, 2), value(sub, 0x9011, 2)),
    digitizedAt: exifTime(value(sub, 0x9004, 2), value(sub, 0x9012, 2)),
    modifiedAt: exifTime(value(main, 0x0132, 2), value(sub, 0x9010, 2)),
  }
  for (const [key, field] of Object.entries(fields)) {
    if (field !== undefined) (result.exif ??= {})[key] ??= field
  }
}

function iptcDate(raw) {
  const date = raw.replace(/^(\d{4})(\d\d)(\d\d)$/, '$1-$2-$3')
  if (/^\d{8}$/.test(raw) && validDate(date)) return date
}

function iptcTime(raw) {
  const match = /^(\d\d)(\d\d)(\d\d)(?:([+-]\d\d)(\d\d))?$/.exec(raw)
  if (!match) return
  const clock = match.slice(1, 4).join(':')
  if (!validClock(clock)) return
  if (!match[4]) return clock
  const zone = match[4] + ':' + match[5]
  if (offsetMinutes(zone) !== undefined) return clock + zone
}

function decodeCaption(raw, charset) {
  if (charset === '\x1b(B') return raw.every(byte => byte < 128) ? utf8.decode(raw) : undefined
  if (charset === '\x1b-A') return latin1.decode(raw)
  if (charset && charset !== '\x1b%G') return
  try {
    return utf8.decode(raw)
  } catch {
    if (!charset) return latin1.decode(raw)
  }
}

function readIim(view, start, end, result) {
  const fields = {}
  let charset, caption
  for (let at = start; at + 5 <= end && view.getUint8(at) === 0x1c;) {
    const record = view.getUint8(at + 1), tag = view.getUint8(at + 2)
    let size = view.getUint16(at + 3)
    at += 5
    if (size >= 0x8000) {
      const count = size - 0x8000
      if (!count || count > 4 || at + count > end) break
      size = 0
      for (let i = 0; i < count; i++) size = size * 256 + view.getUint8(at++)
    }
    if (at + size > end) break
    const raw = bytesAt(view, at, size)
    if (record === 1 && tag === 90) charset = latin1.decode(raw)
    if (record === 2) {
      if (tag === 55) fields.dateCreated ??= iptcDate(latin1.decode(raw))
      if (tag === 60) fields.timeCreated ??= iptcTime(latin1.decode(raw))
      if (tag === 62) fields.digitalCreationDate ??= iptcDate(latin1.decode(raw))
      if (tag === 63) fields.digitalCreationTime ??= iptcTime(latin1.decode(raw))
      if (tag === 120) caption ??= raw
    }
    at += size
  }
  if (caption) fields.caption = decodeCaption(caption, charset)?.replace(/\0+$/, '')
  for (const [key, field] of Object.entries(fields)) {
    if (field) (result.iptc ??= {})[key] ??= field
  }
}

function readPhotoshop(view, start, end, result) {
  if (end - start < 14 || latin1.decode(bytesAt(view, start, 14)) !== 'Photoshop 3.0\0') return
  let at = start + 14
  while (at + 7 <= end && view.getUint32(at) === 0x3842494d) { // 8BIM
    const id = view.getUint16(at + 4)
    const nameLength = view.getUint8(at + 6) + 1
    at += 6 + nameLength + nameLength % 2
    if (at + 4 > end) return
    const size = view.getUint32(at)
    at += 4
    if (at + size > end) return
    if (id === 0x0404) readIim(view, at, at + size, result)
    at += size + size % 2
  }
}

// Return the first incomplete marker so streamed inputs only parse each complete segment once.
function inspectMarkers(view, at, result) {
  const limit = Math.min(view.byteLength, MAX_JPEG_HEADER_BYTES)
  if (at === 0) {
    if (limit < 2) return 0
    if (view.getUint16(0) !== 0xffd8) return
    at = 2
  }
  while (at + 2 <= limit) {
    if (view.getUint8(at) !== 0xff) return
    const marker = view.getUint8(at + 1)
    if (marker === 0xda || marker === 0xd9 || marker === 0) return
    if (marker === 0xff) { at++; continue }
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue }
    if (at + 4 > limit) break
    const length = view.getUint16(at + 2)
    if (length < 2) return
    const payload = at + 4, end = at + 2 + length
    if (end > limit) break
    if (marker === 0xe1 && end - payload >= 6 && view.getUint32(payload) === 0x45786966 && view.getUint16(payload + 4) === 0) {
      readExif(new DataView(view.buffer, view.byteOffset + payload + 6, end - payload - 6), result)
    }
    if (marker === 0xed) readPhotoshop(view, payload, end, result)
    if (frameMarkers.has(marker) && end - payload >= 5) {
      result.height = view.getUint16(payload + 1)
      result.width = view.getUint16(payload + 3)
    }
    at = end
  }
  return at
}

export function inspectJpeg(view) {
  const result = {}
  inspectMarkers(view, 0, result)
  return result
}

export async function readJpegMetadata(original, signal) {
  signal?.throwIfAborted()
  const reader = (await original.openBytes(signal)).getReader()
  const abort = () => { reader.cancel(signal.reason).catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const result = {}
    const prefix = new Uint8Array(MAX_JPEG_HEADER_BYTES)
    let length = 0, marker = 0
    while (length < prefix.length && marker !== undefined) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      const chunk = value.subarray(0, prefix.length - length)
      prefix.set(chunk, length)
      length += chunk.length
      marker = inspectMarkers(new DataView(prefix.buffer, 0, length), marker, result)
    }
    return result
  } finally {
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
