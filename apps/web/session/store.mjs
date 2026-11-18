import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fchmodSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const maxPendingAttempts = 256

export const randomId = () => randomBytes(32).toString('base64url')
const digest = value => createHash('sha256').update(value).digest('hex')

export function openSessionStore(path, key) {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true })
  const file = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try { fchmodSync(file, 0o600) } finally { closeSync(file) }
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL,
      claimed INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS attempts_expiry ON attempts (expires_at);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, data BLOB NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);
  `)
  const start = db.prepare(`
    INSERT INTO attempts (id, expires_at, state, data)
    SELECT ?, ?, ?, ? WHERE (SELECT count(*) FROM attempts) < ?
  `)
  const claim = db.prepare(
    'UPDATE attempts SET claimed = 1 WHERE id = ? AND state = ? AND expires_at > ? AND claimed = 0 RETURNING data',
  )
  const finish = db.prepare('DELETE FROM attempts WHERE id = ? AND claimed = 1 AND expires_at > ?')
  const removeAttempt = db.prepare('DELETE FROM attempts WHERE id = ?')
  const removeExpiredAttempts = db.prepare('DELETE FROM attempts WHERE expires_at <= ?')
  const create = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)')
  const read = db.prepare('SELECT expires_at, data FROM sessions WHERE id = ? AND expires_at > ?')
  const update = db.prepare('UPDATE sessions SET data = ? WHERE id = ? AND expires_at > ?')
  const remove = db.prepare('DELETE FROM sessions WHERE id = ?')
  const removeExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?')

  function encrypt(id, record) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(id))
    const bytes = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), bytes])
  }

  function decrypt(id, data) {
    const bytes = Buffer.from(data)
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
    cipher.setAAD(Buffer.from(id))
    cipher.setAuthTag(bytes.subarray(12, 28))
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'))
  }

  return {
    startAttempt(id, now, expiresAt, state, record) {
      removeExpiredAttempts.run(now)
      return start.run(digest(id), expiresAt, digest(state), JSON.stringify(record), maxPendingAttempts).changes === 1
    },
    claimAttempt(id, state, now) {
      const row = claim.get(digest(id), digest(state), now)
      return row && JSON.parse(row.data)
    },
    removeAttempt(id) { return Boolean(id && removeAttempt.run(digest(id)).changes) },
    establishSession(attemptId, sessionId, previousId, now, expiresAt, record) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const claimed = finish.run(digest(attemptId), now).changes === 1
        if (claimed) {
          const hash = digest(sessionId)
          create.run(hash, expiresAt, encrypt(hash, record))
          if (previousId) remove.run(digest(previousId))
        }
        db.exec('COMMIT')
        return claimed
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    readSession(id, now) {
      if (!id) return undefined
      const hash = digest(id)
      const row = read.get(hash, now)
      return row && { expiresAt: row.expires_at, ...decrypt(hash, row.data) }
    },
    updateSession(id, now, record) {
      const hash = digest(id)
      return update.run(encrypt(hash, record), hash, now).changes === 1
    },
    removeSession(id) { if (id) remove.run(digest(id)) },
    purge(now) {
      removeExpiredAttempts.run(now)
      removeExpiredSessions.run(now)
    },
    close() { db.close() },
  }
}
