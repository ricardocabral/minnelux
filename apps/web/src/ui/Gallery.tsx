import { type FormEvent, type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import type { TagV1 } from '../library/contract.ts'
import type { AssetRow, LibraryClient, ResultHandle } from '../library/worker-contract.ts'
import type { Query } from '../search/contract.ts'
import { searchTerms } from '../search/search.ts'
import { Icon, Sheet, countLabel, libraryError, useStoredImage } from './components.tsx'
import { AlbumDetails } from './Details.tsx'
import { Viewer, viewerRoute } from './Viewer.tsx'

export type Scope = { kind: 'all' } | { kind: 'untagged' } | { kind: 'tag'; id: string }
export type Filters = { tagId: string; from: string; through: string }
export const emptyFilters: Filters = { tagId: '', from: '', through: '' }
export const allMedia: Scope = { kind: 'all' }
export const libraryRoute = '/library'
const pageSize = 48
const monthName = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export function CollectionNavigation({ tags, scope, onScope }: {
  tags: readonly TagV1[]
  scope: Scope
  onScope: (scope: Scope) => void
}) {
  const [search, setSearch] = useState('')
  const needle = normalize(search.trim())
  const matches = tags.filter(tag => normalize(tag.title).includes(needle))

  return <nav aria-label="Library navigation">
    <p className="nav-label">Library</p>
    <button type="button" className="nav-button" aria-current={scope.kind === 'all' ? 'page' : undefined} onClick={() => onScope(allMedia)}>
      <Icon name="library" /><span className="nav-name">All Media</span>
    </button>
    <button type="button" className="nav-button" aria-current={scope.kind === 'untagged' ? 'page' : undefined} onClick={() => onScope({ kind: 'untagged' })}>
      <Icon name="tag" /><span className="nav-name">Untagged</span>
    </button>
    <hr className="nav-rule" />
    <p className="nav-label">Tags</p>
    <label className="collection-search">
      <span className="visually-hidden">Find a collection</span>
      <input type="search" placeholder="Find a collection" value={search} onChange={event => setSearch(event.currentTarget.value)} />
    </label>
    {matches.length ? matches.map(tag => <button
      key={tag.id}
      type="button"
      className="nav-button"
      aria-current={scope.kind === 'tag' && tag.id === scope.id ? 'page' : undefined}
      onClick={() => onScope({ kind: 'tag', id: tag.id })}
    ><Icon name="tag" /><span className="nav-name">{tag.title}</span></button>)
      : <p className="empty-nav">{needle ? 'No matching collections' : 'No tags yet'}</p>}
  </nav>
}

export function FiltersSheet({ tags, filters, onApply, onDismiss }: {
  tags: readonly TagV1[]
  filters: Filters
  onApply: (filters: Filters) => void
  onDismiss: () => void
}) {
  const [error, setError] = useState(false)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const next = {
      tagId: String(values.get('tag') ?? ''),
      from: String(values.get('from') ?? ''),
      through: String(values.get('through') ?? ''),
    }
    if (next.from && next.through && next.from > next.through) {
      setError(true)
      return
    }
    onApply(next)
  }

  return <Sheet title="Filters" titleId="filter-title" onDismiss={onDismiss}>
    <form onSubmit={submit}>
      <label>Also tagged with
        <select name="tag" defaultValue={filters.tagId}>
          <option value="">Any tag</option>
          {tags.map(tag => <option key={tag.id} value={tag.id}>{tag.title}</option>)}
        </select>
      </label>
      <label>Captured on or after <input name="from" type="date" max="9999-12-31" defaultValue={filters.from} /></label>
      <label>Captured on or before <input name="through" type="date" max="9999-12-31" defaultValue={filters.through} /></label>
      {error ? <p className="form-error" role="alert">Choose an end date on or after the start date.</p> : null}
      <div className="form-actions">
        <button type="button" className="control" onClick={() => onApply(emptyFilters)}>Clear</button>
        <button type="submit" className="control primary">Apply filters</button>
      </div>
    </form>
  </Sheet>
}

export function GalleryResults({ client, query, revisionId, scopeLabel, tags, filtered, album, controls, loading, error, onReset, onBrowseTag, onImport, onCollections }: {
  client: LibraryClient
  query: Query
  revisionId: string | null
  scopeLabel: string
  tags: readonly TagV1[]
  filtered: boolean
  album?: TagV1
  controls: ReactNode
  loading: boolean
  error?: string
  onReset: () => void
  onBrowseTag: (id: string) => void
  onImport?: () => void
  onCollections: () => void
}) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const showingViewer = pathname === viewerRoute
  const enteredViewer = useRef(false)
  const [page, setPage] = useState<{ result?: ResultHandle; rows: AssetRow[]; error?: string }>({ rows: [] })
  const [pageError, setPageError] = useState<string>()
  const [loadingMore, setLoadingMore] = useState(false)
  const pageRead = useRef<AbortController | undefined>(undefined)
  const [viewerPosition, setViewerPosition] = useState<number | null>(null)
  const [openedThumbnail, setOpenedThumbnail] = useState<{ handle: string; id: string; url: string }>()
  const origin = useRef<{ index: number; scroll: number; tile: HTMLButtonElement } | undefined>(undefined)
  const nextTag = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (loading || error) return
    const controller = new AbortController()
    let handle: string | undefined
    async function load() {
      try {
        const result = await client.query(query, controller.signal)
        if (controller.signal.aborted) {
          void client.release(result.handle).catch(() => {})
          return
        }
        handle = result.handle
        if (result.revisionId !== revisionId) throw new Error('stale')
        const rows = result.total ? await client.readRange(result.handle, 0, pageSize, controller.signal) : []
        if (!controller.signal.aborted) setPage({ result, rows })
      } catch (error) {
        const fallback = query.text || query.tagIds?.length ? 'Search is unavailable. Browse All Media or try again.'
          : 'The gallery could not be loaded. Try reopening the library.'
        if (!controller.signal.aborted) setPage({ rows: [], error: libraryError(error, fallback) })
      }
    }
    void load()
    return () => {
      controller.abort()
      pageRead.current?.abort()
      if (handle) void client.release(handle).catch(() => {})
    }
  }, [client, query, revisionId, loading, error])

  useEffect(() => {
    if (showingViewer) {
      if (origin.current) enteredViewer.current = true
      else void navigate(libraryRoute, { replace: true })
      return
    }
    if (!enteredViewer.current) return
    enteredViewer.current = false
    if (nextTag.current !== undefined) {
      onBrowseTag(nextTag.current)
      nextTag.current = undefined
      return
    }
    const previous = origin.current
    if (previous) requestAnimationFrame(() => {
      if (!previous.tile.isConnected) return
      window.scrollTo(0, previous.scroll)
      previous.tile.focus({ preventScroll: true })
    })
  }, [showingViewer, navigate, onBrowseTag])

  const { result, rows } = page
  const text = Boolean(query.text)
  const title = text ? 'Search results' : scopeLabel
  const rowGroups = new Map<string, { row: AssetRow; index: number }[]>()
  for (const [index, row] of rows.entries()) {
    const date = (row.capturedAt?.wallTime ?? row.addedAt).slice(0, 7)
    const group = text ? 'Best matches' : monthName.format(new Date(`${date}-01T00:00:00Z`))
    const existing = rowGroups.get(group)
    if (existing) existing.push({ row, index })
    else rowGroups.set(group, [{ row, index }])
  }

  async function loadMore() {
    if (!result || pageRead.current || rows.length >= result.total) return
    const controller = new AbortController()
    pageRead.current = controller
    setLoadingMore(true)
    setPageError(undefined)
    try {
      const next = await client.readRange(result.handle, rows.length, pageSize, controller.signal)
      if (!next.length) throw new Error('missing')
      if (!controller.signal.aborted) setPage({ result, rows: [...rows, ...next] })
    } catch (error) {
      if (!controller.signal.aborted) setPageError(libraryError(error, 'Could not load more items. Try again.'))
    } finally {
      pageRead.current = undefined
      if (!controller.signal.aborted) setLoadingMore(false)
    }
  }

  function openViewer(event: MouseEvent<HTMLButtonElement>, index: number) {
    const tile = event.currentTarget
    origin.current = { index, scroll: window.scrollY, tile }
    const row = rows[index]
    const image = tile.querySelector('img')
    setOpenedThumbnail(result && row?.mediaKind === 'photo' && image?.complete && image.naturalWidth
      ? { handle: result.handle, id: row.id, url: image.currentSrc }
      : undefined)
    void navigate(viewerRoute)
    setViewerPosition(index)
  }

  function closeViewer() {
    if (showingViewer) void navigate(-1)
  }

  const failure = page.error ?? error
  const count = result ? countLabel(result.total, text ? 'result' : 'item') : undefined
  return <>
    <div className="heading">
      <div>
        <h1>{title}</h1>
        <p className="scope-count" role="status">{count ? count + (text && scopeLabel !== 'All Media' ? ` in ${scopeLabel}` : '')
          : failure ? '' : loading ? 'Opening library…' : 'Loading items…'}</p>
      </div>
      <button type="button" className="control mobile-collections" onClick={onCollections}>
        <Icon name="collections" />Collections
      </button>
    </div>
    {controls}
    {album && !text ? <AlbumDetails client={client} tag={album} /> : null}
    {failure ? <section className="empty">
      <h2>Library unavailable</h2>
      <p role="alert">{failure}</p>
      {filtered || scopeLabel !== 'All Media' ? <button type="button" className="control" onClick={onReset}>Browse All Media</button> : null}
    </section> : result ? renderGallery(result) : null}
  </>

  function renderGallery(result: ResultHandle) {
    const thumbnail = showingViewer && openedThumbnail?.handle === result.handle ? openedThumbnail : undefined
    return <>
      {rowGroups.size ? [...rowGroups].map(([group, items]) => <section className="collection-group" key={group}>
        <h2 className="group-title">{group}<span>{countLabel(rowGroups.size === 1 && text ? result.total : items.length, 'item')}</span></h2>
        <div className="grid">
          {items.map(({ row, index }) => <GalleryTile key={row.id} row={row} client={client}
            keepPreview={thumbnail?.id === row.id} onOpen={event => openViewer(event, index)} />)}
        </div>
      </section>) : <section className="empty">
        <h2>{filtered ? 'No matches' : 'No items here yet'}</h2>
        <p>{filtered ? 'Try another search or browse All Media.' : scopeLabel === 'All Media' ? 'This library is empty.' : `No items in ${scopeLabel}.`}</p>
        {scopeLabel !== 'All Media' || filtered ? <button type="button" className="control" onClick={onReset}>Browse All Media</button>
          : onImport ? <button type="button" className="control primary" onClick={onImport}>Import a photo</button> : null}
      </section>}
      {pageError ? <p role="alert" className="form-error">{pageError}</p> : null}
      {rows.length < result.total ? <div className="more-results">
        <button type="button" className="control" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? 'Loading more…' : 'Load more'}
        </button>
      </div> : null}
      {showingViewer && viewerPosition !== null ? <Viewer
        client={client}
        result={result}
        rows={rows}
        label={title}
        tags={tags}
        position={viewerPosition}
        thumbnail={thumbnail}
        onStep={setViewerPosition}
        onClose={closeViewer}
        onBrowseTag={id => {
          nextTag.current = id
          closeViewer()
        }}
      /> : null}
    </>
  }
}

function GalleryTile({ row, client, keepPreview, onOpen }: {
  row: AssetRow
  client: LibraryClient
  keepPreview: boolean
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void
}) {
  const tile = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  const title = row.title || row.filename
  const video = row.mediaKind === 'video'

  useEffect(() => {
    if (!row.hasPreview) return
    const observer = new IntersectionObserver(entries => {
      const entry = entries.at(-1)
      if (entry) setVisible(entry.isIntersecting)
    })
    if (tile.current) observer.observe(tile.current)
    return () => observer.disconnect()
  }, [row.hasPreview])

  return <article className="tile" ref={tile}>
    <button type="button" className="tile-open" aria-label={`Open ${title}${video ? ', video' : ''}`} onClick={onOpen}>
      {row.hasPreview ? visible || keepPreview ? <TilePreview client={client} id={row.id} /> : null
        : <TilePlaceholder loading={false} />}
      <span className="caption" aria-hidden="true">{title}</span>
      {video ? <span className="clip"><Icon name="play" />Video</span> : null}
    </button>
  </article>
}

function TilePreview({ client, id }: { client: LibraryClient; id: string }) {
  const [failed, setFailed] = useState(false)
  const { url, loading } = useStoredImage(client, 'preview', id)
  return url && !failed ? <img alt="" src={url} onError={() => setFailed(true)} /> : <TilePlaceholder loading={loading} />
}

function TilePlaceholder({ loading }: { loading: boolean }) {
  return <span className="placeholder"><Icon name="library" />{loading ? 'Loading preview…' : 'Preview unavailable'}</span>
}

export function galleryQuery(scope: Scope, text: string, mediaKind: Query['mediaKind'], filters: Filters): Query {
  const scopedTag = scope.kind === 'tag' ? scope.id : undefined
  const tagIds = [...new Set([scopedTag, filters.tagId].filter((id): id is string => Boolean(id)))]
  const dayAfter = filters.through && filters.through !== '9999-12-31'
    ? new Date(Date.parse(`${filters.through}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    : undefined

  return {
    text: searchTerms(text).size ? text : undefined,
    tagIds: tagIds.length ? tagIds : undefined,
    untagged: scope.kind === 'untagged' || undefined,
    mediaKind,
    fromDate: filters.from || undefined,
    beforeDate: dayAfter,
  }
}
