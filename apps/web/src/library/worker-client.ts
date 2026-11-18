import {
  libraryProtocolVersion,
  type LibraryClient,
  type LibraryOperation,
  type LibraryReply,
  type LibraryRequests,
} from './worker-contract.ts'

type Port = {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

type Pending = {
  operation: LibraryOperation
  resolve(value: unknown): void
  reject(reason: unknown): void
}

export function connectLibraryClient(
  port: Port,
  sessionId: string,
  onExpired?: () => void,
): LibraryClient & { close(): void; hasUnconfirmedPublication(): boolean } {
  const pending = new Map<string, Pending>()
  let closed = false
  let uncertainPublication = false

  function receive({ data }: MessageEvent<LibraryReply>) {
    if (data?.version !== libraryProtocolVersion || data.sessionId !== sessionId) return
    const request = pending.get(data.requestId)
    if (!request || request.operation !== data.operation || data.status === 'progress') return
    if (data.status === 'error') {
      request.reject(Object.assign(new Error(data.code), { code: data.code }))
      if (data.code === 'expired') onExpired?.()
      return
    }
    if (data.operation === 'publish') {
      if (data.value.status === 'outcomeUnknown') uncertainPublication = true
      if (data.value.status === 'published' || data.value.status === 'unchanged') uncertainPublication = false
    }
    request.resolve(data.value)
    if (data.operation === 'publish' &&
      (data.value.status === 'failed' || data.value.status === 'outcomeUnknown') &&
      data.value.code === 'expired') onExpired?.()
  }

  port.addEventListener('message', receive)
  if ('start' in port && typeof port.start === 'function') port.start()

  function send<Name extends LibraryOperation>(
    operation: Name,
    input: LibraryRequests[Name]['input'],
    signal?: AbortSignal,
  ): Promise<LibraryRequests[Name]['output']> {
    return new Promise((resolve, reject) => {
      if (closed) throw new DOMException('Library session closed', 'AbortError')
      signal?.throwIfAborted()
      const requestId = crypto.randomUUID()
      const envelope = { version: libraryProtocolVersion, sessionId, requestId }

      function finish() {
        pending.delete(requestId)
        signal?.removeEventListener('abort', abort)
      }

      function abort() {
        finish()
        reject(signal?.reason)
        port.postMessage({
          ...envelope,
          requestId: crypto.randomUUID(),
          operation: 'cancel',
          input: { requestId },
        })
      }

      pending.set(requestId, {
        operation,
        resolve(value) {
          finish()
          resolve(value as LibraryRequests[Name]['output'])
        },
        reject(reason) {
          finish()
          reject(reason)
        },
      })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        port.postMessage({ ...envelope, operation, input })
      } catch (error) {
        finish()
        reject(error)
      }
    })
  }

  return {
    open: (signal) => send('open', null, signal),
    query: (query, signal) => send('query', query, signal),
    readRange: (handle, offset, limit, signal) => send('readRange', { handle, offset, limit }, signal),
    readAsset: (handle, assetId, signal) => send('readAsset', { handle, assetId }, signal),
    readOriginal: (handle, assetId, signal) => send('readOriginal', { handle, assetId }, signal),
    readPreview: (assetId, signal) => send('readPreview', { assetId }, signal),
    readAlbumCover: (tagId, signal) => send('readAlbumCover', { tagId }, signal),
    release: (handle) => send('release', { handle }),
    publish: (intent, options) => send('publish', { intent, mode: options?.mode }, options?.signal),
    hasUnconfirmedPublication() {
      return uncertainPublication || Array.from(pending.values()).some(item => item.operation === 'publish')
    },
    close() {
      closed = true
      port.removeEventListener('message', receive)
      const reason = new DOMException('Library session closed', 'AbortError')
      for (const request of pending.values()) request.reject(reason)
    },
  }
}
