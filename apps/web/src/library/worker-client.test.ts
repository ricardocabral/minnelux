import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { connectLibraryClient } from './worker-client.ts'

test('matches replies by protocol, session, request, and operation', async () => {
  const { port1, port2 } = new MessageChannel()
  const client = connectLibraryClient(port1, 'reader')
  try {
    const request = once(port2, 'message')
    const result = client.open()
    const [envelope] = await request
    const value = { revisionId: 'r1', baseToken: 'base', tags: [], canWrite: false }
    port2.postMessage({ ...envelope, sessionId: 'old', status: 'error', code: 'old-session' })
    port2.postMessage({ ...envelope, version: 2, status: 'error', code: 'wrong-version' })
    port2.postMessage({ ...envelope, operation: 'query', status: 'error', code: 'wrong-operation' })
    port2.postMessage({ ...envelope, status: 'ok', value })
    assert.deepEqual(await result, value)
  } finally {
    client.close()
    port1.close()
    port2.close()
  }
})

test('aborts a request and rejects pending work when the session closes', async () => {
  const { port1, port2 } = new MessageChannel()
  const client = connectLibraryClient(port1, 'reader')
  try {
    const abort = new AbortController()
    const sent = once(port2, 'message')
    const abandoned = client.query({}, abort.signal)
    const [request] = await sent
    const canceled = once(port2, 'message')
    abort.abort()
    await assert.rejects(abandoned, { name: 'AbortError' })
    assert.deepEqual((await canceled)[0].input, { requestId: request.requestId })

    const pending = client.open()
    client.close()
    await assert.rejects(pending, { name: 'AbortError' })
    await assert.rejects(client.open(), { name: 'AbortError' })
  } finally {
    port1.close()
    port2.close()
  }
})

test('invalidates only the current session when the worker reports credential expiry', async () => {
  const { port1, port2 } = new MessageChannel()
  let expired = 0
  const client = connectLibraryClient(port1, 'reader', () => expired++)
  try {
    const sent = once(port2, 'message')
    const result = client.open()
    const [request] = await sent
    port2.postMessage({ ...request, sessionId: 'old', status: 'error', code: 'expired' })
    port2.postMessage({ ...request, status: 'error', code: 'expired' })
    await assert.rejects(result, { message: 'expired' })
    assert.equal(expired, 1)
  } finally {
    client.close()
    port1.close()
    port2.close()
  }
})

test('sends the original publication intent with the recovery mode', async () => {
  const { port1, port2 } = new MessageChannel()
  const client = connectLibraryClient(port1, 'editor')
  try {
    const intent = { kind: 'create-tag', title: 'Family', operationId: 'confirmed', baseToken: 'base' } as const
    const sent = once(port2, 'message')
    const recovered = client.publish(intent, { mode: 'recover' })
    const [request] = await sent
    assert.deepEqual(request.input, { intent, mode: 'recover' })
    const value = { status: 'published', revisionId: 'r1' }
    port2.postMessage({ ...request, status: 'ok', value })
    assert.deepEqual(await recovered, value)
  } finally {
    client.close()
    port1.close()
    port2.close()
  }
})

test('reports uncertainty on expiry after a publication can have committed', { timeout: 2_000 }, async () => {
  const { port1, port2 } = new MessageChannel()
  let warned = false
  const client = connectLibraryClient(port1, 'editor', () => {
    warned = client.hasUnconfirmedPublication()
  })
  try {
    const sent = once(port2, 'message')
    const result = client.publish({ kind: 'create-tag', title: 'Family', operationId: 'op', baseToken: 'base' })
    const [request] = await sent
    assert.equal(client.hasUnconfirmedPublication(), true)
    port2.postMessage({
      ...request, status: 'ok',
      value: { status: 'outcomeUnknown', operationId: 'op', code: 'expired' },
    })
    await result
    assert.equal(warned, true)
  } finally {
    client.close()
    port1.close()
    port2.close()
  }
})
