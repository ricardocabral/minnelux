import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import { connectLibraryClient } from './library/worker-client.ts'
import { libraryProtocolVersion, type AuthorizedLibrarySource, type WorkerStart } from './library/worker-contract.ts'
import { authorizeConnection, type ConnectionSettings } from './storage/connection.ts'
import { forgetGoogleLogin, rememberGoogleLogin, restoreGoogleLogin } from './storage/remembered-google-login.ts'
import AppView from './ui/App.tsx'

const root = createRoot(document.getElementById('root')!)
let active: {
  id: string
  client: ReturnType<typeof connectLibraryClient>
  close(): void
  kind: WorkerStart['source']['kind']
  rememberedId?: string
} | undefined
let connecting: AbortController | undefined
let connectionNotice: string | undefined
let checkingConnection = true
let retryForget: (() => void) | undefined

function disconnect(notice?: string) {
  connectionNotice = notice
  connecting?.abort()
  active?.close()
  active = undefined
  render()
}

async function forgetAndDisconnect(rememberedId: string, notice?: string) {
  checkingConnection = true
  retryForget = undefined
  disconnect(notice ?? 'Removing saved login…')
  try {
    await forgetGoogleLogin(rememberedId)
    connectionNotice = notice
  } catch {
    const failure = 'The browser could not remove the saved login. Try again.'
    connectionNotice = notice ? notice + ' ' + failure : failure
    retryForget = () => void forgetAndDisconnect(rememberedId, notice)
  } finally {
    checkingConnection = false
    render()
  }
}

function closeConnection(notice?: string) {
  if (active?.rememberedId) void forgetAndDisconnect(active.rememberedId, notice)
  else disconnect(notice)
}

function connectionLost(notice: string) {
  const pending = active?.client.hasUnconfirmedPublication()
  closeConnection(pending ? notice + ' A publication may have succeeded. Check the library before importing the photo again.' : notice)
}

function start(source: WorkerStart['source'], close: () => void = () => {}, rememberedId?: string) {
  const id = crypto.randomUUID()
  const worker = new Worker(new URL('./library/worker.ts', import.meta.url), { type: 'module' })
  const client = connectLibraryClient(worker, id, () => {
    if (active?.id === id) connectionLost('The session expired. Connect again.')
  })
  try {
    worker.postMessage({ kind: 'start', version: libraryProtocolVersion, sessionId: id, source } satisfies WorkerStart)
  } catch (error) {
    client.close()
    worker.terminate()
    throw error
  }
  active?.close()
  active = {
    id, kind: source.kind, client, rememberedId,
    close() {
      client.close()
      worker.terminate()
      close()
    },
  }
  worker.addEventListener('error', () => {
    if (active?.id === id) connectionLost('The library process stopped. Connect again.')
  }, { once: true })
  render()
}

function startAuthorized(source: AuthorizedLibrarySource, closeSession?: () => void, rememberedId?: string) {
  const expiry = setTimeout(
    () => connectionLost('The session expired. Connect again.'),
    Math.max(0, source.expiresAt - Date.now()),
  )
  function close() {
    clearTimeout(expiry)
    closeSession?.()
  }
  try {
    start(source, close, rememberedId)
  } catch (error) {
    close()
    throw error
  }
}

async function connect(settings: ConnectionSettings, rememberLogin: boolean) {
  connecting?.abort()
  const attempt = new AbortController()
  connecting = attempt
  try {
    const session = await authorizeConnection(settings, attempt.signal)
    let rememberedId: string | undefined
    connectionNotice = undefined
    if (rememberLogin && session.source.kind === 'gcs') {
      try {
        rememberedId = await rememberGoogleLogin(session.source)
      } catch {
        connectionNotice = 'The browser could not save this login. Connect again after reloading.'
      }
    }
    if (attempt.signal.aborted) {
      session.close()
      if (rememberedId) await forgetGoogleLogin(rememberedId)
      return
    }
    startAuthorized(session.source, session.close, rememberedId)
  } catch (error) {
    if (!attempt.signal.aborted) throw error
  } finally {
    if (connecting === attempt) connecting = undefined
  }
}

async function restore() {
  try {
    const saved = await restoreGoogleLogin()
    if (saved) startAuthorized(saved.source, undefined, saved.id)
  } catch {
    // A browser that disallows IndexedDB can still connect for this page.
  } finally {
    checkingConnection = false
    render()
  }
}

function render() {
  root.render(<HashRouter><AppView
    key={active?.id ?? 'connect'}
    client={active?.client}
    isFixture={active?.kind === 'sample'}
    checkingConnection={checkingConnection}
    onRetryForget={retryForget}
    onConnect={connect}
    onCancelConnect={() => connecting?.abort()}
    onOpenFixture={import.meta.env.MODE === 'test' ? () => {
      connecting?.abort()
      start({ kind: 'sample' })
    } : undefined}
    onDisconnect={() => closeConnection()}
    connectionNotice={connectionNotice}
  /></HashRouter>)
}

render()
void restore()
