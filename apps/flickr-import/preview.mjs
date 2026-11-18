const maxPreviewSize = 360
const maxImagePixels = 80_000_000
const maxPreviewBytes = 48 * 1024 ** 2
const previewImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const exifRotation = new Map([[3, 180], [6, 90], [8, 270]])

export async function makePreview(original, metadata, signal) {
  signal?.throwIfAborted()
  const type = original.mimeType
  if (original.byteLength > maxPreviewBytes || (!previewImageTypes.has(type) && !type.startsWith('video/'))) return undefined
  const blob = await new Response(await original.openBytes(signal), {
    headers: { 'Content-Type': type },
  }).blob()
  signal?.throwIfAborted()
  if (type.startsWith('image/')) {
    const header = new DataView(await blob.slice(0, 512 * 1024).arrayBuffer())
    const { orientation, width, height } = inspectImage(type, header)
    if (!width || !height || width * height > maxImagePixels) return undefined
    if (orientation) metadata.exifOrientation = orientation
    let image
    try {
      image = await createImageBitmap(blob, { imageOrientation: 'from-image' })
      if (image.width * image.height > maxImagePixels) return undefined
      return draw(image, image.width, image.height, displayRotation(metadata))
    } catch {
      signal?.throwIfAborted()
      return undefined
    } finally {
      image?.close()
    }
  }
  if (type.startsWith('video/')) return drawVideo(blob, metadata, signal)
}

function displayRotation(metadata) {
  const flickr = metadata.flickrRotation ?? 0
  return flickr === exifRotation.get(metadata.exifOrientation) ? 0 : flickr
}

function draw(source, width, height, degrees = 0) {
  if (!width || !height) return undefined
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, maxPreviewSize / Math.max(width, height))
  const scaledWidth = Math.max(1, Math.round(width * scale))
  const scaledHeight = Math.max(1, Math.round(height * scale))
  canvas.width = degrees % 180 ? scaledHeight : scaledWidth
  canvas.height = degrees % 180 ? scaledWidth : scaledHeight
  const ctx = canvas.getContext('2d')
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate(degrees * Math.PI / 180)
  ctx.drawImage(source, -scaledWidth / 2, -scaledHeight / 2, scaledWidth, scaledHeight)
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/webp', 0.78))
}

async function drawVideo(blob, metadata, signal) {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  const url = URL.createObjectURL(blob)
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
      }
      const fail = () => {
        cleanup()
        reject(new Error('Video preview unavailable'))
      }
      const abort = () => {
        cleanup()
        reject(signal.reason)
      }
      const timeout = setTimeout(fail, 12_000)
      video.onloadeddata = () => {
        cleanup()
        resolve()
      }
      video.onerror = fail
      signal?.addEventListener('abort', abort, { once: true })
      video.src = url
    })
    if (video.videoWidth * video.videoHeight > maxImagePixels) return undefined
    return await draw(video, video.videoWidth, video.videoHeight, displayRotation(metadata))
  } catch {
    signal?.throwIfAborted()
    return undefined
  } finally {
    video.onloadeddata = null
    video.onerror = null
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

function inspectImage(type, view) {
  if (type === 'image/jpeg') return inspectJpeg(view)
  if (type === 'image/png' && view.byteLength >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (type === 'image/gif' && view.byteLength >= 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  if (type === 'image/webp' && view.byteLength >= 30) {
    const chunk = view.getUint32(12)
    if (chunk === 0x56503858) { // VP8X
      const length24 = (at) => view.getUint8(at) | view.getUint8(at + 1) << 8 | view.getUint8(at + 2) << 16
      return { width: length24(24) + 1, height: length24(27) + 1 }
    }
    if (chunk === 0x56503820) { // VP8
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    }
    if (chunk === 0x5650384c) { // VP8L
      const dimensions = view.getUint32(21, true)
      return { width: (dimensions & 0x3fff) + 1, height: (dimensions >>> 14 & 0x3fff) + 1 }
    }
  }
  return {}
}

function inspectJpeg(view) {
  let offset = 2
  const result = {}
  while (offset + 4 <= view.byteLength && view.getUint8(offset) === 0xff) {
    const kind = view.getUint8(offset + 1)
    if (kind === 0xda || kind === 0xd9) break
    if (kind === 0xff) {
      offset++
      continue
    }
    const length = view.getUint16(offset + 2)
    const payload = offset + 4
    const end = offset + 2 + length
    if (length < 2 || end > view.byteLength) break
    if (kind === 0xe1 && end - payload >= 14 && view.getUint32(payload) === 0x45786966 &&
        view.getUint16(payload + 4) === 0) {
      result.orientation ??= readOrientation(view, payload + 6, end)
    }
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(kind) &&
        end - payload >= 5) {
      result.height = view.getUint16(payload + 1)
      result.width = view.getUint16(payload + 3)
    }
    offset = end
  }
  return result
}

function readOrientation(view, start, end) {
  const byteOrder = view.getUint16(start)
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return undefined
  const little = byteOrder === 0x4949
  if (view.getUint16(start + 2, little) !== 42) return undefined
  const directory = start + view.getUint32(start + 4, little)
  if (directory < start + 8 || directory + 2 > end) return undefined
  const count = view.getUint16(directory, little)
  for (let index = 0; index < count; index++) {
    const at = directory + 2 + index * 12
    if (at + 12 > end) return undefined
    if (view.getUint16(at, little) === 274 &&
        view.getUint16(at + 2, little) === 3 && view.getUint32(at + 4, little) === 1) {
      const orientation = view.getUint16(at + 8, little)
      return orientation >= 1 && orientation <= 8 ? orientation : undefined
    }
  }
}
