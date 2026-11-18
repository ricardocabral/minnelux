import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectJpeg, readJpegMetadata } from './jpeg.mjs'

const bytes = (...n) => Buffer.from(n)
function segment(marker, payload) {
  const size = payload.length + 2
  return Buffer.concat([bytes(0xff, marker, size >> 8, size), payload])
}
const frame = segment(0xc2, bytes(8, 3, 0, 4, 0))
const jpeg = (...segments) => Buffer.concat([bytes(0xff, 0xd8), ...segments, bytes(0xff, 0xda)])
const inspect = buffer => inspectJpeg(new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength))

// Encode two TIFF directories, with inline SHORT/LONG and offset-backed ASCII/RATIONAL values.
function exifSegment(little, main, detail) {
  const buffer = Buffer.alloc(2048)
  const write16 = (at, value) => buffer[little ? 'writeUInt16LE' : 'writeUInt16BE'](value, at)
  const write32 = (at, value) => buffer[little ? 'writeUInt32LE' : 'writeUInt32BE'](value, at)
  buffer.write(little ? 'II' : 'MM')
  write16(2, 42)
  write32(4, 8)
  const subOffset = 8 + 6 + 12 * (main.length + 1)
  let next = subOffset + 6 + 12 * detail.length
  function directory(at, entries) {
    write16(at, entries.length)
    for (const [index, [tag, type, value]] of entries.entries()) {
      const slot = at + 2 + index * 12
      write16(slot, tag)
      write16(slot + 2, type)
      const ascii = type === 2 && Buffer.from(value + '\0')
      write32(slot + 4, ascii ? ascii.length : 1)
      if (type === 3) write16(slot + 8, value)
      if (type === 4) write32(slot + 8, value)
      if (ascii && ascii.length <= 4) ascii.copy(buffer, slot + 8)
      if (type === 5 || (ascii && ascii.length > 4)) {
        write32(slot + 8, next)
        if (ascii) { ascii.copy(buffer, next); next += ascii.length }
        else { write32(next, value[0]); write32(next + 4, value[1]); next += 8 }
        next += next % 2
      }
    }
  }
  directory(8, [...main, [0x8769, 4, subOffset]])
  directory(subOffset, detail)
  return segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), buffer.subarray(0, next)]))
}

for (const little of [false, true]) test('reads camera settings and independent EXIF clock offsets, ' + (little ? 'II' : 'MM'), () => {
  const app1 = exifSegment(little, [
    [0x10f, 2, 'Acme'], [0x110, 2, 'Z2'], [0x112, 3, 6], [0x132, 2, '2024:03:01 10:03:02'],
  ], [
    [0x829a, 5, [1, 250]], [0x829d, 5, [28, 10]], [0x8827, 3, 200],
    [0x9209, 3, 0x49], [0x920a, 5, [105, 2]], [0xa433, 2, 'Optics'], [0xa434, 2, 'Prime'],
    [0x9003, 2, '2024:02:29 23:59:58'], [0x9004, 2, '2024:03:01 04:00:01'],
    [0x9011, 2, '-03:30'], [0x9012, 2, '+00:00'],
  ])
  assert.deepEqual(inspect(jpeg(frame, app1)), {
    width: 1024, height: 768, orientation: 6, exif: {
      make: 'Acme', model: 'Z2', lensMake: 'Optics', lensModel: 'Prime', iso: 200,
      exposureSeconds: 0.004, fNumber: 2.8, flash: 73, focalLengthMm: 52.5,
      capturedAt: { wallTime: '2024-02-29T23:59:58', precision: 'second', provenance: 'exif', offsetMinutes: -210 },
      digitizedAt: { wallTime: '2024-03-01T04:00:01', precision: 'second', provenance: 'exif', offsetMinutes: 0 },
      modifiedAt: { wallTime: '2024-03-01T10:03:02', precision: 'second', provenance: 'exif' },
    },
  })
})

function dataset(record, id, data) {
  data = Buffer.from(data)
  return Buffer.concat([bytes(0x1c, record, id, data.length >> 8, data.length), data])
}
function resource(id, data) {
  const header = Buffer.alloc(12)
  header.write('8BIM')
  header.writeUInt16BE(id, 4)
  header.writeUInt32BE(data.length, 8)
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)])
}
const photoshop = (...resources) => segment(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\0'), ...resources]))

test('reads IIM dates, times and UTF-8 caption from the Photoshop IPTC resource', () => {
  const iim = Buffer.concat([dataset(1, 90, '\x1b%G'), dataset(2, 55, '20240229'),
    dataset(2, 60, '235958-0330'), dataset(2, 62, '20240301'), dataset(2, 63, '040001'),
    dataset(2, 120, 'Noite em São Paulo 🌙')])
  assert.deepEqual(inspect(jpeg(photoshop(resource(0x0400, bytes(0)), resource(0x0404, iim)))), {
    iptc: { dateCreated: '2024-02-29', timeCreated: '23:59:58-03:30', digitalCreationDate: '2024-03-01',
      digitalCreationTime: '04:00:01', caption: 'Noite em São Paulo 🌙' },
  })
})

test('ignores invalid calendar values, zero denominators, bad orientation and out-of-segment pointers', () => {
  const invalid = exifSegment(true, [[0x112, 3, 9]], [[0x9003, 2, '2023:02:29 12:00:00'], [0x829a, 5, [10, 0]]])
  const badPointer = exifSegment(true, [[0x10f, 2, 'Camera']], [])
  badPointer.writeUInt32LE(0xffffffff, 28)
  const iim = Buffer.concat([dataset(2, 55, '20230229'), dataset(2, 60, '250000'), dataset(2, 120, 'kept')])
  const photo = jpeg(invalid, badPointer, photoshop(resource(0x0404, iim)), frame)
  assert.deepEqual(inspect(photo), { iptc: { caption: 'kept' }, width: 1024, height: 768 })
  for (let length = 0; length < photo.length; length++) inspect(photo.subarray(0, length))
})

test('stops at the scan marker across small stream chunks and cancels the remainder', async () => {
  const header = jpeg(frame)
  let cursor = 0, cancelled = false
  const result = await readJpegMetadata({ openBytes: async () => new ReadableStream({
    pull(c) {
      assert.ok(cursor < header.length, 'read beyond the JPEG header')
      c.enqueue(header.subarray(cursor, ++cursor))
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 }) })
  assert.deepEqual(result, { width: 1024, height: 768 })
  assert.equal(cancelled, true)
})

test('bounds streaming reads even when many APP segments precede the scan', async () => {
  const largeSegment = segment(0xe2, Buffer.alloc(65530))
  let reads = 0, cancelled = false
  const result = await readJpegMetadata({ openBytes: async () => new ReadableStream({
    pull(c) {
      assert.ok(++reads < 15, 'unbounded reads')
      c.enqueue(reads === 1 ? Buffer.concat([bytes(0xff, 0xd8), frame]) : largeSegment)
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 }) })
  assert.deepEqual(result, { width: 1024, height: 768 })
  assert.equal(cancelled, true)
})

test('decodes IIM captions using the declared character set and skips invalid UTF-8', () => {
  const caption = (charset, raw) => inspect(jpeg(photoshop(resource(0x0404, Buffer.concat([
    dataset(1, 90, charset), dataset(2, 120, raw),
  ]))))).iptc?.caption
  assert.equal(caption('\x1b(B', 'Evening'), 'Evening')
  assert.equal(caption('\x1b-A', bytes(0xe7, 0xe3, 0x6f)), 'ção')
  assert.equal(caption('\x1b%G', bytes(0xc3)), undefined)
})

test('preserves flash zero, extended ISO, and a wall time with an unusable offset', () => {
  const app1 = exifSegment(false, [[0x132, 2, '2021:07:04 05:06:07']], [
    [0x8827, 3, 65535], [0x8833, 4, 102400], [0x9209, 3, 0], [0x9010, 2, '+01:99'],
  ])
  assert.deepEqual(inspect(jpeg(app1)), { exif: {
    iso: 102400, flash: 0,
    modifiedAt: { wallTime: '2021-07-04T05:06:07', precision: 'second', provenance: 'exif' },
  } })
})

test('ignores invalid resource and dataset lengths without crossing into the next marker', () => {
  const badResource = resource(0x0404, Buffer.alloc(0))
  badResource.writeUInt32BE(0xffffffff, 8)
  const badDataset = resource(0x0404, bytes(0x1c, 2, 120, 0x80, 4, 0xff, 0xff, 0xff, 0xff))
  const extended = resource(0x0404, bytes(0x1c, 2, 120, 0x80, 2, 0, 2, 72, 105))
  assert.deepEqual(inspect(jpeg(photoshop(badResource), photoshop(badDataset), photoshop(extended), frame)), {
    iptc: { caption: 'Hi' }, width: 1024, height: 768,
  })
})

test('cancels a pending read when the import is aborted', async () => {
  const abort = new AbortController()
  let reading, cancelled = false
  const started = new Promise(resolve => { reading = resolve })
  const promise = readJpegMetadata({ openBytes: async () => new ReadableStream({
    pull() { reading() },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 }) }, abort.signal)
  await started
  abort.abort()
  await assert.rejects(promise, { name: 'AbortError' })
  assert.equal(cancelled, true)
})
