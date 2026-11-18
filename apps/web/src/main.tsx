import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import { relativeKey } from './library/catalog.ts'
import { connectLibraryClient } from './library/worker-client.ts'
import type { ConnectConfiguration } from './library/worker-contract.ts'
import type { WorkerStart } from './library/worker.ts'
import { authorizeGcsSession } from './storage/gcs-session.ts'
import AppView from './ui/App.tsx'

type OAuth = Parameters<typeof authorizeGcsSession>[0]['oauth']
type GisWindow = Window & { google?: { accounts: { oauth2: OAuth } } }
const gis = window as GisWindow
const root = createRoot(document.getElementById('root')!)
let active: { id: string; client: ReturnType<typeof connectLibraryClient>; close(): void; sample: boolean } | undefined
let connecting: AbortController | undefined
let loadingIdentity: Promise<void> | undefined
let connectionNotice: string | undefined

function disconnect(notice?: string) {
  connectionNotice = notice
  connecting?.abort()
  active?.close()
  active = undefined
  render()
}

function connectionLost(notice: string) {
  const pending = active?.client.hasUnconfirmedPublication()
  disconnect(pending ? notice + ' A publication may have succeeded. Check the library before importing the photo again.' : notice)
}

function start(source: WorkerStart['source'], close: () => void = () => {}) {
  const id = crypto.randomUUID()
  const worker = new Worker(new URL('./library/worker.ts', import.meta.url), { type: 'module' })
  const client = connectLibraryClient(worker, id, () => {
    if (active?.id === id) connectionLost('The session expired. Connect again.')
  })
  active?.close()
  active = {
    id, sample: source.kind === 'sample', client,
    close() {
      client.close()
      worker.terminate()
      close()
    },
  }
  worker.addEventListener('error', () => {
    if (active?.id === id) connectionLost('The library process stopped. Connect again.')
  }, { once: true })
  worker.postMessage({ kind: 'start', sessionId: id, source } satisfies WorkerStart)
  render()
}

async function connect(configuration: ConnectConfiguration) {
  const prefix = configuration.prefix.trim().replace(/^\/+|\/+$/g, '') || 'library'
  if (!relativeKey(prefix)) throw Object.assign(new Error('Invalid library prefix'), { code: 'invalidPrefix' })

  if (!gis.google?.accounts.oauth2) {
    loadingIdentity ??= new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://accounts.google.com/gsi/client'
      script.async = true
      script.onload = () => resolve()
      script.onerror = () => {
        script.remove()
        loadingIdentity = undefined
        reject(Object.assign(new Error('Google sign-in could not load'), { code: 'signInUnavailable' }))
      }
      document.head.append(script)
    })
    await loadingIdentity
    throw Object.assign(new Error('Google sign-in is ready. Select Connect again.'), { code: 'signInReady' })
  }

  connecting?.abort()
  const attempt = new AbortController()
  connecting = attempt
  try {
    const session = await authorizeGcsSession({
      oauth: gis.google.accounts.oauth2,
      clientId: configuration.clientId,
      bucket: configuration.bucket,
      access: configuration.access === 'edit' ? 'editor' : 'viewer',
      signal: attempt.signal,
    })
    if (attempt.signal.aborted) {
      session.close()
      return
    }
    const expiry = setTimeout(() => connectionLost('The session expired. Connect again.'), Math.max(0, session.expiresAt - Date.now()))
    start({
      kind: 'gcs',
      bucket: configuration.bucket,
      prefix,
      token: session.getToken(),
      expiresAt: session.expiresAt,
      canWrite: session.access === 'editor',
    }, () => {
      clearTimeout(expiry)
      session.close()
    })
  } finally {
    if (connecting === attempt) connecting = undefined
  }
}

function render() {
  root.render(<HashRouter><AppView
    key={active?.id ?? 'connect'}
    client={active?.client}
    isFixture={active?.sample}
    onConnect={connect}
    onOpenFixture={import.meta.env.MODE === 'test' ? () => {
      connecting?.abort()
      start({ kind: 'sample' })
    } : undefined}
    onDisconnect={() => disconnect()}
    connectionNotice={connectionNotice}
  /></HashRouter>)
}

render()
