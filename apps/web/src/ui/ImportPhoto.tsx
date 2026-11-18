import { type FormEvent, useEffect, useRef, useState } from 'react'
import { makePreview } from '../../../flickr-import/preview.mjs'
import type { LibraryIntent, PublishResult } from '../library/contract.ts'
import type { LibraryClient } from '../library/worker-contract.ts'
import { Sheet, libraryError } from './components.tsx'

export type PhotoIntent = Extract<LibraryIntent, { kind: 'import-photo' }>

export function ImportPhoto({ client, baseToken, uncertain, onUncertain, onDismiss, onPublished }: {
  client: LibraryClient
  baseToken: string
  uncertain?: PhotoIntent
  onUncertain: (intent: PhotoIntent) => void
  onDismiss: () => void
  onPublished: (message: string) => void
}) {
  const [stage, setStage] = useState<'preview' | 'publish' | 'recover'>()
  const [error, setError] = useState<string>()
  const request = useRef<AbortController | undefined>(undefined)
  const prior = useRef<{ file: File; tags: string[]; intent: PhotoIntent } | undefined>(undefined)
  const busy = stage !== undefined

  useEffect(() => () => request.current?.abort(), [])

  function dismiss() {
    if (!request.current) onDismiss()
  }

  function startRequest() {
    const controller = new AbortController()
    request.current = controller
    setError(undefined)
    return controller.signal
  }

  function finishRequest(signal: AbortSignal) {
    request.current = undefined
    if (!signal.aborted) setStage(undefined)
  }

  async function send(intent: PhotoIntent, mode: 'publish' | 'recover', signal: AbortSignal) {
    setStage(mode)
    let result: PublishResult
    try {
      result = await client.publish(intent, { mode, signal })
    } catch {
      if (!signal.aborted) onUncertain(intent)
      return
    }
    if (signal.aborted) return
    if (result.status === 'published') {
      onPublished(mode === 'recover' ? 'Publication confirmed.' : 'Photo published.')
    } else if (result.status === 'unchanged') {
      onPublished('This photo and its tags are already in the library.')
    } else if (result.status === 'outcomeUnknown' || mode === 'recover') {
      onUncertain(intent)
      if (mode === 'recover') {
        const fallback = 'The library has no matching confirmation yet. Try checking again.'
        setError(result.status === 'outcomeUnknown' || result.status === 'failed' ? libraryError(result.code, fallback) : fallback)
      }
    } else if (result.status === 'stale') {
      setError('The library changed. Close this dialog and reopen the library before trying again.')
    } else {
      setError(libraryError(result.code, 'The photo could not be published. Try again.'))
    }
  }

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (request.current || uncertain) return

    const form = event.currentTarget
    const fields = new FormData(form)
    const selected = (form.elements.namedItem('photo') as HTMLInputElement).files?.[0]
    const tags = ['firstTag', 'secondTag'].map(name => String(fields.get(name) ?? '').trim())
    const normalized = tags.map(title => title.normalize('NFKC').toLowerCase())

    if (!selected?.size || (selected.type !== 'image/jpeg' && (selected.type || !/\.jpe?g$/i.test(selected.name)))) {
      setError('Choose a JPEG photo.')
      return
    }
    if (selected.size > 48 * 1024 ** 2) {
      setError('Choose a JPEG photo no larger than 48 MiB.')
      return
    }
    if (!normalized[0] || !normalized[1] || normalized[0] === normalized[1]) {
      setError('Enter two different tag names.')
      return
    }

    const signal = startRequest()
    try {
      const previous = prior.current
      let intent = previous?.file === selected && previous.tags.every((tag, index) => tag === tags[index])
        ? previous.intent : undefined
      if (!intent) {
        setStage('preview')
        const file = selected.type ? selected : new File([selected], selected.name, { type: 'image/jpeg', lastModified: selected.lastModified })
        const preview = await makePreview({ mimeType: file.type, byteLength: file.size, openBytes: () => file.stream() }, {}, signal)
        if (signal.aborted) return
        if (!preview) {
          setError('A preview could not be generated. Choose a supported JPEG photo.')
          return
        }
        intent = {
          kind: 'import-photo',
          file,
          preview,
          tagTitles: tags,
          addedAt: new Date().toISOString(),
          baseToken,
          operationId: crypto.randomUUID(),
        }
        prior.current = { file: selected, tags, intent }
      }
      await send(intent, 'publish', signal)
    } catch (error) {
      if (!signal.aborted) setError(libraryError(error, 'A preview could not be generated. Choose a supported JPEG photo.'))
    } finally {
      finishRequest(signal)
    }
  }

  async function recover() {
    if (!uncertain || request.current) return
    const signal = startRequest()
    try {
      await send(uncertain, 'recover', signal)
    } finally {
      finishRequest(signal)
    }
  }

  const progress = stage === 'preview' ? 'Creating preview…' : stage === 'recover' ? 'Checking publication…' : 'Publishing photo…'

  return <Sheet title="Import media" titleId="import-title" onDismiss={dismiss} dismissDisabled={busy}>
    {uncertain ? <div aria-busy={busy}>
      <p className="form-error" role="alert">Publication could not be confirmed. Check the result before starting another import.</p>
      <p>{uncertain.file.name}</p>
      {busy ? <p role="status">{progress}</p> : null}
      {error ? <p className="form-error" role="status">{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="control" disabled={busy} onClick={dismiss}>Close</button>
        <button type="button" className="control primary" disabled={busy} onClick={() => void recover()}>Check publication</button>
      </div>
    </div> : <>
      <p>Choose one JPEG photo and add two tags before publishing.</p>
      <form onSubmit={event => void publish(event)} aria-busy={busy}>
        <fieldset disabled={busy}>
          <label>JPEG photo <input type="file" name="photo" required accept="image/jpeg,.jpg,.jpeg" /></label>
          <label>First tag <input type="text" name="firstTag" required maxLength={50} autoComplete="off" /></label>
          <label>Second tag <input type="text" name="secondTag" required maxLength={50} autoComplete="off" /></label>
        </fieldset>
        {busy ? <p role="status">{progress}</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="form-actions">
          <button type="button" className="control" disabled={busy} onClick={dismiss}>Cancel</button>
          <button type="submit" className="control primary" disabled={busy}>Publish photo</button>
        </div>
      </form>
    </>}
  </Sheet>
}
