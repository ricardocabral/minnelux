import { readObject, VIDEO } from './gcs.js';

const scope = new URL(self.registration.scope);
const route = `${scope.pathname}media/`;
const rangeLimit = 1024 * 1024;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin === scope.origin && url.pathname.startsWith(route)) {
    event.respondWith(serveVideo(event, url.pathname.slice(route.length)));
  }
});

async function serveVideo(event, asset) {
  if (event.request.method !== 'GET' || !/^[a-f0-9-]{36}$/.test(asset)) {
    return new Response(null, { status: 404 });
  }

  // Ask the requesting tab each time, including after the browser restarts the worker.
  const client = event.clientId && await self.clients.get(event.clientId);
  if (!client || client.type !== 'window') return new Response(null, { status: 403 });
  const page = new URL(client.url);
  if (page.origin !== scope.origin || ![scope.pathname, `${scope.pathname}index.html`].includes(page.pathname)) {
    return new Response(null, { status: 403 });
  }
  const session = await askTab(client, asset);
  if (!session || session.expiresAt <= Date.now()) return new Response(null, { status: 401 });

  const range = event.request.headers.get('Range') ?? 'bytes=0-';
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return new Response(null, { status: 416 });
  const start = Number(match[1]);
  // Browsers often ask for the rest of the object. Bound an open-ended request
  // so the test can observe a seek without fetching the whole video first.
  const upstreamRange = match[2] ? range : `bytes=${start}-${start + rangeLimit - 1}`;
  const requestId = crypto.randomUUID();
  try {
    const response = await readObject(session.bucket, VIDEO, {
      token: session.token, range: upstreamRange, signal: event.request.signal,
    });
    const contentRange = response.headers.get('Content-Range');
    const contentType = response.headers.get('Content-Type');
    const contentLength = response.headers.get('Content-Length');
    // Never accidentally stream the entire fixture when the CDN ignores Range.
    const usable = response.status === 206 && /^bytes \d+-\d+\/\d+$/.test(contentRange)
      && contentType?.startsWith('video/') && Number(contentLength) > 0 && response.body;
    client.postMessage({
      kind: 'range', asset, requestId, range, upstreamRange,
      status: response.status, contentRange, contentType, contentLength,
    });
    if (!usable) {
      await response.body?.cancel();
      return new Response(null, { status: response.status >= 400 ? response.status : 502 });
    }

    let bytes = 0;
    let reported = 0;
    const report = () => {
      reported = bytes;
      client.postMessage({ kind: 'bytes', asset, requestId, bytes });
    };
    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes - reported >= 64 * 1024) report();
        controller.enqueue(chunk);
      },
      flush: report,
    }));
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Length': contentLength,
        'Content-Range': contentRange,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    client.postMessage({ kind: 'network-error', asset, upstreamRange });
    return new Response(null, { status: 502 });
  }
}

function askTab(client, asset) {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    const finish = (session) => {
      clearTimeout(timeout);
      port1.close();
      resolve(session);
    };
    const timeout = setTimeout(() => finish(null), 2000);
    port1.onmessage = (event) => finish(event.data);
    client.postMessage({ kind: 'request-session', asset }, [port2]);
  });
}
