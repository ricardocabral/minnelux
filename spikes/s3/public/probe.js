import { signIn } from './auth.js';
import { connect } from './storage.js';

const prefix = 'proof/fixtures/';
const photoKey = prefix + 'photo.jpg';
const videoKey = prefix + 'video.mp4';
const evidence = document.querySelector('#evidence');
const status = document.querySelector('#session');
const preview = document.querySelector('#preview');
const player = document.querySelector('#player');
let config;
let session;
let expiryTimer;
let photoUrl;
let resume;

function log(message) {
  const line = document.createElement('div');
  line.textContent = `${new Date().toISOString().slice(11, 23)} ${message}`;
  evidence.append(line);
}

function describe(error) {
  if (error.$metadata?.httpStatusCode) {
    return `HTTP ${error.$metadata.httpStatusCode} (${error.name})`;
  }
  if (error.constructor === Error) return error.message;
  return `Request failed (${error.name}).`;
}

function onClick(id, action) {
  document.querySelector(id).addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      log(describe(error));
    } finally {
      button.disabled = false;
    }
  });
}

function authorized() {
  if (!session || session.expiresAt <= Date.now()) throw new Error('Sign in to run this check.');
  return session.storage;
}

function disconnect(reason) {
  if (session && player.getAttribute('src')) {
    resume = { identityId: session.identityId, time: player.currentTime };
  }
  session?.controller.abort();
  session = undefined;
  clearTimeout(expiryTimer);
  player.pause();
  player.removeAttribute('src');
  player.load();
  player.hidden = true;
  preview.removeAttribute('src');
  preview.hidden = true;
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = undefined;
  status.textContent = `${reason}. Sign in to reconnect.`;
  log(reason);
}

onClick('#sign-in', async () => {
  if (session) disconnect('Dropped previous local session');
  const { identityId, credentials } = await signIn(config);
  const controller = new AbortController();
  session = {
    identityId, controller, expiresAt: credentials.expiration.getTime(),
    storage: connect(config, credentials, controller.signal),
  };
  expiryTimer = setTimeout(() => disconnect('Temporary AWS credentials expired'), session.expiresAt - Date.now());
  status.textContent = `Cognito issued temporary AWS credentials for ${config.bucket}.`;
  log(`AWS credential expiration: ${credentials.expiration.toISOString()}`);
  const position = resume?.identityId === identityId ? resume.time : undefined;
  resume = undefined;
  if (position !== undefined) await openVideo(position);
});

onClick('#disconnect', () => {
  if (session) disconnect('Dropped local session');
});

onClick('#anonymous', async () => {
  const endpoint = `https://${config.bucket}.s3.${config.region}.amazonaws.com/${photoKey}`;
  try {
    const response = await fetch(endpoint, { cache: 'no-store', credentials: 'omit' });
    log(`Unsigned JPEG: HTTP ${response.status}`);
    await response.body?.cancel();
    if (response.ok) throw new Error('Unexpected public read.');
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    log('Unsigned fetch was blocked by the browser. Check the S3 status in the Network panel.');
  }
});

onClick('#photo', async () => {
  const active = session;
  const result = await authorized().read(photoKey);
  const bytes = await result.Body.transformToByteArray();
  if (session !== active) return;
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = URL.createObjectURL(new Blob([bytes], { type: result.ContentType }));
  preview.src = photoUrl;
  await preview.decode();
  if (session === active) preview.hidden = false;
  log(`JPEG: HTTP ${result.$metadata.httpStatusCode}, decoded ${preview.naturalWidth} × ${preview.naturalHeight}`);
});

onClick('#inspect', async () => {
  const storage = authorized();
  const first = await storage.list(prefix);
  if (!first.IsTruncated || !first.NextContinuationToken) throw new Error('Expected a continuation token.');
  const next = await storage.list(prefix, first.NextContinuationToken);
  const keys = [first.Contents?.[0]?.Key, next.Contents?.[0]?.Key];
  if (!keys.includes(photoKey) || !keys.includes(videoKey)) throw new Error('Unexpected fixture listing.');
  log('Listing: two fixture keys across two pages.');
  const metadata = await storage.stat(videoKey);
  if (!metadata.ETag || !metadata.ContentLength) throw new Error('Video metadata is missing the ETag or byte size.');
  const range = await storage.read(videoKey, 'bytes=100000-100099');
  const bytes = await range.Body.transformToByteArray();
  if (range.$metadata.httpStatusCode !== 206 || bytes.length !== 100 ||
      range.ContentRange !== `bytes 100000-100099/${metadata.ContentLength}`) {
    throw new Error('Unexpected signed range response.');
  }
  log(`Signed Range: HTTP 206, Content-Range ${range.ContentRange}, ${bytes.length} bytes`);
  await expectFailure(() => storage.list(''), 'Bucket-wide listing', 403);
  await expectFailure(() => storage.read('private/outside.txt'), 'Read outside allowed prefixes', 403);

  const absentKey = `proof/runs/${crypto.randomUUID()}/head.json`;
  let missingStatus;
  try {
    await storage.stat(absentKey);
  } catch (error) {
    missingStatus = error.$metadata?.httpStatusCode;
    if (missingStatus !== 403 && missingStatus !== 404) throw error;
  }
  const missing = await storage.list(absentKey);
  if (!missingStatus || missing.Contents?.length) throw new Error('Unexpected result for an uncreated head.');
  log(`Uncreated head: HEAD ${missingStatus}, exact-prefix listing found no objects.`);
});

async function expectFailure(action, label, expected) {
  try {
    await action();
  } catch (error) {
    log(`${label}: ${describe(error)} (expected HTTP ${expected})`);
    if (error.$metadata?.httpStatusCode === expected) return;
    throw error;
  }
  throw new Error(`${label} unexpectedly succeeded.`);
}

onClick('#publication', async () => {
  const storage = authorized();
  const run = `proof/runs/${crypto.randomUUID()}`;
  const head = `${run}/head.json`;
  const snapshot = `${run}/revisions/r1.json`;
  let first;
  try {
    first = await storage.put(snapshot, { items: [] });
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 403) throw error;
    log(`Snapshot write denied: ${describe(error)}. This session did not publish a revision.`);
    return;
  }
  log(`Snapshot create: HTTP ${first.$metadata.httpStatusCode}`);
  await expectFailure(() => storage.put(snapshot, { items: ['duplicate'] }), 'Duplicate snapshot', 412);
  const created = await storage.put(head, { revision: 'r1' });
  const current = await storage.read(head);
  const body = await current.Body.transformToString();
  const etag = current.ETag;
  if (!etag || etag !== created.ETag || JSON.parse(body).revision !== 'r1') {
    throw new Error('Read the head but could not validate its revision and matching ETag.');
  }
  log(`Conditional head create: HTTP ${created.$metadata.httpStatusCode}, ETag readable on PUT and GET`);
  await expectFailure(() => storage.put(head, { revision: 'r0' }), 'Duplicate head create', 412);
  await storage.put(`${run}/revisions/r2.json`, { items: ['synthetic'] });
  const updated = await storage.put(head, { revision: 'r2' }, etag);
  log(`Conditional head update: HTTP ${updated.$metadata.httpStatusCode}`);
  await expectFailure(() => storage.put(head, { revision: 'r1' }, etag), 'Stale head update', 412);
  const final = await storage.read(head);
  if (JSON.parse(await final.Body.transformToString()).revision !== 'r2') {
    throw new Error('Final head contains the wrong revision.');
  }
  log('Published revision r2 remains readable after stale-write rejection.');
});

async function openVideo(position) {
  const active = session;
  const { url } = await authorized().mediaUrl(videoKey);
  if (session !== active) return;
  player.hidden = false;
  player.preload = 'metadata';
  player.onloadedmetadata = () => {
    if (position !== undefined) player.currentTime = position;
    log(`Video metadata: ${player.duration.toFixed(2)} seconds${position === undefined ? '' : `, restored ${position.toFixed(2)} seconds`}`);
  };
  player.src = url;
}

onClick('#video', () => openVideo());
onClick('#seek', async () => {
  if (!Number.isFinite(player.duration)) throw new Error('Open the video and wait for its metadata.');
  const target = player.duration * 0.75;
  if (Math.abs(player.currentTime - target) > 0.1) {
    player.addEventListener('seeked', () => log(`Player seeked to ${player.currentTime.toFixed(2)} seconds.`), { once: true });
    player.currentTime = target;
  }
  await player.play().catch(() => log('Use the video Play control to resume playback.'));
});

onClick('#expiry', async () => {
  const storage = authorized();
  const signal = session.controller.signal;
  const { url, expiresAt } = await storage.mediaUrl(videoKey, 12);
  const readRange = (signedUrl, range) => fetch(signedUrl, {
    cache: 'no-store', headers: { Range: range }, signal,
  });
  const first = await readRange(url, 'bytes=0-99');
  if (first.status !== 206) throw new Error(`Presigned Range returned HTTP ${first.status} before expiry.`);
  const bytes = await first.arrayBuffer();
  if (bytes.byteLength !== 100 || !first.headers.get('Content-Range')) throw new Error('Presigned range headers or bytes are missing.');
  log('Presigned Range: HTTP 206 before expiry with readable Content-Range.');
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now()) + 2_000));
  try {
    const late = await readRange(url, 'bytes=100-199');
    log(`New range on expired URL: HTTP ${late.status}`);
    await late.body?.cancel();
    if (late.status !== 403) throw new Error('Expected an expired URL to return HTTP 403.');
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    log('Browser blocked the expired URL response. Verify the status in the Network panel.');
  }
  const renewed = await storage.mediaUrl(videoKey);
  const reopened = await readRange(renewed.url, 'bytes=100-199');
  log(`Same range on fresh URL: HTTP ${reopened.status}`);
  await reopened.body?.cancel();
  if (reopened.status !== 206) throw new Error('Renewing the media URL did not restore range reads.');
});

player.addEventListener('error', () => log('Video failed. Check the S3 request in the Network panel.'));

try {
  const response = await fetch('./config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error();
  config = await response.json();
  const { region, bucket, userPoolId, identityPoolId, clientId, cognitoOrigin } = config;
  const login = new URL(cognitoOrigin);
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
      !userPoolId?.startsWith(region + '_') || !identityPoolId?.startsWith(region + ':') || !clientId ||
      login.origin !== cognitoOrigin || login.protocol !== 'https:' || login.port ||
      !login.hostname.endsWith(`.auth.${region}.amazoncognito.com`)) {
    throw new Error();
  }
  status.textContent = `Signed out of ${bucket}`;
  document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
} catch {
  status.textContent = 'Supply the S3 proof configuration in config.json.';
}
