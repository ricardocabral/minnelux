import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, openAsBlob } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs, promisify } from 'node:util'
import { createGcsStore } from './gcs.mjs'
import { readJpegMetadata } from './jpeg.mjs'
import { prepareFlickrImport } from './plan.mjs'
import { displayRotation, maxPreviewBytes, maxPreviewSize, previewImageTypes, readPreviewImage } from './preview.mjs'
import { createFlickrRepository } from './repository.mjs'
import { scanFlickrZip } from './zip.mjs'

const run = promisify(execFile)
const usage = `Usage:
  npm run import:flickr -- --bucket BUCKET --source SOURCE [--prefix library] [--label LABEL] [--account ACCOUNT] [--no-thumbnails] ZIP...
  npm run import:flickr -- --bucket BUCKET [--prefix library] [--account ACCOUNT] --list-sources

Publishes each ZIP as a separate checkpoint. Rerun with the same source and
ZIPs to skip completed uploads and finish any unpublished parts.
Uses the configured Google Cloud CLI credentials. Requires ImageMagick for
photo thumbnails. Use --no-thumbnails to import originals without previews.
`

async function stageUpload(bytes, type, signal) {
  const dir = await mkdtemp(join(tmpdir(), 'minnelux-flickr-'))
  const path = join(dir, 'upload')
  const dispose = () => rm(dir, { recursive: true, force: true })
  try {
    await pipeline(Readable.fromWeb(bytes), createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal })
    return { body: await openAsBlob(path, { type }), dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

async function makePhotoPreview(directory, original, metadata, signal) {
  const type = original.mimeType
  if (!previewImageTypes.has(type) || original.byteLength > maxPreviewBytes) return
  const bytes = await new Response(await original.openBytes(signal)).blob()
  const image = await readPreviewImage(bytes, type)
  if (!image) return
  if (image.orientation) metadata.exifOrientation = image.orientation
  const coder = type.slice('image/'.length)
  const thumbnail = await new Promise((resolve, reject) => {
    const child = execFile('magick', [
      '-limit', 'memory', '128MiB', '-limit', 'map', '256MiB', '-limit', 'disk', '512MiB',
      '-limit', 'thread', '2', `${coder}:-[0]`, '-auto-orient', '-rotate', String(displayRotation(metadata)),
      '-thumbnail', `${maxPreviewSize}x${maxPreviewSize}>`, '-strip', '-quality', '78', 'webp:-',
    ], { encoding: 'buffer', maxBuffer: 1024 ** 2, timeout: 30000, signal }, (error, stdout) => {
      if (error) reject(new Error('Could not generate thumbnail'))
      else resolve(stdout)
    })
    // Decoder failures are reported by execFile. Closing its input early can raise EPIPE.
    child.stdin.on('error', () => {})
    pipeline(Readable.fromWeb(bytes.stream()), child.stdin, { signal }).catch(error => {
      if (error.code !== 'EPIPE') reject(error)
    })
  })
  if (!thumbnail.length) return
  const path = join(directory, randomUUID())
  await writeFile(path, thumbnail, { flag: 'wx', mode: 0o600, signal })
  return openAsBlob(path, { type: 'image/webp' })
}

export async function importArchives({
  files, store, sourceKey, prefix = 'library', label = 'Flickr archive', thumbnails = true, signal,
  onEvent = () => {},
}) {
  const outcomes = []
  for (const [index, file] of files.entries()) {
    signal?.throwIfAborted()
    const progress = event => onEvent({ zip: index + 1, ...event })
    progress({ total: files.length, phase: 'scanning' })
    const part = await scanFlickrZip(await openAsBlob(file), { signal })
    const directory = thumbnails ? await mkdtemp(join(tmpdir(), 'minnelux-flickr-previews-')) : undefined
    try {
      const repository = createFlickrRepository(store, { prefix, stageUpload })
      const base = await repository.readFlickrImport(sourceKey, signal)
      const { preview, plan } = await prepareFlickrImport(base, [part], {
        binding: { sourceKey, label },
        openObject: (ref, readSignal) => repository.openImportObject(base.baseToken, ref, readSignal),
        readEmbeddedJpeg: readJpegMetadata,
        makePreview: directory ? makePhotoPreview.bind(null, directory) : undefined,
        signal,
      })
      const counts = Object.fromEntries(Object.entries(preview).map(([name, items]) => [name, items.length]))
      progress({ total: files.length, phase: 'publishing', counts })
      const onProgress = ({ completed, total }) => {
        if (completed === total || completed % 100 === 0) {
          progress({ phase: 'uploading', completed, total })
        }
      }

      let mode = 'publish'
      let result = await repository.publishFlickrImport(plan, { signal, onProgress })
      for (let attempt = 0; attempt < 2; attempt++) {
        if (result.status !== 'outcomeUnknown' && !(result.status === 'failed' && result.code === 'storage')) break
        if (result.status === 'outcomeUnknown') mode = 'recover'
        await delay(500 * 2 ** attempt, undefined, { signal })
        result = await repository.publishFlickrImport(plan, { mode, signal, onProgress })
      }
      progress({ total: files.length, ...result })
      signal?.throwIfAborted()
      if (result.status !== 'published' && result.status !== 'unchanged') {
        throw new Error(`ZIP ${index + 1} ${result.status}${result.code ? ` (${result.code})` : ''}. Rerun with the same source and ZIPs.`)
      }
      outcomes.push(result)
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }
  return outcomes
}

function cloudStore(bucket, account) {
  let current
  let refreshAt = 0
  let pending
  async function getToken(signal) {
    if (current && Date.now() < refreshAt) return current
    pending ??= run('gcloud', ['auth', 'print-access-token', '--quiet', '--account=' + account], { signal, timeout: 60000 })
      .then(({ stdout }) => {
        current = stdout.trim()
        if (!current || /\s/.test(current)) throw new Error('Google Cloud CLI returned an invalid access token')
        refreshAt = Date.now() + 5 * 60 * 1000
        return current
      })
      .catch(() => { throw Object.assign(new Error('Google Cloud CLI authentication failed'), { code: 'expired' }) })
      .finally(() => { pending = undefined })
    return pending
  }
  async function request(url, options) {
    const timeout = AbortSignal.timeout(300000)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const response = await fetch(url, { ...options, signal })
    if (response.status !== 401 || !options.headers?.has?.('Authorization')) return response
    await response.body?.cancel()
    if (options.headers.get('Authorization') === `Bearer ${current}`) refreshAt = 0
    const headers = new Headers(options.headers)
    headers.set('Authorization', `Bearer ${await getToken(signal)}`)
    return fetch(url, { ...options, headers, signal })
  }
  return createGcsStore(bucket, getToken, { fetch: request, resumable: true })
}

async function main(args, signal) {
  const { values, positionals: files } = parseArgs({
    args, allowPositionals: true,
    options: {
      bucket: { type: 'string' }, source: { type: 'string' }, prefix: { type: 'string' },
      label: { type: 'string' }, account: { type: 'string' }, 'no-thumbnails': { type: 'boolean' },
      'list-sources': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    process.stdout.write(usage)
    return
  }
  const listSources = values['list-sources'] ?? false
  if (!values.bucket || (listSources ? values.source || files.length : !values.source || !files.length)) {
    throw new Error('Pass a bucket, source key, and ZIP files, or use --list-sources. See --help.')
  }
  let account = values.account
  if (!account) {
    try {
      const { stdout } = await run('gcloud', ['config', 'get-value', 'account', '--quiet'], { signal, timeout: 10000 })
      account = stdout.trim()
    } catch {
      throw new Error('Could not read the active Google Cloud CLI account. Configure gcloud or pass --account.')
    }
  }
  if (!account || account === '(unset)') throw new Error('Select a Google Cloud CLI account before importing.')
  const store = cloudStore(values.bucket, account)
  const prefix = values.prefix ?? 'library'
  if (listSources) {
    const sources = await createFlickrRepository(store, { prefix }).listFlickrSources(signal)
    console.log(JSON.stringify(sources.map(({ sourceKey, label }) => ({ sourceKey, label }))))
    return
  }
  const thumbnails = !values['no-thumbnails']
  if (thumbnails) {
    try {
      await run('magick', ['-version'], { signal, timeout: 10000 })
    } catch {
      throw new Error('ImageMagick is required for thumbnails. Install it or pass --no-thumbnails.')
    }
  }
  await importArchives({
    files, store, prefix, thumbnails, signal, sourceKey: values.source, label: values.label,
    onEvent: event => console.log(JSON.stringify(event)),
  })
}

if (import.meta.main) {
  const stop = new AbortController()
  process.once('SIGINT', () => stop.abort())
  process.once('SIGTERM', () => stop.abort())
  try {
    await main(process.argv.slice(2), stop.signal)
  } catch (error) {
    console.error(stop.signal.aborted ? 'Import interrupted. Rerun with the same source and ZIPs.' : error.message)
    process.exitCode = stop.signal.aborted ? 130 : 1
  }
}
