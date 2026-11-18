export const PHOTO = 'proof/fixtures/photo.jpg';
export const VIDEO = 'proof/fixtures/video.mp4';
const ORIGIN = 'https://storage.googleapis.com';

export function objectUrl(bucket, key, media = false) {
  const url = new URL(`/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`, ORIGIN);
  if (media) url.searchParams.set('alt', 'media');
  return url;
}

export function readObject(bucket, key, { token, range, media = true, signal } = {}) {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (range) headers.set('Range', range);
  return fetch(objectUrl(bucket, key, media), { headers, signal, cache: 'no-store', credentials: 'omit' });
}

export function writeObject(bucket, key, token, body, type, generation) {
  const url = new URL(`/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`, ORIGIN);
  url.search = new URLSearchParams({ uploadType: 'media', name: key, ifGenerationMatch: generation });
  return fetch(url, {
    method: 'POST',
    credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
    body,
  });
}
