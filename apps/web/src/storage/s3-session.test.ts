import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createHash } from 'node:crypto'
import { CognitoIdentityClient, GetCredentialsForIdentityCommand, GetIdCommand } from '@aws-sdk/client-cognito-identity'
import { authorizeS3Session } from './s3-session.ts'

const settings = {
  region: 'us-east-2',
  cognitoOrigin: 'https://photos.auth.us-east-2.amazoncognito.com',
  userPoolId: 'us-east-2_example',
  clientId: 'client888',
  identityPoolId: 'us-east-2:11111111-1111-1111-1111-111111111111',
}
const identityId = 'us-east-2:22222222-2222-2222-2222-222222222222'
const callbackUrl = 'https://library.example/nested/viewer/cognito-callback.html'
const opener = {}

function browser(context: TestContext) {
  let opened = false
  let navigate!: (url: URL) => void
  const navigation = new Promise<URL>(resolve => { navigate = resolve })
  const popup = {
    closed: false,
    opener,
    close() { this.closed = true },
    document: {createElement(tag: string) {
      assert.equal(tag, 'a')
      return { href: '', rel: '', click() {
        assert.equal(this.rel, 'noreferrer')
        assert.equal(popup.opener, null)
        navigate(new URL(this.href))
      }}
    }},
  }
  context.mock.method(globalThis, 'fetch', async () => assert.fail('unexpected token exchange'))
  Object.defineProperty(globalThis, 'window', {value: {
    location: new URL('https://library.example/nested/viewer/index.html?invite=private#/photos'),
    open(url: string) {
      assert.equal(url, 'about:blank')
      opened = true
      return popup
    },
  }, configurable:true})
  context.after(() => Reflect.deleteProperty(globalThis, 'window'))
  return { popup, get opened() {return opened}, navigation }
}

async function respond(navigation: Promise<URL>) {
  const authorize = await navigation
  const state = authorize.searchParams.get('state')
  assert.match(state ?? '', /^[a-f0-9]{64}$/)
  const channel = new BroadcastChannel('minnelux-cognito-' + state)
  channel.postMessage({state:'unrelated', code:'incorrect'})
  channel.postMessage({state, code:'cognito-test-code'})
  channel.close()
  return authorize
}

for (const [groups, access] of [[['team'], 'editor'], [['team-other'], 'viewer']] as const) {
  test(`authorizes the ${access} with the exact callback and the AWS-issued identity`, async context => {
    const contents = Buffer.from(JSON.stringify({ 'cognito:groups':groups })).toString('base64url')
    const idToken = `eyJhbGciOiJSUzI1NiJ9.${contents}.dGVzdA`
    const environment = browser(context)
    const {popup, navigation} = environment
    context.mock.timers.enable({apis:['Date', 'setTimeout']})
    const expiresAt = Date.now() + 10_000
    const flow = authorizeS3Session({...settings, editorGroup:'team'})
    assert.equal(popup.opener, null)
    context.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
      assert.equal(input.href, settings.cognitoOrigin + '/oauth2/token')
      assert.equal(init.method, 'POST')
      assert.equal(init.redirect, 'error')
      assert.equal(init.referrerPolicy, 'no-referrer')
      assert.equal(init.credentials, 'omit')
      const grant = init.body as URLSearchParams
      assert.equal(grant.get('redirect_uri'), callbackUrl)
      assert.equal(grant.get('code'), 'cognito-test-code')
      assert.equal(grant.get('grant_type'), 'authorization_code')
      assert.equal(grant.get('client_id'), settings.clientId)
      const authorize = await navigation
      const challenge = createHash('sha256').update(grant.get('code_verifier') ?? '').digest('base64url')
      assert.equal(authorize.searchParams.get('code_challenge'), challenge)
      return Response.json({id_token:idToken, refresh_token:'discard-this'})
    })
    context.mock.method(CognitoIdentityClient.prototype, 'send', async (command: GetIdCommand | GetCredentialsForIdentityCommand, options: {abortSignal: AbortSignal}) => {
      assert.deepEqual(command.input.Logins, {'cognito-idp.us-east-2.amazonaws.com/us-east-2_example':idToken})
      assert.equal(options.abortSignal.aborted, false)
      if (command instanceof GetIdCommand) {
        assert.equal(command.input.IdentityPoolId, settings.identityPoolId)
        return {IdentityId:identityId}
      }
      assert.ok(command instanceof GetCredentialsForIdentityCommand)
      assert.equal(command.input.IdentityId, identityId)
      return {IdentityId:identityId, Credentials:{AccessKeyId:'test-key', SecretKey:'test-secret', SessionToken:'test-session', Expiration:new Date(expiresAt)}}
    })
    const authorize = await respond(navigation)
    assert.equal(authorize.origin + authorize.pathname, settings.cognitoOrigin + '/oauth2/authorize')
    assert.equal(authorize.searchParams.get('redirect_uri'), callbackUrl)
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(authorize.searchParams.get('response_type'), 'code')
    assert.equal(authorize.searchParams.get('scope'), 'openid')
    assert.equal(environment.opened, true)
    const session = await flow
    try {
      assert.equal(session.subject, `${settings.identityPoolId}/${identityId}`)
      assert.equal(session.access, access)
      assert.equal(session.expiresAt, expiresAt)
      assert.deepEqual(session.getCredentials(), {accessKeyId:'test-key', secretAccessKey:'test-secret', sessionToken:'test-session'})
      assert.ok(popup.closed)
      if (access === 'viewer') {
        context.mock.timers.tick(10_000)
        assert.throws(session.getCredentials, {code:'expired'})
      }
    } finally {
      session.close()
    }
    assert.throws(session.getCredentials, {code:access === 'editor' ? 'aborted' : 'expired'})
  })
}

test('rejects an untrusted Cognito origin before opening a popup', async context => {
  const app = browser(context)
  for (const cognitoOrigin of [
    'https://photos.auth.us-east-2.amazoncognito.com.evil.example',
    'https://photos.auth.us-west-2.amazoncognito.com',
    'http://photos.auth.us-east-2.amazoncognito.com',
    'https://user:pass@photos.auth.us-east-2.amazoncognito.com',
  ]) {
    await assert.rejects(authorizeS3Session({...settings, cognitoOrigin}), {code:'invalidResponse'})
  }
  assert.equal(app.opened, false)
})

test('an abort closes the popup and prevents a late callback from exchanging a code', async context => {
  const {popup, navigation} = browser(context)
  const controller = new AbortController()
  const flow = authorizeS3Session(settings, controller.signal)
  await navigation
  controller.abort()
  await respond(navigation)
  await assert.rejects(flow, {code:'aborted'})
  assert.ok(popup.closed)
})


test('times out stalled sign-in and closes the popup', async context => {
  context.mock.timers.enable({apis:['setTimeout']})
  const {popup, navigation} = browser(context)
  const flow = authorizeS3Session(settings)
  const rejection = assert.rejects(flow, {code:'signInTimeout'})
  await navigation
  context.mock.timers.tick(180_000)
  await rejection
  assert.ok(popup.closed)
})

test('removes provider details from errors returned to the caller', async context => {
  const {popup, navigation} = browser(context)
  context.mock.method(globalThis, 'fetch', async () => Response.json({id_token:'e30.e30.dGVzdA'}))
  context.mock.method(CognitoIdentityClient.prototype, 'send', async () => {
    throw Object.assign(new Error('private provider response'), {code:'denied', secret:'temporary field'})
  })
  const flow = authorizeS3Session(settings)
  const rejection = assert.rejects(flow, error => {
    assert.deepEqual(error, Object.assign(new Error('denied'), {code:'denied'}))
    return true
  })
  await respond(navigation)
  await rejection
  assert.ok(popup.closed)
})
