import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadPhotoOriginal } from './photo-display.ts'

test('does not read oversized or unsupported originals automatically', async () => {
  const client = { async readOriginal(): Promise<Blob> { throw new Error('unexpected read') } }
  for (const original of [
    { byteLength: 49 * 1024 ** 2, mimeType: 'image/jpeg' },
    { byteLength: 10, mimeType: 'image/svg+xml' },
    { byteLength: 10, mimeType: 'image/tiff' },
  ]) {
    const resource = loadPhotoOriginal(client, 'result', { id: 'photo', original })
    try {
      assert.equal(await resource.ready, undefined)
    } finally {
      resource.close()
    }
  }
})

test('rejects a supported original over the existing raster pixel limit before decoding', async () => {
  const header = new Uint8Array(24)
  header.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
  const view = new DataView(header.buffer)
  view.setUint32(16, 10_000)
  view.setUint32(20, 10_000)
  const blob = new Blob([header], { type: 'image/png' })
  const resource = loadPhotoOriginal({ async readOriginal() { return blob } }, 'result', {
    id: 'photo', original: { byteLength: blob.size, mimeType: blob.type },
  })
  try {
    assert.equal(await resource.ready, undefined)
  } finally {
    resource.close()
  }
})

test('checks the image signature before trusting its dimension fields', async () => {
  const bytes = new Uint8Array(24)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, 64)
  view.setUint32(20, 64)
  const blob = new Blob([bytes], { type: 'image/png' })
  const resource = loadPhotoOriginal({ async readOriginal() { return blob } }, 'result', {
    id: 'photo', original: { byteLength: blob.size, mimeType: blob.type },
  })
  try {
    assert.equal(await resource.ready, undefined)
  } finally {
    resource.close()
  }
})
