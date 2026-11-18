export function makePreview(
  original: {
    mimeType: string
    byteLength: number
    openBytes(signal?: AbortSignal): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
  },
  metadata: { exifOrientation?: number; flickrRotation?: 0 | 90 | 180 | 270 },
  signal?: AbortSignal,
): Promise<Blob | undefined>
