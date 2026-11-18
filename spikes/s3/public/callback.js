const { pathname, search } = location;
history.replaceState(null, '', pathname);
const response = new URLSearchParams(search);
const state = response.get('state');
if (state && /^[a-f0-9]{64}$/.test(state)) {
  const callback = new BroadcastChannel(`minnelux-s3-${state}`);
  callback.postMessage({ code: response.get('code'), error: response.has('error') });
  callback.close();
  window.close();
} else {
  document.querySelector('#status').textContent = 'No matching sign-in request.';
}
