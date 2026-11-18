import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import { connectLibraryClient } from './library/worker-client.ts'
import { libraryProtocolVersion, type WorkerStart } from './library/worker-contract.ts'
import { authorizeConnection, libraryPrefix, type ConnectionSettings } from './storage/connection.ts'
import { endDurableSession, reportRejectedGrant, resumeDurableSession, startDurableSession } from './storage/durable-session.ts'
import AppView from './ui/App.tsx'

const root = createRoot(document.getElementById('root')!)
let active: { id: string; client: ReturnType<typeof connectLibraryClient>; close(): void; kind: WorkerStart['source']['kind'] } | undefined
let connecting: AbortController | undefined
let connectionNotice: string | undefined
const durable = import.meta.env.VITE_DURABLE_GCS_SESSION === '1'
let restoring = durable
let retrySignOut = false

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

function start(source: WorkerStart['source'], close: () => void = () => {},
  onExpired = () => connectionLost('The session expired. Connect again.')) {
  const id = crypto.randomUUID()
  const worker = new Worker(new URL('./library/worker.ts', import.meta.url), { type: 'module' })
  const client = connectLibraryClient(worker, id, () => {
    if (active?.id === id) onExpired()
  })
  active?.close()
  active = {
    id, kind: source.kind, client,
    close() {
      client.close()
      worker.terminate()
      close()
    },
  }
  worker.addEventListener('error', () => {
    if (active?.id === id) connectionLost('The library process stopped. Connect again.')
  }, { once: true })
  worker.postMessage({ kind: 'start', version: libraryProtocolVersion, sessionId: id, source } satisfies WorkerStart)
  render()
}

async function connect(settings: ConnectionSettings) {
  if (durable && settings.provider === 'gcs') {
    return startDurableSession({ ...settings, prefix: libraryPrefix(settings.prefix) })
  }
  connecting?.abort()
  const attempt = new AbortController()
  connecting = attempt
  try {
    const session = await authorizeConnection(settings, attempt.signal)
    if (attempt.signal.aborted) {
      session.close()
      return
    }
    const expiry = setTimeout(
      () => connectionLost('The session expired. Connect again.'),
      Math.max(0, session.source.expiresAt - Date.now()),
    )
    function close() {
      clearTimeout(expiry)
      session.close()
    }
    try {
      start(session.source, close)
    } catch (error) {
      close()
      throw error
    }
  } catch (error) {
    if (!attempt.signal.aborted) throw error
  } finally {
    if (connecting === attempt) connecting = undefined
  }
}

async function restore() {
  const url = new URL(location.href)
  if (url.searchParams.get('signIn') === 'failed') {
    url.searchParams.delete('signIn')
    history.replaceState(history.state, '', url)
    connectionNotice = 'Google sign-in could not be completed. Connect again.'
  } else {
    try {
      const restored = await resumeDurableSession()
      if (restored) {
        const { source, grantId } = restored
        const expiry = setTimeout(() => connectionLost('Your access token expired. Reload to reconnect.'),
          Math.max(0, source.expiresAt - Date.now()))
        start(source, () => clearTimeout(expiry), () => void rejectDurableGrant(grantId))
      }
    } catch {
      connectionNotice = 'The saved session could not be restored. Try reloading this page.'
    }
  }
  restoring = false
  render()
}

async function rejectDurableGrant(grantId: string) {
  restoring = true
  connectionLost('Your access token was rejected.')
  try {
    await reportRejectedGrant(grantId)
    connectionNotice += ' Reload to reconnect.'
  } catch {
    connectionNotice += ' Connect again.'
  } finally {
    restoring = false
    render()
  }
}

async function signOut() {
  restoring = true
  retrySignOut = false
  disconnect('Signing out…')
  try {
    await endDurableSession()
    connectionNotice = undefined
  } catch {
    connectionNotice = 'The server could not sign you out. Try again.'
    retrySignOut = true
  } finally {
    restoring = false
    render()
  }
}

function render() {
  root.render(<HashRouter><AppView
    key={active?.id ?? 'connect'}
    client={active?.client}
    isFixture={active?.kind === 'sample'}
    durable={durable}
    checkingConnection={restoring}
    onRetrySignOut={retrySignOut ? () => void signOut() : undefined}
    onConnect={connect}
    onCancelConnect={() => connecting?.abort()}
    onOpenFixture={import.meta.env.MODE === 'test' ? () => {
      connecting?.abort()
      start({ kind: 'sample' })
    } : undefined}
    onDisconnect={durable && active?.kind === 'gcs' ? () => void signOut() : () => disconnect()}
    connectionNotice={connectionNotice}
  /></HashRouter>)
}

render()
if (durable) void restore()
