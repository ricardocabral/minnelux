export { createGcsStore, downscopeGcsToken } from './gcs.mjs'
export { prepareFlickrImport } from './plan.mjs'
export { createFlickrRepository } from './repository.mjs'
export { makePreview } from './preview.mjs'
export { readJpegMetadata } from './jpeg.mjs'

// The worker keeps ZIP handles for the current selection. It receives archive bytes
// and never receives a storage credential.
export async function scanZipFiles(files, { signal, onProgress } = {}) {
  if (!files.length) throw new Error('Choose at least one Flickr ZIP')
  signal?.throwIfAborted()
  const worker = new Worker(new URL('./zip-worker.js', import.meta.url), { type: 'module' })
  const pending = new Map()
  let nextId = 0
  let closed = false
  const close = (reason = new DOMException('ZIP selection closed', 'AbortError')) => {
    if (closed) return
    closed = true
    worker.terminate()
    signal?.removeEventListener('abort', abort)
    for (const { reject } of pending.values()) reject(reason)
    pending.clear()
  }
  const abort = () => close(signal.reason)
  worker.addEventListener('error', () => close(new Error('Could not start the ZIP reader')))
  signal?.addEventListener('abort', abort, { once: true })
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id)
    if (!request) return
    pending.delete(data.id)
    if (data.error) request.reject(new Error(data.error))
    else request.resolve(data.value)
  }
  const request = (kind, fields) => {
    if (closed) throw new DOMException('ZIP selection closed', 'AbortError')
    const id = ++nextId
    const result = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      worker.postMessage({ id, kind, ...fields })
    })
    return { id, result }
  }

  try {
    const parts = []
    for (const [position, file] of files.entries()) {
      const { id: scanId, result } = request('scan', { file })
      const part = await result
      for (const member of part.members) {
        if (!member.readable) continue
        member.openBytes = async (memberSignal) => {
          memberSignal?.throwIfAborted()
          const { result: opened } = request('open', { scanId, index: member.index })
          const body = await opened
          memberSignal?.throwIfAborted()
          return body instanceof MessagePort ? portStream(body) : body
        }
      }
      parts.push(part)
      onProgress?.({ completed: position + 1, total: files.length })
    }
    return { parts, close }
  } catch (error) {
    close()
    throw error
  }
}

function portStream(port) {
  return new ReadableStream({
    pull(controller) {
      return new Promise((resolve) => {
        port.onmessage = ({ data }) => {
          if (data.error) controller.error(new Error(data.error))
          else if (data.done) controller.close()
          else controller.enqueue(data.value)
          if (data.done || data.error) port.close()
          resolve()
        }
        port.postMessage('pull')
      })
    },
    cancel() {
      port.postMessage('cancel')
      port.close()
    },
  })
}
