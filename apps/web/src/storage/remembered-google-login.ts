import { relativeKey } from '../library/catalog.ts'
import type { AuthorizedLibrarySource } from '../library/worker-contract.ts'
import { record } from './io.ts'

type GoogleSource = Extract<AuthorizedLibrarySource, { kind: 'gcs' }>
type RememberedLogin = { id: string; source: GoogleSource }
const loginKey = 'google'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('minnelux-logins', 1)
    let blocked = false
    request.onblocked = () => {
      blocked = true
      reject(new Error('Browser storage is blocked'))
    }
    request.onupgradeneeded = () => request.result.createObjectStore('logins')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      if (blocked) request.result.close()
      else resolve(request.result)
    }
  })
}

async function updateLogin(update: (value: unknown, store: IDBObjectStore) => RememberedLogin | void) {
  const database = await openDatabase()
  try {
    return await new Promise<RememberedLogin | void>((resolve, reject) => {
      const transaction = database.transaction('logins', 'readwrite')
      const store = transaction.objectStore('logins')
      let result: RememberedLogin | void
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage transaction aborted'))
      const request = store.get(loginKey)
      request.onsuccess = () => { result = update(request.result, store) }
    })
  } finally {
    database.close()
  }
}

function isValidLogin(value: unknown): value is RememberedLogin {
  if (!record(value) || typeof value.id !== 'string' || !record(value.source)) return false
  const { kind, bucket, prefix, token, canWrite, expiresAt } = value.source
  return kind === 'gcs' && typeof bucket === 'string' && bucket !== '' && relativeKey(prefix) &&
    typeof token === 'string' && /^[!-~]+$/.test(token) && typeof canWrite === 'boolean' &&
    typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) &&
    expiresAt > Date.now() && expiresAt <= Date.now() + 86_400_000
}

export async function rememberGoogleLogin(source: GoogleSource): Promise<string> {
  const id = crypto.randomUUID()
  await updateLogin((_, store) => { store.put({ id, source } satisfies RememberedLogin, loginKey) })
  return id
}

export function restoreGoogleLogin() {
  return updateLogin((value, store) => {
    if (isValidLogin(value)) return value
    if (value !== undefined) store.delete(loginKey)
  })
}

export async function forgetGoogleLogin(id: string): Promise<void> {
  await updateLogin((value, store) => {
    // An older tab can disconnect after another tab saves a new login.
    if (record(value) && value.id === id) store.delete(loginKey)
  })
}
