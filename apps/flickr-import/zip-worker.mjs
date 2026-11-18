import { createZipBudget, scanFlickrZip } from './zip.mjs'

const batches = new Map()
const budget = createZipBudget()
self.onmessage = async ({ data }) => {
  try {
    if (data.kind === 'scan') {
      const { partId, members } = await scanFlickrZip(data.file, { budget })
      batches.set(data.id, members)
      self.postMessage({
        id: data.id,
        value: {
          partId,
          members: members.map(({ openBytes, ...entry }, index) => ({
            ...entry,
            readable: Boolean(openBytes),
            index,
          })),
        },
      })
      return
    }

    const member = batches.get(data.scanId)?.[data.index]
    if (data.kind !== 'open' || typeof member?.openBytes !== 'function') {
      throw Object.assign(new Error('No readable ZIP entry'), { code: 'unreadable-entry' })
    }
    const stream = await member.openBytes()
    try {
      self.postMessage({ id: data.id, value: stream }, [stream])
    } catch {
      const reader = stream.getReader()
      const { port1, port2 } = new MessageChannel()
      port1.onmessage = async ({ data: command }) => {
        try {
          if (command === 'cancel') {
            await reader.cancel()
            return port1.close()
          }
          const { value, done } = await reader.read()
          if (done) {
            port1.postMessage({ done })
            return port1.close()
          }
          const chunk = value.slice()
          port1.postMessage({ value: chunk }, [chunk.buffer])
        } catch {
          port1.postMessage({ error: 'unreadable-entry' })
          port1.close()
        }
      }
      self.postMessage({ id: data.id, value: port2 }, [port2])
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: error.code ?? 'archive-failed' })
  }
}
