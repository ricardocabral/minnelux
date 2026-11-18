import { useEffect, useRef, useState } from 'react'
import type { AssetV1, TagV1 } from '../library/contract.ts'
import type { AssetRow, LibraryClient, ResultHandle } from '../library/worker-contract.ts'
import { AssetDetails } from './Details.tsx'
import { Icon, Modal, libraryError, useStoredImage } from './components.tsx'

const shortDate = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' })
export const viewerRoute = '/viewer'

export function Viewer({ client, result, rows, label, tags, position, onStep, onClose, onBrowseTag }: {
  client: LibraryClient
  result: ResultHandle
  rows: readonly AssetRow[]
  label: string
  tags: readonly TagV1[]
  position: number
  onStep: (position: number) => void
  onClose: () => void
  onBrowseTag: (tagId: string) => void
}) {
  const [showDetails, setShowDetails] = useState(() => !window.matchMedia('(max-width: 740px)').matches)
  const [zoomedAt, setZoomedAt] = useState<number>()
  const zoom = zoomedAt === position
  const touch = useRef<{ x: number; y: number } | undefined>(undefined)
  const row = rows[position]
  const [detail, setDetail] = useState<{ position: number; asset?: AssetV1; error?: string }>()
  const asset = detail?.position === position ? detail.asset : undefined
  const rowId = row?.id

  useEffect(() => {
    const controller = new AbortController()
    async function read() {
      try {
        const id = rowId ?? (await client.readRange(result.handle, position, 1, controller.signal))[0]?.id
        if (!id) throw new Error('missing')
        const asset = await client.readAsset(result.handle, id, controller.signal)
        if (!controller.signal.aborted) setDetail({ position, asset })
      } catch (error) {
        if (!controller.signal.aborted) setDetail({ position, error: libraryError(error, 'Media details are unavailable.') })
      }
    }
    void read()
    return () => controller.abort()
  }, [client, position, result.handle, rowId])

  function step(delta: number) {
    const next = position + delta
    if (next >= 0 && next < result.total) {
      setZoomedAt(undefined)
      onStep(next)
    }
  }

  const title = asset?.metadata.title || asset?.filename || row?.title || row?.filename || 'Media'
  const capturedAt = asset?.metadata.capturedAt || row?.capturedAt
  const addedAt = asset?.addedAt || row?.addedAt
  const date = capturedAt ? shortDate.format(new Date(`${capturedAt.wallTime.slice(0, 10)}T00:00:00Z`))
    : addedAt ? `Added ${shortDate.format(new Date(addedAt))}` : undefined
  const media = asset ?? row
  const mediaId = media?.id
  const hasPreview = asset ? asset.previews.length > 0 : row?.hasPreview
  const previewError = detail?.position === position ? detail.error : undefined
  const allowZoom = media?.mediaKind === 'photo' && hasPreview

  return <Modal className="viewer" titleId="viewer-title" onDismiss={onClose}>
    <header className="viewer-header" onKeyDown={keyNavigate}>
      <button type="button" className="control icon-button" aria-label="Close viewer" onClick={onClose}><Icon name="close" /></button>
      <div className="viewer-context">
        <span>{label}</span>
        <span className="viewer-position" aria-live="polite">{position + 1} of {result.total}</span>
      </div>
      <button type="button" className="control icon-button" aria-label="Details" aria-expanded={showDetails} aria-controls="viewer-info" onClick={() => setShowDetails(!showDetails)}>
        <Icon name="info" />
      </button>
    </header>
    <div className="viewer-body" onKeyDown={keyNavigate}>
      <div className="viewer-stage">
        <button type="button" className="control icon-button" aria-label="Previous item" disabled={position <= 0} onClick={() => step(-1)}><Icon name="left" /></button>
        <div className={`stage-media${zoom ? ' zoomed' : ''}`}
          onTouchStart={event => {
            const point = event.touches[0]
            touch.current = !zoom && event.touches.length === 1 && point ? { x: point.clientX, y: point.clientY } : undefined
          }}
          onTouchEnd={event => {
            const origin = touch.current
            touch.current = undefined
            const point = event.changedTouches[0]
            if (zoom || !origin || !point) return
            const deltaX = point.clientX - origin.x
            if (Math.abs(deltaX) > 55 && Math.abs(point.clientY - origin.y) < 50) step(deltaX < 0 ? 1 : -1)
          }}
          onTouchCancel={() => { touch.current = undefined }}
        >
          <ViewerImage key={position} client={client} id={hasPreview ? mediaId : undefined} title={title}
            pending={!media && !previewError} onZoom={allowZoom ? toggleZoom : undefined} />
        </div>
        <button type="button" className="control icon-button" aria-label="Next item" disabled={position >= result.total - 1} onClick={() => step(1)}><Icon name="right" /></button>
      </div>
      <aside className="viewer-info" id="viewer-info" aria-label="Media details" hidden={!showDetails}>
        {asset ? <AssetDetails asset={asset} tags={tags} onBrowseTag={onBrowseTag} />
          : previewError ? <p role="alert">{previewError}</p> : <p role="status">Loading details…</p>}
      </aside>
    </div>
    <footer className="viewer-footer" onKeyDown={keyNavigate}>
      <div className="viewer-caption">
        <h2 id="viewer-title">{title}</h2>
        {date ? <p>{date}</p> : null}
      </div>
      {allowZoom ? <div className="viewer-tools">
        <button type="button" className="control" aria-pressed={zoom} onClick={toggleZoom}>{zoom ? 'Fit image' : 'Zoom in'}</button>
      </div> : null}
    </footer>
  </Modal>

  function toggleZoom() {
    setZoomedAt(zoom ? undefined : position)
  }

  function keyNavigate(event: React.KeyboardEvent) {
    if (event.altKey || event.metaKey || event.ctrlKey || zoom) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      step(event.key === 'ArrowLeft' ? -1 : 1)
    }
  }
}

function ViewerImage({ client, id, title, pending, onZoom }: {
  client: LibraryClient
  id?: string
  title: string
  pending: boolean
  onZoom?: () => void
}) {
  const [failed, setFailed] = useState(false)
  const { url, loading } = useStoredImage(client, 'preview', id)
  if (loading || pending) return <p role="status">Loading preview…</p>
  if (!url || failed) return <p>Preview unavailable.</p>
  return <img alt={title} src={url} onError={() => setFailed(true)} onDoubleClick={onZoom} />
}
