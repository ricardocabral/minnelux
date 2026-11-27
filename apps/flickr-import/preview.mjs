import { inspectJpeg, MAX_JPEG_HEADER_BYTES } from './jpeg.mjs'

export const maxPreviewSize = 360
const maxImagePixels = 80_000_000
export const maxPreviewBytes = 48 * 1024 ** 2
export const previewImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
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
    const imageInfo = await readPreviewImage(blob, type)
    if (!imageInfo) return undefined
    if (imageInfo.orientation) metadata.exifOrientation = imageInfo.orientation
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

export async function readPreviewImage(blob, type) {
  const header = new DataView(await blob.slice(0, MAX_JPEG_HEADER_BYTES).arrayBuffer())
  const info = inspectImage(type, header)
  return info.width && info.height && info.width * info.height <= maxImagePixels ? info : undefined
}

export function displayRotation(metadata) {
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
  if (type === 'image/png' && view.byteLength >= 24 &&
      view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a &&
      view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452) { // IHDR
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (type === 'image/gif' && view.byteLength >= 10 && view.getUint32(0) === 0x47494638 &&
      (view.getUint16(4) === 0x3761 || view.getUint16(4) === 0x3961)) { // GIF87a or GIF89a
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  if (type === 'image/webp' && view.byteLength >= 30 &&
      view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) { // RIFF and WEBP
    const chunk = view.getUint32(12)
    if (chunk === 0x56503858 && view.getUint32(16, true) === 10) { // VP8X
      const length24 = (at) => view.getUint8(at) | view.getUint8(at + 1) << 8 | view.getUint8(at + 2) << 16
      return { width: length24(24) + 1, height: length24(27) + 1 }
    }
    if (chunk === 0x56503820 && view.getUint8(23) === 0x9d &&
        view.getUint16(24) === 0x012a) { // VP8 key-frame signature
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    }
    if (chunk === 0x5650384c && view.getUint8(20) === 0x2f) { // VP8L signature
      const dimensions = view.getUint32(21, true)
      return { width: (dimensions & 0x3fff) + 1, height: (dimensions >>> 14 & 0x3fff) + 1 }
    }
  }
  return {}
}
