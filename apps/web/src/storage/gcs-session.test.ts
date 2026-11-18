import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizeGcsSession, type GisOAuth } from './gcs-session.ts'

const viewerScope = 'https://www.googleapis.com/auth/devstorage.read_only'
const editorScope = 'https://www.googleapis.com/auth/devstorage.read_write'

function gis(granted: string) {
  let config: Parameters<GisOAuth['initTokenClient']>[0]
  let requested = false
  const oauth: GisOAuth = {initTokenClient(value) {
    config = value
    return {requestAccessToken({prompt}) {
      assert.equal(prompt, 'select_account')
      requested = true
    }}
  }}
  return {oauth, get options() {return config}, finish(expiresIn = '3600') {
    assert.ok(requested)
    config.callback({access_token:'synthetic-token', expires_in:expiresIn, token_type:'Bearer', scope:granted})
  }}
}

const base = {clientId:'synthetic-client', bucket:'private-bucket', access:'viewer'} as const

test('requests the narrow viewer grant, verifies the subject, and invalidates the token on close', async () => {
  const google = gis('openid ' + viewerScope)
  let requests = 0
  const connecting = authorizeGcsSession({...base, oauth:google.oauth, fetch:async (input, init) => {
    requests++
    assert.equal(new URL(String(input)).hostname, 'openidconnect.googleapis.com')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-token')
    return Response.json({sub:'synthetic-user'})
  }})
  assert.equal(google.options.scope, 'openid ' + viewerScope)
  assert.equal(google.options.include_granted_scopes, false)
  google.finish()
  const session = await connecting
  assert.equal(session.subject, 'synthetic-user')
  assert.equal(session.getToken(), 'synthetic-token')
  await assert.rejects(session.store.write('library/head.json', new Blob(), {kind:'create'}), {code:'denied'})
  assert.equal(requests, 1)
  session.close()
  assert.throws(session.getToken, {code:'aborted'})
  assert.equal(session.signal.aborted, true)
})

test('rejects a viewer token that exceeds the requested grant', async () => {
  const google = gis('openid ' + viewerScope + ' ' + editorScope)
  const connecting = authorizeGcsSession({...base, oauth:google.oauth, fetch:async () => {
    assert.fail('token exceeded requested grant')
  }})
  google.finish()
  await assert.rejects(connecting, {code:'denied'})
})

test('drops authorization when the caller switches before the GIS response', async () => {
  const google = gis('openid ' + viewerScope)
  const controller = new AbortController()
  const connecting = authorizeGcsSession({...base, oauth:google.oauth, signal:controller.signal, fetch:async () => {
    assert.fail('late acknowledgement cannot send a private request')
  }})
  controller.abort()
  google.finish()
  await assert.rejects(connecting, {code:'aborted'})
})

test('invalidates private access when the provider rejects a live token', async () => {
  const google = gis('openid ' + editorScope)
  const connecting = authorizeGcsSession({...base, access:'editor', oauth:google.oauth, fetch:async input =>
    new URL(String(input)).hostname === 'openidconnect.googleapis.com'
      ? Response.json({sub:'synthetic-user'}) : new Response(null, {status:401}),
  })
  google.finish()
  const session = await connecting
  await assert.rejects(session.store.read('library/head.json'), {code:'expired'})
  assert.throws(session.getToken, {code:'expired'})
  assert.equal(session.signal.aborted, true)
})
