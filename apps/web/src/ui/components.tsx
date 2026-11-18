import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { FlickrTime } from '../library/contract.ts'
import type { LibraryClient } from '../library/worker-contract.ts'
import logo from '../../../../docs/mkt/logo/horizontal/minnelux-light-320x88.png'

const symbols = {
  search: <><circle cx="10.7" cy="10.7" r="5.5" /><path d="m15 15 4 4" /></>,
  library: <><rect x="4" y="6" width="16" height="14" rx="2" /><path d="M8 3h8m-12 14 4.4-4.3 3.3 3.1 2.6-2.6L20 18" /><circle cx="15.2" cy="10.3" r="1" /></>,
  tag: <><path d="M20 12 12 20 4 12V4h8z" /><circle cx="8.1" cy="8.1" r="1" /></>,
  collections: <path d="M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  filter: <><path d="M4 7h16M4 12h16M4 17h16" /><circle cx="9" cy="7" r="2" fill="var(--surface)" /><circle cx="15" cy="12" r="2" fill="var(--surface)" /><circle cx="10" cy="17" r="2" fill="var(--surface)" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  left: <path d="m14 5-7 7 7 7" />,
  right: <path d="m10 5 7 7-7 7" />,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5m0-8h.01" /></>,
  play: <path d="m8 5 12 7-12 7z" />,
}

export function Icon({ name }: { name: keyof typeof symbols }) {
  return <svg className="symbol" viewBox="0 0 24 24" aria-hidden="true">{symbols[name]}</svg>
}

export function Brand() {
  return <img className="brand" src={logo} width="320" height="88" alt="Minnelux" />
}

export function Modal({ titleId, className, onDismiss, children }: {
  titleId: string
  className: 'sheet' | 'viewer'
  onDismiss: () => void
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])

  return <dialog
    ref={dialog}
    className={className}
    aria-labelledby={titleId}
    onCancel={event => {
      event.preventDefault()
      onDismiss()
    }}
  >{children}</dialog>
}

export function Sheet({ title, titleId, onDismiss, dismissDisabled, children }: {
  title: string
  titleId: string
  onDismiss: () => void
  dismissDisabled?: boolean
  children: ReactNode
}) {
  return <Modal className="sheet" titleId={titleId} onDismiss={onDismiss}>
    <div className="sheet-head">
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="control plain icon-button" onClick={onDismiss} disabled={dismissDisabled} aria-label={`Close ${title.toLowerCase()}`}>
        <Icon name="close" />
      </button>
    </div>
    {children}
  </Modal>
}

const pendingImages = new Set<() => Promise<void>>()
const imageReadLimit = 6
let activeImageReads = 0

function readStoredImage(client: LibraryClient, kind: 'preview' | 'cover', id: string, signal: AbortSignal) {
  return new Promise<Blob | undefined>((resolve, reject) => {
    signal.throwIfAborted()

    function cancel() {
      pendingImages.delete(start)
      reject(signal.reason)
    }

    async function start() {
      signal.removeEventListener('abort', cancel)
      activeImageReads++
      try {
        resolve(await (kind === 'cover' ? client.readAlbumCover(id, signal) : client.readPreview(id, signal)))
      } catch (error) {
        reject(error)
      } finally {
        activeImageReads--
        const next = pendingImages.values().next().value
        if (next) {
          pendingImages.delete(next)
          void next()
        }
      }
    }

    if (activeImageReads < imageReadLimit) {
      void start()
    } else {
      pendingImages.add(start)
      signal.addEventListener('abort', cancel, { once: true })
    }
  })
}

export function useStoredImage(client: LibraryClient, kind: 'preview' | 'cover', id?: string) {
  const [image, setImage] = useState<{ client: LibraryClient; id: string; url?: string }>()
  const active = image?.client === client && image.id === id ? image : undefined

  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    let url: string | undefined
    readStoredImage(client, kind, id, controller.signal).then(blob => {
      if (controller.signal.aborted) return
      url = blob ? URL.createObjectURL(blob) : undefined
      setImage({ client, id, url })
    }).catch(() => {
      if (!controller.signal.aborted) setImage({ client, id })
    })
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [client, id, kind])

  return { url: active?.url, loading: id !== undefined && active === undefined }
}

export function countLabel(count: number, singular: string) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

export function wallTime(time?: FlickrTime) {
  if (!time) return undefined
  const value = time.wallTime.replace('T', ' ')
  if (time.offsetMinutes === undefined) return value
  const minutes = Math.abs(time.offsetMinutes)
  const hours = String(Math.floor(minutes / 60)).padStart(2, '0')
  const rest = String(minutes % 60).padStart(2, '0')
  return `${value} UTC${time.offsetMinutes < 0 ? '−' : '+'}${hours}:${rest}`
}

export function SourceLink({ url, children }: { url?: string; children: ReactNode }) {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
    return <a href={parsed.href} target="_blank" rel="noopener noreferrer">{children}</a>
  } catch {
    return null
  }
}

export function libraryError(error: unknown, fallback: string) {
  const code = error instanceof Error && 'code' in error ? error.code : error instanceof Error ? error.message : error
  switch (code) {
    case 'invalidPrefix': return 'Enter a library prefix such as library or archive/photos.'
    case 'expired': return 'Your session expired. Reconnect to open the library.'
    case 'denied': return 'This account does not have the required library access.'
    case 'corrupt': return 'The library data could not be read.'
    case 'unsupportedVersion': return 'This library version is unsupported.'
    case 'storage': return 'Storage is unavailable. Try again.'
    default: return fallback
  }
}
