import { relativeKey } from '../library/catalog.ts'
import type { AuthorizedLibrarySource } from '../library/worker-contract.ts'
import { authorizeGcsSession, type GisOAuth } from './gcs-session.ts'
import { authorizeS3Session, type S3ConnectionSettings } from './s3-session.ts'

type GcsSettings = { provider: 'gcs'; clientId: string; access: 'read' | 'edit' }
export type ConnectionSettings = { bucket: string; prefix: string } & (
  GcsSettings | ({ provider: 's3' } & S3ConnectionSettings)
)

type GisWindow = Window & { google?: { accounts: { oauth2: GisOAuth } } }
let loadingGoogle: Promise<void> | undefined

async function openGoogle(settings: GcsSettings & { bucket: string }, signal: AbortSignal) {
  const google = (window as GisWindow).google
  if (!google?.accounts.oauth2) {
    loadingGoogle ??= new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://accounts.google.com/gsi/client'
      script.async = true
      script.onload = () => resolve()
      script.onerror = () => {
        script.remove()
        loadingGoogle = undefined
        reject(Object.assign(new Error('Google sign-in could not load'), { code: 'signInUnavailable' }))
      }
      document.head.append(script)
    })
    await loadingGoogle
    signal.throwIfAborted()
    throw Object.assign(new Error('Google sign-in is ready. Select Connect again.'), { code: 'signInReady' })
  }
  return authorizeGcsSession({
    oauth: google.accounts.oauth2,
    clientId: settings.clientId,
    bucket: settings.bucket,
    access: settings.access === 'edit' ? 'editor' : 'viewer',
    signal,
  })
}

export function libraryPrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/g, '') || 'library'
  if (!relativeKey(prefix)) throw Object.assign(new Error('Invalid library prefix'), { code: 'invalidPrefix' })
  return prefix
}

export async function authorizeConnection(settings: ConnectionSettings, signal: AbortSignal): Promise<{
  source: AuthorizedLibrarySource
  close(): void
}> {
  const { bucket } = settings
  const prefix = libraryPrefix(settings.prefix)
  signal.throwIfAborted()

  if (settings.provider === 'gcs') {
    const session = await openGoogle(settings, signal)
    try {
      signal.throwIfAborted()
      return {
        source: {
          kind: 'gcs', bucket, prefix, token: session.getToken(),
          expiresAt: session.expiresAt, canWrite: session.access === 'editor',
        },
        close: session.close,
      }
    } catch (error) {
      session.close()
      throw error
    }
  }

  // Validate the DNS bucket name before opening the sign-in window or signing requests.
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) {
    throw Object.assign(new Error('Invalid Amazon S3 bucket'), { code: 'invalidBucket' })
  }
  const session = await authorizeS3Session(settings, signal)
  try {
    signal.throwIfAborted()
    return {
      source: {
        kind: 's3', bucket, prefix, region: settings.region, credentials: session.getCredentials(),
        expiresAt: session.expiresAt, canWrite: session.access === 'editor',
      },
      close: session.close,
    }
  } catch (error) {
    session.close()
    throw error
  }
}
