import { createHash } from 'node:crypto'
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'

const authorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth'
const tokenEndpoint = 'https://oauth2.googleapis.com/token'
const userInfoEndpoint = 'https://openidconnect.googleapis.com/v1/userinfo'

export class OAuthGrantError extends Error {}

function scopesFor(access) {
  const storageScope = access === 'edit' ? 'read_write' : 'read_only'
  return ['openid', 'https://www.googleapis.com/auth/devstorage.' + storageScope]
}

function verifyScopes(value, access) {
  const granted = typeof value === 'string' ? new Set(value.trim().split(/\s+/)) : new Set()
  const required = scopesFor(access)
  if (granted.size !== required.length || !required.every(scope => granted.has(scope))) {
    throw new OAuthGrantError('Google did not grant the requested scopes')
  }
}

function tokenString(value) {
  return typeof value === 'string' && value.length <= 16_384 && /^[!-~]+$/.test(value)
}

export function createGoogleOAuth({ clientId, clientSecret, redirectUri, request, now }) {
  const requestGoogle = (url, options) => request(url, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(10_000),
  })
  const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
    [customFetch]: requestGoogle,
  })

  function authorizationUrl({ access, state, verifier, nonce }) {
    const url = new URL(authorizationEndpoint)
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopesFor(access).join(' '),
      access_type: 'offline',
      include_granted_scopes: 'false',
      prompt: 'consent select_account',
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString()
    return url.href
  }

  async function tokens(parameters, access) {
    const requestedAt = now()
    const response = await requestGoogle(tokenEndpoint, {
      method: 'POST',
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...parameters }),
    })
    const result = await response.json()
    if (response.status === 400 && result?.error === 'invalid_grant') throw new OAuthGrantError('Google authorization expired')
    if (!response.ok || !result || !tokenString(result.access_token) ||
        typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer' || !Number.isSafeInteger(result.expires_in) ||
        result.expires_in < 1 || result.expires_in > 86_400 ||
        (result.refresh_token !== undefined && !tokenString(result.refresh_token))) {
      throw new Error('Google token response was invalid')
    }
    if (parameters.grant_type !== 'refresh_token' || result.scope !== undefined) verifyScopes(result.scope, access)
    return {
      token: result.access_token,
      expiresAt: requestedAt + result.expires_in * 1000,
      refreshToken: result.refresh_token,
      idToken: result.id_token,
    }
  }

  async function subject(token) {
    const response = await requestGoogle(userInfoEndpoint, { headers: { Authorization: 'Bearer ' + token } })
    if (response.status === 401 || response.status === 403) throw new OAuthGrantError('Google authorization expired')
    if (!response.ok) throw new Error('Google identity check failed')
    const info = await response.json()
    if (!tokenString(info?.sub) || info.sub.length > 255) throw new OAuthGrantError('Google subject was invalid')
    return info.sub
  }

  return {
    authorizationUrl,
    async exchange(code, attempt) {
      const { idToken, ...grant } = await tokens({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: attempt.verifier,
      }, attempt.access)
      if (!grant.refreshToken || !tokenString(idToken)) throw new OAuthGrantError('Google offline grant was missing')
      const { payload } = await jwtVerify(idToken, googleKeys, {
        algorithms: ['RS256'],
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: clientId,
        requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
        maxTokenAge: '10m',
        currentDate: new Date(now()),
      })
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
      if (audiences.length !== 1 || audiences[0] !== clientId ||
          payload.nonce !== attempt.nonce || (payload.azp !== undefined && payload.azp !== clientId) ||
          (await subject(grant.token)) !== payload.sub) {
        throw new OAuthGrantError('Google identity did not match')
      }
      return { ...grant, subject: payload.sub }
    },
    async refresh(previous, access) {
      const { idToken, ...grant } = await tokens({
        grant_type: 'refresh_token', refresh_token: previous.refreshToken,
      }, access)
      return { ...grant, refreshToken: grant.refreshToken ?? previous.refreshToken }
    },
    async verifySubject(token, previousSubject) {
      if ((await subject(token)) !== previousSubject) throw new OAuthGrantError('Google identity changed')
    },
  }
}
