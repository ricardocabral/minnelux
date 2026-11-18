import { PHOTO, VIDEO, readObject, writeObject } from './gcs.js';

const form = document.querySelector('#connection');
const sessionLabel = document.querySelector('#session');
const video = document.querySelector('#player');
const preview = document.querySelector('#preview');
const evidence = document.querySelector('#evidence');
const scopeRoot = new URL('./', location.href);
const scopePrefix = 'https://www.googleapis.com/auth/devstorage.';
let session;
let asset;
let photoUrl;
let resume;
let seek;
let videoSize = 0;
let furthestRequestedByte = -1;
let received = new Map();
let expiryTimer;

function log(message) {
  evidence.textContent += `${new Date().toISOString().slice(11, 23)} ${message}\n`;
}

function run(selector, action) {
  const button = document.querySelector(selector);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      log(error.message);
    } finally {
      button.disabled = false;
    }
  });
}

function currentBucket() {
  const bucket = form.elements.bucket.value.trim();
  if (!/^[a-z0-9][a-z0-9._-]+[a-z0-9]$/.test(bucket)) throw new Error('Enter a valid GCS bucket name.');
  return bucket;
}

function signedIn() {
  if (session && session.expiresAt > Date.now()) return session;
  throw new Error('Sign in to run this check.');
}

const worker = navigator.serviceWorker;
worker?.addEventListener('message', (event) => {
  if (event.source !== worker.controller) return;
  const { kind, asset: requested, requestId, bytes, range, upstreamRange, status, contentRange, contentLength } = event.data;
  if (kind === 'request-session') {
    event.ports[0]?.postMessage(requested === asset ? session ?? null : null);
    return;
  }
  if (requested !== asset) return;
  if (kind === 'range') {
    log(`Worker ${range} → GCS ${upstreamRange}: ${status}, Content-Range ${contentRange}, Content-Length ${contentLength}`);
    const bounds = /^bytes (\d+)-(\d+)\//.exec(contentRange);
    if (status === 206 && bounds) {
      const [, start, end] = bounds;
      if (seek && Number(start) > seek.previousEnd + 1) seek.discontinuous = true;
      furthestRequestedByte = Math.max(furthestRequestedByte, Number(end));
    }
    if (status === 401) loseSession('Google rejected the token');
  } else if (kind === 'bytes') {
    received.set(requestId, bytes);
  } else if (kind === 'network-error') {
    log(`Worker network error for ${upstreamRange}`);
  }
});

function loseSession(reason) {
  if (asset && session) resume = { time: video.currentTime, bucket: session.bucket };
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.hidden = true;
  preview.hidden = true;
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = undefined;
  asset = undefined;
  session = undefined;
  clearTimeout(expiryTimer);
  sessionLabel.textContent = `${reason}. Sign in to reconnect.`;
  log(reason);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const identity = globalThis.google?.accounts?.oauth2;
    if (!identity) throw new Error('Google Identity Services is still loading or was blocked.');
    const bucket = currentBucket();
    const access = event.submitter?.value ?? 'read';
    const scope = scopePrefix + (access === 'write' ? 'read_write' : 'read_only');
    const reportFailure = () => log('Google authorization did not return the requested storage scope.');
    identity.initTokenClient({
      client_id: form.elements.client.value.trim(),
      scope,
      include_granted_scopes: false,
      error_callback: reportFailure,
      callback: (response) => {
        const scopes = response.scope?.split(/\s+/) ?? [];
        const lifetime = Number(response.expires_in);
        if (!response.access_token || !scopes.includes(scope) || !Number.isFinite(lifetime) || lifetime <= 0
          || (access === 'read' && scopes.some((value) => value.startsWith(scopePrefix) && value !== scope))) {
          reportFailure();
          return;
        }
        if (session && session.bucket !== bucket) loseSession('Changed bucket');
        session = { token: response.access_token, bucket, access, expiresAt: Date.now() + lifetime * 1000 };
        clearTimeout(expiryTimer);
        expiryTimer = setTimeout(() => loseSession('Google token expired'), lifetime * 1000);
        sessionLabel.textContent = `Signed in with ${access === 'write' ? 'read/write' : 'read-only'} scope for ${bucket}`;
        log(`Google Identity Services granted ${scopes.filter((value) => value.startsWith(scopePrefix)).join(', ')} for ${lifetime}s`);
        if (resume?.bucket === bucket) openVideo().catch((error) => log(error.message));
      },
    }).requestAccessToken({ prompt: 'select_account' });
  } catch (error) {
    log(error.message);
  }
});

run('#anonymous', async () => {
  const response = await readObject(currentBucket(), PHOTO);
  log(`Signed-out JPEG read: HTTP ${response.status}`);
  await response.body?.cancel();
});

run('#photo', async () => {
  const { bucket, token } = signedIn();
  const response = await readObject(bucket, PHOTO, { token });
  log(`Authorized JPEG read: HTTP ${response.status}`);
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401) loseSession('Google rejected the token');
    return;
  }
  const photo = await response.blob();
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = URL.createObjectURL(photo);
  preview.src = photoUrl;
  await preview.decode();
  preview.hidden = false;
  log(`JPEG decoded at ${preview.naturalWidth} × ${preview.naturalHeight}, ${photo.size} bytes`);
});

run('#publication', async () => {
  const { bucket, token, access } = signedIn();
  const prefix = `proof/runs/${crypto.randomUUID()}`;
  async function publish(key, value, generation, label, expected) {
    const response = await writeObject(bucket, key, token, JSON.stringify(value), 'application/json', generation);
    log(`${label}: HTTP ${response.status} (expected ${expected})`);
    if (response.status !== expected) {
      await response.body?.cancel();
      throw new Error('Publication check failed.');
    }
    return response.json();
  }
  const head = `${prefix}/head.json`;
  if (access === 'read') {
    await publish(head, { revision: 1 }, '0', 'Read-only publication', 403);
    return;
  }
  await publish(`${prefix}/revisions/r1.json`, { items: [] }, '0', 'Private snapshot upload', 200);
  const first = await publish(head, { revision: 'r1' }, '0', 'Conditional head creation', 200);
  const observed = await readObject(bucket, head, { token, media: false });
  if (!observed.ok || (await observed.json()).generation !== first.generation) throw new Error('Head generation could not be verified.');
  await publish(`${prefix}/revisions/r2.json`, { items: ['synthetic'] }, '0', 'Second snapshot upload', 200);
  await publish(head, { revision: 'r2' }, first.generation, 'Conditional head update', 200);
  await publish(head, { revision: 'r1' }, first.generation, 'Stale head update', 412);
  const final = await readObject(bucket, head, { token });
  if (!final.ok || (await final.json()).revision !== 'r2') throw new Error('Final head contains the wrong revision.');
  log('Published revision r2 remains readable after stale-write rejection.');
});

async function openVideo() {
  const { bucket, token } = signedIn();
  if (!worker) throw new Error('Service workers require a supported browser and secure origin.');
  await worker.register(new URL('worker.js', scopeRoot), { type: 'module' });
  await worker.ready;
  if (!worker.controller) {
    await new Promise((resolve, reject) => {
      const onControl = () => {
        if (!worker.controller) return;
        clearTimeout(timeout);
        worker.removeEventListener('controllerchange', onControl);
        resolve();
      };
      const timeout = setTimeout(() => {
        worker.removeEventListener('controllerchange', onControl);
        reject(new Error('Service worker did not claim this page.'));
      }, 5000);
      worker.addEventListener('controllerchange', onControl);
      onControl();
    });
  }
  const response = await readObject(bucket, VIDEO, { token, media: false });
  if (!response.ok) throw new Error(`Video metadata: HTTP ${response.status}`);
  videoSize = Number((await response.json()).size);
  if (!Number.isSafeInteger(videoSize) || videoSize <= 0) throw new Error('GCS did not return a valid video size.');
  const position = resume?.bucket === bucket ? resume.time : undefined;
  resume = undefined;
  seek = undefined;
  furthestRequestedByte = -1;
  received = new Map();
  asset = crypto.randomUUID();
  video.hidden = false;
  video.preload = 'metadata';
  video.src = new URL(`media/${asset}`, scopeRoot);
  if (position !== undefined) {
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = position;
      log(`Restoring position ${position.toFixed(2)}s after sign-in. Press Play to resume.`);
    }, { once: true });
  }
}

run('#video', openVideo);
run('#seek', async () => {
  if (!Number.isFinite(video.duration)) throw new Error('Open the video and wait for its duration before seeking.');
  const bytesBeforeSeek = [...received.values()].reduce((sum, bytes) => sum + bytes, 0);
  seek = { bytesBeforeSeek, previousEnd: furthestRequestedByte, discontinuous: false, position: video.duration * 0.75 };
  video.currentTime = seek.position;
});
run('#reconnect', async () => loseSession('Local token cleared'));

video.addEventListener('loadedmetadata', () => log(`Browser loaded ${video.duration.toFixed(2)}s video, full object ${videoSize} bytes`));
video.addEventListener('playing', () => log(`Browser playing at ${video.currentTime.toFixed(2)}s`));
video.addEventListener('seeked', () => {
  const receivedBytes = [...received.values()].reduce((sum, bytes) => sum + bytes, 0);
  const result = seek;
  seek = undefined;
  log(`Browser reached ${video.currentTime.toFixed(2)}s; worker streamed ${receivedBytes} of ${videoSize} bytes`);
  if (result) log(`Seek started after ${result.bytesBeforeSeek} bytes; new upstream offset: ${result.discontinuous ? 'observed' : 'not observed'}`);
});
video.addEventListener('error', () => log(`Browser video error code ${video.error?.code}`));
