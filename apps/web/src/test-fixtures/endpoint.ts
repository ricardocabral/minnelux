import type { IncomingMessage, ServerResponse } from 'node:http'
import fixture from '../library/fixtures/flickr-v1.json' with { type: 'json' }

type Entry = { bytes: Buffer; mimeType: string; version: string }

export function fixtureEndpoint() {
  const objects = new Map<string, Entry>(Object.entries(fixture).map(([key, entry]) => [key, {
    bytes: Buffer.from(entry.base64, 'base64'),
    mimeType: entry.mimeType,
    version: `"${entry.generation}"`,
  }]))
  let generation = objects.size
  function put(key: string, bytes: Buffer, mimeType: string) {
    const entry = { bytes, mimeType, version: `"${++generation}"` }
    objects.set(key, entry)
    return entry
  }

  return async function serve(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (url.pathname !== '/__minnelux_fixture') return next()
    const key = url.searchParams.get('key') ?? ''
    const view = url.searchParams.get('view')
    res.setHeader('Cache-Control', 'no-store')

    function status(code: number) {
      res.statusCode = code
      res.end()
    }

    if (req.method === 'PUT') {
      const chunks: Buffer[] = []
      let size = 0
      try {
        for await (const chunk of req) {
          size += chunk.length
          if (size > 16 * 1024 * 1024) return status(413)
          chunks.push(chunk)
        }
      } catch {
        return status(400)
      }
      const prior = objects.get(key)
      if (req.headers['if-none-match'] === '*' ? Boolean(prior) :
        !prior || req.headers['if-match'] !== prior.version) return status(412)
      const entry = put(key, Buffer.concat(chunks), req.headers['content-type'] ?? 'application/octet-stream')
      res.setHeader('ETag', entry.version)
      return status(204)
    }

    if (req.method !== 'GET') return status(405)
    if (view === 'list') {
      const offset = Number(url.searchParams.get('cursor') ?? '0')
      const keys = Array.from(objects.keys()).filter(value => value.startsWith(key)).sort()
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({
        entries: keys.slice(offset, offset + 25).map(key => {
          const entry = objects.get(key)!
          return { key, byteLength: entry.bytes.length, mimeType: entry.mimeType, observedVersion: entry.version }
        }),
        nextCursor: offset + 25 < keys.length ? String(offset + 25) : undefined,
      }))
    }
    const entry = objects.get(key)
    if (!entry) return status(404)

    res.setHeader('Content-Type', view === 'stat' ? 'application/json' : entry.mimeType)
    res.setHeader('ETag', entry.version)
    if (view === 'stat') return res.end(JSON.stringify({
      byteLength: entry.bytes.length, mimeType: entry.mimeType, observedVersion: entry.version,
    }))

    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
    let body = entry.bytes
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start > end || end >= body.length) return status(416)
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`)
      res.setHeader('X-Object-Length', body.length)
      body = body.subarray(start, end + 1)
    }
    res.setHeader('Content-Length', body.length)
    res.end(body)
  }
}
