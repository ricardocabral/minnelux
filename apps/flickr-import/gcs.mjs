const storageOrigin = 'https://storage.googleapis.com'
const generationPattern = /^\d+$/
const bucketPattern = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/

export function createGcsStore(bucket, getToken, { fetch: request = globalThis.fetch } = {}) {
  if (!bucketPattern.test(bucket)) {
    throw new TypeError('Enter a Cloud Storage bucket name')
  }

  const encodedBucket = encodeURIComponent(bucket)

  async function send(url, options, signal) {
    signal?.throwIfAborted()
    const token = await getToken()
    if (!token) throw Object.assign(new Error('Sign in to Cloud Storage'), { status: 401 })
    const headers = new Headers(options.headers)
    headers.set('Authorization', `Bearer ${token}`)
    return request(url, {
      ...options,
      headers,
      signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
  }

  return {
    libraryId: `gs://${bucket}`,

    async get(key, { signal } = {}) {
      const url = new URL(`/storage/v1/b/${encodedBucket}/o/${encodeURIComponent(key)}`, storageOrigin)
      url.searchParams.set('fields', 'generation,size')
      const metadata = await send(url, {}, signal)
      if (metadata.status === 404) return null
      const { generation, size } = await checkedJson(metadata)
      requireGeneration(generation)
      if (!/^\d+$/.test(size) || Number(size) > 1024 ** 3) {
        throw new Error('Cloud Storage object exceeds the read limit')
      }

      url.search = new URLSearchParams({ alt: 'media', generation })
      const media = await send(url, {}, signal)
      checkStatus(media)
      const body = await media.blob()
      if (body.size !== Number(size)) throw new Error('Cloud Storage object size did not match metadata')
      return { body, generation }
    },

    async put(key, body, { match, signal } = {}) {
      if (typeof match !== 'string' || !generationPattern.test(match)) {
        throw new TypeError('Cloud Storage writes require a generation precondition')
      }
      const url = new URL(`/upload/storage/v1/b/${encodedBucket}/o`, storageOrigin)
      url.search = new URLSearchParams({
        uploadType: 'multipart',
        ifGenerationMatch: match,
        fields: 'generation',
      })
      // Object names travel in the multipart metadata so create-only requests
      // share one URL and the browser can reuse the authorization preflight.
      const boundary = 'minnelux-' + crypto.randomUUID()
      const contentType = body.type || 'application/octet-stream'
      const type = 'multipart/related; boundary=' + boundary
      const envelope = new Blob([
        '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n',
        JSON.stringify({ name: key, contentType }),
        '\r\n--' + boundary + '\r\nContent-Type: ' + contentType + '\r\n\r\n',
        body,
        '\r\n--' + boundary + '--\r\n',
      ], { type })
      const response = await send(url, {
        method: 'POST',
        body: envelope,
        headers: { 'Content-Type': type },
      }, signal)
      const { generation } = await checkedJson(response)
      requireGeneration(generation)
      return { generation }
    },
  }
}

function requireGeneration(generation) {
  if (typeof generation !== 'string' || !generationPattern.test(generation)) {
    throw new Error('Cloud Storage did not return an object generation')
  }
}

function checkStatus(response) {
  if (!response.ok) {
    throw Object.assign(new Error(`Cloud Storage returned HTTP ${response.status}`), { status: response.status })
  }
}

async function checkedJson(response) {
  checkStatus(response)
  return response.json()
}

export async function downscopeGcsToken(sourceToken, bucket, prefix, access, {
  fetch: request = globalThis.fetch,
  signal,
} = {}) {
  const validPrefix = prefix.split('/').every((part) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(part))
  if (!bucketPattern.test(bucket) || !validPrefix || !['reader', 'editor'].includes(access)) {
    throw new TypeError('Invalid Cloud Storage bucket, library prefix, or access mode')
  }
  const availableResource = `//storage.googleapis.com/projects/_/buckets/${bucket}`
  const objectRoot = `projects/_/buckets/${bucket}/objects/${prefix}`
  const rule = (expression, roles) => ({
    availableResource,
    availabilityCondition: { expression },
    availablePermissions: roles.map((role) => `inRole:roles/storage.${role}`),
  })
  const objectRoles = ['objectViewer']
  if (access === 'editor') objectRoles.push('objectCreator')
  const accessBoundaryRules = [
    rule(`resource.name.startsWith('${objectRoot}/')`, objectRoles),
  ]
  if (access === 'editor') {
    accessBoundaryRules.push(rule(`resource.name == '${objectRoot}/head.json'`, ['objectUser']))
  }
  const tokenType = 'urn:ietf:params:oauth:token-type:access_token'
  const response = await request('https://sts.googleapis.com/v1/token', {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal,
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token_type: tokenType,
      requested_token_type: tokenType,
      subject_token: sourceToken,
      options: JSON.stringify({ accessBoundary: { accessBoundaryRules } }),
    }),
  })
  const { access_token: token } = await checkedJson(response)
  if (typeof token !== 'string' || !token) throw new Error('Token exchange returned no access token')
  return token
}
