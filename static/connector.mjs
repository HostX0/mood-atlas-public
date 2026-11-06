const protocol = 'mood-atlas-public-connect-v1';
const pending = new Map();
window.addEventListener('message', event => {
  const m = event.data;
  if (event.source !== window || event.origin !== location.origin || m?.protocol !== protocol || m.direction !== 'response') return;
  const request = pending.get(m.id);
  if (!request) return;
  pending.delete(m.id); clearTimeout(request.timer);
  if (m.response?.ok) request.resolve(m.response);
  else request.reject(Object.assign(new Error(m.response?.error || 'Could not reach the extension. Refresh the page and reconnect.'), {code:m.response?.code || 'EXTENSION_TIMEOUT'}));
});
export function extension(action, payload, timeout = 90000) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error(action === 'hello' ? 'Install Mood Atlas Connect, then refresh this page.' :
        'The extension connection was interrupted. Reconnect and resume. Your progress is saved.'), {code:action==='hello'?'EXTENSION_MISSING':'EXTENSION_TIMEOUT'}));
    }, timeout);
    pending.set(id, {resolve, reject, timer});
    window.postMessage({protocol, direction: 'request', id, action, payload}, location.origin);
  });
}
