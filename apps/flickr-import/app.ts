import {
  createFlickrRepository, createGcsStore, downscopeGcsToken, makePreview, prepareFlickrImport, scanZipFiles,
} from './importer.mjs'

const input = (id: string) => document.getElementById(id) as HTMLInputElement
const button = (id: string) => document.getElementById(id) as HTMLButtonElement
const node = (id: string) => document.getElementById(id)!
const account = document.getElementById('source') as HTMLSelectElement
const files = input('archives')
const newSource = ''
let session
let selection
let prepared
let busy = false
let signInRequest = 0
let signInAbort
let expiryTimer
let recovery
const renderedUrls = new Set<string>()

const options = new URLSearchParams(location.search)
input('bucket').value = options.get('bucket') ?? ''
input('oauth').value = options.get('client_id') ?? ''

const authScript = document.createElement('script')
authScript.src = 'https://accounts.google.com/gsi/client'
authScript.async = true
authScript.referrerPolicy = 'no-referrer'
document.head.append(authScript)

function status(message: string, isError = false) {
  node('status').textContent = message
  node('status').classList.toggle('error', isError)
}

function showControls() {
  button('preview').disabled = busy || session?.access !== 'editor'
  button('publish').disabled = busy
  button('reopen').disabled = busy || account.value === newSource
  button('disconnect').hidden = !session
  files.disabled = busy || session?.access !== 'editor'
  input('label').disabled = busy
  for (const select of node('reviews').querySelectorAll('select')) select.disabled = busy || Boolean(prepared?.recover)
  account.disabled = busy
  node('label-field').hidden = account.value !== newSource
  node('source-section').hidden = !session
}

function clearMediaUrls() {
  for (const url of renderedUrls) URL.revokeObjectURL(url)
  renderedUrls.clear()
}

function clearPreview() {
  clearMediaUrls()
  selection?.close()
  selection = undefined
  prepared = undefined
  node('counts').replaceChildren()
  node('reviews').replaceChildren()
  node('results').hidden = true
}

function disconnect(message = 'Disconnected.', preserveRecovery = false) {
  if (!preserveRecovery) recovery = undefined
  clearTimeout(expiryTimer)
  signInRequest++
  signInAbort?.abort()
  signInAbort = undefined
  session?.abort.abort()
  session = undefined
  busy = false
  clearPreview()
  files.value = ''
  input('label').value = 'Flickr archive'
  account.replaceChildren()
  showControls()
  status(message)
}

async function loadAccounts(active, selected?: string) {
  const sources = await active.repository.listFlickrSources(active.abort.signal)
  if (session !== active) return
  const choices = sources.map((source) => new Option(source.label, source.sourceKey))
  if (active.access === 'editor') choices.push(new Option('New Flickr source', newSource))
  account.replaceChildren(...choices)
  if (selected && sources.some((source) => source.sourceKey === selected)) account.value = selected
  else if (active.access === 'editor' && !sources.length) account.value = newSource
}

function connect(access: 'reader' | 'editor') {
  disconnect('Waiting for Google sign-in…', true)
  const browser = window as typeof window & { google?: any }
  if (!browser.google?.accounts?.oauth2) {
    status('Google sign-in is loading. Try again in a moment.', true)
    return
  }
  const bucket = input('bucket').value.trim()
  const prefix = input('prefix').value.trim()
  const clientId = input('oauth').value.trim()
  if (!bucket || !prefix || !clientId) {
    status('Enter a bucket, library prefix, and Google OAuth web client ID.', true)
    return
  }
  if (recovery && (recovery.bucket !== bucket || recovery.prefix !== prefix)) recovery = undefined
  const requestId = signInRequest
  const scope = 'https://www.googleapis.com/auth/devstorage.' + (access === 'editor' ? 'read_write' : 'read_only')
  const client = browser.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope,
    include_granted_scopes: false,
    callback: async (result) => {
      if (requestId !== signInRequest) return
      const expiresAt = Date.now() + Number(result.expires_in) * 1000
      if (!result.access_token || !Number.isFinite(expiresAt) || expiresAt <= Date.now() ||
          !result.scope?.split(/\s+/).includes(scope)) {
        status('Google did not grant the requested Cloud Storage scope.', true)
        return
      }
      const abort = new AbortController()
      signInAbort = abort
      try {
        const token = await downscopeGcsToken(result.access_token, bucket, prefix, access, { signal: abort.signal })
        if (requestId !== signInRequest) return
        const repository = createFlickrRepository(createGcsStore(bucket, () => session === active ? token : undefined), { prefix })
        const active = { repository, abort, access, bucket, prefix }
        session = active
        expiryTimer = setTimeout(() => {
          if (session === active) disconnect('Your session expired. Sign in again to continue.', true)
        }, Math.max(0, expiresAt - Date.now()))
        await loadAccounts(active, recovery?.sourceKey)
        if (session !== active) return
        if (recovery) {
          const base = await repository.readFlickrImport(recovery.sourceKey, abort.signal)
          if (session !== active) return
          const receipt = base.receipts.find((entry) => entry.operationId === recovery.operationId)
          status(receipt ? 'The earlier import was published.' : 'The earlier publication is still unconfirmed. Preview any remaining ZIPs against the current library.', !receipt)
          recovery = undefined
        } else {
          status(access === 'editor' ? 'Connected for import.' : 'Connected for viewing.')
        }
        showControls()
      } catch (error) {
        if (requestId !== signInRequest) return
        disconnect(errorMessage(error, 'Could not connect to private storage'), true)
        node('status').classList.add('error')
      }
    },
    error_callback: () => {
      if (requestId === signInRequest) status('Google sign-in closed. Select the sign-in button to retry.', true)
    },
  })
  client.requestAccessToken()
}

const countLabels = {
  matched: 'Matched originals',
  metadataOnly: 'Sidecars awaiting media',
  mediaOnly: 'Media without sidecars',
  albumReferenceOnly: 'Album references awaiting an item',
  ambiguous: 'Ambiguous media',
  duplicates: 'Duplicate candidates',
  invalidMetadata: 'Invalid entries',
  unsupportedMedia: 'Unsupported media',
  albumDisagreements: 'Album disagreements',
  unresolvedAlbums: 'Unresolved albums',
  photoConflicts: 'Photo metadata conflicts',
  albumConflicts: 'Album document conflicts',
  previewErrors: 'Previews unavailable',
}

function countCards(counts) {
  const values = document.createElement('dl')
  values.className = 'stats'
  for (const [label, count] of Object.entries(counts)) {
    const card = document.createElement('div')
    const title = document.createElement('dt')
    const value = document.createElement('dd')
    title.textContent = label
    value.textContent = String(count)
    card.append(title, value)
    values.append(card)
  }
  node('counts').replaceChildren(values)
}

function choose(labelText: string, choices, selected, fn: (member) => void) {
  const label = document.createElement('label')
  label.textContent = labelText
  const select = document.createElement('select')
  select.append(new Option('Defer this choice', ''))
  for (const [index, { name }] of choices.entries()) select.append(new Option(name, String(index)))
  const current = choices.findIndex((choice) => JSON.stringify(choice.member) === JSON.stringify(selected))
  if (current !== -1) select.value = String(current)
  select.onchange = () => fn(select.value === '' ? undefined : choices[Number(select.value)].member)
  label.append(select)
  node('reviews').append(label)
}

function showPreview(context) {
  const { preview, base, decisions } = context
  node('result-heading').textContent = 'Import preview'
  countCards(Object.fromEntries(Object.entries(countLabels).map(([key, label]) => [label, preview[key].length])))
  node('reviews').replaceChildren()
  const makeChoices = (part, key, choices) => (member) => {
    if (member) decisions[part][key] = member
    else delete decisions[part][key]
    context.publishPlan = undefined
    refreshPreview(context)
  }
  const mediaReview = new Map()
  for (const item of [...preview.ambiguous, ...preview.duplicates]) {
    if (!item.photoId || base.source?.links[item.photoId]) continue
    mediaReview.set(item.photoId, item.candidates)
  }
  for (const [photoId, candidates] of mediaReview) {
    choose(`Original for Flickr item ${photoId}`, candidates.map((candidate) => ({
      name: `${candidate.filename} · entry ${candidate.member[1] + 1} · ${candidate.sha256.slice(0, 12)}`,
      member: candidate.member,
    })), decisions.originals[photoId], makeChoices('originals', photoId, candidates))
  }
  for (const item of preview.ambiguous) {
    if (item.photoId) continue
    for (const candidate of item.candidates) {
      const label = document.createElement('label')
      label.textContent = `Flickr ID for ${candidate.filename} · entry ${candidate.member[1] + 1}`
      const id = document.createElement('input')
      id.inputMode = 'numeric'
      id.pattern = '[0-9]+'
      id.required = true
      const link = document.createElement('button')
      link.type = 'button'
      link.textContent = 'Use Flickr ID'
      link.onclick = () => {
        if (!id.reportValidity()) return
        if (base.source?.links[id.value]) return status('That Flickr ID already has a confirmed original.', true)
        makeChoices('originals', id.value, null)(candidate.member)
      }
      label.append(id, link)
      node('reviews').append(label)
    }
  }
  for (const [part, conflicts] of [['photos', preview.photoConflicts], ['albums', preview.albumConflicts]]) {
    for (const item of conflicts) {
      choose(`Source record for Flickr ${item.id}`, item.members.map((member) => ({
        name: `Archive ${member[0].slice(0, 12)} · entry ${member[1] + 1}`,
        member,
      })), decisions[part][item.id] ?? item.selected, makeChoices(part, item.id, item.members))
    }
  }
  const issues = [...preview.invalidMetadata, ...preview.unsupportedMedia]
  for (const issue of issues.slice(0, 20)) {
    const message = document.createElement('p')
    message.textContent = `${issue.filename} · ${issue.reason}`
    node('reviews').append(message)
  }
  node('results').hidden = false
  button('publish').hidden = false
}

function errorMessage(error, context: string) {
  if (error?.name === 'AbortError') return 'Operation cancelled.'
  if (error?.status === 401 || error?.code === 'expired') return 'Your session ended. Sign in again to continue.'
  if (error?.status === 403) return 'Cloud Storage denied access to this library.'
  return `${context}. ${error?.message ?? ''}`.trim()
}

async function withSession(work) {
  const active = session
  if (!active || busy) return
  busy = true
  showControls()
  try {
    await work(active)
  } catch (error) {
    if (session === active) {
      if (error?.code === 'expired' || error?.status === 401) {
        disconnect('Your session expired. Sign in again to continue.', true)
      } else {
        status(errorMessage(error, 'The operation could not finish'), true)
      }
    }
  } finally {
    if (session === active) {
      busy = false
      showControls()
    }
  }
}

async function refreshPreview(context) {
  await withSession(async (active) => {
    if (context.active !== active) return
    status('Updating the preview…')
    const update = await prepare(context, false)
    if (session !== active) return
    context.preview = update.preview
    showPreview(context)
    status('Review the proposed import.')
  })
}

async function prepare(context, withPreviews: boolean) {
  const { active, base, binding, decisions, parts } = context
  return prepareFlickrImport(base, parts, {
    binding,
    decisions,
    openObject: (ref, signal) => active.repository.openImportObject(base.baseToken, ref, signal),
    makePreview: withPreviews ? makePreview : undefined,
    operationId: crypto.randomUUID(),
    signal: active.abort.signal,
    onProgress: withPreviews ? ({ phase, completed, total }) => {
      if (session === active && phase === 'preparing') status(`Preparing ${completed} of ${total} items…`)
    } : undefined,
  })
}

button('sign-in').onclick = () => connect('editor')
button('read-only').onclick = () => connect('reader')
button('disconnect').onclick = () => disconnect()
for (const id of ['bucket', 'prefix', 'oauth']) {
  input(id).oninput = () => disconnect('Storage settings changed. Sign in again.')
}
account.onchange = () => {
  clearPreview()
  files.value = ''
  input('label').value = 'Flickr archive'
  showControls()
}
files.onchange = () => { clearPreview(); showControls() }
input('label').oninput = clearPreview

button('preview').onclick = () => withSession(async (active) => {
  if (active.access !== 'editor') return
  clearPreview()
  const selected = Array.from(files.files ?? [])
  if (!selected.length && account.value === newSource) throw new Error('Select one or more Flickr ZIPs.')
  const sourceKey = account.value || crypto.randomUUID()
  const binding = account.value ? undefined : { sourceKey, label: input('label').value.trim() || 'Flickr archive' }
  status('Reading Flickr ZIPs…')
  const base = await active.repository.readFlickrImport(sourceKey, active.abort.signal)
  const scanned = selected.length ? await scanZipFiles(selected, {
    signal: active.abort.signal,
    onProgress: ({ completed, total }) => { if (session === active) status(`Read ${completed} of ${total} ZIP files…`) },
  }) : { parts: [], close() {} }
  if (session !== active) return scanned.close()
  selection = scanned
  const context = { active, base, binding, parts: scanned.parts, decisions: { originals: {}, photos: {}, albums: {} } }
  const { preview } = await prepare(context, false)
  if (session !== active) return
  prepared = { ...context, preview }
  showPreview(prepared)
  status('Review the proposed import.')
})

button('publish').onclick = () => withSession(async (active) => {
  if (!prepared || prepared.active !== active) return
  const context = prepared
  if (!context.publishPlan) {
    status('Preparing originals and previews…')
    context.publishPlan = (await prepare(context, true)).plan
  }
  status('Uploading and publishing the library revision…')
  recovery = {
    bucket: active.bucket,
    prefix: active.prefix,
    sourceKey: context.publishPlan.sourceKey,
    operationId: context.publishPlan.operationId,
  }
  const result = await active.repository.publishFlickrImport(context.publishPlan, {
    signal: active.abort.signal,
    mode: context.recover ? 'recover' : 'publish',
    onProgress: ({ completed, total }) => {
      if (session === active && (completed % 25 === 0 || completed === total)) {
        status(`Uploaded ${completed} of ${total} objects…`)
      }
    },
  })
  if (session !== active) return
  if (result.status === 'published' || result.status === 'unchanged') {
    recovery = undefined
    const sourceKey = context.publishPlan.sourceKey
    clearPreview()
    files.value = ''
    await loadAccounts(active, sourceKey)
    status(result.status === 'published' ? 'Import published. You can reopen it from storage.' : 'These files were already imported.')
  } else if (result.status === 'outcomeUnknown') {
    if (result.code === 'expired') {
      disconnect('Your session expired. Sign in again to check the publication.', true)
      return
    }
    context.recover = true
    status('Publication could not be confirmed. Select Publish import to check the same operation again.', true)
  } else if (result.status === 'stale') {
    recovery = undefined
    clearPreview()
    status('The library changed. Preview the selected ZIPs again before publishing.', true)
  } else {
    recovery = undefined
    if (result.code === 'expired') {
      disconnect('Your session expired. Sign in again to continue.')
      return
    }
    status(`Could not publish the import (${result.code}). The last confirmed revision is still available.`, true)
  }
})

button('reopen').onclick = () => withSession(async (active) => {
  clearPreview()
  const base = await active.repository.readFlickrImport(account.value, active.abort.signal)
  if (session !== active) return
  node('result-heading').textContent = 'Published Flickr assets'
  countCards({
    'Assets': base.assets.length,
    'Album and keyword tags': base.tags.length,
    'Saved source records': Object.keys(base.source?.photos ?? {}).length,
  })
  const library = document.createElement('div')
  const filter = document.createElement('label')
  filter.textContent = 'Filter by imported tag'
  const tagSelect = document.createElement('select')
  tagSelect.append(new Option('All tags', ''))
  for (const tag of base.tags) tagSelect.append(new Option(`${tag.title} · ${tag.source.kind}`, tag.id))
  filter.append(tagSelect)
  library.append(filter)
  const listing = document.createElement('div')
  library.append(listing)
  node('reviews').append(library)
  const size = 20
  let page = 0
  function renderPage() {
    clearMediaUrls()
    listing.replaceChildren()
    const selected = tagSelect.value ? base.assets.filter((asset) => asset.tagIds.includes(tagSelect.value)) : base.assets
    const list = document.createElement('ul')
    list.className = 'assets'
    for (const asset of selected.slice(page * size, (page + 1) * size)) {
      const row = document.createElement('li')
      const title = document.createElement('span')
      title.textContent = asset.metadata.title || asset.filename
      row.append(title)
      const fetchAsset = async (ref) => {
        const bytes = await active.repository.openImportObject(base.baseToken, ref, active.abort.signal)
        return new Response(bytes, { headers: { 'Content-Type': ref.mimeType } }).blob()
      }
      if (asset.previews[0]) {
        const thumb = document.createElement('button')
        thumb.className = 'secondary'
        thumb.textContent = 'Load preview'
        thumb.onclick = () => withSession(async () => {
          const blob = await fetchAsset(asset.previews[0])
          if (session !== active || !row.isConnected) return
          const image = document.createElement('img')
          image.alt = title.textContent ?? ''
          const url = URL.createObjectURL(blob)
          renderedUrls.add(url)
          image.src = url
          thumb.replaceWith(image)
        })
        row.append(thumb)
      }
      const download = document.createElement('button')
      download.className = 'secondary'
      download.textContent = 'Download original'
      download.onclick = () => withSession(async () => {
        const blob = await fetchAsset(asset.original)
        if (session !== active || !row.isConnected) return
        const element = document.createElement('a')
        const url = URL.createObjectURL(blob)
        renderedUrls.add(url)
        element.href = url
        element.download = asset.filename
        element.click()
        setTimeout(() => {
          URL.revokeObjectURL(url)
          renderedUrls.delete(url)
        }, 10_000)
      })
      row.append(download)
      list.append(row)
    }
    listing.append(list)
    const pages = Math.max(1, Math.ceil(selected.length / size))
    const position = document.createElement('p')
    position.textContent = `${selected.length} assets · Page ${page + 1} of ${pages}`
    listing.append(position)
    for (const [label, offset] of [['Previous', -1], ['Next', 1]] as const) {
      const control = document.createElement('button')
      control.className = 'secondary'
      control.textContent = label
      control.disabled = page + offset < 0 || page + offset >= pages
      control.onclick = () => { page += offset; renderPage() }
      listing.append(control)
    }
  }
  tagSelect.onchange = () => { page = 0; renderPage() }
  renderPage()
  node('results').hidden = false
  button('publish').hidden = true
  status('Opened the published revision from storage.')
})

showControls()
