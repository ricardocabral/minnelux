import { maxPreviewBytes, previewImageTypes, readPreviewImage } from '../../../flickr-import/preview.mjs'
import type { StoredObjectRef } from './contract.ts'
import type { LibraryClient } from './worker-contract.ts'

const otherPhotoTypes = new Set(['image/avif', 'image/heic', 'image/heif', 'image/tiff'])

export type DecodedPhoto = { url: string; width: number; height: number }

export function loadPhotoOriginal(client: Pick<LibraryClient, 'readOriginal'>, handle: string, photo: {
  id: string
  original: Pick<StoredObjectRef, 'byteLength' | 'mimeType'>
}) {
  const controller = new AbortController()
  const { signal } = controller
  let url: string | undefined
  let image: HTMLImageElement | undefined

  function release() {
    if (url) URL.revokeObjectURL(url)
    image?.removeAttribute('src')
    url = undefined
    image = undefined
  }

  async function load(): Promise<DecodedPhoto | undefined> {
    const { byteLength, mimeType } = photo.original
    const hasHeaderCheck = previewImageTypes.has(mimeType)
    if (byteLength > maxPreviewBytes || (!hasHeaderCheck && !otherPhotoTypes.has(mimeType))) return undefined

    const blob = await client.readOriginal(handle, photo.id, signal)
    if (hasHeaderCheck && !await readPreviewImage(blob, mimeType)) return undefined
    signal.throwIfAborted()
    url = URL.createObjectURL(blob)
    image = new Image()
    image.src = url
    await image.decode()
    signal.throwIfAborted()
    return { url, width: image.naturalWidth, height: image.naturalHeight }
  }

  return {
    signal,
    ready: load().catch(error => {
      release()
      throw error
    }),
    close() {
      controller.abort()
      release()
    },
  }
}
