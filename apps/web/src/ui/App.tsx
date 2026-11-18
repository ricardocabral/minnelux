import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useLocation } from 'react-router'
import type { LibraryClient, LibraryOverview } from '../library/worker-contract.ts'
import type { Query } from '../search/contract.ts'
import type { ConnectionSettings } from '../storage/connection.ts'
import {
  CollectionNavigation, FiltersSheet, GalleryResults, allMedia, emptyFilters, galleryQuery, libraryRoute,
  type Filters, type Scope,
} from './Gallery.tsx'
import { ImportPhoto, type PhotoIntent } from './ImportPhoto.tsx'
import { Brand, Icon, Sheet, libraryError } from './components.tsx'
import { viewerRoute } from './Viewer.tsx'
import './styles.css'

type AppProps = {
  client?: LibraryClient
  isFixture?: boolean
  connectionNotice?: string
  checkingConnection?: boolean
  durable?: boolean
  onRetrySignOut?: () => void
  onConnect?: (configuration: ConnectionSettings) => Promise<void>
  onCancelConnect?: () => void
  onOpenFixture?: () => void
  onDisconnect?: () => void
}

type ConnectionFeedback = { text: string; role: 'status' | 'alert' }
const connectionMessages = new Map<string, ConnectionFeedback>([
  ['signInReady', { text: 'Google sign-in is ready. Select Connect again.', role: 'status' }],
  ['signInUnavailable', { text: 'Google sign-in could not load. Try again.', role: 'alert' }],
  ['popupBlocked', { text: 'Allow the Cognito sign-in pop-up and try again.', role: 'alert' }],
  ['signInTimeout', { text: 'Cognito sign-in timed out. Try again.', role: 'alert' }],
  ['invalidBucket', { text: 'Enter a valid S3 bucket name.', role: 'alert' }],
])

export default function AppView({ client, isFixture, connectionNotice, checkingConnection, durable, onRetrySignOut, onConnect, onCancelConnect, onOpenFixture, onDisconnect }: AppProps) {
  return client ? <ConnectedLibrary client={client} isFixture={isFixture} onDisconnect={onDisconnect} />
    : <Connect connectionNotice={connectionNotice} checkingConnection={checkingConnection} durable={durable}
      onRetrySignOut={onRetrySignOut} onConnect={onConnect} onCancelConnect={onCancelConnect} onOpenFixture={onOpenFixture} />
}

function Connect({ connectionNotice, checkingConnection, durable, onRetrySignOut, onConnect, onCancelConnect, onOpenFixture }: Pick<AppProps,
  'connectionNotice' | 'checkingConnection' | 'durable' | 'onRetrySignOut' | 'onConnect' | 'onCancelConnect' | 'onOpenFixture'
>) {
  const { pathname } = useLocation()
  const [provider, setProvider] = useState<ConnectionSettings['provider']>('gcs')
  const [pending, setPending] = useState(false)
  const providerName = provider === 'gcs' ? 'Google Cloud Storage' : 'Amazon S3'
  const [feedback, setFeedback] = useState<ConnectionFeedback>()

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!onConnect || pending) return
    const fields = new FormData(event.currentTarget)
    const setting = (name: string) => String(fields.get(name) ?? '').trim()
    const location = { bucket: setting('bucket'), prefix: setting('prefix') }
    setPending(true)
    setFeedback(undefined)
    try {
      await onConnect(provider === 'gcs' ? {
        ...location, provider, clientId: setting('googleClientId'),
        access: fields.get('access') === 'edit' ? 'edit' : 'read',
      } : {
        ...location, provider, region: setting('region'), cognitoOrigin: setting('cognitoOrigin'),
        clientId: setting('cognitoClientId'), userPoolId: setting('userPoolId'),
        identityPoolId: setting('identityPoolId'), editorGroup: setting('editorGroup') || undefined,
      })
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      const message = typeof code === 'string' ? connectionMessages.get(code) : undefined
      setFeedback(message ?? {
        text: libraryError(error, `The ${providerName} connection failed. Check the configuration and try again.`),
        role: 'alert',
      })
    } finally {
      setPending(false)
    }
  }

  return <>
    {pathname !== '/connect' ? <Navigate to="/connect" replace /> : null}
    <header className="top connect-top"><Brand /></header>
    <main className="connect-main">
      <h1>Open your library</h1>
      {connectionNotice ? <p role="status">{connectionNotice}</p> : null}
      {checkingConnection ? (!connectionNotice ? <p role="status">Checking for a saved connection…</p> : null)
      : onRetrySignOut ? <button type="button" className="control primary" onClick={onRetrySignOut}>Retry sign-out</button>
      : onConnect ? <>
        <form className="connect-form" onSubmit={event => void connect(event)} aria-busy={pending}>
          {durable ? null : <label>Storage provider
            <select value={provider} disabled={pending} onChange={event => {
              setProvider(event.target.value === 's3' ? 's3' : 'gcs')
              setFeedback(undefined)
            }}>
              <option value="gcs">Google Cloud Storage</option>
              <option value="s3">Amazon S3</option>
            </select>
          </label>}
          <label>Bucket name <input name="bucket" required autoComplete="off" disabled={pending} /></label>
          <label>Library prefix <input name="prefix" autoComplete="off" disabled={pending} /></label>
          {provider === 'gcs' ? <>
            {durable ? null : <label>Google OAuth client ID <input key="googleClientId" name="googleClientId" required autoComplete="off" disabled={pending} /></label>}
            <label>Access
              <select name="access" disabled={pending}>
                <option value="read">Read only</option>
                <option value="edit">Read and edit</option>
              </select>
            </label>
          </> : <>
            <label>AWS region <input name="region" required autoComplete="off" disabled={pending} /></label>
            <label>Cognito managed login URL <input name="cognitoOrigin" type="url" required autoComplete="off" disabled={pending} /></label>
            <label>Cognito app client ID <input name="cognitoClientId" required autoComplete="off" disabled={pending} /></label>
            <label>Cognito user pool ID <input name="userPoolId" required autoComplete="off" disabled={pending} /></label>
            <label>Cognito identity pool ID <input name="identityPoolId" required autoComplete="off" disabled={pending} /></label>
            <label>Cognito editor group <input name="editorGroup" placeholder="writers" autoComplete="off" disabled={pending} /></label>
          </>}
          <button type="submit" className="control primary" disabled={pending}>Connect to {providerName}</button>
          {pending ? <p role="status">Connecting to {providerName}…</p> : null}
          {pending && provider === 's3' && onCancelConnect ?
            <button type="button" className="control" onClick={onCancelConnect}>Cancel sign-in</button> : null}
          {feedback ? <p role={feedback.role} className={feedback.role === 'alert' ? 'form-error' : undefined}>{feedback.text}</p> : null}
        </form>
      </> : <p>Storage connections are unavailable in this build.</p>}
      {onOpenFixture && !checkingConnection && !onRetrySignOut ? <div className="connect-footer">
        <button type="button" className={onConnect ? 'control' : 'control primary'} onClick={onOpenFixture} disabled={pending}>
          Open sample library
        </button>
      </div> : null}
    </main>
  </>
}

function ConnectedLibrary({ client, isFixture, onDisconnect }: {
  client: LibraryClient
  isFixture?: boolean
  onDisconnect?: () => void
}) {
  const { pathname } = useLocation()
  const [generation, setGeneration] = useState(0)
  const [opening, setOpening] = useState<{ generation: number; client: LibraryClient; overview?: LibraryOverview; error?: string }>()
  const [scope, setScope] = useState<Scope>(allMedia)
  const [text, setText] = useState('')
  const [kind, setKind] = useState<Query['mediaKind']>()
  const [filters, setFilters] = useState<Filters>(emptyFilters)
  const [sheet, setSheet] = useState<'collections' | 'filters' | 'import'>()
  const [uncertainImport, setUncertainImport] = useState<PhotoIntent>()
  const [notice, setNotice] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const main = useRef<HTMLElement>(null)

  const active = opening?.generation === generation && opening.client === client ? opening : undefined
  const overview = active?.overview
  const ready = overview !== undefined
  const tags = useMemo(() => overview?.tags.toSorted((first, second) => first.title.localeCompare(second.title)) ?? [], [overview])
  const selectedTag = scope.kind === 'tag' ? tags.find(tag => tag.id === scope.id) : undefined
  const scopeLabel = selectedTag?.title ?? (scope.kind === 'untagged' ? 'Untagged' : 'All Media')
  const query = useMemo(() => galleryQuery(scope, text.trim(), kind, filters), [scope, text, kind, filters])
  const narrowed = Boolean(query.text || query.mediaKind || filters.tagId || filters.from || filters.through)
  const filtersActive = Boolean(filters.tagId || filters.from || filters.through)

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if (event.key !== '/' || event.altKey || event.ctrlKey || event.metaKey) return
      if (document.querySelector('dialog[open]') || (event.target instanceof HTMLElement
        && (event.target.closest('input, select, textarea') || event.target.isContentEditable))) return
      if (searchInput.current?.disabled) return
      event.preventDefault()
      searchInput.current?.focus()
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    client.open(controller.signal).then(overview => {
      if (!controller.signal.aborted) setOpening({ generation, client, overview })
    }).catch(error => {
      if (!controller.signal.aborted) setOpening({ generation, client, error: libraryError(error, 'The library could not be opened. Try again.') })
    })
    return () => controller.abort()
  }, [client, generation])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const selectScope = useCallback((next: Scope, focusGallery = false) => {
    setScope(current => current.kind === next.kind
      && (current.kind !== 'tag' || (next.kind === 'tag' && current.id === next.id)) ? current : next)
    setText('')
    setKind(undefined)
    setFilters(emptyFilters)
    window.scrollTo(0, 0)
    if (focusGallery) requestAnimationFrame(() => main.current?.focus({ preventScroll: true }))
  }, [])

  const browseTag = useCallback((id: string) => selectScope({ kind: 'tag', id }, true), [selectScope])

  function reopen() {
    setGeneration(previous => previous + 1)
  }

  function importPhoto() {
    setSheet('import')
  }

  return <>
    {pathname !== libraryRoute && pathname !== viewerRoute ? <Navigate to={libraryRoute} replace /> : null}
    <a className="skip" href="#gallery-main" onClick={event => {
      event.preventDefault()
      main.current?.focus()
    }}>Skip to gallery</a>
    <header className="top top-connected">
      <Brand />
      <label className="search">
        <span className="visually-hidden">Search photos, videos, and tags</span>
        <Icon name="search" />
        <input ref={searchInput} type="search" placeholder="Search photos, videos, and tags" autoComplete="off"
          disabled={!ready} value={text} onChange={event => {
            setText(event.currentTarget.value)
            window.scrollTo(0, 0)
          }} />
        <kbd className="search-kbd" aria-hidden="true">/</kbd>
      </label>
      <div className="top-actions">
        <span className="sample session-name">{isFixture ? 'Sample library' : 'Connected library'}</span>
        <div className="asset-actions">
          {overview?.canWrite ? <button type="button" className="control primary" onClick={importPhoto}><Icon name="plus" />Import</button> : null}
          {onDisconnect ? <button type="button" className="control plain" onClick={onDisconnect}>Disconnect</button> : null}
        </div>
      </div>
    </header>
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-inner">
          <CollectionNavigation tags={tags} scope={scope} onScope={selectScope} />
        </div>
      </aside>
      <main className="main" id="gallery-main" tabIndex={-1} ref={main}>
        <GalleryResults
          key={JSON.stringify([generation, overview?.revisionId, ready, active?.error, query])}
          client={client}
          query={query}
          revisionId={overview?.revisionId ?? null}
          scopeLabel={scopeLabel}
          tags={tags}
          album={selectedTag?.album ? selectedTag : undefined}
          filtered={narrowed}
          loading={!active}
          error={active?.error}
          onReset={() => selectScope(allMedia, true)}
          onBrowseTag={browseTag}
          onImport={overview?.canWrite ? importPhoto : undefined}
          onCollections={() => setSheet('collections')}
          controls={<div className="toolbar">
            {ready ? <>
              <div className="media-toggle" role="group" aria-label="Media type">
                <button type="button" aria-pressed={kind === undefined} onClick={() => setKind(undefined)}>All</button>
                <button type="button" aria-pressed={kind === 'photo'} onClick={() => setKind('photo')}>Photos</button>
                <button type="button" aria-pressed={kind === 'video'} onClick={() => setKind('video')}>Videos</button>
              </div>
              {filtersActive ? <button type="button" className="filter-chip" onClick={() => setFilters(emptyFilters)}>
                Clear filters <Icon name="close" />
              </button> : null}
            </> : null}
            <span className="spacer" />
            {ready ? <button type="button" className="control" onClick={() => setSheet('filters')}><Icon name="filter" />Filters</button> : null}
            <button type="button" className="control" disabled={!active} onClick={reopen}>Reopen library</button>
          </div>}
        />
      </main>
    </div>
    {notice ? <div className="notice" role="status">{notice}</div> : null}
    {sheet === 'collections' ? <Sheet title="Collections" titleId="collections-title" onDismiss={() => setSheet(undefined)}>
      <CollectionNavigation tags={tags} scope={scope} onScope={next => {
        setSheet(undefined)
        selectScope(next, true)
      }} />
    </Sheet> : null}
    {sheet === 'filters' ? <FiltersSheet tags={tags} filters={filters} onApply={next => {
      setFilters(next)
      setSheet(undefined)
    }} onDismiss={() => setSheet(undefined)} /> : null}
    {sheet === 'import' && overview?.canWrite ? <ImportPhoto
      client={client}
      baseToken={overview.baseToken}
      uncertain={uncertainImport}
      onUncertain={setUncertainImport}
      onDismiss={() => setSheet(undefined)}
      onPublished={message => {
        setUncertainImport(undefined)
        setSheet(undefined)
        setNotice(message)
        selectScope(allMedia)
        reopen()
      }}
    /> : null}
  </>
}
