import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readPreviewImage } from './preview.mjs'
import { createFlickrRepository } from './repository.mjs'
import { importArchives } from './cli.mjs'

test('publishes an export one ZIP at a time and restarts from saved parts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'flickr-cli-fixture-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const jpeg = await readFile(new URL('./test-fixtures/photo.jpg', import.meta.url))
  // A large original exercises the file-backed staging path. Trailing padding
  // keeps the same real JPEG header and allows the fixture to compress cheaply.
  const bytes = Buffer.concat([jpeg, Buffer.alloc(17 * 1024 ** 2)])
  const { ZipWriter, BlobWriter, BlobReader } = await import('@zip.js/zip.js')
  for (const [name, entry, body] of [
    ['metadata', 'photo_123.json', '{"id":"123","name":"CLI fixture"}'],
    ['original', 'fixture_123_o.jpg', bytes],
  ]) {
    const writer = new ZipWriter(new BlobWriter())
    await writer.add(entry, new BlobReader(new Blob([body])))
    await writeFile(join(directory, name + '.zip'), new Uint8Array(await (await writer.close()).arrayBuffer()))
  }
  const files = ['metadata.zip', 'original.zip'].map(name => join(directory, name))
  const objects = new Map()
  let writes = 0
  const store = {
    libraryId: 'synthetic',
    async get(key) { return objects.get(key) ?? null },
    async put(key, body, { match }) {
      if (match !== (objects.get(key)?.generation ?? '0')) {
        throw Object.assign(new Error('precondition'), { status: 412 })
      }
      const generation = String(++writes)
      objects.set(key, { generation, body: new Blob([await body.arrayBuffer()], { type: body.type }) })
      return { generation }
    },
  }
  const thumbnails = spawnSync('magick', ['-version']).status === 0
  const options = { files, store, sourceKey: 'fixture', thumbnails }
  const checkpoint = await importArchives({ ...options, files: files.slice(0, 1) })
  assert.deepEqual(checkpoint.map(item => item.status), ['published'])
  const result = await importArchives(options)
  assert.deepEqual(result.map(item => item.status), ['unchanged', 'published'])
  const repository = createFlickrRepository(store)
  const saved = await repository.readFlickrImport('fixture')
  assert.equal(saved.assets.length, 1)
  assert.equal(saved.assets[0].metadata.title, 'CLI fixture')
  if (thumbnails) {
    const [preview] = saved.assets[0].previews
    assert.equal(preview.mimeType, 'image/webp')
    const stream = await repository.openImportObject(saved.baseToken, preview)
    const image = await readPreviewImage(await new Response(stream).blob(), preview.mimeType)
    assert.ok(image && Math.max(image.width, image.height) <= 360)
  }
  const original = await repository.openImportObject(saved.baseToken, saved.assets[0].original)
  assert.deepEqual(await new Response(original).bytes(), new Uint8Array(bytes))
  const previousWrites = writes
  assert.deepEqual((await importArchives(options)).map(item => item.status), ['unchanged', 'unchanged'])
  assert.equal(writes, previousWrites)
})

test('the executable exposes its usage without contacting Google Cloud', () => {
  const output = execFileSync(process.execPath, ['cli.mjs', '--help'], { cwd: new URL('.', import.meta.url), encoding: 'utf8' })
  assert.match(output, /--bucket .+--source/)
})

test('reports an unreadable ZIP without disclosing the supplied path', () => {
  const privateFilename = 'synthetic-private-flickr-archive.zip'
  const result = spawnSync(process.execPath, [
    'cli.mjs', '--bucket', 'fixture-bucket', '--source', 'fixture',
    '--account', 'fixture', '--no-thumbnails', '--', privateFilename,
  ], { cwd: new URL('.', import.meta.url), encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Could not read ZIP 1/)
  assert.ok(!result.stderr.includes(privateFilename))
})
