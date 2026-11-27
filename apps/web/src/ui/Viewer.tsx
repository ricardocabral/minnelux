import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { displayRotation } from '../../../flickr-import/preview.mjs'
import type { AssetV1, TagV1 } from '../library/contract.ts'
import { loadPhotoOriginal, type DecodedPhoto } from '../library/photo-display.ts'
import type { AssetRow, LibraryClient, ResultHandle } from '../library/worker-contract.ts'
import { AssetDetails } from './Details.tsx'
import { Icon, Modal, libraryError, useStoredImage } from './components.tsx'

const shortDate = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' })
export const viewerRoute = '/viewer'

export function Viewer({ client, result, rows, label, tags, position, thumbnail, onStep, onClose, onBrowseTag }: {
  client: LibraryClient
  result: ResultHandle
  rows: readonly AssetRow[]
  label: string
  tags: readonly TagV1[]
  position: number
  thumbnail?: { id: string; url: string }
  onStep: (position: number) => void
  onClose: () => void
  onBrowseTag: (tagId: string) => void
}) {
  const [showDetails, setShowDetails] = useState(() => !window.matchMedia('(max-width: 740px)').matches)
  const [zoomedAt, setZoomedAt] = useState<number>()
  const zoom = zoomedAt === position
  const touch = useRef<{ x: number; y: number } | undefined>(undefined)
  const row = rows[position]
  const [loadedDetail, setDetail] = useState<{ handle: string; position: number; asset?: AssetV1; error?: string }>()
  const detail = loadedDetail?.handle === result.handle && loadedDetail.position === position ? loadedDetail : undefined
  const asset = detail?.asset
  const rowId = row?.id

  useEffect(() => {
    const controller = new AbortController()
    async function read() {
      try {
        const id = rowId ?? (await client.readRange(result.handle, position, 1, controller.signal))[0]?.id
        if (!id) throw new Error('missing')
        const asset = await client.readAsset(result.handle, id, controller.signal)
        if (!controller.signal.aborted) setDetail({ handle: result.handle, position, asset })
      } catch (error) {
        if (!controller.signal.aborted) setDetail({ handle: result.handle, position, error: libraryError(error, 'Media details are unavailable.') })
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
  const previewError = detail?.error
  const isPhoto = media?.mediaKind === 'photo'
  const original = useOriginalImage(client, result.handle, asset?.mediaKind === 'photo' ? asset : undefined)
  const rotation = asset ? displayRotation(asset.metadata) : 0
  const allowZoom = isPhoto && (hasPreview || original.image)

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
          <ViewerImage key={JSON.stringify([result.handle, position])} client={client} previewId={hasPreview ? mediaId : undefined}
            thumbnailUrl={thumbnail?.id === mediaId ? thumbnail?.url : undefined}
            original={original.image} rotation={rotation} title={title} isPhoto={isPhoto}
            pending={(!media && !previewError) || Boolean(isPhoto && !detail) || original.loading} onZoom={allowZoom ? toggleZoom : undefined} />
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
      <ViewerTools key={`${result.handle}:${position}`} client={client} handle={result.handle}
        photo={asset?.mediaKind === 'photo' ? asset : undefined}
        zoom={zoom} onZoom={allowZoom ? toggleZoom : undefined} />
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

function ViewerTools({ client, handle, photo, zoom, onZoom }: {
  client: LibraryClient
  handle: string
  photo?: AssetV1
  zoom: boolean
  onZoom?: () => void
}) {
  const active = useRef<AbortController | undefined>(undefined)
  const [download, setDownload] = useState<{ status: 'pending' } | { status: 'failed'; message: string }>()
  const downloading = download?.status === 'pending'
  useEffect(() => () => active.current?.abort(), [])

  async function downloadOriginal() {
    if (!photo || active.current) return
    const controller = new AbortController()
    active.current = controller
    setDownload({ status: 'pending' })
    try {
      const blob = await client.readOriginal(handle, photo.id, controller.signal)
      if (controller.signal.aborted) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = photo.filename
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      link.click()
      setDownload(undefined)
    } catch (error) {
      if (!controller.signal.aborted) {
        setDownload({ status: 'failed', message: libraryError(error, 'Could not download the original. Try again.') })
      }
    } finally {
      active.current = undefined
    }
  }

  if (!photo && !onZoom) return null
  const zoomLabel = zoom ? 'Fit image' : 'Zoom in'
  return <div className="viewer-tools">
    <div className="viewer-tool-buttons">
      {onZoom ? <button type="button" className="control icon-button" aria-label={zoomLabel} title={zoomLabel}
        aria-pressed={zoom} onClick={onZoom}><Icon name={zoom ? 'zoom-out' : 'zoom-in'} /></button> : null}
      {photo ? <button type="button" className="control icon-button" aria-label="Download original"
        title="Download original" aria-disabled={downloading || undefined} onClick={downloadOriginal}><Icon name="download" /></button> : null}
    </div>
    {downloading ? <p role="status">Preparing download…</p> : null}
    {download?.status === 'failed' ? <p role="alert">{download.message}</p> : null}
  </div>
}

function useOriginalImage(client: LibraryClient, handle: string, photo?: AssetV1) {
  const [read, setRead] = useState<{
    client: LibraryClient; handle: string; photo: AssetV1; signal: AbortSignal; image?: DecodedPhoto
  }>()
  const active = read?.client === client && read.handle === handle && read.photo === photo && !read.signal.aborted ? read : undefined

  useEffect(() => {
    if (!photo) return
    const resource = loadPhotoOriginal(client, handle, photo)
    const { signal } = resource
    resource.ready.catch(() => undefined).then(image => {
      if (!signal.aborted) setRead({ client, handle, photo, signal, image })
    })
    return resource.close
  }, [client, handle, photo])

  return { image: active?.image, loading: photo !== undefined && active === undefined }
}

function ViewerImage({ client, previewId, thumbnailUrl, original, rotation, title, isPhoto, pending, onZoom }: {
  client: LibraryClient
  previewId?: string
  thumbnailUrl?: string
  original?: DecodedPhoto
  rotation: number
  title: string
  isPhoto?: boolean
  pending: boolean
  onZoom?: () => void
}) {
  const [failedPreview, setFailedPreview] = useState<string>()
  const [failedOriginal, setFailedOriginal] = useState<string>()
  const thumbnail = thumbnailUrl !== failedPreview ? thumbnailUrl : undefined
  const { url, loading } = useStoredImage(client, 'preview', thumbnail ? undefined : previewId)
  const preview = thumbnail ?? (url !== failedPreview ? url : undefined)
  if (original && original.url !== failedOriginal) {
    const style = rotation ? { rotate: rotation + 'deg' } : undefined
    const image = <img alt={title} src={original.url} style={style}
      onError={() => setFailedOriginal(original.url)} onDoubleClick={onZoom} />
    if (rotation % 180 === 0) return image
    return <div className="quarter-turn" style={{
      '--image-ratio': original.height / original.width,
      '--image-width': original.height + 'px',
    } as CSSProperties}>{image}</div>
  }
  if (preview) return <img alt={title} src={preview} onError={() => setFailedPreview(preview)} onDoubleClick={onZoom} />
  if (loading || pending) return <p role="status">{isPhoto ? 'Loading photo…' : 'Loading preview…'}</p>
  return <p>{isPhoto ? 'Photo unavailable.' : 'Preview unavailable.'}</p>
}
