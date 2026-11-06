(() => {
  const protocol = 'mood-atlas-public-connect-v1';
  const origins = ['https://mood-atlas-public.vercel.app', 'http://127.0.0.1:8765'];
  if (window !== window.top || !origins.includes(location.origin)) return;
  const actions = new Set(['hello', 'connect', 'disconnect', 'job.start', 'job.adopt', 'job.step', 'job.status']);
  window.addEventListener('message', async event => {
    const m = event.data;
    if (event.source !== window || event.origin !== location.origin || m?.protocol !== protocol ||
        m.direction !== 'request' || !/^[a-f0-9-]{36}$/.test(m.id) || !actions.has(m.action)) return;
    let response;
    try { response = await chrome.runtime.sendMessage({protocol, action: m.action, payload: m.payload}); }
    catch { response = {ok: false, code: 'EXTENSION_RELOADED', error: 'The extension was reloaded. Refresh Mood Atlas and reconnect.'}; }
    window.postMessage({protocol, direction: 'response', id: m.id, response}, location.origin);
  });
})();
