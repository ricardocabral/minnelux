import { createHash, randomUUID } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

export const clientId = 'fixture.apps.googleusercontent.com'
const subject = 'synthetic-google-user'
export const readScope = 'openid https://www.googleapis.com/auth/devstorage.read_only'

export async function fakeGoogle(now) {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }
  const authorized = new Map()
  const knownAccessTokens = new Set()
  const knownRefreshTokens = new Set()
  const calls = { exchanges: 0, refreshes: 0 }

  function authorize(url) {
    const parameters = new URL(url).searchParams
    const code = randomUUID()
    authorized.set(code, parameters)
    const callback = new URL(parameters.get('redirect_uri'))
    callback.searchParams.set('state', parameters.get('state'))
    callback.searchParams.set('code', code)
    return callback
  }

  async function request(url, options) {
    switch (String(url)) {
      case 'https://www.googleapis.com/oauth2/v3/certs':
        return Response.json({ keys: [jwk] })
      case 'https://openidconnect.googleapis.com/v1/userinfo':
        if (calls.userInfoFailures > 0) {
          calls.userInfoFailures--
          return new Response(null, { status: 503 })
        }
        return knownAccessTokens.has(options.headers.Authorization.slice('Bearer '.length))
          ? Response.json({ sub: subject }) : new Response(null, { status: 401 })
      case 'https://oauth2.googleapis.com/token': {
        const token = 'fixture-access-' + randomUUID()
        const result = { access_token: token, token_type: 'Bearer', expires_in: 3600 }
        const grant = options.body
        if (grant.get('grant_type') === 'refresh_token') {
          calls.refreshes++
          if (!knownRefreshTokens.delete(grant.get('refresh_token'))) {
            return Response.json({ error: 'invalid_grant' }, { status: 400 })
          }
          if (calls.refreshScope !== undefined) result.scope = calls.refreshScope
        } else {
          calls.exchanges++
          await calls.beforeExchange?.()
          const code = grant.get('code')
          const authorization = authorized.get(code)
          authorized.delete(code)
          if (authorization?.get('code_challenge') !==
              createHash('sha256').update(grant.get('code_verifier') ?? '').digest('base64url')) {
            return Response.json({ error: 'invalid_grant' }, { status: 400 })
          }
          result.scope = calls.exchangeScope ?? authorization.get('scope')
          const issuedAt = Math.floor(now() / 1000)
          result.id_token = await new SignJWT({ nonce: calls.nonce ?? authorization.get('nonce'), azp: calls.authorizedParty })
            .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
            .setAudience(calls.audience ?? clientId).setIssuer('https://accounts.google.com').setSubject(subject)
            .setIssuedAt(issuedAt).setExpirationTime(issuedAt + 3600).sign(privateKey)
        }
        result.refresh_token = 'fixture-refresh-' + randomUUID()
        knownAccessTokens.add(token)
        knownRefreshTokens.add(result.refresh_token)
        return Response.json(result)
      }
      default:
        throw new Error('Unexpected provider endpoint')
    }
  }

  return { request, authorize, calls, knownAccessTokens, knownRefreshTokens }
}
