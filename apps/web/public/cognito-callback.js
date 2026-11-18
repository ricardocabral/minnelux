const response = new URLSearchParams(location.search)
history.replaceState(null, '', location.pathname)
const states = response.getAll('state')
const state = states[0]
if (states.length === 1 && /^[a-f0-9]{64}$/.test(state)) {
  // Keep this channel prefix and payload in sync with src/storage/s3-session.ts.
  const channel = new BroadcastChannel('minnelux-cognito-' + state)
  const codes = response.getAll('code')
  const code = codes.length === 1 ? codes[0] : null
  channel.postMessage({state, code, error:response.has('error')})
  channel.close()
  window.close()
} else {
  document.querySelector('#status').textContent = 'No matching sign-in request.'
}
