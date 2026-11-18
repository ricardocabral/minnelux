import type { StoreErrorCode } from './contract.ts'

export function storeError(code: StoreErrorCode, status?: number): Error & {code: StoreErrorCode; status?: number} {
  return Object.assign(new Error(code), status === undefined ? {code} : {code, status})
}

export function checkCancellation(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason: unknown = signal.reason
  if (reason instanceof Error && 'code' in reason && reason.code === 'expired') throw reason
  throw storeError('aborted')
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function lengthBound(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
  exactBytes?: number,
): ReadableStream<Uint8Array> {
  let size = 0
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      checkCancellation(signal)
      size += chunk.byteLength
      if (size > maxBytes) throw storeError('limit')
      if (exactBytes !== undefined && size > exactBytes) throw storeError('invalidResponse')
      controller.enqueue(chunk)
    },
    flush() {
      checkCancellation(signal)
      if (exactBytes !== undefined && size !== exactBytes) throw storeError('invalidResponse')
    },
  }), {signal})
}

export async function boundedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
  exactBytes?: number,
): Promise<Blob> {
  checkCancellation(signal)
  try {
    const value = await new Response(lengthBound(body, maxBytes, signal, exactBytes)).blob()
    checkCancellation(signal)
    return value
  } catch (error) {
    checkCancellation(signal)
    throw error
  }
}
